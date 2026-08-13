import prisma from '../src/lib/db';
import { llmCallLogRetentionDays } from '../src/lib/ai/llm-call-log';

/**
 * Срок хранения журнала вызовов модели (translation-m0x).
 *
 * Журнал держит содержимое промптов, то есть персональные данные клиентов бюро
 * — ФИО в документах, адреса, реквизиты. Часть машинно-опознаваемого
 * `redactPii()` вычищает при записи, но ФИО он сознательно не трогает (почему —
 * см. шапку `src/lib/ai/llm-call-log.ts`). Поэтому срок хранения здесь не
 * гигиена, а единственная защита от накопления: журнал включают на время
 * разбора инцидента, а этот скрипт гарантирует, что включённым забытым он не
 * превратится в бессрочное хранилище ПД.
 *
 * Политика: удалять записи старше `LLM_CALL_LOG_RETENTION_DAYS` (по умолчанию
 * 30 дней). Запускать по расписанию; идемпотентен, повторный запуск безвреден.
 *
 *   pnpm tsx scripts/cleanup-llm-log.ts           # удалить просроченное
 *   pnpm tsx scripts/cleanup-llm-log.ts --dry-run # только показать, сколько
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const retentionDays = llmCallLogRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const expired = await prisma.llmCallLog.count({ where: { createdAt: { lt: cutoff } } });
  const total = await prisma.llmCallLog.count();

  console.log(`Срок хранения: ${retentionDays} дн. (записи старше ${cutoff.toISOString()})`);
  console.log(`Всего записей: ${total}, просрочено: ${expired}`);

  if (dryRun) {
    console.log('--dry-run: ничего не удалено.');
    return;
  }
  if (expired === 0) {
    console.log('Удалять нечего.');
    return;
  }

  const { count } = await prisma.llmCallLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  console.log(`Удалено записей: ${count}. Осталось: ${total - count}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
