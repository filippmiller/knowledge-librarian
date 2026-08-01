/**
 * Сколько правил модалка источника опишет НЕВЕРНО.
 * Запуск: railway run npx tsx scripts/probe-rule-provenance.ts
 *
 * Модалка отвечает оператору на один вопрос: «текст этого правила
 * действительно взят вот отсюда?» Ответ становится ложью в трёх случаях, и
 * каждый из них надо считать отдельно, потому что лечатся они по-разному.
 */
import prisma from '../src/lib/db';

function str(span: Record<string, unknown> | null, key: string): string | null {
  const v = span?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

async function main() {
  const rules = await prisma.rule.findMany({
    where: { status: 'ACTIVE' },
    select: { ruleCode: true, version: true, documentId: true, sourceSpan: true },
  });

  let orphanWithSpan = 0; // документа нет, но правило явно из документа
  let orphanTagged = 0; // документа нет и стоит метка происхождения — честный случай
  let editedKeepsOldQuote = 0; // текст переписали, цитата от прежней версии
  let voiceEditedQuote = 0; // цитата — это текст оператора, а не фрагмент документа

  for (const r of rules) {
    const span = (r.sourceSpan ?? null) as Record<string, unknown> | null;
    const quote = str(span, 'quote');
    const hint = str(span, 'locationHint');
    const tag = str(span, 'authorityTag');

    if (!r.documentId) {
      if (tag) orphanTagged++;
      else if (quote || hint) orphanWithSpan++;
      continue;
    }

    if (hint === 'Отредактировано голосом') voiceEditedQuote++;
    else if (r.version > 1) editedKeepsOldQuote++;
  }

  const total = rules.length;
  const wrong = orphanWithSpan + editedKeepsOldQuote + voiceEditedQuote;

  console.log(`активных правил: ${total}`);
  console.log(`модалка опишет неверно: ${wrong} (${((wrong / total) * 100).toFixed(1)}%)`);
  console.log(`  документа нет, метки происхождения нет — назовёт «надиктовано голосом»: ${orphanWithSpan}`);
  console.log(`  текст правки новее цитаты — зелёное «найдено» про прежнюю версию: ${editedKeepsOldQuote}`);
  console.log(`  цитата подменена текстом оператора — красное «не найдено» обвинит извлечение: ${voiceEditedQuote}`);
  console.log(`честных случаев «документа нет по природе» (есть authorityTag): ${orphanTagged}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
