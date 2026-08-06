import { describe, expect, it } from 'vitest';
import { applicabilityProfileSchema } from '../profile';
import { KNOWLEDGE_UNIT_KINDS } from '../kinds';

const REVIEWED_AT = '2026-08-06T10:00:00Z';
const SCOPED_SCENARIO = { state: 'SCOPED', include: ['apostille.zags.spb'] };

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'PROCEDURE_STEP',
    facets: { scenario: SCOPED_SCENARIO },
    audience: 'CLIENT_SAFE',
    reviewStatus: 'UNCLASSIFIED',
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  };
}

function issuePaths(input: unknown): string[] {
  const result = applicabilityProfileSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

function issueCodes(input: unknown): string[] {
  const result = applicabilityProfileSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.code);
}

function isValid(input: unknown): boolean {
  return applicabilityProfileSchema.safeParse(input).success;
}

/**
 * Таблица легальности truth table §5.1 целиком — все 2×2×2 комбинации, а не
 * только счастливый путь. Биконъюнкция сама по себе разрешила бы строки 6 и 8
 * (UNCLASSIFIED с ОДНИМ заполненным аудит-полем), поэтому §5.1 усиливает её, и
 * тест обязан ловить именно усиление.
 */
const REVIEW_LEGALITY = [
  { reviewStatus: 'UNCLASSIFIED', reviewedBy: null, reviewedAt: null, invalidPaths: [] },
  { reviewStatus: 'REVIEWED', reviewedBy: 'anna', reviewedAt: REVIEWED_AT, invalidPaths: [] },
  {
    reviewStatus: 'REVIEWED',
    reviewedBy: null,
    reviewedAt: REVIEWED_AT,
    invalidPaths: ['reviewedBy'],
  },
  { reviewStatus: 'REVIEWED', reviewedBy: 'anna', reviewedAt: null, invalidPaths: ['reviewedAt'] },
  {
    reviewStatus: 'REVIEWED',
    reviewedBy: null,
    reviewedAt: null,
    invalidPaths: ['reviewedBy', 'reviewedAt'],
  },
  {
    reviewStatus: 'UNCLASSIFIED',
    reviewedBy: 'anna',
    reviewedAt: null,
    invalidPaths: ['reviewedBy'],
  },
  {
    reviewStatus: 'UNCLASSIFIED',
    reviewedBy: 'anna',
    reviewedAt: REVIEWED_AT,
    invalidPaths: ['reviewedBy', 'reviewedAt'],
  },
  {
    reviewStatus: 'UNCLASSIFIED',
    reviewedBy: null,
    reviewedAt: REVIEWED_AT,
    invalidPaths: ['reviewedAt'],
  },
] as const;

describe('reviewStatus × reviewedBy × reviewedAt — truth table §5.1', () => {
  it('таблица покрывает все 8 комбинаций, без пропущенных строк', () => {
    const seen = new Set(
      REVIEW_LEGALITY.map(
        (row) =>
          `${row.reviewStatus}|${row.reviewedBy === null ? 'null' : 'set'}|${
            row.reviewedAt === null ? 'null' : 'set'
          }`
      )
    );
    expect(seen.size).toBe(8);
  });

  it.each(REVIEW_LEGALITY)(
    '$reviewStatus / by=$reviewedBy / at=$reviewedAt',
    ({ reviewStatus, reviewedBy, reviewedAt, invalidPaths }) => {
      const input = profile({ reviewStatus, reviewedBy, reviewedAt });
      if (invalidPaths.length === 0) {
        expect(isValid(input)).toBe(true);
        return;
      }
      expect(isValid(input)).toBe(false);
      expect(issuePaths(input).sort()).toEqual([...invalidPaths].sort());
    }
  );

  it('reviewedAt — ISO-8601 строка, а не Date и не голая дата', () => {
    const reviewed = (reviewedAt: unknown) =>
      isValid(profile({ reviewStatus: 'REVIEWED', reviewedBy: 'anna', reviewedAt }));

    expect(reviewed(REVIEWED_AT)).toBe(true);
    expect(reviewed('2026-08-06T13:00:00+03:00')).toBe(true);
    expect(reviewed(new Date(REVIEWED_AT))).toBe(false);
    expect(reviewed('2026-08-06')).toBe(false);
    expect(reviewed(1786000000000)).toBe(false);
  });

  it.each(['', ' ', '\t', '   '])(
    'reviewedBy=%j не считается подтверждением',
    (reviewedBy) => {
      expect(
        isValid(profile({ reviewStatus: 'REVIEWED', reviewedBy, reviewedAt: REVIEWED_AT }))
      ).toBe(false);
    }
  );

  it('пробельный reviewedBy закрыт и на пофасетном GLOBAL — схема одна', () => {
    expect(
      isValid(
        profile({
          facets: { scenario: { state: 'GLOBAL', reviewedBy: '   ', reviewedAt: REVIEWED_AT } },
          reviewStatus: 'REVIEWED',
          reviewedBy: 'anna',
          reviewedAt: REVIEWED_AT,
        })
      )
    ).toBe(false);
  });
});

describe('NOT_APPLICABLE ≠ UNKNOWN ≠ GLOBAL', () => {
  it('применимая фасета обязана присутствовать явным состоянием', () => {
    // Ключ отсутствует — это утверждение «ось не действует», а для
    // PROCEDURE_STEP scenario действует, поэтому профиль невалиден.
    const input = profile({ facets: {} });
    expect(isValid(input)).toBe(false);
    expect(issuePaths(input)).toContain('facets.scenario');
  });

  it('неприменимая фасета обязана отсутствовать — UNKNOWN на ней запрещён', () => {
    const input = profile({
      facets: { scenario: SCOPED_SCENARIO, service: { state: 'UNKNOWN' } },
    });
    expect(isValid(input)).toBe(false);
    expect(issuePaths(input)).toContain('facets.service');
  });

  it('одна и та же фасета: отсутствие легально для одного kind и нелегально для другого', () => {
    // service отсутствует
    expect(isValid(profile({ kind: 'PROCEDURE_STEP', facets: { scenario: SCOPED_SCENARIO } }))).toBe(
      true
    );
    expect(isValid(profile({ kind: 'PRICE_RULE', facets: { scenario: SCOPED_SCENARIO } }))).toBe(
      false
    );
    // ...и наоборот: SCOPED-значение легально там, где ось применима
    expect(
      isValid(
        profile({
          kind: 'PRICE_RULE',
          facets: {
            scenario: SCOPED_SCENARIO,
            service: { state: 'SCOPED', include: ['apostille.zags'] },
          },
        })
      )
    ).toBe(true);
    expect(
      isValid(
        profile({
          kind: 'PROCEDURE_STEP',
          facets: {
            scenario: SCOPED_SCENARIO,
            service: { state: 'SCOPED', include: ['apostille.zags'] },
          },
        })
      )
    ).toBe(false);
  });

  it('UNKNOWN на обязательной фасете запрещён — и это ДРУГАЯ ошибка, чем неприменимость', () => {
    const unknownRequired = profile({ facets: { scenario: { state: 'UNKNOWN' } } });
    expect(isValid(unknownRequired)).toBe(false);
    expect(issuePaths(unknownRequired)).toEqual(['facets.scenario']);

    const notApplicable = profile({
      facets: { scenario: SCOPED_SCENARIO, deliveryCity: { state: 'UNKNOWN' } },
    });
    const message = applicabilityProfileSchema.safeParse(notApplicable).error?.issues[0]?.message;
    expect(message).toMatch(/не применима/);

    const requiredMessage = applicabilityProfileSchema.safeParse(unknownRequired).error?.issues[0]
      ?.message;
    expect(requiredMessage).toMatch(/обязательна/);
  });

  it('GLOBAL — не то же самое, что UNKNOWN: это подтверждённый wildcard', () => {
    const global = {
      state: 'GLOBAL',
      reviewedBy: 'anna',
      reviewedAt: REVIEWED_AT,
    };
    expect(
      isValid(
        profile({
          facets: { scenario: global },
          reviewStatus: 'REVIEWED',
          reviewedBy: 'anna',
          reviewedAt: REVIEWED_AT,
        })
      )
    ).toBe(true);

    // GLOBAL на неподтверждённом unit'е — «применимо ко всему» без человека.
    const unreviewed = profile({ facets: { scenario: global } });
    expect(isValid(unreviewed)).toBe(false);
    expect(issuePaths(unreviewed)).toContain('facets.scenario');
  });

  it('SCOPED с пустым include не может подменить GLOBAL в обход ревью', () => {
    expect(isValid(profile({ facets: { scenario: { state: 'SCOPED', include: [] } } }))).toBe(false);
    expect(
      isValid(
        profile({
          facets: { scenario: { state: 'SCOPED', include: [], exclude: ['apostille.zags.spb'] } },
        })
      )
    ).toBe(false);
  });

  it('одно значение не может быть одновременно в include и exclude', () => {
    expect(
      isValid(
        profile({
          facets: {
            scenario: {
              state: 'SCOPED',
              include: ['apostille.zags.spb'],
              exclude: ['apostille.zags.spb'],
            },
          },
        })
      )
    ).toBe(false);
  });

  it('состояние вне трёх объявленных отвергается', () => {
    expect(isValid(profile({ facets: { scenario: { state: 'ANY' } } }))).toBe(false);
    expect(isValid(profile({ facets: { scenario: { state: 'NOT_APPLICABLE' } } }))).toBe(false);
  });
});

describe('неизвестный ключ фасеты — ошибка валидации, не no-op', () => {
  it('опечатка в имени фасеты валит разбор', () => {
    const input = profile({
      facets: { scenario: SCOPED_SCENARIO, issuerCountry: { state: 'UNKNOWN' } },
    });
    expect(isValid(input)).toBe(false);
    expect(issueCodes(input)).toContain('unrecognized_keys');
  });

  it('неизвестный ключ не выживает в разобранном значении', () => {
    const result = applicabilityProfileSchema.safeParse(
      profile({ facets: { scenario: SCOPED_SCENARIO, issuerCountry: { state: 'UNKNOWN' } } })
    );
    expect(result.success).toBe(false);
  });

  it('неизвестное поле профиля тоже отвергается', () => {
    expect(isValid(profile({ scopeStatus: 'GLOBAL' }))).toBe(false);
  });
});

describe('обязательные фасеты — безусловны, а не зависят от audience', () => {
  it.each(['CLIENT_SAFE', 'INTERNAL_ONLY'])(
    'UNKNOWN на обязательной фасете запрещён при audience=%s',
    (audience) => {
      expect(isValid(profile({ audience, facets: { scenario: { state: 'UNKNOWN' } } }))).toBe(false);
    }
  );

  it('DELIVERY_RULE требует и scenario, и deliveryCity — не одно вместо другого', () => {
    const withBoth = profile({
      kind: 'DELIVERY_RULE',
      facets: { scenario: SCOPED_SCENARIO, deliveryCity: { state: 'SCOPED', include: ['spb'] } },
    });
    expect(isValid(withBoth)).toBe(true);

    expect(
      isValid(
        profile({
          kind: 'DELIVERY_RULE',
          facets: { scenario: SCOPED_SCENARIO, deliveryCity: { state: 'UNKNOWN' } },
        })
      )
    ).toBe(false);
    expect(
      isValid(
        profile({
          kind: 'DELIVERY_RULE',
          facets: { scenario: { state: 'UNKNOWN' }, deliveryCity: { state: 'SCOPED', include: ['spb'] } },
        })
      )
    ).toBe(false);
  });
});

describe('audience — действующая семантика, без CLIENT/INTERNAL/BOTH', () => {
  it.each(['CLIENT_SAFE', 'INTERNAL_ONLY'])('%s принимается', (audience) => {
    expect(isValid(profile({ audience }))).toBe(true);
  });

  it.each(['CLIENT', 'INTERNAL', 'BOTH', null, undefined])('%s отвергается', (audience) => {
    expect(isValid(profile({ audience }))).toBe(false);
  });

  it('audience обязателен для КАЖДОГО kind, включая тот, у которого нет фасет', () => {
    const withoutAudience = {
      kind: 'TERM_DEFINITION',
      facets: {},
      reviewStatus: 'REVIEWED',
      reviewedBy: 'anna',
      reviewedAt: REVIEWED_AT,
    };
    expect(isValid(withoutAudience)).toBe(false);
  });
});

describe('TERM_DEFINITION — нефасетные обязательные поля truth table §2.1', () => {
  it('валиден без единой фасеты, если подтверждён человеком', () => {
    expect(
      isValid(
        profile({
          kind: 'TERM_DEFINITION',
          facets: {},
          reviewStatus: 'REVIEWED',
          reviewedBy: 'anna',
          reviewedAt: REVIEWED_AT,
        })
      )
    ).toBe(true);
  });

  it('без reviewStatus=REVIEWED невалиден', () => {
    const input = profile({ kind: 'TERM_DEFINITION', facets: {} });
    expect(isValid(input)).toBe(false);
    expect(issuePaths(input)).toContain('reviewStatus');
  });

  it('пустой applicableFacets не означает «можно положить UNKNOWN»', () => {
    expect(
      isValid(
        profile({
          kind: 'TERM_DEFINITION',
          facets: { scenario: { state: 'UNKNOWN' } },
          reviewStatus: 'REVIEWED',
          reviewedBy: 'anna',
          reviewedAt: REVIEWED_AT,
        })
      )
    ).toBe(false);
  });
});

describe('каждый kind реестра имеет хотя бы один валидный профиль', () => {
  const facetsByKind: Record<string, Record<string, unknown>> = {
    PROCEDURE_STEP: { scenario: SCOPED_SCENARIO },
    EXCEPTION_RULE: { scenario: SCOPED_SCENARIO },
    TERM_DEFINITION: {},
    DELIVERY_RULE: {
      scenario: SCOPED_SCENARIO,
      deliveryCity: { state: 'SCOPED', include: ['spb'] },
    },
    PRICE_RULE: {
      scenario: SCOPED_SCENARIO,
      service: { state: 'SCOPED', include: ['apostille.zags'] },
    },
  };

  it.each([...KNOWLEDGE_UNIT_KINDS])('%s', (kind) => {
    expect(
      isValid(
        profile({
          kind,
          facets: facetsByKind[kind],
          reviewStatus: 'REVIEWED',
          reviewedBy: 'anna',
          reviewedAt: REVIEWED_AT,
        })
      )
    ).toBe(true);
  });
});
