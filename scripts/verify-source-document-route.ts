/**
 * Кейсы для ветки «к чему подшивается нотариальный перевод».
 * Запуск: npx tsx scripts/verify-source-document-route.ts
 *
 * Проверяется не только таблица маршрутов, но и сквозной путь: клиентский текст
 * обязан существовать и обязан проходить сигнализацию утечки. Прошлая сессия
 * трижды выкатывала верную ветку, которая до клиента не доходила, и каждый раз
 * это обнаруживалось только запросом к проду.
 */
import {
  resolveSourceDocumentRoute,
  SOURCE_DOCUMENT_ROUTES,
} from '../src/lib/knowledge/source-document-route';
import {
  buildDeterministicGuardrailResultForTests,
  buildInternalGuardrailResultForTests,
} from '../src/lib/ai/enhanced-answering-engine';
import { checkClientSafety } from '../src/lib/knowledge/audience';

let failed = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

/* --- таблица --- */
check('маршрутов ровно три', SOURCE_DOCUMENT_ROUTES.length === 3);
check(
  'оригинал НЕ нужен только на маршруте простой копии',
  SOURCE_DOCUMENT_ROUTES.filter((r) => !r.originalRequired).map((r) => r.key).join() === 'photocopy'
);

/* --- когда ветка обязана срабатывать --- */
const FIRES: Array<[string, 'explain_routes' | 'strict_destination']> = [
  ['К чему подшивается нотариальный перевод — к оригиналу, к копии или к нотариальной копии?', 'explain_routes'],
  ['Нужен ли оригинал документа для нотариального заверения перевода?', 'explain_routes'],
  ['Можно ли сделать нотариальный перевод по скану, без оригинала?', 'explain_routes'],
  ['Я в другом городе, оригинал прислать не могу. Сможете сделать нотариальный перевод?', 'explain_routes'],
  ['Обязательно ли привозить оригинал, если нужен нотариально заверенный перевод?', 'explain_routes'],
  ['Что вы подшиваете к переводу, если я принесу только ксерокопию?', 'explain_routes'],
  // Строгая инстанция названа — «достаточно скана» здесь было бы противоречием
  // фактам. Замечание Kimi к первой версии: исключён был только апостиль.
  ['Можно ли по скану сделать нотариальный перевод для консульства?', 'strict_destination'],
  ['Нужен ли оригинал для нотариального перевода, который пойдёт в суд?', 'strict_destination'],
  ['Нужен ли оригинал для нотариального перевода в консульство?', 'strict_destination'],
  ['Нужен ли оригинал для нотариального перевода на легализацию?', 'strict_destination'],
  ['Нужен ли оригинал для нотариального перевода диплома в ВУЗ?', 'strict_destination'],
];

for (const [q, expected] of FIRES) {
  const v = resolveSourceDocumentRoute(q);
  check(`срабатывает как ${expected}: «${q.slice(0, 58)}…»`, v.kind === expected, `получено ${v.kind}`);
}

/* --- когда ветка обязана МОЛЧАТЬ --- */
const SILENT = [
  // Апостиль — чужая таблица, и там оригинал действительно нужен.
  'Нужен ли оригинал для апостиля на диплом?',
  'Можно ли апостилировать документ по скану?',
  // Про перевод, но не про исходник.
  'Сколько стоит нотариальное заверение перевода?',
  'Как быстро делается нотариальный перевод паспорта?',
  // Про оригинал, но не про нотариальный перевод.
  'Оригинал справки о несудимости выдан в Саратове, что делать?',
  'Вы возвращаете оригиналы документов после выдачи заказа?',
  // Вне темы вовсе.
  'Какие языки вы переводите?',
  // Сознательное сужение: про нотариуса в вопросе ни слова, а просто перевод
  // подшивать не к чему. Молчание здесь — не пробел, а отказ угадывать.
  'Перевод диплома для ВУЗа — обязательно ли нести оригинал?',
];

for (const q of SILENT) {
  const v = resolveSourceDocumentRoute(q);
  check(`молчит: «${q.slice(0, 58)}…»`, v.kind === 'unknown', `получено ${v.kind}`);
}

/* --- сквозной путь: внутренний контур --- */
const internal = buildInternalGuardrailResultForTests(
  'Нужен ли оригинал документа для нотариального заверения перевода?'
);
check('внутренний контур получает детерминированный ответ', internal !== null);
check(
  'внутренний ответ называет все три маршрута',
  Boolean(
    internal &&
      /ксерокопи/iu.test(internal.answer) &&
      /нотариальн[а-яё]*\s+копи/iu.test(internal.answer) &&
      /оригинал/iu.test(internal.answer)
  )
);
check(
  'внутренний ответ НЕ утверждает, что нужен именно оригинал',
  Boolean(internal && !/^Да,\s+оригинал\s+нужен/iu.test(internal.answer))
);

/* --- сквозной путь: клиентский контур --- */
const client = buildDeterministicGuardrailResultForTests(
  'Я в другом городе, оригинал прислать не могу. Сможете сделать нотариальный перевод?',
  'client'
);
check('клиент получает детерминированный ответ', client !== null);
check(
  'клиенту НЕ уходит удерживающая заглушка',
  Boolean(client && !/уточню детали/iu.test(client.answer)),
  client?.answer.slice(0, 80)
);
check(
  'клиентский текст обещает удалённый вариант — это и есть заказ',
  Boolean(client && /удал[её]нн/iu.test(client.answer))
);
check(
  'клиентский текст ставит условие принимающей стороны, а не обещает безусловно',
  Boolean(client && /не\s+требует\s+заверенн/iu.test(client.answer))
);

// Клиентский текст обязан проходить сигнализацию утечки: иначе ответ сам себя
// эскалирует и до клиента не доходит. Это ровно тот дефект, который в прошлой
// сессии обнаружился только на проде.
const safety = client ? checkClientSafety(client.answer) : null;
check(
  'клиентский текст проходит сигнализацию утечки',
  Boolean(safety?.safe),
  safety?.violations.join(', ')
);

const strictClient = buildDeterministicGuardrailResultForTests(
  'Можно ли по скану сделать нотариальный перевод для консульства?',
  'client'
);
check('строгая инстанция: клиент получает ответ', strictClient !== null);
check(
  'строгая инстанция: клиенту НЕ обещан удалённый маршрут',
  Boolean(strictClient && !/оригинал\s+не\s+нужен/iu.test(strictClient.answer))
);
const strictSafety = strictClient ? checkClientSafety(strictClient.answer) : null;
check(
  'строгая инстанция: клиентский текст проходит сигнализацию утечки',
  Boolean(strictSafety?.safe),
  strictSafety?.violations.join(', ')
);

console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
