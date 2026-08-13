import { describe, expect, it } from 'vitest';
import { resolveMainPathAnswerSource } from '@/lib/ai/answer-source';

describe('resolveMainPathAnswerSource — метка отражает опору, а не ветку кода', () => {
  it('отказ по insufficient — это не knowledge_base', () => {
    expect(resolveMainPathAnswerSource('insufficient')).toBe('none');
  });

  it.each(['high', 'medium', 'low'] as const)(
    'уровень %s при найденных цитатах — knowledge_base',
    (level) => {
      expect(resolveMainPathAnswerSource(level)).toBe('knowledge_base');
    }
  );

  it('не смотрит в текст ответа: high остаётся knowledge_base даже если в тексте «нет данных»', () => {
    // Функция нарочно не принимает текст. Если когда-нибудь начнёт —
    // этот кейс напомнит, что подстрока «нет данных» подгоняет метрику.
    expect(resolveMainPathAnswerSource('high')).toBe('knowledge_base');
    expect(resolveMainPathAnswerSource('insufficient')).toBe('none');
  });
});
