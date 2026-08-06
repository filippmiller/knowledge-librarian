/**
 * Закрепление ПРОДОВОЙ политики доставки после переезда её чистой части из
 * `telegram/auto-answer-policy.ts` в `ai/delivery-decision.ts`.
 *
 * Переезд обязан быть чистым: ни одно решение не имеет права измениться. Раньше
 * это проверялось только скриптом `scripts/verify-auto-answer-policy.ts`,
 * который надо запускать руками, — потому что модуль нельзя было импортировать
 * без Prisma. Теперь можно, и те же условия закреплены тестом.
 */

import { describe, expect, it } from 'vitest';
import {
  decideDelivery,
  explainAutoAnswer,
  isAnswerWithheld,
  shouldAutoAnswer,
  shouldSendClarification,
  type AutoAnswerSettings,
  type DeliverableAnswer,
} from '../delivery-decision';
import { DEFAULT_MIN_CONFIDENCE } from '@/lib/telegram/constants';

const ON: AutoAnswerSettings = { enabled: true, minConfidence: DEFAULT_MIN_CONFIDENCE };
const OFF: AutoAnswerSettings = { enabled: false, minConfidence: DEFAULT_MIN_CONFIDENCE };

function answer(overrides: Partial<DeliverableAnswer> = {}): DeliverableAnswer {
  return {
    confidence: 0.6,
    confidenceLevel: 'medium',
    answerSource: 'knowledge_base',
    requiresHumanReview: false,
    ...overrides,
  };
}

const CLARIFICATION = {
  atNodeKey: 'apostille_region',
  prompt: 'Где был выдан документ?',
  options: [{ id: 'spb', label: 'Санкт-Петербург', targetScenarioKey: 'apostille_spb' }],
};

describe('explainAutoAnswer — каждая причина блокировки', () => {
  it('выключенный тумблер важнее качества ответа', () => {
    expect(explainAutoAnswer(answer({ confidence: 1, confidenceLevel: 'high' }), OFF)).toBe(
      'auto_answer_disabled'
    );
  });

  it('требуется проверка человеком', () => {
    expect(explainAutoAnswer(answer({ requiresHumanReview: true }), ON)).toBe(
      'human_review_required'
    );
  });

  it('ответ из общих знаний модели', () => {
    expect(explainAutoAnswer(answer({ answerSource: 'general_ai' }), ON)).toBe('general_ai_source');
  });

  it.each(['low', 'insufficient'] as const)('движок сам оценил ответ как %s', (level) => {
    expect(explainAutoAnswer(answer({ confidenceLevel: level }), ON)).toBe(
      'confidence_level_too_low'
    );
  });

  it('уверенность ниже порога оператора', () => {
    expect(explainAutoAnswer(answer({ confidence: 0.4 }), ON)).toBe('below_min_confidence');
  });

  it('ничто не мешает — null', () => {
    expect(explainAutoAnswer(answer(), ON)).toBeNull();
    expect(shouldAutoAnswer(answer(), ON)).toBe(true);
  });

  it('возвращается ПЕРВАЯ причина, а не самая тяжёлая', () => {
    // Выключенный тумблер проверяется раньше всех прочих условий.
    expect(
      explainAutoAnswer(answer({ requiresHumanReview: true, answerSource: 'general_ai' }), OFF)
    ).toBe('auto_answer_disabled');
  });

  it('порог 0.5: ровно на границе отвечаем (инцидент 30.07 — 52% и 63% medium)', () => {
    expect(explainAutoAnswer(answer({ confidence: 0.5 }), ON)).toBeNull();
    expect(explainAutoAnswer(answer({ confidence: 0.52 }), ON)).toBeNull();
    expect(explainAutoAnswer(answer({ confidence: 0.63 }), ON)).toBeNull();
  });
});

describe('уточнение: сценарное vs голый needsClarification', () => {
  it('только сценарное уточнение считается уточнением', () => {
    expect(shouldSendClarification(answer({ scenarioClarification: CLARIFICATION }))).toBe(true);
    expect(shouldSendClarification(answer())).toBe(false);
  });

  it('сценарное уточнение уходит даже при выключенном автоответе', () => {
    expect(decideDelivery(answer({ scenarioClarification: CLARIFICATION }), OFF)).toBe('clarify');
  });

  it('сценарное уточнение уходит даже при нулевой уверенности', () => {
    expect(
      decideDelivery(
        answer({ confidence: 0, confidenceLevel: 'insufficient', scenarioClarification: CLARIFICATION }),
        ON
      )
    ).toBe('clarify');
  });

  it('слабый ответ без сценарного уточнения уходит оператору, а не мимо шлюза', () => {
    expect(decideDelivery(answer({ confidenceLevel: 'insufficient' }), ON)).toBe('escalate');
  });
});

describe('decideDelivery', () => {
  it.each([
    ['уверенный ответ из базы', answer(), ON, 'answer'],
    ['проверка человеком', answer({ requiresHumanReview: true }), ON, 'escalate'],
    ['общие знания модели', answer({ answerSource: 'general_ai' }), ON, 'escalate'],
    ['ниже порога', answer({ confidence: 0.3 }), ON, 'escalate'],
    ['автоответ выключен', answer(), OFF, 'escalate'],
    ['сценарное уточнение', answer({ scenarioClarification: CLARIFICATION }), ON, 'clarify'],
  ] as const)('%s → %s', (_name, result, settings, expected) => {
    expect(decideDelivery(result, settings)).toBe(expected);
  });
});

describe('isAnswerWithheld — подмена текста только для клиента', () => {
  it.each([
    ['escalate', 'client', true],
    ['escalate', 'internal', false],
    ['answer', 'client', false],
    ['answer', 'internal', false],
    ['clarify', 'client', false],
    ['clarify', 'internal', false],
  ] as const)('%s + %s → %s', (decision, audience, withheld) => {
    expect(isAnswerWithheld(decision, audience)).toBe(withheld);
  });
});
