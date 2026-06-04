/**
 * Deterministic unit tests for the pure answer-policy predicates.
 *
 * No DB, no models, no env — these are pure functions. Guards the three bug
 * fixes from the 2026-05-31 live-bot screenshot:
 *   A — clarification turns must NOT escalate to a human (isClarificationTurn)
 *   B — typed text answering a pending clarification must be detected
 *       (looksLikeClarificationReply)
 *   C — junk drafts (fragments / non-answers) must NOT be captured (isDraftableDraft)
 *
 * Run: npx tsx scripts/eval/unit-guards.ts   (exit 0 = all pass, 1 = failure)
 */

import {
  isClarificationTurn,
  looksLikeClarificationReply,
  isDraftableDraft,
} from '../../src/lib/ai/answer-policy';
import { lintRule } from '../../src/lib/document-processing/extraction-lint';
import { selectKeyTerms } from '../../src/lib/knowledge/glossary';

let failures = 0;
function check(name: string, got: boolean, want: boolean): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}  (got ${got}, want ${want})`);
}

// ── A: isClarificationTurn ───────────────────────────────────────────────────
check('A clarif: scenarioClarification → escalate? no', isClarificationTurn({ scenarioClarification: { prompt: 'Где выдан?', options: [] } as unknown as Parameters<typeof isClarificationTurn>[0]['scenarioClarification'], needsClarification: false, clarificationQuestion: undefined }), true);
check('A clarif: needsClarification flag', isClarificationTurn({ scenarioClarification: undefined, needsClarification: true, clarificationQuestion: undefined }), true);
check('A clarif: clarificationQuestion present', isClarificationTurn({ scenarioClarification: undefined, needsClarification: false, clarificationQuestion: { question: 'Какой документ?', options: ['СОР', 'диплом'] } }), true);
check('A clarif: a real answer is NOT a clarification', isClarificationTurn({ scenarioClarification: undefined, needsClarification: false, clarificationQuestion: undefined }), false);

// ── B: looksLikeClarificationReply ───────────────────────────────────────────
check('B reply: "Москва"', looksLikeClarificationReply('Москва'), true);
check('B reply: "Санкт-Петербург"', looksLikeClarificationReply('Санкт-Петербург'), true);
check('B reply: "Ленинградская область"', looksLikeClarificationReply('Ленинградская область'), true);
check('B reply: empty string', looksLikeClarificationReply('   '), false);
check('B reply: a NEW question with "?"', looksLikeClarificationReply('а сколько стоит перевод?'), false);
check('B reply: a NEW question with interrogative', looksLikeClarificationReply('как апостилировать диплом'), false);
check('B reply: long sentence is not a button reply', looksLikeClarificationReply('мне нужно сделать это срочно пожалуйста помогите'), false);

// ── C: isDraftableDraft ──────────────────────────────────────────────────────
check('C draft: fragment "Москва" → reject', isDraftableDraft('Москва', 'Любой ответ'), false);
check('C draft: non-answer "нет данных" → reject', isDraftableDraft('как апостилировать СОР в Москве', 'В базе знаний нет данных по этому вопросу. Уточните, пожалуйста, услугу.'), false);
check('C draft: non-answer "уточните" → reject', isDraftableDraft('какой-то реальный вопрос', 'Пожалуйста, уточните о какой услуге речь.'), false);
check('C draft: real Q + real content → accept', isDraftableDraft('как апостилировать диплом о высшем образовании', 'Апостиль на диплом ставится в Министерстве образования по месту выдачи; госпошлина 2500 руб.'), true);
check('C draft: fragment even with real content → reject', isDraftableDraft('Москва', 'Апостиль ставится в Минюсте по адресу ...'), false);

// ── P3#7: extraction-lint FILLER catches inflected Cyrillic (the \w trap) ─────
const fillerCaught = lintRule({ ruleCode: 'R-T', title: 'x', body: 'Документы принимаются в волшебной атмосфере уюта.', sourceQuote: '' }).some((w) => w.kind === 'filler');
check('P3#7 filler: inflected "волшебной/атмосфере" caught', fillerCaught, true);
const operationalClean = lintRule({ ruleCode: 'R-T', title: 'x', body: 'Апостиль ставится в Минюсте, госпошлина 2500 рублей.', sourceQuote: 'Апостиль ставится в Минюсте, госпошлина 2500 рублей.' }).some((w) => w.kind === 'filler');
check('P3#7 filler: operational text not flagged', operationalClean, false);

// ── Q2: selectKeyTerms keeps short domain acronyms, drops generic short words ─
const kt = selectKeyTerms(['апостиль', 'документы', 'мвд', 'для', 'как']);
check('Q2 keyterms: keeps "мвд" (discriminating acronym)', kt.includes('мвд'), true);
check('Q2 keyterms: keeps "загс"', selectKeyTerms(['загс', 'спб']).includes('загс'), true);
check('Q2 keyterms: keeps long term "документы"', kt.includes('документы'), true);
check('Q2 keyterms: drops generic short "для"', kt.includes('для'), false);
check('Q2 keyterms: drops generic short "как"', kt.includes('как'), false);

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
