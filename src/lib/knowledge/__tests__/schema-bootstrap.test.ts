import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS,
  runKnowledgeSchemaBootstrap,
  type SchemaBootstrapDb,
} from '../schema-bootstrap';

describe('KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS', () => {
  it('каждый statement идемпотентен: IF NOT EXISTS или guarded DO-блок', () => {
    for (const statement of KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS) {
      expect(
        statement.includes('IF NOT EXISTS'),
        `не-идемпотентный statement: ${statement.slice(0, 80)}`
      ).toBe(true);
    }
  });

  it('bootstrap строго аддитивен — ни DROP, ни DELETE, ни TRUNCATE, ни UPDATE', () => {
    for (const statement of KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS) {
      // ON DELETE / ON UPDATE — referential actions внешних ключей, не statements.
      const withoutReferentialActions = statement.replace(
        /ON (DELETE|UPDATE) (SET NULL|SET DEFAULT|CASCADE|RESTRICT|NO ACTION)/g,
        ''
      );
      expect(withoutReferentialActions).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i);
    }
  });

  it('зеркалит миграцию: каждая таблица, индекс и constraint из migration.sql присутствует', async () => {
    const migration = await readFile(
      join(
        process.cwd(),
        'prisma/migrations/20260813120000_aurora_v2_knowledge_units/migration.sql'
      ),
      'utf8'
    );
    const all = KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.join('\n');
    for (const match of migration.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)"|CREATE TABLE "([^"]+)"|ADD CONSTRAINT "([^"]+)"/g)) {
      const name = match[1] ?? match[2] ?? match[3];
      expect(all, `bootstrap потерял объект миграции: ${name}`).toContain(`"${name}"`);
    }
  });
});

describe('runKnowledgeSchemaBootstrap', () => {
  function fakeDb() {
    const executed: string[] = [];
    const queried: string[] = [];
    // Двойник намеренно ШИРЕ, чем SchemaBootstrapDb: $queryRawUnsafe остаётся,
    // чтобы тест ниже мог доказать, что модуль этот путь не трогает.
    const db: SchemaBootstrapDb & { $queryRawUnsafe: (sql: string) => Promise<unknown> } = {
      $executeRawUnsafe: (async (sql: string) => {
        executed.push(sql);
        return 0;
      }) as SchemaBootstrapDb['$executeRawUnsafe'],
      $queryRawUnsafe: async (sql: string) => {
        queried.push(sql);
        return [];
      },
    };
    return { db, executed, queried };
  }

  it('выполняет все statements под advisory-локом и снимает лок', async () => {
    const { db, executed } = fakeDb();
    const result = await runKnowledgeSchemaBootstrap(db);
    expect(result.ok).toBe(true);
    expect(result.statementsRun).toBe(KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.length);
    expect(executed[0]).toContain('pg_advisory_lock');
    expect(executed.slice(1, -1)).toEqual([...KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS]);
    expect(executed[executed.length - 1]).toContain('pg_advisory_unlock');
  });

  it('ошибка DDL пробрасывается, но лок всё равно снимается', async () => {
    const { db, executed } = fakeDb();
    const passthrough = db.$executeRawUnsafe;
    db.$executeRawUnsafe = (async (sql: string) => {
      if (sql.includes('pg_advisory')) return passthrough(sql);
      throw new Error('нет соединения с БД');
    }) as SchemaBootstrapDb['$executeRawUnsafe'];
    await expect(runKnowledgeSchemaBootstrap(db)).rejects.toThrow('нет соединения с БД');
    expect(executed[executed.length - 1]).toContain('pg_advisory_unlock');
  });

  // Живой прод-отказ, деплой 2026-08-13 (`0ec97d79`): лок брали через
  // $queryRawUnsafe, а `pg_advisory_lock()` возвращает `void` — Prisma не умеет
  // десериализовать такую колонку и падает с
  // "Failed to deserialize column of type 'void'". Исключение летело ДО первого
  // DDL, поэтому statementsRun был 0, все три таблицы отсутствовали, а
  // /api/health/schema отдавал auroraV2Ready:false при полностью успешном
  // деплое. Прежний двойник этого не ловил: его $queryRawUnsafe покорно
  // возвращал [] на что угодно.
  it('не берёт лок через query-путь: он не переживает void-возврат pg_advisory_lock', async () => {
    const { db, executed, queried } = fakeDb();
    db.$queryRawUnsafe = async () => {
      throw new Error(
        "Raw query failed. Code: `N/A`. Message: `Failed to deserialize column of type 'void'.`"
      );
    };

    const result = await runKnowledgeSchemaBootstrap(db);

    expect(result.ok).toBe(true);
    expect(result.statementsRun).toBe(KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.length);
    expect(executed).toEqual(
      expect.arrayContaining([...KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS])
    );
    expect(queried).toEqual([]);
  });
});
