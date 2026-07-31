/**
 * Ложные тревоги сторожа устаревших цен на реальных ответах бота.
 *
 * `checkStalePrice` задуман как контроль перед отправкой: он объявляет ответ
 * подозрительным, если названная сумма не встречается среди действующих цен
 * ИМЕННО ТОЙ услуги, о которой идёт речь. Цена такого контроля — автономность:
 * каждая ложная тревога уводит верный ответ на человека. Поэтому доля ложных
 * тревог должна быть измерена ДО того, как контроль встанет в путь ответа.
 *
 * Материал — ответы, сохранённые замером автономности на 150 вопросах
 * (`.autonomy-150-results*.jsonl`). Это единственный набор реальных ответов
 * бота с ценами: в ответах операторов сверяемых сумм нет вовсе. Ответы сняты
 * с более старой ревизии движка, и для замера формулировок это было бы
 * возражением — но здесь измеряется поведение СТОРОЖА на русском тексте с
 * ценами, а он от ревизии движка не зависит.
 *
 * Каждое срабатывание печатается целиком: вердикт судьи по тому же ответу
 * стоит рядом, и видно, тревога совпала с настоящей ошибкой или нет.
 *
 * Запуск: railway run npx tsx scripts/audit-stale-price-fp.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import prisma from '../src/lib/db';

interface SavedAnswer {
  question: string;
  answer?: string;
  verdict?: string;
}

function loadAnswers(): SavedAnswer[] {
  const files = readdirSync('docs/bot-audit').filter((f) => f.startsWith('.autonomy-150-results'));
  const seen = new Set<string>();
  const rows: SavedAnswer[] = [];
  for (const file of files) {
    for (const line of readFileSync(`docs/bot-audit/${file}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: SavedAnswer;
      try {
        row = JSON.parse(line) as SavedAnswer;
      } catch {
        continue; // оборванная строка после прерванного прогона
      }
      if (!row.answer) continue;
      // Прогоны шли параллельными воркерами с пересекающимися диапазонами —
      // без дедупликации один и тот же ответ считался бы дважды.
      const key = `${row.question}|${row.answer.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

async function main() {
  const tariffs = await getTariffs('client');
  if (tariffs.length === 0) {
    console.error('Сетка пуста — сверять не с чем. Проверь DATABASE_URL.');
    process.exit(1);
  }

  const answers = loadAnswers();
  let fired = 0;
  let checkedAmounts = 0;

  for (const row of answers) {
    const verdict = checkStalePrice(row.answer ?? '', tariffs);
    checkedAmounts += verdict.checked;
    if (verdict.ok) continue;
    fired += 1;
    console.log(`\n=== ТРЕВОГА · судья по этому ответу: ${row.verdict ?? '—'}`);
    console.log(`ВОПРОС: ${row.question.slice(0, 100)}`);
    for (const f of verdict.findings) {
      console.log(`  ${f.amount} ₽ при услуге «${f.serviceHint}» · в прайсе: ${f.currentAmounts.join(', ')}`);
      console.log(`  предложение: ${f.sentence.slice(0, 160)}`);
    }
  }

  console.log(`\n=== ИТОГ ===`);
  console.log(`ответов проверено: ${answers.length}`);
  console.log(`сумм, до которых контроль вообще дотянулся: ${checkedAmounts}`);
  console.log(`ответов с тревогой: ${fired}`);
  console.log(
    fired === 0
      ? 'Ложных тревог нет — но и подтверждённых находок нет: охват контроля узкий.'
      : 'Каждую тревогу разобрать руками: ложная стоит автономности, верная — денег клиента.'
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
