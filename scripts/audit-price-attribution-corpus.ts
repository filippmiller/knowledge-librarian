/**
 * Ложные тревоги проверки приписки цены — на реальных ответах прода.
 *
 * Проверка блокирует клиенту ответ, противоречащий прайсу. Цена ошибки в другую
 * сторону — заглушённый верный ответ, то есть потеря автономности, ради которой
 * всё делается. Проверять её на выдуманных фразах нельзя: они писались тем же
 * человеком, что и правило.
 *
 * Поэтому берём ответы, которые бот РЕАЛЬНО выдал в прошлых прогонах (они
 * сохранены в отчётах цитатами) и считаем, сколько из них проверка объявила бы
 * противоречием. Каждое срабатывание нужно разобрать глазами: это либо
 * пойманная ошибка, либо ложная тревога.
 *
 * Запуск: npx tsx scripts/audit-price-attribution-corpus.ts
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';

const DIR = join(process.cwd(), 'docs', 'bot-audit');

/** Ответы бота в отчётах записаны цитатой — блоком строк, начинающихся с «> ». */
function extractQuotedAnswers(markdown: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.startsWith('> ')) {
      buffer.push(line.slice(2));
    } else if (line.trim() === '>') {
      buffer.push('');
    } else {
      if (buffer.length) out.push(buffer.join('\n').trim());
      buffer = [];
    }
  }
  if (buffer.length) out.push(buffer.join('\n').trim());
  // Короткие цитаты — это заголовки таблиц и однострочные пометки, не ответы.
  return out.filter((a) => a.length > 120);
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.md'));
let answers = 0;
let withPrices = 0;
let flagged = 0;

for (const file of files) {
  const text = readFileSync(join(DIR, file), 'utf8');
  for (const answer of extractQuotedAnswers(text)) {
    answers += 1;
    const verdict = checkCertificationPriceAttribution(answer);
    if (verdict.checked > 0) withPrices += 1;
    if (verdict.consistent) continue;
    flagged += 1;
    console.log(`\n────── ${file}`);
    for (const c of verdict.contradictions) {
      console.log(`  услуга : ${c.serviceLabel}`);
      console.log(`  назвал : ${c.claimed}`);
      console.log(`  прайс  : ${c.expected}`);
      console.log(`  фраза  : ${c.sentence}`);
    }
  }
}

console.log(
  `\nответов разобрано: ${answers}; из них с привязанной ценой заверения: ${withPrices}; объявлено противоречием: ${flagged}`
);
