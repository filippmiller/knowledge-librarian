import { describe, expect, it } from 'vitest';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import {
  applyReviewManifest,
  computeReviewedUnitHash,
  parseReviewManifest,
  type ReviewManifestEntry,
} from '../review-manifest';

/**
 * Committed review manifest — план §3 PR H [R4a], разрешение противоречия
 * «one-command H» против «ручной review в F».
 *
 * Порядок в `--mode=e2e`:
 * 1. DOCX извлекается ЗАНОВО;
 * 2. units сопоставляются с manifest по `unitId` (НЕ по якорю блока: у
 *    фрагментов одного абзаца якорь общий — см. describe ниже);
 * 3. решение человека переприменяется ТОЛЬКО при совпадении обоих хэшей —
 *    содержания и структуры целиком;
 * 4. новый, изменившийся или пропавший unit → EXTRACTION_GATE_FAIL, прогон стоит;
 * 5. дальше в retrieval идут только подтверждённые units.
 *
 * Смысл ворот: проверяется именно СВЕЖАЯ экстракция, но автоматика не
 * притворяется человеком. Человеческое `accept` не автоматизируется никак.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Не дольше 15 секунд подряд.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-1', 'не дольше 15 секунд'),
    evidenceByField: { statement: span('anchor-1', 'не дольше 15 секунд') },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId: 'u1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

function entry(overrides: Partial<ReviewManifestEntry> = {}): ReviewManifestEntry {
  return {
    sourceRuleId: 4,
    unitId: 'u1',
    sourceAnchor: 'block-1',
    decision: 'ACCEPT',
    reviewedContentHash: 'hash-1',
    reviewedUnitHash: computeReviewedUnitHash(unit()),
    reviewedBy: 'fixture-reviewer',
    reviewedAt: '2026-08-07T00:00:00+03:00',
    ...overrides,
  };
}

describe('applyReviewManifest — счастливый путь', () => {
  it('подтверждённый unit проходит дальше', () => {
    const result = applyReviewManifest([unit()], [entry()]);

    expect(result.ok).toBe(true);
    expect(result.confirmed.map((u) => u.unitId)).toEqual(['u1']);
    expect(result.failures).toEqual([]);
  });

  it('связывает unit с номером исходного правила', () => {
    const result = applyReviewManifest([unit()], [entry({ sourceRuleId: 4 })]);

    expect(result.sourceRuleByUnitId.get('u1')).toBe(4);
  });

  it('REJECT не пропускает unit в retrieval, но воротами не является', () => {
    const result = applyReviewManifest([unit()], [entry({ decision: 'REJECT' })]);

    expect(result.ok).toBe(true);
    expect(result.confirmed).toEqual([]);
  });

  /**
   * Найдено ревью Grok (C1). `EDIT` означает, что человек ОТВЕРГ извлечённый
   * текст и заменил его. Подтверждать при `EDIT` свежую экстракцию — значит
   * заново одобрить ровно тот текст, который человек забраковал. Манифест
   * пост-правочного тела не несёт, поэтому единственный честный исход —
   * остановить прогон, а не молча принять неисправленное.
   */
  it('EDIT останавливает прогон: манифест не несёт исправленного текста', () => {
    const result = applyReviewManifest([unit()], [entry({ decision: 'EDIT' })]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('edit_decision_unsupported');
    expect(result.confirmed).toEqual([]);
  });
});

/** Найдено ревью Grok (H1, M1, M2, M3). */
describe('applyReviewManifest — дрейф вне contentHash и вырожденные входы', () => {
  it('ЛОВИТ дрейф parentRuleRef, невидимый для contentHash', () => {
    const result = applyReviewManifest([unit({ parentRuleRef: 'DRIFTED' })], [entry()]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('reviewed_unit_changed');
  });

  it('ЛОВИТ дрейф title', () => {
    const result = applyReviewManifest([unit({ title: 'Другой заголовок' })], [entry()]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('reviewed_unit_changed');
  });

  it('ЛОВИТ появление uncertainties у ранее чистого unit', () => {
    const result = applyReviewManifest(
      [unit({ uncertainties: [{ kind: 'AMBIGUOUS_FACET', description: 'неясна фасета', quote: 'спорный текст' }] })],
      [entry()]
    );

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('reviewed_unit_changed');
  });

  it('пустая экстракция — сбой, а не вырожденный успех', () => {
    const result = applyReviewManifest([], []);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('empty_extraction');
  });

  it('дубль unitId во входе — сбой, а не двойное подтверждение', () => {
    const result = applyReviewManifest([unit(), unit()], [entry()]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('duplicate_unit_in_extraction');
  });

  it('при провале ворот связь unit→правило пуста: частичный успех не просачивается', () => {
    const result = applyReviewManifest(
      [unit(), unit({ unitId: 'u2', contentHash: 'x' })],
      [entry()]
    );

    expect(result.ok).toBe(false);
    expect(result.sourceRuleByUnitId.size).toBe(0);
  });
});

/**
 * Раздробленное правило — не исключение, а основной случай: план §0.3 прямо
 * требует, чтобы для Q04 выбранные units СОВМЕСТНО покрывали 15 сек / 30 сек /
 * 3 цикла. Такие фрагменты происходят из ОДНОГО абзаца, поэтому
 * `sourceBlockAnchor` у них общий (`computeSourceBlockAnchor` считается по
 * границам блока), а различает их `computeUnitId` через смещения evidence.
 * Сопоставление по якорю схлопнуло бы три решения человека в одно.
 */
describe('applyReviewManifest — раздробленное правило (несколько units в одном блоке)', () => {
  const fragments = [
    unit({ unitId: 'u-15s', contentHash: 'h15' }),
    unit({ unitId: 'u-30s', contentHash: 'h30' }),
    unit({ unitId: 'u-3c', contentHash: 'h3c' }),
  ];
  const decisions = [
    entry({
      unitId: 'u-15s',
      reviewedContentHash: 'h15',
      reviewedUnitHash: computeReviewedUnitHash(fragments[0]),
    }),
    entry({
      unitId: 'u-30s',
      reviewedContentHash: 'h30',
      reviewedUnitHash: computeReviewedUnitHash(fragments[1]),
    }),
    entry({
      unitId: 'u-3c',
      reviewedContentHash: 'h3c',
      reviewedUnitHash: computeReviewedUnitHash(fragments[2]),
    }),
  ];

  it('все три фрагмента одного абзаца подтверждаются', () => {
    const result = applyReviewManifest(fragments, decisions);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.confirmed.map((u) => u.unitId)).toEqual(['u-15s', 'u-30s', 'u-3c']);
  });

  it('все три связаны с номером исходного правила', () => {
    const result = applyReviewManifest(fragments, decisions);

    expect([...result.sourceRuleByUnitId.values()]).toEqual([4, 4, 4]);
  });

  it('изменение ОДНОГО фрагмента ловится, остальные не маскируют его', () => {
    const result = applyReviewManifest(
      [fragments[0], unit({ unitId: 'u-30s', contentHash: 'CHANGED' }), fragments[2]],
      decisions
    );

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.unitId)).toEqual(['u-30s']);
  });
});

describe('applyReviewManifest — EXTRACTION_GATE_FAIL', () => {
  it('НОВЫЙ unit, которого не было при ревью, останавливает прогон', () => {
    const result = applyReviewManifest(
      [unit(), unit({ unitId: 'u2', sourceBlockAnchor: 'block-2' })],
      [entry()]
    );

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('unit_absent_from_manifest');
  });

  it('ИЗМЕНИВШИЙСЯ unit (другой contentHash) останавливает прогон', () => {
    const result = applyReviewManifest([unit({ contentHash: 'hash-CHANGED' })], [entry()]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('content_hash_changed');
  });

  it('изменившийся unit НЕ попадает в confirmed — решение не переприменяется', () => {
    const result = applyReviewManifest([unit({ contentHash: 'hash-CHANGED' })], [entry()]);

    expect(result.confirmed).toEqual([]);
  });

  it('ПРОПАВШИЙ unit (есть в manifest, нет в экстракции) останавливает прогон', () => {
    const result = applyReviewManifest([], [entry()]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('unit_missing_from_extraction');
  });

  it('якорь в манифесте не совпадает с якорем unit — запись правлена руками', () => {
    const result = applyReviewManifest([unit()], [entry({ sourceAnchor: 'block-OTHER' })]);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('source_anchor_mismatch');
  });

  it('сообщает ВСЕ расхождения сразу — чинить по одному за прогон слишком дорого', () => {
    const result = applyReviewManifest(
      [unit({ contentHash: 'changed' }), unit({ unitId: 'u9', sourceBlockAnchor: 'block-9' })],
      [entry(), entry({ unitId: 'u5', sourceAnchor: 'block-5' })]
    );

    expect(new Set(result.failures.map((f) => f.code))).toEqual(
      new Set(['content_hash_changed', 'unit_absent_from_manifest', 'unit_missing_from_extraction'])
    );
  });
});

describe('parseReviewManifest — строгий разбор', () => {
  const line = (o: unknown) => JSON.stringify(o);

  it('разбирает валидную запись', () => {
    expect(parseReviewManifest(line(entry()))).toEqual([entry()]);
  });

  it('отвергает sourceRuleId вне 1–10', () => {
    expect(() => parseReviewManifest(line(entry({ sourceRuleId: 11 })))).toThrow();
  });

  it('отвергает неизвестное решение', () => {
    expect(() =>
      parseReviewManifest(line({ ...entry(), decision: 'MAYBE' }))
    ).toThrow();
  });

  it('отвергает лишнее поле — манифест не место для подсказок', () => {
    expect(() => parseReviewManifest(line({ ...entry(), hint: 'ответ на Q04' }))).toThrow();
  });

  it('отвергает дубль unitId — два мнения по одному unit неразрешимы', () => {
    expect(() => parseReviewManifest(`${line(entry())}\n${line(entry())}`)).toThrow(/u1/);
  });
});
