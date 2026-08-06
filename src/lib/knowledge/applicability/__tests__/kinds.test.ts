import { describe, expect, it } from 'vitest';
import { FACET_KEYS, facetMapSchema, isFacetKey, type FacetKey } from '../facets';
import {
  applicableFacetsOf,
  isFacetApplicableTo,
  KNOWLEDGE_KIND_REGISTRY,
  KNOWLEDGE_UNIT_KINDS,
  knowledgeUnitKindSchema,
  requiredFacetsOf,
  type KnowledgeUnitKind,
} from '../kinds';

/**
 * Реестр видов знания сверяется со СПИСКОМ ИЗ truth table §2.1 дословно.
 * Тест намеренно дублирует таблицу литералом: если кто-то «согласует» код с
 * иллюстративным наброском плана (у которого PROCEDURE_STEP имел ещё и
 * `service`), тест обязан упасть, а не молча принять другой контракт.
 */
const TRUTH_TABLE_2_1: Record<
  string,
  { applicableFacets: readonly string[]; requiredFacets: readonly string[] }
> = {
  PROCEDURE_STEP: { applicableFacets: ['scenario'], requiredFacets: ['scenario'] },
  EXCEPTION_RULE: { applicableFacets: ['scenario'], requiredFacets: ['scenario'] },
  TERM_DEFINITION: { applicableFacets: [], requiredFacets: [] },
  DELIVERY_RULE: {
    applicableFacets: ['scenario', 'deliveryCity'],
    requiredFacets: ['scenario', 'deliveryCity'],
  },
  PRICE_RULE: { applicableFacets: ['scenario', 'service'], requiredFacets: ['scenario', 'service'] },
};

describe('KNOWLEDGE_KIND_REGISTRY — дословный перенос truth table §2.1', () => {
  it('содержит ровно те же kind, что и таблица', () => {
    expect([...KNOWLEDGE_UNIT_KINDS].sort()).toEqual(Object.keys(TRUTH_TABLE_2_1).sort());
  });

  it.each(Object.keys(TRUTH_TABLE_2_1))('%s: applicable и required совпадают', (kind) => {
    const expected = TRUTH_TABLE_2_1[kind];
    expect([...applicableFacetsOf(kind as KnowledgeUnitKind)]).toEqual(expected.applicableFacets);
    expect([...requiredFacetsOf(kind as KnowledgeUnitKind)]).toEqual(expected.requiredFacets);
  });

  it('service применим ТОЛЬКО к PRICE_RULE — расхождение с наброском плана решено в пользу truth table', () => {
    const kindsWithService = KNOWLEDGE_UNIT_KINDS.filter((kind) =>
      isFacetApplicableTo(kind, 'service')
    );
    expect(kindsWithService).toEqual(['PRICE_RULE']);
    expect(isFacetApplicableTo('PROCEDURE_STEP', 'service')).toBe(false);
  });

  it('requiredFacets ⊆ applicableFacets для каждого kind', () => {
    for (const kind of KNOWLEDGE_UNIT_KINDS) {
      const applicable = applicableFacetsOf(kind);
      for (const facet of requiredFacetsOf(kind)) {
        expect(applicable).toContain(facet);
      }
    }
  });

  it('все объявленные фасеты существуют в FACET_REGISTRY', () => {
    for (const kind of KNOWLEDGE_UNIT_KINDS) {
      for (const facet of applicableFacetsOf(kind)) {
        expect(isFacetKey(facet)).toBe(true);
      }
    }
  });

  it('пустой applicableFacets у TERM_DEFINITION — это отсутствие ФАСЕТ, а не отсутствие проверок', () => {
    // audience — применимое измерение §3.2, но не фасета, поэтому его нет в
    // реестре; «вакуумный MATCH» закрывается тем, что оно всё равно обязательно
    // на профиле (см. profile.test.ts).
    expect(applicableFacetsOf('TERM_DEFINITION')).toEqual([]);
    expect(KNOWLEDGE_KIND_REGISTRY.TERM_DEFINITION.requiredFacets).toEqual([]);
  });

  it('knowledgeUnitKindSchema отвергает kind вне реестра', () => {
    expect(knowledgeUnitKindSchema.safeParse('PROCEDURE_STEP').success).toBe(true);
    expect(knowledgeUnitKindSchema.safeParse('PRICE_POLICY').success).toBe(false);
  });
});

describe('FACET_REGISTRY — реестр ключей, а не свободная карта', () => {
  it('facetMapSchema знает ровно те же ключи, что и реестр', () => {
    expect(Object.keys(facetMapSchema.shape).sort()).toEqual([...FACET_KEYS].sort());
  });

  it('каталог фасет — десять объявленных осей', () => {
    expect([...FACET_KEYS]).toEqual([
      'scenario',
      'service',
      'documentType',
      'issuingCountry',
      'destinationCountry',
      'documentForm',
      'languageFrom',
      'languageTo',
      'deliveryCity',
      'partner',
    ]);
  });

  it('опечатка в имени фасеты не является ключом', () => {
    expect(isFacetKey('issuingCountry')).toBe(true);
    // Ровно тот EAV-сценарий, ради которого реестр типизирован.
    for (const typo of ['issuerCountry', 'issueCountry', 'issuingContry']) {
      expect(isFacetKey(typo)).toBe(false);
    }
  });

  it('значение фасеты валидируется схемой СВОЕГО ключа', () => {
    const asFacet = (key: FacetKey, value: string) =>
      facetMapSchema.safeParse({ [key]: { state: 'SCOPED', include: [value] } }).success;

    expect(asFacet('issuingCountry', 'RU')).toBe(true);
    // Код языка не проходит как код страны, хотя обе оси — строки.
    expect(asFacet('issuingCountry', 'ru')).toBe(false);
    expect(asFacet('languageFrom', 'ru')).toBe(true);
    expect(asFacet('languageFrom', 'RU')).toBe(false);
    expect(asFacet('documentForm', 'ORIGINAL')).toBe(true);
    expect(asFacet('documentForm', 'НОТАРИАЛЬНАЯ_КОПИЯ')).toBe(false);
    expect(asFacet('scenario', 'apostille.zags.spb')).toBe(true);
    expect(asFacet('scenario', 'Apostille.ZAGS')).toBe(false);
  });
});
