import { describe, expect, it } from 'vitest';
import { assertVocabularyConsistency, isKnownConcept, resolveConceptAlias } from '../concepts';
import {
  CITY_CONCEPTS,
  COUNTRY_CONCEPTS,
  DOCUMENT_TYPE_CONCEPTS,
  LANGUAGE_CONCEPTS,
  PARTNER_CONCEPTS,
  SERVICE_CONCEPTS,
} from '../concept-registry';

/**
 * Источники данных: TariffSection (prisma/schema.prisma) для SERVICE_CONCEPTS,
 * `DocType` (src/lib/knowledge/scenarios.ts) для DOCUMENT_TYPE_CONCEPTS,
 * `/api/tariffs/facets` на проде для 52 языков (реальные значения — не
 * выдуманные). Что не подтверждено живыми данными (country, city, partner —
 * за исключением уже используемых `RU`/`spb`/`lo`), сюда не попадает: пустой
 * словарь честнее выдуманного (см. `scenarios.ts` — «Do NOT add
 * domain-level placeholders»).
 */

const REGISTRIES = {
  service: SERVICE_CONCEPTS,
  documentType: DOCUMENT_TYPE_CONCEPTS,
  country: COUNTRY_CONCEPTS,
  language: LANGUAGE_CONCEPTS,
  city: CITY_CONCEPTS,
  partner: PARTNER_CONCEPTS,
} as const;

describe('все словари внутренне согласованы', () => {
  it.each(Object.entries(REGISTRIES))('%s не бросает на assertVocabularyConsistency', (name, vocab) => {
    expect(() => assertVocabularyConsistency(vocab, name)).not.toThrow();
  });
});

describe('SERVICE_CONCEPTS — из TariffSection, единственного источника истины по услугам', () => {
  it.each(['translation', 'certification', 'apostille_spb', 'nostrification'])(
    'признаёт реальную услугу "%s"',
    (id) => {
      expect(isKnownConcept(SERVICE_CONCEPTS, id)).toBe(true);
    }
  );

  it('содержит все 12 значений TariffSection — ни больше, ни меньше', () => {
    expect(Object.keys(SERVICE_CONCEPTS)).toHaveLength(12);
  });

  it('выдуманная услуга отвергается', () => {
    expect(isKnownConcept(SERVICE_CONCEPTS, 'legalization_of_everything')).toBe(false);
  });

  it('русский синоним «перевод» разрешается в translation', () => {
    expect(resolveConceptAlias(SERVICE_CONCEPTS, 'перевод')).toBe('translation');
  });
});

describe('DOCUMENT_TYPE_CONCEPTS — из DocType, уже используемого в SCENARIOS', () => {
  it.each(['notary', 'opeka', 'zags', 'translation'])('признаёт "%s"', (id) => {
    expect(isKnownConcept(DOCUMENT_TYPE_CONCEPTS, id)).toBe(true);
  });
});

describe('COUNTRY_CONCEPTS — минимальный, только доказанно нужный', () => {
  it('признаёт RU (используется существующим тестом B1 kinds.test.ts)', () => {
    expect(isKnownConcept(COUNTRY_CONCEPTS, 'RU')).toBe(true);
  });

  it('двухэтапный контракт: resolve нормализует РЕГИСТР, isKnownConcept — нет', () => {
    // `RU` хранится ЗАГЛАВНЫМИ (страны — ISO alpha-2). `resolveConceptAlias`
    // приводит вход к каноническому виду ДО сохранения в профиль;
    // `isKnownConcept` затем сверяет уже канонический вид, а не сырой текст —
    // именно поэтому 'ru' проходит resolve, но не проходит прямую проверку.
    expect(resolveConceptAlias(COUNTRY_CONCEPTS, 'ru')).toBe('RU');
    expect(isKnownConcept(COUNTRY_CONCEPTS, 'ru')).toBe(false);
  });
});

describe('LANGUAGE_CONCEPTS — 52 реальных языка с прод /api/tariffs/facets + ru', () => {
  it('содержит все 52 языка матрицы плюс ru (сторона, не хранящаяся в Tariff.language)', () => {
    expect(Object.keys(LANGUAGE_CONCEPTS)).toHaveLength(53);
  });

  it.each([
    ['en', 'английский'],
    ['de', 'немецкий'],
    ['fr', 'французский'],
    ['zh', 'китайский'],
  ])('код "%s" разрешает русский алиас "%s"', (code, alias) => {
    expect(resolveConceptAlias(LANGUAGE_CONCEPTS, alias)).toBe(code);
  });

  it('ru используется существующим тестом B1 kinds.test.ts', () => {
    expect(isKnownConcept(LANGUAGE_CONCEPTS, 'ru')).toBe(true);
  });
});

describe('CITY_CONCEPTS — только регионы, уже доказанные в SCENARIOS', () => {
  it.each(['spb', 'lo'])('признаёт "%s"', (id) => {
    expect(isKnownConcept(CITY_CONCEPTS, id)).toBe(true);
  });
});

describe('PARTNER_CONCEPTS — намеренно пуст: подтверждённых партнёров пока нет', () => {
  it('пуст, а не выдуман', () => {
    expect(Object.keys(PARTNER_CONCEPTS)).toHaveLength(0);
  });
});
