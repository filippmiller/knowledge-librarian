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

let failures = 0;
function check(name: string, got: boolean, want: boolean): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗ FAIL'}  ${name}  (got ${got}, want ${want})`);
}

// ── A: isClarificationTurn ───────────────────────────────────────────────────
check('A clarif: scenarioClarification → escalate? no', isClarificationTurn({ scenarioClarification: { prompt: 'Где выдан?', options: [] } as any, needsClarification: false, clarificationQuestion: undefined }), true);
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

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
