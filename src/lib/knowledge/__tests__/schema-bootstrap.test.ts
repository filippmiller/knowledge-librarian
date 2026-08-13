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
    const db: SchemaBootstrapDb = {
      // Лок/анлок обязаны идти через executeRaw, НЕ через queryRaw:
      // pg_advisory_lock() возвращает void, и queryRaw падает на его
      // десериализации (так упал первый прод-запуск 2026-08-13). Двойник
      // поэтому вообще не имеет $queryRawUnsafe — обращение к нему было бы
      // ошибкой типов уже на компиляции.
      $executeRawUnsafe: (async (sql: string) => {
        executed.push(sql);
        return 0;
      }) as SchemaBootstrapDb['$executeRawUnsafe'],
    };
    return { db, executed };
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
    const original = db.$executeRawUnsafe;
    let calls = 0;
    db.$executeRawUnsafe = (async (sql: string) => {
      calls++;
      if (calls === 2) throw new Error('нет соединения с БД'); // первый DDL после лока
      return original(sql);
    }) as SchemaBootstrapDb['$executeRawUnsafe'];
    await expect(runKnowledgeSchemaBootstrap(db)).rejects.toThrow('нет соединения с БД');
    expect(executed[executed.length - 1]).toContain('pg_advisory_unlock');
  });
});
