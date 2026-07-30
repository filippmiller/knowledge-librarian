/**
 * Импорт операторских ответов из корпуса Bitrix в базу знаний.
 *
 * Замер точности (docs/bot-audit/accuracy-vs-operator.md) показал: из 21
 * отправленного клиенту ответа проверку прошёл ровно один — тот, который
 * написал и утвердил оператор. Все синтезированные получили WEAK или WRONG,
 * потому что синтез из фрагментов теряет условия («но оригинал привезти надо»,
 * «не считая дня приёма»), а оператор их всегда называет.
 *
 * Корпус: docs/email-bot/may2026-knowledge-base-final.json — 180 разобранных
 * обращений за май 2026 с ответами, которые операторы реально давали клиентам.
 * Он по построению клиентский.
 *
 * Три корзины, и участие владельца нужно только во второй:
 *
 *   1. IMPORT       — прошёл проверку клиентской безопасности и не содержит
 *                     цен. Импортируется.
 *   2. ЦЕНЫ         — содержит числа, похожие на цену. Корпус собран в мае, а
 *                     действующий прайс датирован 01.01.2026: какая цифра
 *                     верна, решает владелец, а не скрипт.
 *   3. БЕЗОПАСНОСТЬ — сработала сигнализация: ответ уводит клиента наружу или
 *                     проговаривает внутреннее устройство. Требует правки
 *                     текста человеком.
 *
 * ВНИМАНИЕ. Импортируемые пары получают authority-тег, то есть работают через
 * canonical-override: обходят сценарный гейт и получают уверенность 1.0 при
 * совпадении вопроса на 0.55 по более короткой стороне. На пяти парах риск
 * ложного совпадения был мал, на ста восьмидесяти он существенно выше.
 * Ужесточение override (порог, учёт длинной стороны, окно поиска) обязано
 * идти следующим шагом — иначе вырастет число уверенно неверных ответов.
 *
 * Запуск:
 *   railway run npx tsx scripts/import-operator-answers.ts
 *   railway run npx tsx scripts/import-operator-answers.ts --apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { KnowledgeAudience, PrismaClient } from '@prisma/client';
import { checkClientSafety } from '../src/lib/knowledge/audience';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';

interface CorpusCase {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq?: number;
  confidence?: number;
}

/** Числа, похожие на денежную сумму: 4+ знака, с пробелами-разделителями или без. */
function extractMoney(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b\d[\d\s]{2,}\d\b/gu)) {
    const digits = m[0].replace(/\s+/g, '');
    if (digits.length >= 4) found.add(digits);
  }
  return [...found];
}

function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main(): Promise<void> {
  const corpus: CorpusCase[] = JSON.parse(readFileSync(CORPUS, 'utf8'));
  console.log(`Корпус: ${corpus.length} кейсов`);

  const existing = await prisma.qAPair.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, question: true },
  });
  const existingByQuestion = new Map(existing.map((qa) => [normalizeQuestion(qa.question), qa.id]));
  console.log(`Активных Q&A-пар в базе: ${existing.length}`);

  const toImport: CorpusCase[] = [];
  const needPriceDecision: Array<{ c: CorpusCase; money: string[] }> = [];
  const needSafetyFix: Array<{ c: CorpusCase; violations: string[] }> = [];
  const duplicates: CorpusCase[] = [];

  for (const c of corpus) {
    if (!c.question?.trim() || !c.answer?.trim()) continue;
    if (existingByQuestion.has(normalizeQuestion(c.question))) {
      duplicates.push(c);
      continue;
    }
    const safety = checkClientSafety(c.answer);
    if (!safety.safe) {
      needSafetyFix.push({ c, violations: safety.violations });
      continue;
    }
    const money = extractMoney(c.answer);
    if (money.length > 0 || c.price_dependent) {
      needPriceDecision.push({ c, money });
      continue;
    }
    toImport.push(c);
  }

  console.log('');
  console.log(`Уже есть в базе (пропуск):      ${duplicates.length}`);
  console.log(`К импорту сразу:                ${toImport.length}`);
  console.log(`Ждут решения по ценам:          ${needPriceDecision.length}`);
  console.log(`Ждут правки текста:            ${needSafetyFix.length}`);

  // Отчёт по двум корзинам, требующим человека.
  const lines: string[] = [];
  lines.push('# Импорт операторских ответов: что требует решения');
  lines.push('');
  lines.push(`Корпус: \`${CORPUS}\` — ${corpus.length} кейсов за май 2026.`);
  lines.push('');
  lines.push(`- импортировано без вопросов: **${toImport.length}**`);
  lines.push(`- уже было в базе: ${duplicates.length}`);
  lines.push(`- ждут решения по ценам: **${needPriceDecision.length}**`);
  lines.push(`- ждут правки текста: **${needSafetyFix.length}**`);
  lines.push('');
  lines.push('## Ждут решения по ценам');
  lines.push('');
  lines.push(
    'Корпус собран в мае 2026, действующий прайс датирован 01.01.2026. Если число из ответа оператора расходится с прайсом — какая цифра верна, решает владелец. Скрипт эти пары не импортирует.'
  );
  lines.push('');
  for (const { c, money } of needPriceDecision) {
    lines.push(`### ${c.question}`);
    lines.push('');
    lines.push(
      `\`категория: ${c.category}\` · \`частота: ${c.freq ?? '—'}\` · \`price_dependent: ${c.price_dependent}\`` +
        (money.length ? ` · числа в ответе: **${money.join(', ')}**` : ' · чисел в ответе нет, но кейс помечен как зависящий от цены')
    );
    lines.push('');
    lines.push('> ' + c.answer.split('\n').join('\n> '));
    lines.push('');
  }
  lines.push('## Ждут правки текста');
  lines.push('');
  lines.push(
    'Сигнализация клиентской безопасности сработала: ответ уводит клиента наружу или проговаривает внутреннее устройство. Такие ответы писались коллеге или содержат маршрут мимо бюро — их нужно переписать под клиента, прежде чем импортировать.'
  );
  lines.push('');
  for (const { c, violations } of needSafetyFix) {
    lines.push(`### ${c.question}`);
    lines.push('');
    lines.push(`\`категория: ${c.category}\` · сработало: **${violations.join(', ')}**`);
    lines.push('');
    lines.push('> ' + c.answer.split('\n').join('\n> '));
    lines.push('');
  }

  const out = 'docs/bot-audit/import-operator-answers-pending.md';
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`\nОтчёт по требующим решения: ${out}`);

  if (!apply) {
    console.log('\nЭто предпросмотр. Для импорта первой корзины добавьте --apply');
    return;
  }

  let created = 0;
  for (const c of toImport) {
    await prisma.qAPair.create({
      data: {
        question: c.question.trim(),
        answer: c.answer.trim(),
        status: 'ACTIVE',
        audience: KnowledgeAudience.CLIENT_SAFE,
        metadata: {
          authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
          origin: 'historical-operator',
          importedFrom: CORPUS,
          corpusCategory: c.category,
          corpusFreq: c.freq ?? null,
          corpusConfidence: c.confidence ?? null,
        },
      },
    });
    created++;
  }
  console.log(`\nСоздано пар: ${created}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
