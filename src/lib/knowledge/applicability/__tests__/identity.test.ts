import { describe, expect, it } from 'vitest';
import {
  computeContentHash,
  computeSourceBlockAnchor,
  computeUnitId,
  resolveEvidenceOffsets,
} from '../identity';
import type { ExtractedKnowledgeUnit } from '../extraction';

/**
 * PR F acceptance criteria (Beads translation-179 / plan §3 PR F):
 * - unitId стабилен между двумя прогонами по тому же revision при изменённой
 *   формулировке statement (регрессионный тест: тот же unitId, другой contentHash);
 * - evidence quote детерминированно разрешается ОБРАТНО в offsets, без эвристик;
 * - изменение span/kind меняет unitId (это и есть EXTRACTION_GATE_FAIL сигнал).
 */

describe('computeSourceBlockAnchor — детерминирован, из pre-LLM полей', () => {
  it('одинаковые входы дают одинаковый anchor', () => {
    const a = computeSourceBlockAnchor('rev-1', 'section.1', 0, 100);
    const b = computeSourceBlockAnchor('rev-1', 'section.1', 0, 100);
    expect(a).toBe(b);
  });

  it.each([
    ['sourceRevisionHash', ['rev-2', 'section.1', 0, 100]],
    ['sectionPath', ['rev-1', 'section.2', 0, 100]],
    ['blockStart', ['rev-1', 'section.1', 5, 100]],
    ['blockEnd', ['rev-1', 'section.1', 0, 200]],
  ])('меняется, если меняется %s', (_field, args) => {
    const base = computeSourceBlockAnchor('rev-1', 'section.1', 0, 100);
    const changed = computeSourceBlockAnchor(
      args[0] as string,
      args[1] as string,
      args[2] as number,
      args[3] as number
    );
    expect(changed).not.toBe(base);
  });
});

describe('resolveEvidenceOffsets — точное вхождение, без эвристик', () => {
  const TEXT = 'Раздражение кожи снимают в уединённом месте. Не более 3 дней подряд.';

  it('находит единственное вхождение цитаты', () => {
    const result = resolveEvidenceOffsets(TEXT, 'уединённом месте');
    expect(result).not.toBeNull();
    expect(TEXT.slice(result!.start, result!.end)).toBe('уединённом месте');
  });

  it('цитата, которой нет дословно в тексте (LLM исказила), — null, не эвристика', () => {
    // "уединенном" без Ё — не то же самое, что "уединённом" в тексте.
    const result = resolveEvidenceOffsets(TEXT, 'уединенном месте');
    expect(result).toBeNull();
  });

  it('пустая цитата — null (нечего резолвить)', () => {
    expect(resolveEvidenceOffsets(TEXT, '')).toBeNull();
  });

  it('цитата, встречающаяся НЕСКОЛЬКО раз, — null: тихий выбор первого вхождения мог бы указать не на то место (находка ревью этого PR)', () => {
    const repeated = 'кожа кожа кожа';
    expect(resolveEvidenceOffsets(repeated, 'кожа')).toBeNull();
  });

  it('вложенное совпадение: "дней" внутри "через 3 дней" — если "дней" встречается и отдельно в тексте, это тоже неоднозначность, не первое вхождение', () => {
    const withNestedMatch = 'через 3 дней придёт ответ. дней осталось немного.';
    // "дней" встречается дважды (внутри "3 дней" и отдельно дальше) — не
    // должно молча резолвиться в первое из двух непроверяемых совпадений.
    expect(resolveEvidenceOffsets(withNestedMatch, 'дней')).toBeNull();
  });
});

describe('computeUnitId — post-extraction, устойчив к перефразировке', () => {
  it('одинаковые (anchor, start, end, kind) дают одинаковый unitId', () => {
    const a = computeUnitId('anchor-1', 10, 40, 'PROCEDURE_STEP');
    const b = computeUnitId('anchor-1', 10, 40, 'PROCEDURE_STEP');
    expect(a).toBe(b);
  });

  it.each([
    ['sourceBlockAnchor', ['anchor-2', 10, 40, 'PROCEDURE_STEP']],
    ['resolvedEvidenceStart', ['anchor-1', 11, 40, 'PROCEDURE_STEP']],
    ['resolvedEvidenceEnd', ['anchor-1', 10, 41, 'PROCEDURE_STEP']],
    ['kind', ['anchor-1', 10, 40, 'EXCEPTION_RULE']],
  ])('меняется, если меняется %s — это и есть сигнал EXTRACTION_GATE_FAIL', (_field, args) => {
    const base = computeUnitId('anchor-1', 10, 40, 'PROCEDURE_STEP');
    const changed = computeUnitId(
      args[0] as string,
      args[1] as number,
      args[2] as number,
      args[3] as ExtractedKnowledgeUnit['kind']
    );
    expect(changed).not.toBe(base);
  });
});

describe('computeContentHash — fingerprint содержания, НЕ identity', () => {
  const BASE = {
    statement: 'Не более 3 дней подряд.',
    facets: { scenario: 'apostille.zags.spb' } as ExtractedKnowledgeUnit['facets'],
    triggerCondition: null,
    numericConstraint: { factKey: 'максимум суток', value: 3, unit: 'сутки' },
  };

  it('одинаковое содержание — одинаковый hash', () => {
    expect(computeContentHash(BASE)).toBe(computeContentHash({ ...BASE }));
  });

  it('регрессия acceptance criterion: перефразировка statement МЕНЯЕТ contentHash (это его смысл), но НЕ unitId (проверено отдельно — unitId вообще не видит statement)', () => {
    const rephrased = { ...BASE, statement: 'Продолжительность — максимум трое суток.' };
    expect(computeContentHash(rephrased)).not.toBe(computeContentHash(BASE));
  });

  it('порядок ключей facets не влияет на hash — детерминированная сериализация', () => {
    const a = { ...BASE, facets: { scenario: 'apostille.zags.spb', service: 'apostille_spb' } as ExtractedKnowledgeUnit['facets'] };
    const b = { ...BASE, facets: { service: 'apostille_spb', scenario: 'apostille.zags.spb' } as ExtractedKnowledgeUnit['facets'] };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('изменение numericConstraint меняет hash', () => {
    const changed = { ...BASE, numericConstraint: { factKey: 'максимум суток', value: 5, unit: 'сутки' } };
    expect(computeContentHash(changed)).not.toBe(computeContentHash(BASE));
  });

  it('порядок конъюнктов triggerCondition.all НЕ влияет на hash — это союз "И", смысл не зависит от порядка (находка ревью этого PR: без сортировки был бы ложный drift)', () => {
    const order1 = {
      ...BASE,
      triggerCondition: {
        all: [
          { fact: 'privacyContext' as const, equals: 'PUBLIC' as const },
          { fact: 'consentStatus' as const, equals: 'ABSENT' as const },
        ],
      },
    };
    const order2 = {
      ...BASE,
      triggerCondition: {
        all: [
          { fact: 'consentStatus' as const, equals: 'ABSENT' as const },
          { fact: 'privacyContext' as const, equals: 'PUBLIC' as const },
        ],
      },
    };
    expect(computeContentHash(order1)).toBe(computeContentHash(order2));
  });

  it('но реальное изменение состава triggerCondition.all всё ещё меняет hash', () => {
    const withOneClause = {
      ...BASE,
      triggerCondition: { all: [{ fact: 'privacyContext' as const, equals: 'PUBLIC' as const }] },
    };
    const withTwoClauses = {
      ...BASE,
      triggerCondition: {
        all: [
          { fact: 'privacyContext' as const, equals: 'PUBLIC' as const },
          { fact: 'consentStatus' as const, equals: 'ABSENT' as const },
        ],
      },
    };
    expect(computeContentHash(withOneClause)).not.toBe(computeContentHash(withTwoClauses));
  });
});
