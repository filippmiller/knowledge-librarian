import { describe, it, expect } from 'vitest';
import { questionTermOverlapForTests } from '@/lib/ai/enhanced-answering-engine';

// Regression coverage for the two term-overlap bugs documented in
// .claude/audits/2026-08-05-full-retrieval-audit-claude.md §9. Both audits
// (Grok+Codex) independently flagged this area, and the plan
// (docs/plans/2026-08-05-aurora-knowledge-engine-v2.md, Задача 0.1) requires
// hard-negative cases to call questionTermOverlapForTests directly on real
// question strings rather than reason about the stemming algebra by hand —
// that "algebra, not a live call" methodology is exactly what produced the
// original wrong hypothesis (see the audit section below).

describe('questionTermOverlapForTests — причесать/чесать hard negatives', () => {
  // Audit finding: truncation only strips 1-2 TRAILING characters, so it can
  // never remove a 2-3 letter PREFIX (по-/при-/под-). The four verb forms
  // below were hypothesized to collide via stemming; live calls prove the
  // term sets are disjoint. (The real prod false-positive was traced to an
  // unrelated rare word dominating a short question, not to this stemming.)
  const verbForms = ['почесать', 'чесать', 'причесать', 'подчесать'];

  for (let i = 0; i < verbForms.length; i++) {
    for (let j = i + 1; j < verbForms.length; j++) {
      const a = verbForms[i];
      const b = verbForms[j];
      it(`"${a}" vs "${b}" — disjoint term sets, zero overlap`, () => {
        expect(questionTermOverlapForTests(a, b)).toEqual({ short: 0, long: 0 });
      });
    }
  }

  it('"чесание" (noun, -ание suffix) does not overlap with any verb form', () => {
    for (const verb of verbForms) {
      expect(questionTermOverlapForTests('чесание', verb).short).toBe(0);
    }
  });
});

describe('questionTermOverlapForTests — negation flips the result', () => {
  // extractSearchTerms drops words shorter than 3 letters, which silently
  // swallows "не"/"без" — the exact words that invert Russian polarity.
  // questionTermOverlap has an explicit hasNegation() guard for this; these
  // cases pin that guard against regression.
  it('"Нужен ли оригинал..." vs "Не нужен ли оригинал..." — zero overlap', () => {
    expect(
      questionTermOverlapForTests(
        'Нужен ли оригинал для заверения?',
        'Не нужен ли оригинал для заверения?'
      )
    ).toEqual({ short: 0, long: 0 });
  });

  it('"Можно ли апостилировать..." vs "Можно ли НЕ апостилировать..." — zero overlap', () => {
    expect(
      questionTermOverlapForTests(
        'Можно ли апостилировать в СПб?',
        'Можно ли не апостилировать в СПб?'
      )
    ).toEqual({ short: 0, long: 0 });
  });

  it('"апостиль" vs "апостиль без легализации" — zero overlap ("без" negation)', () => {
    expect(
      questionTermOverlapForTests('нужен апостиль на диплом', 'апостиль без легализации нужен')
    ).toEqual({ short: 0, long: 0 });
  });
});
