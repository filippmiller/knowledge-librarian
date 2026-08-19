import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS,
  bootstrapKnowledgeSchemaAtStartup,
  getLastBootstrapStatus,
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

  it('зеркалит миграцию корпусов: колонки и индексы corpusId есть в bootstrap', async () => {
    const migration = await readFile(
      join(process.cwd(), 'prisma/migrations/20260819120000_corpus_isolation/migration.sql'),
      'utf8'
    );
    const all = KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.join('\n');
    for (const match of migration.matchAll(/CREATE INDEX IF NOT EXISTS "([^"]+)"|ALTER TABLE "([^"]+)" ADD COLUMN/g)) {
      const name = match[1] ?? match[2];
      expect(all, `bootstrap потерял объект миграции корпусов: ${name}`).toContain(`"${name}"`);
    }
    expect(all).toContain('"corpusId"');
    expect(all).toContain("'aurora'");
  });
});

describe('runKnowledgeSchemaBootstrap', () => {
  function fakeDb({ lockAcquired = true }: { lockAcquired?: boolean } = {}) {
    const executed: string[] = [];
    const queried: string[] = [];
    const db: SchemaBootstrapDb = {
      // DDL и анлок идут через executeRaw. Через queryRaw их гонять нельзя:
      // pg_advisory_lock() возвращает void, и queryRaw падает на его
      // десериализации — так упал первый прод-запуск 2026-08-13.
      $executeRawUnsafe: (async (sql: string) => {
        executed.push(sql);
        return 0;
      }) as SchemaBootstrapDb['$executeRawUnsafe'],
      // А вот РЕЗУЛЬТАТ try-лока прочитать можно только запросом: executeRaw
      // отдаёт счётчик строк, а не значение. Это безопасно —
      // pg_try_advisory_lock() возвращает boolean, а не void.
      $queryRawUnsafe: (async (sql: string) => {
        queried.push(sql);
        return [{ locked: lockAcquired }];
      }) as SchemaBootstrapDb['$queryRawUnsafe'],
    };
    return { db, executed, queried };
  }

  it('выполняет все statements под advisory-локом и снимает лок', async () => {
    const { db, executed, queried } = fakeDb();
    const result = await runKnowledgeSchemaBootstrap(db);
    expect(result.ok).toBe(true);
    expect(result.statementsRun).toBe(KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.length);
    expect(queried[0]).toContain('pg_try_advisory_lock');
    expect(executed.slice(0, -1)).toEqual([...KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS]);
    expect(executed[executed.length - 1]).toContain('pg_advisory_unlock');
  });

  // Блокирующий pg_advisory_lock ЖДЁТ освобождения — именно это подвесило старт
  // сервера 2026-08-13 (деплой `0a89eb7c`: healthcheck 11 раз получил service
  // unavailable, деплой отменён). Ждать здесь нечего: DDL идемпотентен, сосед
  // доведёт его сам.
  it('лок занят другим инстансом — DDL пропускается, а не ожидается', async () => {
    const { db, executed } = fakeDb({ lockAcquired: false });
    const result = await runKnowledgeSchemaBootstrap(db);
    expect(result.ok).toBe(true);
    expect(result.skippedLockHeld).toBe(true);
    expect(result.statementsRun).toBe(0);
    expect(executed).toEqual([]);
  });

  it('ошибка DDL пробрасывается, но лок всё равно снимается', async () => {
    const { db, executed } = fakeDb();
    const original = db.$executeRawUnsafe;
    let calls = 0;
    db.$executeRawUnsafe = (async (sql: string) => {
      calls++;
      if (calls === 1) throw new Error('нет соединения с БД'); // первый DDL
      return original(sql);
    }) as SchemaBootstrapDb['$executeRawUnsafe'];
    await expect(runKnowledgeSchemaBootstrap(db)).rejects.toThrow('нет соединения с БД');
    expect(executed[executed.length - 1]).toContain('pg_advisory_unlock');
  });
});

describe('bootstrapKnowledgeSchemaAtStartup', () => {
  // Регрессия на прод-отказ 2026-08-13, деплой `0a89eb7c`. Обёртка ловила
  // ИСКЛЮЧЕНИЕ, но зависание исключения не бросает: register() ждал вечно,
  // сервер не отвечал на /, healthcheck отменил деплой. В логах контейнера не
  // было ни `ok`, ни `FAILED` — единственный признак, что bootstrap не
  // завершился вовсе.
  it('зависшая БД не держит старт сервера: обёртка всё равно завершается', async () => {
    vi.useFakeTimers();
    try {
      const hangingDb: SchemaBootstrapDb = {
        $executeRawUnsafe: (() => new Promise(() => {})) as SchemaBootstrapDb['$executeRawUnsafe'],
        $queryRawUnsafe: (() => new Promise(() => {})) as SchemaBootstrapDb['$queryRawUnsafe'],
      };

      const startup = bootstrapKnowledgeSchemaAtStartup(hangingDb);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(startup).resolves.toBeUndefined();

      const status = getLastBootstrapStatus();
      expect(status?.ok).toBe(false);
      expect(status?.error).toMatch(/не уложился/);
    } finally {
      vi.useRealTimers();
    }
  });
});
