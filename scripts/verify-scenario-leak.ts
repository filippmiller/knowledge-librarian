/**
 * Утечка правил одного сценария в чужие ответы.
 * Запуск: npx tsx scripts/verify-scenario-leak.ts
 *
 * Дефект: когда классификатор сценария молчал, фильтр снимался ЦЕЛИКОМ, и
 * правило, верное только внутри апостиля, попадало в любой ответ. Так `R-333`
 * («перевод подшивается к нотариальной копии или апостилированному оригиналу»)
 * оказалось в ответе про посольство, где это ложь.
 *
 * Почему не «при неизвестном сценарии допускать только универсальные правила»:
 * замер показал, что классификатор узнаёт сценарий лишь в 14 случаях из 35
 * вопросов про апостиль. Такое правило отняло бы у 60% апостильных вопросов все
 * 255 апостильных правил. Поэтому признак лексический — слово «апостиль» в
 * вопросе есть всегда, когда речь об этой услуге.
 */
import { lexicallyAdmissibleScenarioRoots } from '../src/lib/knowledge/scenarios';

let failed = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

/** Вопросы, где апостильные правила ДОПУСТИМЫ. */
const ALLOW_APOSTILLE = [
  'Можно ли поставить апостиль на выписку ЕГРЮЛ?',
  'Делаете ли вы апостиль на документы и сколько это занимает?',
  'Нужен апостиль на справку о несудимости из Саратова',
  'На каком языке проставляется апостиль в России?',
  'Можно ли перевести и сам документ, и апостиль на нём?',
  'Сколько стоит консульская легализация диплома?',
  'Нужна ли легализация для документов в ОАЭ?',
];

/** Вопросы, где апостильные правила НЕДОПУСТИМЫ — здесь и была утечка. */
const DENY_APOSTILLE = [
  'Что вы прикладываете к переводу для посольства?',
  'Какой пакет документов нужен для подачи перевода в суд?',
  'Нужен ли оригинал документа для нотариального заверения перевода?',
  'Сколько стоит нотариальное заверение перевода?',
  'В чём разница между ксерокопией и нотариальной копией?',
  'Какие есть варианты заверения перевода?',
  'Сохранится ли при переводе вёрстка документа?',
  'Можно ли оформить заказ удалённо по электронной почте?',
];

for (const q of ALLOW_APOSTILLE) {
  const roots = lexicallyAdmissibleScenarioRoots(q);
  check(`апостильные правила ДОПУЩЕНЫ: «${q.slice(0, 58)}…»`, roots.includes('apostille'), `корни: ${roots.join(', ') || '—'}`);
}

for (const q of DENY_APOSTILLE) {
  const roots = lexicallyAdmissibleScenarioRoots(q);
  check(`апостильные правила ОТСЕЧЕНЫ: «${q.slice(0, 58)}…»`, !roots.includes('apostille'), `корни: ${roots.join(', ')}`);
}

// Полнота на реальном корпусе: все вопросы, где встречается слово «апостиль»,
// обязаны сохранить доступ к апостильным правилам. Иначе лечение хуже болезни.
import { readFileSync } from 'node:fs';
interface Case { question: string }
const corpus: Case[] = JSON.parse(
  readFileSync('docs/email-bot/may2026-knowledge-base-final.json', 'utf8')
);
const apostilleQuestions = corpus.filter((c) => /апостил/i.test(c.question));
const kept = apostilleQuestions.filter((c) =>
  lexicallyAdmissibleScenarioRoots(c.question).includes('apostille')
);
check(
  `корпус: все ${apostilleQuestions.length} вопросов про апостиль сохранили доступ к апостильным правилам`,
  kept.length === apostilleQuestions.length,
  `сохранили ${kept.length}`
);

const nonApostille = corpus.filter((c) => !/апостил|легализац/i.test(c.question));
const leaked = nonApostille.filter((c) =>
  lexicallyAdmissibleScenarioRoots(c.question).includes('apostille')
);
check(
  `корпус: ни один из ${nonApostille.length} вопросов не про апостиль не пропускает апостильные правила`,
  leaked.length === 0,
  `протекло ${leaked.length}: ${leaked.slice(0, 3).map((c) => c.question.slice(0, 50)).join(' | ')}`
);

console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
