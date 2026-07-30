/**
 * Кэш ответов: точное совпадение работает, чужой ответ не выдаётся.
 *
 * Главная регрессия — отрицание. Нечёткий проход строил ключ из термов длиной
 * от трёх символов, поэтому «не», «с» и «на» отбрасывались, и вопрос получал
 * ответ на свою противоположность. Проход удалён; тесты ниже фиксируют, что он
 * не вернётся незаметно.
 *
 * Запуск: npx tsx scripts/verify-answer-cache.ts
 */
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import {
  clearAnswerCache,
  getAnswerCacheKey,
  getCachedAnswer,
  storeCachedAnswer,
} from '@/lib/ai/answer-cache';

function makeResult(answer: string): EnhancedAnswerResult {
  return {
    answer,
    confidence: 0.8,
    confidenceLevel: 'high',
    needsClarification: false,
    citations: [],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: '',
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
    answerSource: 'knowledge_base',
    requiresHumanReview: false,
  } as EnhancedAnswerResult;
}

interface Case {
  name: string;
  stored: string;
  asked: string;
  expectHit: boolean;
}

const CASES: Case[] = [
  {
    name: 'точное совпадение отдаёт ответ',
    stored: 'Нужен ли оригинал для нотариального заверения?',
    asked: 'Нужен ли оригинал для нотариального заверения?',
    expectHit: true,
  },
  {
    name: 'регистр и ё не мешают точному совпадению',
    stored: 'Сколько стоит апостиль?',
    asked: 'СКОЛЬКО СТОИТ АПОСТИЛЬ?',
    expectHit: true,
  },
  {
    name: 'ОТРИЦАНИЕ: «не нужен» не должен получить ответ на «нужен»',
    stored: 'Нужен ли оригинал для нотариального заверения?',
    asked: 'Не нужен ли оригинал для нотариального заверения?',
    expectHit: false,
  },
  {
    name: 'ОТРИЦАНИЕ: «можно ли не» не должен получить ответ на «можно ли»',
    stored: 'Можно ли апостилировать справку в Санкт-Петербурге?',
    asked: 'Можно ли не апостилировать справку в Санкт-Петербурге?',
    expectHit: false,
  },
  {
    name: 'НАПРАВЛЕНИЕ: «на английский» не должен получить ответ на «с английского»',
    stored: 'Сколько стоит перевод с английского языка?',
    asked: 'Сколько стоит перевод на английский язык?',
    expectHit: false,
  },
  {
    name: 'другой вопрос той же темы не считается совпадением',
    stored: 'Сколько стоит нотариальное заверение перевода?',
    asked: 'Сколько стоит срочное нотариальное заверение перевода?',
    expectHit: false,
  },
];

let failed = 0;
for (const c of CASES) {
  clearAnswerCache();
  storeCachedAnswer('client', c.stored, makeResult('ОТВЕТ НА СОХРАНЁННЫЙ ВОПРОС'));
  const hit = getCachedAnswer('client', c.asked);
  const ok = Boolean(hit) === c.expectHit;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ожидали попадание=${c.expectHit} получили=${Boolean(hit)}`);
}

// Аудитории не должны пересекаться ни при каких условиях.
clearAnswerCache();
storeCachedAnswer('internal', 'Где подать документы на апостиль?', makeResult('ВНУТРЕННИЙ ОТВЕТ'));
const crossAudience = getCachedAnswer('client', 'Где подать документы на апостиль?');
const crossOk = crossAudience === null;
if (!crossOk) failed++;
console.log(`${crossOk ? 'PASS' : 'FAIL'}  клиент не получает внутренний закэшированный ответ`);
console.log(`      ожидали попадание=false получили=${Boolean(crossAudience)}`);

// Ключ обязан включать аудиторию — иначе разделение держится на одном месте.
const keyOk =
  getAnswerCacheKey('client', 'Вопрос') !== getAnswerCacheKey('internal', 'Вопрос');
if (!keyOk) failed++;
console.log(`${keyOk ? 'PASS' : 'FAIL'}  ключ кэша различает аудитории`);

const total = CASES.length + 2;
console.log(`\n${total - failed}/${total} прошло`);
if (failed > 0) process.exit(1);
