import { describe, expect, it } from 'vitest';
import { facetMapSchema, type FacetMap } from '../facets';
import { applicabilityProfileSchema } from '../profile';
import { queryFrameSchema } from '../query-frame';
import { ASKABLE_SCOPE_SITUATIONS, evaluateScope, type ScopeVerdict } from '../scope';
import type { ScopeSituation } from '../reasons';
import { buildProfile, buildQuery, global, known, scoped, unknown } from './helpers';

/**
 * ВЛАДЕЛЕЦ РЕШЕНИЯ: `evaluateScope`.
 * ПОКРЫВАЕТ: truth table §3 целиком — преамбула (правило агрегации),
 * §3.1 `scenario`, §3.3 `geography`/`deliveryCity`, §3.4 `service`.
 *
 * §3.2 (`audience`) здесь НЕТ намеренно и это не пропуск: по самой §3.2
 * аудитория запроса приходит из контекста вызова, а не из текста вопроса, и в
 * `QueryFrame` её нет вовсе. Её владелец — `evaluateUnitEligibility`
 * (`eligibility.test.ts`), и прогонять её ещё раз здесь означало бы ровно то
 * дублирование, против которого [R3] и разделил suite'ы.
 */

const S = 'apostille.zags'; // сценарий запроса в матрице §3.1
const S_LEAF = 'apostille.zags.spb'; // его потомок
const S_OTHER = 'apostille.min_justice'; // другая ветка, S' в матрице
const S_ROOT = 'apostille'; // предок S

describe('§3.1 scenario — матрица (профиль × запрос)', () => {
  const cases: ReadonlyArray<{
    row: string;
    column: string;
    profileScenario: FacetMap['scenario'];
    queryScenario: ReturnType<typeof known<string>> | ReturnType<typeof unknown<string>>;
    expected: ScopeVerdict;
    expectedSituation: ScopeSituation;
  }> = [
    // Строка 1: профиль = S или предок S.
    {
      row: 'профиль = S',
      column: 'явный сценарий S',
      profileScenario: scoped([S]),
      queryScenario: known([S]),
      expected: 'MATCH',
      expectedSituation: 'match_exact',
    },
    {
      row: 'профиль = предок S',
      column: 'явный сценарий S',
      profileScenario: scoped([S_ROOT]),
      queryScenario: known([S_LEAF]),
      expected: 'MATCH',
      expectedSituation: 'match_exact',
    },
    {
      row: 'профиль = S',
      column: "явный S', не предок и не сам S",
      profileScenario: scoped([S]),
      queryScenario: known([S_OTHER]),
      expected: 'CONFLICT',
      expectedSituation: 'conflict_value',
    },
    {
      row: 'профиль = S',
      column: 'сценарий не распознан',
      profileScenario: scoped([S]),
      queryScenario: unknown(),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_query_signal',
    },
    // Строка 2: профиль — потомок S. Специфичность должна быть ПОДТВЕРЖДЕНА
    // запросом, а не предположена, поэтому UNKNOWN, а не MATCH.
    {
      row: 'профиль = потомок S',
      column: 'явный сценарий S',
      profileScenario: scoped([S_LEAF]),
      queryScenario: known([S]),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_profile_more_specific',
    },
    {
      row: 'профиль = потомок S',
      column: "явный S'",
      profileScenario: scoped([S_LEAF]),
      queryScenario: known([S_OTHER]),
      expected: 'CONFLICT',
      expectedSituation: 'conflict_value',
    },
    {
      row: 'профиль = потомок S',
      column: 'сценарий не распознан',
      profileScenario: scoped([S_LEAF]),
      queryScenario: unknown(),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_query_signal',
    },
    // Строка 3: профиль — другая ветка.
    {
      row: 'профиль — другая ветка',
      column: 'явный сценарий S',
      profileScenario: scoped([S_OTHER]),
      queryScenario: known([S_LEAF]),
      expected: 'CONFLICT',
      expectedSituation: 'conflict_value',
    },
    {
      row: 'профиль — другая ветка',
      column: "явный S' (и профиль не предок/потомок S')",
      profileScenario: scoped(['apostille.zags.lo']),
      queryScenario: known([S_OTHER]),
      expected: 'CONFLICT',
      expectedSituation: 'conflict_value',
    },
    {
      row: 'профиль — другая ветка',
      column: 'сценарий не распознан',
      profileScenario: scoped([S_OTHER]),
      queryScenario: unknown(),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_query_signal',
    },
    // Строка 4: профиль не заполнен — UNKNOWN во ВСЕХ колонках.
    {
      row: 'профиль не заполнен',
      column: 'явный сценарий S',
      profileScenario: { state: 'UNKNOWN' },
      queryScenario: known([S]),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_profile_scope',
    },
    {
      row: 'профиль не заполнен',
      column: "явный S'",
      profileScenario: { state: 'UNKNOWN' },
      queryScenario: known([S_OTHER]),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_profile_scope',
    },
    {
      row: 'профиль не заполнен',
      column: 'сценарий не распознан',
      profileScenario: { state: 'UNKNOWN' },
      queryScenario: unknown(),
      expected: 'UNKNOWN',
      expectedSituation: 'unknown_profile_scope',
    },
    // Строка 5: GLOBAL — MATCH во всех колонках, включая нераспознанную.
    {
      row: 'scopeStatus(scenario)=GLOBAL',
      column: 'явный сценарий S',
      profileScenario: global(),
      queryScenario: known([S]),
      expected: 'MATCH',
      expectedSituation: 'match_global',
    },
    {
      row: 'scopeStatus(scenario)=GLOBAL',
      column: "явный S'",
      profileScenario: global(),
      queryScenario: known([S_OTHER]),
      expected: 'MATCH',
      expectedSituation: 'match_global',
    },
    {
      row: 'scopeStatus(scenario)=GLOBAL',
      column: 'сценарий не распознан',
      profileScenario: global(),
      queryScenario: unknown(),
      expected: 'MATCH',
      expectedSituation: 'match_global',
    },
  ];

  it.each(cases)('[$row] × [$column] → $expected', ({ profileScenario, queryScenario, expected, expectedSituation }) => {
    const profile = buildProfile('PROCEDURE_STEP', { scenario: profileScenario });
    const query = buildQuery({ facets: { scenario: queryScenario } });

    const decision = evaluateScope(profile, query);
    const expectedReason = `scenario_${expectedSituation}`;

    expect(decision.verdict).toBe(expected);
    expect(decision.facetVerdicts).toEqual([
      { facet: 'scenario', verdict: expected, situation: expectedSituation, reason: expectedReason },
    ]);
    // Ни одно решение не является голым вердиктом.
    expect(decision.reasons).toContain(expectedReason);
  });

  it('фикстуры матрицы — не выдуманные данные: фрейм валиден всегда, профиль — кроме строки «не заполнен»', () => {
    for (const { row, profileScenario, queryScenario } of cases) {
      expect(
        queryFrameSchema.safeParse(buildQuery({ facets: { scenario: queryScenario } })).success
      ).toBe(true);

      const profile = buildProfile('PROCEDURE_STEP', { scenario: profileScenario });
      const parsed = applicabilityProfileSchema.safeParse(profile);

      // Строка «профиль не заполнен» — ровно тот же случай, что и строка «не
      // заполнено на профиле» в §3.2: §2.1 запрещает создавать такой unit
      // (`scenario` обязателен для PROCEDURE_STEP), поэтому строка описывает
      // не легальный путь, а поведение при баге миграции или ручной правке БД.
      // Evaluator обязан её отработать; схема обязана её не пропустить.
      expect(parsed.success).toBe(row !== 'профиль не заполнен');
    }
  });

  it("строка «другая ветка» × S': если профиль всё-таки предок S' — вердикт по своей строке", () => {
    // Матрица §3.1 прямо оговаривает «иначе по своей строке»: у запроса может
    // быть несколько сценариев, и достаточно одного покрытого.
    const profile = buildProfile('PROCEDURE_STEP', { scenario: scoped([S_OTHER]) });
    const query = buildQuery({ facets: { scenario: known([S_LEAF, S_OTHER]) } });

    expect(evaluateScope(profile, query).verdict).toBe('MATCH');
  });

  it('значение в `exclude` профиля даёт CONFLICT, а не пробел', () => {
    const profile = buildProfile('PROCEDURE_STEP', {
      scenario: scoped([S_ROOT], [S]),
    });
    const decision = evaluateScope(profile, buildQuery({ facets: { scenario: known([S_LEAF]) } }));

    expect(decision.verdict).toBe('CONFLICT');
    expect(decision.reasons).toContain('scenario_conflict_excluded_by_profile');
    expect(decision.conflictingFacets).toEqual(['scenario']);
  });

  it('отрицание на стороне запроса: профиль целиком отвергнут → CONFLICT', () => {
    const profile = buildProfile('PROCEDURE_STEP', { scenario: scoped([S]) });
    const decision = evaluateScope(
      profile,
      buildQuery({ facets: { scenario: known([], [S_ROOT]) } })
    );

    expect(decision.verdict).toBe('CONFLICT');
    expect(decision.reasons).toContain('scenario_conflict_excluded_by_query');
  });

  it('исключение профиля ВНУТРИ запрошенной ветки → UNKNOWN, а не MATCH', () => {
    // Находка кросс-ревью. «Весь апостиль, кроме СПб» при вопросе про всю ветку
    // ЗАГС раньше давал уверенный MATCH: исключение не срабатывало, потому что
    // запрос грубее исключённого узла. Правило применимо к части ветки и
    // неприменимо к другой её части — специфичность обязан подтвердить запрос.
    const decision = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: scoped([S_ROOT], [S_LEAF]) }),
      buildQuery({ facets: { scenario: known([S]) } })
    );

    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasons).toContain('scenario_unknown_profile_more_specific');
  });

  it('вердикт не зависит от глубины профиля на противоречивом фрейме', () => {
    // Находка кросс-ревью. Схема B1 ловит только ТОЧНОЕ пересечение
    // include/exclude, иерархическое — нет, поэтому фрейм «вопрос про
    // apostille.zags.spb, но не про apostille.zags» валиден. Раньше широкий
    // профиль получал MATCH через отравленное значение, а узкий — CONFLICT.
    const contradictory = buildQuery({ facets: { scenario: known([S_LEAF], [S]) } });
    expect(queryFrameSchema.safeParse(contradictory).success).toBe(true);

    const broad = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: scoped([S_ROOT]) }),
      contradictory
    );
    const leaf = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: scoped([S_LEAF]) }),
      contradictory
    );

    // Отравленное значение больше не подтверждает ничего.
    expect(broad.verdict).toBe('UNKNOWN');
    expect(broad.reasons).toContain('scenario_unknown_query_signal');
    // Узкий профиль целиком лежит внутри отвергнутой ветки — это достоверный
    // отказ, а не пробел, и разница здесь принципиальная, а не от глубины.
    expect(leaf.verdict).toBe('CONFLICT');
    expect(leaf.reasons).toContain('scenario_conflict_excluded_by_query');
  });

  it('известно только, чем вопрос НЕ является → UNKNOWN, а не MATCH', () => {
    const profile = buildProfile('PROCEDURE_STEP', { scenario: scoped([S]) });
    const decision = evaluateScope(
      profile,
      buildQuery({ facets: { scenario: known([], [S_OTHER]) } })
    );

    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasons).toContain('scenario_unknown_query_signal');
  });
});

describe('§3.3 geography — deliveryCity у DELIVERY_RULE', () => {
  const deliveryProfile = (deliveryCity: FacetMap['deliveryCity']) =>
    buildProfile('DELIVERY_RULE', { scenario: scoped([S_ROOT]), deliveryCity });

  // Сценарий во всех строках совпадает, чтобы вердикт по паре определялся
  // именно географией.
  const queryWithCity = (city: ReturnType<typeof known<string>> | ReturnType<typeof unknown<string>>) =>
    buildQuery({ facets: { scenario: known([S_ROOT]), deliveryCity: city } });

  const cases: ReadonlyArray<{
    condition: string;
    profileCity: FacetMap['deliveryCity'];
    queryCity: ReturnType<typeof known<string>> | ReturnType<typeof unknown<string>>;
    expected: ScopeVerdict;
    expectedReason: string;
  }> = [
    {
      condition: 'query.city ∈ profile.deliveryCityCodes',
      profileCity: scoped(['spb', 'msk']),
      queryCity: known(['spb']),
      expected: 'MATCH',
      expectedReason: 'deliveryCity_match_exact',
    },
    {
      condition: 'query.city известен и ∉ profile.deliveryCityCodes',
      profileCity: scoped(['spb', 'msk']),
      queryCity: known(['kazan']),
      expected: 'CONFLICT',
      expectedReason: 'deliveryCity_conflict_value',
    },
    {
      condition: 'query.city не распознан',
      profileCity: scoped(['spb']),
      queryCity: unknown(),
      expected: 'UNKNOWN',
      expectedReason: 'deliveryCity_unknown_query_signal',
    },
    {
      condition: 'scopeStatus(geography)=GLOBAL, город известен',
      profileCity: global(),
      queryCity: known(['kazan']),
      expected: 'MATCH',
      expectedReason: 'deliveryCity_match_global',
    },
    {
      condition: 'scopeStatus(geography)=GLOBAL, город не распознан',
      profileCity: global(),
      queryCity: unknown(),
      expected: 'MATCH',
      expectedReason: 'deliveryCity_match_global',
    },
  ];

  it.each(cases)('$condition → $expected', ({ profileCity, queryCity, expected, expectedReason }) => {
    const decision = evaluateScope(deliveryProfile(profileCity), queryWithCity(queryCity));

    const cityVerdict = decision.facetVerdicts.find((entry) => entry.facet === 'deliveryCity');
    expect(cityVerdict).toMatchObject({ facet: 'deliveryCity', verdict: expected, reason: expectedReason });
    expect(decision.verdict).toBe(expected);
  });

  it('строка «deliveryCityCodes пуст и не GLOBAL» действительно недостижима — её запрещает схема', () => {
    // §3.3 объявляет ячейку недостижимой, потому что §2 запрещает создание
    // такого unit'а. Проверяется там, где запрет живёт, а не выдумыванием
    // поведения evaluator'а на данных, которых не бывает.
    expect(
      facetMapSchema.safeParse({ deliveryCity: { state: 'SCOPED', include: [] } }).success
    ).toBe(false);
  });
});

describe('§3.4 service — у PRICE_RULE', () => {
  const priceProfile = (service: FacetMap['service']) =>
    buildProfile('PRICE_RULE', { scenario: scoped([S_ROOT]), service });

  const queryWithService = (
    service: ReturnType<typeof known<string>> | ReturnType<typeof unknown<string>>
  ) => buildQuery({ facets: { scenario: known([S_ROOT]), service } });

  const cases: ReadonlyArray<{
    condition: string;
    profileService: FacetMap['service'];
    queryService: ReturnType<typeof known<string>> | ReturnType<typeof unknown<string>>;
    expected: ScopeVerdict;
    expectedReason: string;
  }> = [
    {
      condition: 'query.serviceCode = profile.service.code',
      profileService: scoped(['apostille.zags']),
      queryService: known(['apostille.zags']),
      expected: 'MATCH',
      expectedReason: 'service_match_exact',
    },
    {
      condition: 'query.serviceCode известен и ≠ profile.service.code',
      profileService: scoped(['apostille.zags']),
      queryService: known(['translation.notary']),
      expected: 'CONFLICT',
      expectedReason: 'service_conflict_value',
    },
    {
      condition: 'query.serviceCode не распознан',
      profileService: scoped(['apostille.zags']),
      queryService: unknown(),
      expected: 'UNKNOWN',
      expectedReason: 'service_unknown_query_signal',
    },
    {
      condition: 'scopeStatus(service)=GLOBAL — базовый прайс',
      profileService: global(),
      queryService: known(['translation.notary']),
      expected: 'MATCH',
      expectedReason: 'service_match_global',
    },
  ];

  it.each(cases)('$condition → $expected', ({ profileService, queryService, expected, expectedReason }) => {
    const decision = evaluateScope(priceProfile(profileService), queryWithService(queryService));

    expect(decision.facetVerdicts.find((entry) => entry.facet === 'service')).toMatchObject({
      facet: 'service',
      verdict: expected,
      reason: expectedReason,
    });
  });

  it('синтаксическое несовпадение кодов пока даёт CONFLICT — сопоставление синонимов придёт с Задачей 2.2', () => {
    const decision = evaluateScope(
      priceProfile(scoped(['apostille.zags'])),
      queryWithService(known(['apostille_zags']))
    );
    expect(decision.verdict).toBe('CONFLICT');
  });
});

describe('§3 преамбула — правило агрегации по ПРИМЕНИМЫМ измерениям', () => {
  const deliveryProfile = (
    scenario: FacetMap['scenario'],
    deliveryCity: FacetMap['deliveryCity']
  ) => buildProfile('DELIVERY_RULE', { scenario, deliveryCity });

  it('один CONFLICT перевешивает MATCH', () => {
    const decision = evaluateScope(
      deliveryProfile(scoped([S_ROOT]), scoped(['spb'])),
      buildQuery({ facets: { scenario: known([S_ROOT]), deliveryCity: known(['kazan']) } })
    );
    expect(decision.verdict).toBe('CONFLICT');
    expect(decision.conflictingFacets).toEqual(['deliveryCity']);
  });

  it('один UNKNOWN перевешивает MATCH, но не CONFLICT', () => {
    const withUnknown = evaluateScope(
      deliveryProfile(scoped([S_ROOT]), scoped(['spb'])),
      buildQuery({ facets: { scenario: known([S_ROOT]), deliveryCity: unknown() } })
    );
    expect(withUnknown.verdict).toBe('UNKNOWN');
    expect(withUnknown.unknownFacets).toEqual(['deliveryCity']);

    const withBoth = evaluateScope(
      deliveryProfile({ state: 'UNKNOWN' }, scoped(['spb'])),
      buildQuery({ facets: { scenario: known([S_ROOT]), deliveryCity: known(['kazan']) } })
    );
    expect(withBoth.verdict).toBe('CONFLICT');
  });

  it('все применимые MATCH → MATCH', () => {
    const decision = evaluateScope(
      deliveryProfile(scoped([S_ROOT]), scoped(['spb'])),
      buildQuery({ facets: { scenario: known([S_LEAF]), deliveryCity: known(['spb']) } })
    );
    expect(decision.verdict).toBe('MATCH');
    expect(decision.requiresClarification).toBe(false);
  });
});

describe('§2 / §2.1 — NOT_APPLICABLE не голосует, UNKNOWN голосует', () => {
  it('неприменимая фасета не влияет на вердикт, даже если противоречит запросу', () => {
    // Профиль собран В ОБХОД схемы: `deliveryCity` не применим к
    // PROCEDURE_STEP, и B1 такой профиль не пропустит. Проверяется именно то,
    // что evaluator перебирает РЕЕСТР, а не ключи карты.
    const rogue = buildProfile('PROCEDURE_STEP', {
      scenario: scoped([S_ROOT]),
      deliveryCity: scoped(['spb']),
    });
    expect(applicabilityProfileSchema.safeParse(rogue).success).toBe(false);

    const decision = evaluateScope(
      rogue,
      buildQuery({ facets: { scenario: known([S_ROOT]), deliveryCity: known(['kazan']) } })
    );

    expect(decision.verdict).toBe('MATCH');
    expect(decision.facetVerdicts.map((entry) => entry.facet)).toEqual(['scenario']);
    expect(decision.conflictingFacets).toEqual([]);
  });

  it('TERM_DEFINITION: применимых ФАСЕТ нет — голосовать нечему, но и «вакуумного» CONFLICT нет', () => {
    const decision = evaluateScope(
      buildProfile('TERM_DEFINITION', {}),
      buildQuery({ facets: { scenario: known([S_OTHER]) } })
    );

    expect(decision.facetVerdicts).toEqual([]);
    expect(decision.verdict).toBe('MATCH');
    expect(decision.missingFacets).toEqual([]);
  });

  it('применимая фасета в UNKNOWN голосует UNKNOWN — это НЕ то же, что её отсутствие', () => {
    const voting = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }),
      buildQuery({ facets: { scenario: known([S_ROOT]) } })
    );
    expect(voting.verdict).toBe('UNKNOWN');

    const notApplicable = evaluateScope(
      buildProfile('TERM_DEFINITION', {}),
      buildQuery({ facets: { scenario: known([S_ROOT]) } })
    );
    expect(notApplicable.verdict).toBe('MATCH');
  });

  it('применимая фасета БЕЗ ключа — fail-closed в UNKNOWN, никогда не MATCH', () => {
    const broken = buildProfile('PROCEDURE_STEP', {});
    expect(applicabilityProfileSchema.safeParse(broken).success).toBe(false);

    const decision = evaluateScope(broken, buildQuery({ facets: { scenario: known([S_ROOT]) } }));
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasons).toContain('scenario_unknown_profile_state_absent');
  });

  it('UNKNOWN не даёт эффекта GLOBAL: там, где GLOBAL даёт MATCH, UNKNOWN даёт UNKNOWN', () => {
    const query = buildQuery({ facets: { scenario: known([S_OTHER]) } });

    const asGlobal = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: global() }),
      query
    );
    const asUnknown = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }),
      query
    );

    expect(asGlobal.verdict).toBe('MATCH');
    expect(asUnknown.verdict).toBe('UNKNOWN');
    expect(asUnknown.verdict).not.toBe(asGlobal.verdict);
  });
});

describe('missingFacets вычисляется здесь, из requiredFacets реестра', () => {
  it('обязательная ось без сигнала в запросе попадает в missingFacets', () => {
    const decision = evaluateScope(
      buildProfile('PRICE_RULE', { scenario: scoped([S_ROOT]), service: scoped(['apostille.zags']) }),
      buildQuery({ facets: { scenario: known([S_ROOT]), service: unknown() } })
    );

    expect(decision.missingFacets).toEqual(['service']);
    expect(decision.reasons).toContain('service_missing_in_query');
    expect(decision.requiresClarification).toBe(true);
  });

  it('обе обязательные оси без сигнала — обе в missingFacets, в порядке реестра', () => {
    const decision = evaluateScope(
      buildProfile('DELIVERY_RULE', { scenario: scoped([S_ROOT]), deliveryCity: scoped(['spb']) }),
      buildQuery()
    );

    expect(decision.missingFacets).toEqual(['scenario', 'deliveryCity']);
  });

  it('missingFacets — утверждение о ЗАПРОСЕ: при GLOBAL на профиле ось остаётся missing, но вердикт MATCH', () => {
    const decision = evaluateScope(
      buildProfile('PRICE_RULE', { scenario: scoped([S_ROOT]), service: global() }),
      buildQuery({ facets: { scenario: known([S_ROOT]), service: unknown() } })
    );

    expect(decision.missingFacets).toEqual(['service']);
    expect(decision.verdict).toBe('MATCH');
    expect(decision.requiresClarification).toBe(false);
  });

  it('у kind без обязательных фасет missingFacets всегда пуст', () => {
    expect(evaluateScope(buildProfile('TERM_DEFINITION', {}), buildQuery()).missingFacets).toEqual(
      []
    );
  });

  it('scenario не является единственной обязательной осью — расширяемость сохранена', () => {
    const decision = evaluateScope(
      buildProfile('DELIVERY_RULE', { scenario: scoped([S_ROOT]), deliveryCity: scoped(['spb']) }),
      buildQuery({ facets: { scenario: known([S_ROOT]) } })
    );

    expect(decision.missingFacets).toEqual(['deliveryCity']);
  });
});

describe('решение объясняет себя', () => {
  it('на каждую применимую ось приходится ровно один код причины', () => {
    const decision = evaluateScope(
      buildProfile('DELIVERY_RULE', { scenario: scoped([S_ROOT]), deliveryCity: scoped(['spb']) }),
      buildQuery({ facets: { scenario: known([S_ROOT]), deliveryCity: known(['kazan']) } })
    );

    expect(decision.facetVerdicts).toHaveLength(2);
    for (const entry of decision.facetVerdicts) {
      expect(entry.reason.startsWith(`${entry.facet}_`)).toBe(true);
      expect(decision.reasons).toContain(entry.reason);
    }
  });

  it('вердикт несёт ситуацию отдельным полем — потребителю не надо парсить строку кода', () => {
    const decision = evaluateScope(
      buildProfile('DELIVERY_RULE', { scenario: scoped([S_ROOT]), deliveryCity: scoped(['spb']) }),
      buildQuery({ facets: { scenario: known([S_ROOT]) } })
    );

    for (const entry of decision.facetVerdicts) {
      expect(entry.reason).toBe(`${entry.facet}_${entry.situation}`);
    }
    // Askable и неaskable UNKNOWN различимы без разбора строки — на этом
    // держится выбор между «спросить» и «отдать человеку» в resolveKnowledgeSet.
    expect(ASKABLE_SCOPE_SITUATIONS).toContain('unknown_query_signal');
    expect(ASKABLE_SCOPE_SITUATIONS).not.toContain('unknown_profile_scope');
  });

  it('reasons никогда не пуст там, где есть применимые оси', () => {
    const decision = evaluateScope(
      buildProfile('PROCEDURE_STEP', { scenario: scoped([S_ROOT]) }),
      buildQuery({ facets: { scenario: known([S_ROOT]) } })
    );
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
