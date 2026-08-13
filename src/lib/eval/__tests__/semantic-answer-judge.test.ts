import { describe, expect, it } from 'vitest';
import {
  buildJudgePromptMessages,
  interpretJudgeResponse,
  type RawJudgeVerdict,
} from '../semantic-answer-judge';

/**
 * Goal-shift continuation (2026-08-09), Task 22. The deterministic grader
 * (grade-aurora-fixture.ts) only proves structural correctness -- right
 * rule selected, no unsupported numbers, right disposition. It cannot know
 * whether the PROSE is actually right. This is the missing layer: reads
 * expected_answer ONLY after the engine already produced its answer (the
 * caller enforces that ordering, not this module -- see run-aurora-fixture.ts
 * usage), and never influences engine execution. Prompt-building and
 * response-interpretation are pure/tested without a network call, same
 * split as every other LLM-wrapper in this codebase.
 */

describe('buildJudgePromptMessages — pure, no network', () => {
  it('несёт вопрос, реальный ответ, evidence и ожидаемый ответ', () => {
    const messages = buildJudgePromptMessages({
      question: 'Сколько секунд можно тереть?',
      actualAnswer: 'Не более 15 секунд подряд.',
      selectedEvidenceStatements: ['Непрерывное почёсывание допускается не дольше 15 секунд.'],
      expectedAnswer: 'Не дольше 15 секунд, затем пауза 30 секунд.',
    });
    const user = messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('Сколько секунд можно тереть?');
    expect(user.content).toContain('Не более 15 секунд подряд.');
    expect(user.content).toContain('Непрерывное почёсывание допускается не дольше 15 секунд.');
    expect(user.content).toContain('Не дольше 15 секунд, затем пауза 30 секунд.');
  });
});

describe('interpretJudgeResponse — pure, no network', () => {
  const raw = (overrides: Partial<RawJudgeVerdict> = {}): RawJudgeVerdict => ({
    verdict: 'CORRECT',
    reasoning: 'ответ совпадает с ожидаемым по сути',
    confidence: 0.9,
    ...overrides,
  });

  it('пропускает verdict/reasoning/confidence как есть', () => {
    const result = interpretJudgeResponse(raw({ verdict: 'PARTIALLY_CORRECT', confidence: 0.6 }), {
      provider: 'anthropic',
      model: 'claude-test',
      promptVersion: 'v1',
    });
    expect(result.verdict).toBe('PARTIALLY_CORRECT');
    expect(result.confidence).toBe(0.6);
  });

  it('несёт provider/model/promptVersion судьи в результате — обязательная провенанс', () => {
    const result = interpretJudgeResponse(raw(), {
      provider: 'anthropic',
      model: 'claude-test-judge',
      promptVersion: 'judge-v1',
    });
    expect(result.judgeProvider).toBe('anthropic');
    expect(result.judgeModel).toBe('claude-test-judge');
    expect(result.judgePromptVersion).toBe('judge-v1');
  });

  it.each(['CORRECT', 'PARTIALLY_CORRECT', 'INCORRECT', 'UNSUPPORTED', 'OVERCLAIMED'] as const)(
    'принимает все пять вердиктов (%s)',
    (verdict) => {
      const result = interpretJudgeResponse(raw({ verdict }), { provider: 'p', model: 'm', promptVersion: 'v' });
      expect(result.verdict).toBe(verdict);
    }
  );
});
