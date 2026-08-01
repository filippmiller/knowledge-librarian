/**
 * Что модалка ГОВОРИТ оператору при каждой степени совпадения.
 * Запуск: npx tsx scripts/verify-quote-view-copy.tsx
 *
 * Отдельно от `verify-quote-locator.ts`: там проверяется, что поиск нашёл, здесь —
 * что подпись под находкой не обещает больше, чем поиск сделал. Оба дефекта,
 * найденные ревью PR #44, были именно такими: зелёная плашка про «различия только
 * в пробелах» при игнорировании регистра, и «надиктовано голосом» без единого
 * основания. Подпись — часть логики, а не оформление.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentQuoteView } from '../src/components/document-quote-view';

interface Case {
  name: string;
  text: string;
  quote: string | null;
  /** Обязано присутствовать в том, что прочитает оператор. */
  mustSay: string[];
  /** Обязано отсутствовать: обещание, которого поиск не выполнял. */
  mustNotSay: string[];
}

const CASES: Case[] = [
  {
    name: 'дословно',
    text: 'Апостиль на диплом — 3500 рублей за документ.',
    quote: 'Апостиль на диплом — 3500 рублей за документ.',
    mustSay: ['дословно'],
    mustNotSay: ['наугад', 'не полная сверка'],
  },
  {
    name: 'не дословно: подпись перечисляет регистр и ё/е, а не только пробелы',
    text: 'ПРИЁМ ДОКУМЕНТОВ ВЕДЁТСЯ ПО БУДНЯМ ДО 18:00.',
    quote: 'Прием документов ведется по будням до 18:00.',
    mustSay: ['не дословно', 'регистр', 'ё/е'],
    mustNotSay: ['различия только в пробелах'],
  },
  {
    name: 'частично: названо неполной сверкой',
    text: 'Раздел 4. Нотариальное заверение копии документа стоит 260 рублей за страницу, срочное 300.',
    quote:
      'Нотариальное заверение копии документа стоит 260 рублей за страницу, а также включает выезд курьера по городу',
    mustSay: ['начало цитаты', 'не полная сверка'],
    mustNotSay: ['дословно'],
  },
  {
    name: 'фраза встречается дважды: место названо догадкой',
    text: 'Апостиль. Срок оформления — 3 рабочих дня.\n\nИстребование. Срок оформления — 3 рабочих дня.',
    quote: 'Срок оформления — 3 рабочих дня.',
    mustSay: ['ещё раз', 'наугад'],
    mustNotSay: [],
  },
  {
    name: 'не найдено: правка правила названа среди причин',
    text: 'ЯЗЫК\tОБЫЧНЫЙ\tСРОЧНЫЙ\nУКРАИНСКИЙ\t540\t1640',
    quote: 'УКРАИНСКИЙ 540 1640 | ПОЛЬСКИЙ 640 1740 | стоимость указана за страницу перевода',
    mustSay: ['не найден', 'отредактировали после извлечения', 'вручную'],
    mustNotSay: ['дословно'],
  },
  {
    name: 'цитаты нет: сверять нечего, и это сказано',
    text: 'Апостиль на диплом — 3500 рублей за документ.',
    quote: null,
    mustSay: ['не сохранена цитата', 'вручную'],
    mustNotSay: ['найден'],
  },
];

/** Текст, который реально прочитает человек: без тегов и HTML-мнемоник. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ');
}

let failed = 0;

for (const c of CASES) {
  const html = renderToStaticMarkup(<DocumentQuoteView text={c.text} quote={c.quote} />);
  const said = visibleText(html);
  const problems: string[] = [];

  for (const phrase of c.mustSay) {
    if (!said.includes(phrase)) problems.push(`не сказано: «${phrase}»`);
  }
  for (const phrase of c.mustNotSay) {
    if (said.includes(phrase)) problems.push(`сказано лишнее: «${phrase}»`);
  }

  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    for (const p of problems) console.log(`        ${p}`);
    console.log(`        прочитано: ${said.slice(0, 260)}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} подписей соответствуют тому, что сделал поиск`);
process.exit(failed > 0 ? 1 : 0);
