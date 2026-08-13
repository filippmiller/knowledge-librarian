import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/lib/knowledge/scenarios';
import {
  CITY_CONCEPTS,
  COUNTRY_CONCEPTS,
  DOCUMENT_TYPE_CONCEPTS,
  LANGUAGE_CONCEPTS,
  SERVICE_CONCEPTS,
} from '../concept-registry';
import { FACET_KEYS, facetMapSchema, type FacetKey } from '../facets';
import { applicabilityProfileSchema } from '../profile';

/**
 * B1 сверяет КЛЮЧИ фасет с реестром, чтобы `issuerCountry` не проходил молча.
 * Здесь то же требование предъявляется ЗНАЧЕНИЯМ: строка нужной формы, но
 * пустая по смыслу (одни пробелы) или указывающая в никуда (несуществующий
 * сценарий) — тот же самый баг этажом ниже.
 */
const BLANKS = ['', ' ', '   ', '\t', '\n', ' \t\n '];

const REVIEWED_AT = '2026-08-06T10:00:00Z';

function facetValueAccepted(key: FacetKey, value: string): boolean {
  return facetMapSchema.safeParse({ [key]: { state: 'SCOPED', include: [value] } }).success;
}

describe('значения фасет — ни одна не принимает пустую по смыслу строку', () => {
  for (const key of FACET_KEYS) {
    it.each(BLANKS)(`${key} отвергает %j`, (blank) => {
      expect(facetValueAccepted(key, blank)).toBe(false);
    });
  }

  it('exclude проверяется той же схемой значения, что и include', () => {
    expect(
      facetMapSchema.safeParse({
        scenario: { state: 'SCOPED', include: ['apostille.zags.spb'], exclude: ['   '] },
      }).success
    ).toBe(false);
  });
});

describe('scenario — значение сверяется с реестром SCENARIOS, а не только с формой', () => {
  it.each(Object.keys(SCENARIOS))('существующий узел %s принимается', (key) => {
    expect(facetValueAccepted('scenario', key)).toBe(true);
  });

  it('нелистовой узел легален — профиль может быть предком запроса (§3.1)', () => {
    expect(facetValueAccepted('scenario', 'apostille')).toBe(true);
    expect(facetValueAccepted('scenario', 'apostille.zags')).toBe(true);
  });

  it.each([
    ['apostille.zags.sbp', 'опечатка в последнем сегменте'],
    ['apostile.zags.spb', 'опечатка в корне'],
    ['apostille.zags.spb.extra', 'несуществующий потомок'],
    ['legalization', 'сценарий, которого нет в дереве'],
  ])('%s отвергается (%s)', (key) => {
    expect(facetValueAccepted('scenario', key)).toBe(false);
  });

  it('несуществующий сценарий валит и весь профиль, а не только карту фасет', () => {
    const result = applicabilityProfileSchema.safeParse({
      kind: 'PROCEDURE_STEP',
      facets: { scenario: { state: 'SCOPED', include: ['apostille.zags.sbp'] } },
      audience: 'CLIENT_SAFE',
      reviewStatus: 'UNCLASSIFIED',
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('service — значение сверяется с SERVICE_CONCEPTS (Задача 2.2), а не только с формой', () => {
  it.each(Object.keys(SERVICE_CONCEPTS))('существующая услуга %s принимается', (id) => {
    expect(facetValueAccepted('service', id)).toBe(true);
  });

  it('выдуманная услуга отвергается, хотя её формат корректен', () => {
    expect(facetValueAccepted('service', 'legalization_of_everything')).toBe(false);
  });
});

describe('documentType — сверяется с DOCUMENT_TYPE_CONCEPTS', () => {
  it.each(Object.keys(DOCUMENT_TYPE_CONCEPTS))('существующий тип %s принимается', (id) => {
    expect(facetValueAccepted('documentType', id)).toBe(true);
  });

  it('выдуманный тип документа отвергается', () => {
    expect(facetValueAccepted('documentType', 'birth_certificate_deluxe')).toBe(false);
  });
});

describe('issuingCountry / destinationCountry — сверяется с COUNTRY_CONCEPTS', () => {
  it.each(Object.keys(COUNTRY_CONCEPTS))('%s принимается на обеих осях', (code) => {
    expect(facetValueAccepted('issuingCountry', code)).toBe(true);
    expect(facetValueAccepted('destinationCountry', code)).toBe(true);
  });

  it('формально верный, но не зарегистрированный код страны отвергается', () => {
    expect(facetValueAccepted('issuingCountry', 'US')).toBe(false);
  });
});

describe('languageFrom / languageTo — сверяется с LANGUAGE_CONCEPTS', () => {
  it.each(Object.keys(LANGUAGE_CONCEPTS))('%s принимается на обеих осях', (code) => {
    expect(facetValueAccepted('languageFrom', code)).toBe(true);
    expect(facetValueAccepted('languageTo', code)).toBe(true);
  });

  it('формально верный, но не зарегистрированный код языка отвергается', () => {
    expect(facetValueAccepted('languageFrom', 'xx')).toBe(false);
  });
});

describe('deliveryCity — сверяется с CITY_CONCEPTS', () => {
  it.each(Object.keys(CITY_CONCEPTS))('%s принимается', (id) => {
    expect(facetValueAccepted('deliveryCity', id)).toBe(true);
  });

  it('город вне подтверждённого списка отвергается', () => {
    expect(facetValueAccepted('deliveryCity', 'moscow')).toBe(false);
  });
});

describe('partner — словарь пуст, поэтому отвергается ЛЮБОЕ значение', () => {
  it('формально верный slug партнёра всё равно отвергается — партнёров ещё не подтверждено', () => {
    expect(facetValueAccepted('partner', 'some_partner')).toBe(false);
  });
});

describe('аудит-поля состояния GLOBAL', () => {
  it.each(BLANKS)('reviewedBy=%j отвергается', (blank) => {
    expect(
      facetMapSchema.safeParse({
        scenario: { state: 'GLOBAL', reviewedBy: blank, reviewedAt: REVIEWED_AT },
      }).success
    ).toBe(false);
  });

  it.each(BLANKS)('reviewedAt=%j отвергается', (blank) => {
    expect(
      facetMapSchema.safeParse({
        scenario: { state: 'GLOBAL', reviewedBy: 'anna', reviewedAt: blank },
      }).success
    ).toBe(false);
  });
});
