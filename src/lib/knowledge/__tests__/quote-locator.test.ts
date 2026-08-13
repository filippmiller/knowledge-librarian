import { describe, expect, it } from 'vitest';
import { locateQuote, quoteSpansOverlap } from '../quote-locator';

describe('locateQuote — sanity (existing, production-proven behavior)', () => {
  it('находит точное вхождение', () => {
    const match = locateQuote('Правило: разрешено делать X.', 'разрешено делать X');
    expect(match?.kind).toBe('exact');
  });

  it('не находит цитату, которой нет в тексте', () => {
    expect(locateQuote('Правило про X.', 'совсем другой текст')).toBeNull();
  });
});

/**
 * `quoteSpansOverlap` — general-purpose extension of `locateQuote`'s domain
 * (goal-shift continuation, 2026-08-09): "does quote A's span in this text
 * overlap quote B's span" — pulled out as a shared utility rather than
 * duplicated (audited-extraction.ts's focused-retry dedup, and the taint
 * auto-retry's targeted per-block resample both need exactly this check).
 */
describe('quoteSpansOverlap', () => {
  const TEXT = 'Правило: разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды.';

  it('B — буквальная подстрока A -> пересекаются', () => {
    const a = 'разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды';
    const b = 'не более чем на три секунды';
    expect(quoteSpansOverlap(TEXT, a, b)).toBe(true);
  });

  it('B содержит A целиком (обратное направление) -> пересекаются', () => {
    const a = 'разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды';
    const b = 'Правило: разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды.';
    expect(quoteSpansOverlap(TEXT, a, b)).toBe(true);
  });

  it('окна пересекаются частично (сдвинуты, не вложены) -> пересекаются', () => {
    const shifted = [
      'Раздел один. Разрешено прижать ладонь через одежду не более трёх секунд, повторно нельзя.',
      'Разрешено прижать ладонь через одежду не более трёх секунд',
      'не более трёх секунд, повторно нельзя',
    ];
    expect(quoteSpansOverlap(shifted[0], shifted[1], shifted[2])).toBe(true);
  });

  it('окна не пересекаются вовсе -> false', () => {
    const a = 'Правило: разрешено один раз прижать ладонь через чистую одежду';
    const b = 'на три секунды.';
    // Оба реально встречаются в TEXT, но их диапазоны не соприкасаются.
    expect(quoteSpansOverlap(TEXT, a, b)).toBe(false);
  });

  it('одна из цитат не находится в тексте вовсе -> false (нечем доказать пересечение)', () => {
    expect(quoteSpansOverlap(TEXT, 'разрешено один раз', 'этой фразы тут нет вообще')).toBe(false);
  });

  it('идентичные цитаты -> пересекаются (тривиальный случай)', () => {
    const q = 'разрешено один раз прижать ладонь';
    expect(quoteSpansOverlap(TEXT, q, q)).toBe(true);
  });
});
