import { describe, expect, it } from 'vitest';
import {
  evaluateUnitEligibility,
  UNIT_LIFECYCLE_STATUSES,
  type RequestAudience,
} from '../eligibility';
import type { FacetMap } from '../facets';
import { KNOWLEDGE_UNIT_KINDS, requiredFacetsOf, type KnowledgeUnitKind } from '../kinds';
import { applicabilityProfileSchema, type ProfileAudience } from '../profile';
import { ELIGIBILITY_REASON_CODES } from '../reasons';
import { buildProfile, buildRequestContext, buildUnit, scoped, REVIEWED, UNCLASSIFIED } from './helpers';

/**
 * ВЛАДЕЛЕЦ РЕШЕНИЯ: `evaluateUnitEligibility`.
 * ПОКРЫВАЕТ: обязательные поля по `kind` (truth table §2 / §2.1) в их
 * РАНТАЙМОВОЙ части, матрицу `audience` (§3.2) и гейт `reviewStatus` (§5, §5.1),
 * плюс статус, окно действия и ревизию источника — то, что план перечисляет
 * для этой функции.
 *
 * Осевые матрицы §3.1/§3.3/§3.4 здесь не прогоняются: их владелец —
 * `evaluateScope` (`scope.test.ts`).
 */

/** Полный набор обязательных фасет в состоянии SCOPED — «всё заполнено». */
function filledFacets(kind: KnowledgeUnitKind): FacetMap {
  const facets: Record<string, unknown> = {};
  for (const facet of requiredFacetsOf(kind)) {
    facets[facet] = scoped([
      facet === 'scenario' ? 'apostille' : facet === 'deliveryCity' ? 'spb' : 'apostille.zags',
    ]);
  }
  return facets as FacetMap;
}

describe('§3.2 audience — матрица (профиль × канал запроса)', () => {
  const cases: ReadonlyArray<{
    profileAudience: ProfileAudience | null;
    requestAudience: RequestAudience;
    eligible: boolean;
    reason?: string;
  }> = [
    { profileAudience: 'INTERNAL_ONLY', requestAudience: 'internal', eligible: true },
    {
      profileAudience: 'INTERNAL_ONLY',
      requestAudience: 'client',
      eligible: false,
      reason: 'audience_internal_only_for_client',
    },
    { profileAudience: 'CLIENT_SAFE', requestAudience: 'internal', eligible: true },
    { profileAudience: 'CLIENT_SAFE', requestAudience: 'client', eligible: true },
    {
      profileAudience: null,
      requestAudience: 'internal',
      eligible: true,
      reason: 'audience_missing_for_internal',
    },
    {
      profileAudience: null,
      requestAudience: 'client',
      eligible: false,
      reason: 'audience_missing_for_client',
    },
  ];

  it.each(cases)(
    'профиль=$profileAudience × запрос=$requestAudience → eligible=$eligible',
    ({ profileAudience, requestAudience, eligible, reason }) => {
      const decision = evaluateUnitEligibility(
        buildUnit({ audience: profileAudience }),
        buildRequestContext({ audience: requestAudience })
      );

      expect(decision.eligible).toBe(eligible);
      if (reason !== undefined) {
        expect(decision.reasons).toContain(reason);
      }
      if (!eligible) {
        expect(decision.blockingReasons).toContain(reason);
        expect(decision.autoAnswerAllowed).toBe(false);
      }
    }
  );

  it('пустая аудитория для оператора — UNKNOWN, а не тихое «ок»: кандидат живёт, автоответ нет', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ audience: null }),
      buildRequestContext({ audience: 'internal' })
    );

    expect(decision.eligible).toBe(true);
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.autoAnswerAllowed).toBe(false);
  });

  it('строка «не заполнено на профиле» недостижима через типизированный профиль — это и есть баг миграции', () => {
    // §3.2 прямо говорит, что строка описывает нарушенное ограничение, а не
    // легальный путь. Проверяем, что легального пути действительно нет.
    const profile = buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille']) });
    expect(applicabilityProfileSchema.safeParse({ ...profile, audience: null }).success).toBe(false);
  });
});

describe('§5 / §5.1 reviewStatus — гейт на входе, а не результат матрицы', () => {
  it('UNCLASSIFIED в клиентском канале исключается ДО §3', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ review: UNCLASSIFIED }),
      buildRequestContext({ audience: 'client' })
    );

    expect(decision.eligible).toBe(false);
    expect(decision.blockingReasons).toContain('review_unclassified_for_client');
  });

  it('UNCLASSIFIED во внутреннем канале участвует — оператор и есть линия защиты', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ review: UNCLASSIFIED }),
      buildRequestContext({ audience: 'internal' })
    );

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toContain('review_unclassified_for_internal');
    expect(decision.requiresHumanReview).toBe(true);
  });

  it('REVIEWED-профиль в обоих каналах проходит без следов ревью в причинах', () => {
    for (const audience of ['client', 'internal'] as const) {
      const decision = evaluateUnitEligibility(
        buildUnit({ review: REVIEWED }),
        buildRequestContext({ audience })
      );
      expect(decision.eligible).toBe(true);
      expect(decision.reasons).not.toContain('review_unclassified_for_client');
      expect(decision.reasons).not.toContain('review_unclassified_for_internal');
    }
  });

  it('гейт смотрит на reviewStatus, а не на наличие reviewedBy', () => {
    // §5.1: «единственная точка решения — статус». Тройка полей связана
    // инвариантом, и проверять надо статус, иначе появится второе прочтение.
    const decision = evaluateUnitEligibility(
      buildUnit({ review: UNCLASSIFIED }),
      buildRequestContext({ audience: 'client' })
    );
    expect(decision.blockingReasons).toEqual(['review_unclassified_for_client']);
  });
});

describe('§2 / §2.1 — обязательные фасеты по kind в рантайме', () => {
  it.each(KNOWLEDGE_UNIT_KINDS)(
    '%s: все обязательные оси заполнены → годен и в клиентский автоответ',
    (kind) => {
      const decision = evaluateUnitEligibility(
        buildUnit({ kind, facets: filledFacets(kind) }),
        buildRequestContext({ audience: 'client' })
      );

      expect(decision.eligible).toBe(true);
      expect(decision.autoAnswerAllowed).toBe(true);
      expect(decision.unknownRequiredFacets).toEqual([]);
      expect(decision.absentRequiredFacets).toEqual([]);
    }
  );

  const kindsWithRequired = KNOWLEDGE_UNIT_KINDS.filter((kind) => requiredFacetsOf(kind).length > 0);

  it.each(kindsWithRequired)(
    '%s: обязательная ось в UNKNOWN блокирует КЛИЕНТСКИЙ автоответ, но не выбрасывает unit',
    (kind) => {
      const facets = { ...filledFacets(kind) } as Record<string, unknown>;
      const [firstRequired] = requiredFacetsOf(kind);
      facets[firstRequired] = { state: 'UNKNOWN' };

      const decision = evaluateUnitEligibility(
        buildUnit({ kind, facets: facets as FacetMap }),
        buildRequestContext({ audience: 'client' })
      );

      expect(decision.eligible).toBe(true);
      expect(decision.autoAnswerAllowed).toBe(false);
      expect(decision.requiresHumanReview).toBe(true);
      expect(decision.unknownRequiredFacets).toContain(firstRequired);
      expect(decision.reasons).toContain('required_facet_unknown');
      expect(decision.blockingReasons).toEqual([]);
    }
  );

  it.each(kindsWithRequired)(
    '%s: та же ось в UNKNOWN во ВНУТРЕННЕМ канале автоответ не блокирует, но след оставляет',
    (kind) => {
      const facets = { ...filledFacets(kind) } as Record<string, unknown>;
      const [firstRequired] = requiredFacetsOf(kind);
      facets[firstRequired] = { state: 'UNKNOWN' };

      const decision = evaluateUnitEligibility(
        buildUnit({ kind, facets: facets as FacetMap }),
        buildRequestContext({ audience: 'internal' })
      );

      expect(decision.eligible).toBe(true);
      expect(decision.autoAnswerAllowed).toBe(true);
      expect(decision.reasons).toContain('required_facet_unknown');
    }
  );

  it.each(kindsWithRequired)('%s: отсутствие ключа обязательной оси блокирует оба канала', (kind) => {
    const facets = { ...filledFacets(kind) } as Record<string, unknown>;
    const [firstRequired] = requiredFacetsOf(kind);
    delete facets[firstRequired];

    for (const audience of ['client', 'internal'] as const) {
      const decision = evaluateUnitEligibility(
        buildUnit({ kind, facets: facets as FacetMap }),
        buildRequestContext({ audience })
      );

      expect(decision.eligible).toBe(false);
      expect(decision.blockingReasons).toContain('required_facet_absent');
      expect(decision.absentRequiredFacets).toContain(firstRequired);
    }
  });

  it('TERM_DEFINITION: обязательных ФАСЕТ нет — оба списка всегда пусты', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ kind: 'TERM_DEFINITION', facets: {} }),
      buildRequestContext({ audience: 'client' })
    );

    expect(decision.unknownRequiredFacets).toEqual([]);
    expect(decision.absentRequiredFacets).toEqual([]);
    expect(decision.eligible).toBe(true);
  });

  it('create/publish безусловен, рантайм условен — ровно то разграничение, которое §2.1 закрепила', () => {
    const facets: FacetMap = { scenario: { state: 'UNKNOWN' } };

    // На create UNKNOWN запрещён БЕЗ оговорки про audience.
    expect(
      applicabilityProfileSchema.safeParse(
        buildProfile('PROCEDURE_STEP', facets, { audience: 'INTERNAL_ONLY' })
      ).success
    ).toBe(false);

    // В рантайме судьба зависит от канала — и это не ослабление валидации,
    // а другая, отдельно объявленная проверка.
    const forInternal = evaluateUnitEligibility(
      buildUnit({ facets, audience: 'INTERNAL_ONLY' }),
      buildRequestContext({ audience: 'internal' })
    );
    expect(forInternal.autoAnswerAllowed).toBe(true);

    const forClient = evaluateUnitEligibility(
      buildUnit({ facets }),
      buildRequestContext({ audience: 'client' })
    );
    expect(forClient.autoAnswerAllowed).toBe(false);
  });

  it('scenario не захардкожен: обязательность берётся из реестра', () => {
    // У DELIVERY_RULE вторая обязательная ось — `deliveryCity`; она обязана
    // блокировать автоответ ровно так же, как `scenario`.
    const decision = evaluateUnitEligibility(
      buildUnit({
        kind: 'DELIVERY_RULE',
        facets: { scenario: scoped(['apostille']), deliveryCity: { state: 'UNKNOWN' } },
      }),
      buildRequestContext({ audience: 'client' })
    );

    expect(decision.unknownRequiredFacets).toEqual(['deliveryCity']);
    expect(decision.autoAnswerAllowed).toBe(false);
  });
});

describe('статус жизненного цикла', () => {
  it.each(UNIT_LIFECYCLE_STATUSES)('%s', (status) => {
    const decision = evaluateUnitEligibility(buildUnit({ status }), buildRequestContext());

    expect(decision.eligible).toBe(status === 'ACTIVE');
    if (status !== 'ACTIVE') {
      expect(decision.blockingReasons).toContain('unit_status_not_active');
    }
  });
});

describe('окно действия', () => {
  const now = '2026-08-06T12:00:00Z';

  it.each([
    { label: 'без границ', validFrom: null, validUntil: null, eligible: true, reason: undefined },
    {
      label: 'ещё не вступило в силу',
      validFrom: '2026-09-01T00:00:00Z',
      validUntil: null,
      eligible: false,
      reason: 'validity_not_started',
    },
    {
      label: 'истекло',
      validFrom: null,
      validUntil: '2026-08-01T00:00:00Z',
      eligible: false,
      reason: 'validity_expired',
    },
    {
      label: 'внутри окна',
      validFrom: '2026-08-01T00:00:00Z',
      validUntil: '2026-09-01T00:00:00Z',
      eligible: true,
      reason: undefined,
    },
    {
      label: 'конец раньше начала',
      validFrom: '2026-09-01T00:00:00Z',
      validUntil: '2026-08-01T00:00:00Z',
      eligible: false,
      reason: 'validity_window_malformed',
    },
    {
      label: 'неразбираемая дата',
      validFrom: 'вчера',
      validUntil: null,
      eligible: false,
      reason: 'validity_window_malformed',
    },
    // Date.parse принимает такое молча: '0' превращается в 2000-й год, голая
    // дата — в полночь UTC, 30 февраля — в 2 марта. То есть испорченное
    // значение читалось бы как валидное окно, и unit оказывался бы годен по
    // данным, которых нет.
    {
      label: 'мусор, который Date.parse проглатывает: "0"',
      validFrom: '0',
      validUntil: null,
      eligible: false,
      reason: 'validity_window_malformed',
    },
    {
      label: 'голая дата без времени и зоны',
      validFrom: '2026-08-01',
      validUntil: null,
      eligible: false,
      reason: 'validity_window_malformed',
    },
    {
      label: 'несуществующая дата 30 февраля',
      validFrom: '2026-02-30T00:00:00Z',
      validUntil: null,
      eligible: false,
      reason: 'validity_window_malformed',
    },
  ])('$label → eligible=$eligible', ({ validFrom, validUntil, eligible, reason }) => {
    const decision = evaluateUnitEligibility(
      buildUnit({ validFrom, validUntil }),
      buildRequestContext({ now })
    );

    expect(decision.eligible).toBe(eligible);
    if (reason !== undefined) expect(decision.blockingReasons).toContain(reason);
  });
});

describe('ревизия источника', () => {
  it('unit не помнит происхождения — след есть, блокировки нет (принцип §4.2)', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ sourceRevision: null }),
      buildRequestContext()
    );

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toContain('source_revision_unverified');
  });

  it('сверять не с чем — тоже не блокировка, но и не молчание', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ sourceRevision: { documentId: 'doc-1', revision: 3 } }),
      buildRequestContext({ currentSourceRevisions: {} })
    );

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toContain('source_revision_unverified');
  });

  it('совпало — ни одной причины про ревизию', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ sourceRevision: { documentId: 'doc-1', revision: 3 } }),
      buildRequestContext({ currentSourceRevisions: { 'doc-1': 3 } })
    );

    expect(decision.eligible).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('unit собран по устаревшей ревизии — блокировка', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ sourceRevision: { documentId: 'doc-1', revision: 2 } }),
      buildRequestContext({ currentSourceRevisions: { 'doc-1': 5 } })
    );

    expect(decision.eligible).toBe(false);
    expect(decision.blockingReasons).toContain('source_revision_stale');
  });

  it('ревизия unit’а новее источника — рассинхрон данных, тоже блокировка', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ sourceRevision: { documentId: 'doc-1', revision: 9 } }),
      buildRequestContext({ currentSourceRevisions: { 'doc-1': 5 } })
    );

    expect(decision.eligible).toBe(false);
    expect(decision.blockingReasons).toContain('source_revision_ahead_of_source');
  });
});

describe('решение объясняет себя', () => {
  it('всякое «нет» подкреплено хотя бы одним кодом, и коды — из реестра', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ status: 'DEPRECATED', audience: 'INTERNAL_ONLY', review: UNCLASSIFIED }),
      buildRequestContext({ audience: 'client' })
    );

    expect(decision.eligible).toBe(false);
    expect(decision.blockingReasons.length).toBeGreaterThan(0);
    for (const reason of decision.reasons) {
      expect(ELIGIBILITY_REASON_CODES).toContain(reason);
    }
    // Все блокирующие причины перечислены и в общем списке — второго источника
    // истины про то, «почему нет», не существует.
    for (const reason of decision.blockingReasons) {
      expect(decision.reasons).toContain(reason);
    }
  });

  it('несколько нарушений сразу — перечислены все, а не первое попавшееся', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({
        status: 'SUPERSEDED',
        audience: 'INTERNAL_ONLY',
        validUntil: '2020-01-01T00:00:00Z',
      }),
      buildRequestContext({ audience: 'client' })
    );

    expect(decision.blockingReasons).toEqual(
      expect.arrayContaining([
        'unit_status_not_active',
        'validity_expired',
        'audience_internal_only_for_client',
      ])
    );
  });

  it('годный unit без оговорок не выдумывает причин', () => {
    const decision = evaluateUnitEligibility(
      buildUnit({ sourceRevision: { documentId: 'doc-1', revision: 1 } }),
      buildRequestContext({ currentSourceRevisions: { 'doc-1': 1 } })
    );

    expect(decision).toMatchObject({
      eligible: true,
      autoAnswerAllowed: true,
      requiresHumanReview: false,
      reasons: [],
      blockingReasons: [],
    });
  });
});
