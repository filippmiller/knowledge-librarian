/**
 * Next.js instrumentation — выполняется один раз при старте сервера.
 * Приводит БД к схеме Aurora v2 (идемпотентно, только добавление) — выкладка
 * кода сама применяет свою схему, ручных шагов на сервере нет.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrapKnowledgeSchemaAtStartup } = await import(
      '@/lib/knowledge/schema-bootstrap'
    );
    await bootstrapKnowledgeSchemaAtStartup();
  }
}
