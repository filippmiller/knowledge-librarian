import { describe, expect, it } from 'vitest';
import {
  assertVocabularyConsistency,
  isKnownConcept,
  resolveConceptAlias,
  type ConceptVocabulary,
} from '../concepts';

const SAMPLE: ConceptVocabulary = {
  translation: { id: 'translation', label: 'Перевод', aliases: ['перевод', 'translate'] },
  apostille: { id: 'apostille', label: 'Апостиль' },
};

describe('isKnownConcept', () => {
  it('признаёт id, объявленный в словаре', () => {
    expect(isKnownConcept(SAMPLE, 'translation')).toBe(true);
  });

  it('отвергает id, которого в словаре нет', () => {
    expect(isKnownConcept(SAMPLE, 'legalization')).toBe(false);
  });
});

describe('resolveConceptAlias', () => {
  it('канонический id разрешается сам в себя', () => {
    expect(resolveConceptAlias(SAMPLE, 'translation')).toBe('translation');
  });

  it('известный алиас разрешается в канонический id', () => {
    expect(resolveConceptAlias(SAMPLE, 'перевод')).toBe('translation');
  });

  it('неизвестный текст не разрешается ни во что', () => {
    expect(resolveConceptAlias(SAMPLE, 'легализация')).toBeUndefined();
  });

  it('концепт без алиасов всё равно разрешается по своему id', () => {
    expect(resolveConceptAlias(SAMPLE, 'apostille')).toBe('apostille');
  });

  it('точное совпадение с id одного концепта побеждает алиас другого — не зависит от порядка ключей', () => {
    // 'b' объявлен ПЕРЕД 'a' и несёт алиас, равный id 'a'. Порядок обхода
    // Object.values не должен решать, что вернётся — точный id всегда весомее
    // чужого алиаса.
    const shadow: ConceptVocabulary = {
      b: { id: 'b', label: 'B концепт', aliases: ['a'] },
      a: { id: 'a', label: 'A концепт' },
    };
    expect(resolveConceptAlias(shadow, 'a')).toBe('a');
  });
});

describe('assertVocabularyConsistency', () => {
  it('согласованный словарь не бросает', () => {
    expect(() => assertVocabularyConsistency(SAMPLE, 'sample')).not.toThrow();
  });

  it('ключ карты обязан совпадать с id записи — иначе тихий дрейф', () => {
    const broken: ConceptVocabulary = {
      translation: { id: 'apostille', label: 'Апостиль' },
    };
    expect(() => assertVocabularyConsistency(broken, 'sample')).toThrow(/translation/);
  });

  it('один и тот же алиас на двух концептах — неоднозначность, не тихий выбор первого', () => {
    const ambiguous: ConceptVocabulary = {
      translation: { id: 'translation', label: 'Перевод', aliases: ['перевод'] },
      apostille: { id: 'apostille', label: 'Апостиль', aliases: ['перевод'] },
    };
    expect(() => assertVocabularyConsistency(ambiguous, 'sample')).toThrow(/перевод/);
  });

  it('пустой по смыслу алиас («   ») — тот же баг, что пустая непроверенная строка', () => {
    const blank: ConceptVocabulary = {
      translation: { id: 'translation', label: 'Перевод', aliases: ['   '] },
    };
    expect(() => assertVocabularyConsistency(blank, 'sample')).toThrow(/translation/);
  });

  it('пустая по смыслу метка — та же дыра на другом поле', () => {
    const blank: ConceptVocabulary = {
      translation: { id: 'translation', label: '  ' },
    };
    expect(() => assertVocabularyConsistency(blank, 'sample')).toThrow(/translation/);
  });

  it('алиас, равный id ДРУГОГО концепта, — та же неоднозначность, что алиас на двоих', () => {
    const shadow: ConceptVocabulary = {
      a: { id: 'a', label: 'A концепт' },
      b: { id: 'b', label: 'B концепт', aliases: ['a'] },
    };
    expect(() => assertVocabularyConsistency(shadow, 'sample')).toThrow(/a/);
  });
});
