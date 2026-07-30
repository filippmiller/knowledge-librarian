/**
 * Regression check for the Telegram delivery policy.
 *
 * Reproduces the 2026-07-30 incident: every question was escalated to an
 * operator because no AISettings row existed, and scenario clarifications were
 * escalated too instead of being asked back to the user.
 *
 * Run: npx tsx scripts/verify-auto-answer-policy.ts
 */
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import {
  decideDelivery,
  type AutoAnswerSettings,
  type DeliveryDecision,
} from '@/lib/telegram/auto-answer-policy';
import { DEFAULT_MIN_CONFIDENCE } from '@/lib/telegram/constants';

const ON: AutoAnswerSettings = { enabled: true, minConfidence: DEFAULT_MIN_CONFIDENCE };
const OFF: AutoAnswerSettings = { enabled: false, minConfidence: DEFAULT_MIN_CONFIDENCE };

function result(overrides: Partial<EnhancedAnswerResult>): EnhancedAnswerResult {
  return {
    answer: 'текст ответа',
    confidence: 0.6,
    confidenceLevel: 'medium',
    needsClarification: false,
    citations: [],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: 'q',
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
    answerSource: 'knowledge_base',
    requiresHumanReview: false,
    ...overrides,
  };
}

const clarification = {
  atNodeKey: 'apostille_region',
  prompt: 'Где был выдан документ?',
  options: [
    { id: 'spb', label: 'Санкт-Петербург', targetScenarioKey: 'apostille_spb' },
    { id: 'lo', label: 'Ленинградская область', targetScenarioKey: 'apostille_lo' },
  ],
};

const cases: Array<{
  name: string;
  settings: AutoAnswerSettings;
  result: EnhancedAnswerResult;
  expected: DeliveryDecision;
}> = [
  {
    name: 'график Минюста, 63% medium из базы знаний → отвечаем (инцидент 30.07)',
    settings: ON,
    result: result({ confidence: 0.63, confidenceLevel: 'medium' }),
    expected: 'answer',
  },
  {
    name: 'повторное свидетельство, 52% medium из базы знаний → отвечаем (инцидент 30.07)',
    settings: ON,
    result: result({ confidence: 0.52, confidenceLevel: 'medium' }),
    expected: 'answer',
  },
  {
    name: 'канонический Q&A оператора, 100% high → отвечаем',
    settings: ON,
    result: result({ confidence: 1.0, confidenceLevel: 'high' }),
    expected: 'answer',
  },
  {
    name: 'сильное совпадение QAPair: уровень medium при сыром скоре 0.6 → отвечаем',
    settings: ON,
    result: result({ confidence: 0.6, confidenceLevel: 'medium' }),
    expected: 'answer',
  },
  {
    name: 'уточнение сценария при выключенном автоответе → спрашиваем клиента (инцидент 30.07)',
    settings: OFF,
    result: result({ confidence: 0, confidenceLevel: 'insufficient', scenarioClarification: clarification }),
    expected: 'clarify',
  },
  {
    name: 'уточнение сценария при включённом автоответе → спрашиваем клиента',
    settings: ON,
    result: result({ confidence: 0, confidenceLevel: 'insufficient', scenarioClarification: clarification }),
    expected: 'clarify',
  },
  {
    name: 'общие знания ИИ → оператору даже при высокой уверенности',
    settings: ON,
    result: result({ confidence: 0.9, confidenceLevel: 'high', answerSource: 'general_ai' }),
    expected: 'escalate',
  },
  {
    name: 'ответ помечен на ручную проверку → оператору',
    settings: ON,
    result: result({ confidence: 0.9, confidenceLevel: 'high', requiresHumanReview: true }),
    expected: 'escalate',
  },
  {
    name: 'insufficient без вариантов уточнения → оператору',
    settings: ON,
    result: result({ confidence: 0, confidenceLevel: 'insufficient' }),
    expected: 'escalate',
  },
  {
    name: 'needsClarification без кнопок не обходит порог уверенности → оператору',
    settings: ON,
    result: result({ confidence: 0.35, confidenceLevel: 'low', needsClarification: true }),
    expected: 'escalate',
  },
  {
    name: 'автоответ выключен: фактический ответ уходит оператору',
    settings: OFF,
    result: result({ confidence: 0.9, confidenceLevel: 'high' }),
    expected: 'escalate',
  },
];

let failed = 0;
for (const c of cases) {
  const actual = decideDelivery(c.result, c.settings);
  const ok = actual === c.expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ожидали=${c.expected} получили=${actual}`);
}

console.log(`\n${cases.length - failed}/${cases.length} прошло`);
if (failed > 0) process.exit(1);
