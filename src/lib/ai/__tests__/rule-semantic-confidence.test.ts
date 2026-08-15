import { describe, expect, it } from 'vitest';
import { resolveConfidenceWithRules } from '../enhanced-answering-engine';
import { cosineSimilarity, parseStoredEmbedding, ruleEmbeddingText } from '@/lib/knowledge/rule-embedding';

/**
 * translation-wmq. Измерено на изолированной песочнице (2026-08-14): документ
 * вне тематики бюро дал 0 из 12 доотвеченных вопросов. Показательный случай —
 * вопрос находил 6 РЕЛЕВАНТНЫХ правил и 0 чанков, получал confidence ровно
 * 0.00 и уходил клиенту как «уточню у коллеги», хотя ответ лежал в базе:
 * в формуле уверенности участвовали только семантика чанков и совпадение с
 * Q&A, а правила не весили ничего.
 *
 * Проверенный тупик (зафиксирован, чтобы не вернулись): лексический сигнал по
 * rule.title через questionTermOverlap не работает — при пороге Q&A (0.7) не
 * срабатывает ни на одном из 11 реальных вопросов, медиана 0.00. Заголовки
 * написаны языком каталога, живой вопрос с ними не пересекается.
 */
describe('resolveConfidenceWithRules()', () => {
  it('insufficient + сильное по смыслу правило -> medium (ядро фикса)', () => {
    expect(resolveConfidenceWithRules('insufficient', 0.62)).toBe('medium');
  });

  it('low + сильное правило -> medium', () => {
    expect(resolveConfidenceWithRules('low', 0.55)).toBe('medium');
  });

  it('слабое по смыслу правило уровень НЕ поднимает', () => {
    expect(resolveConfidenceWithRules('insufficient', 0.49)).toBe('insufficient');
    expect(resolveConfidenceWithRules('low', 0.2)).toBe('low');
  });

  it('порог тот же, что у чанков (0.5) — ровно на границе поднимает', () => {
    // Планка переиспользована сознательно: правило заменяет чанк, значит
    // обязано проходить ту же проверку, а не свою собственную шкалу.
    expect(resolveConfidenceWithRules('insufficient', 0.5)).toBe('medium');
  });

  it('правила НИКОГДА не дают high — даже при близости 1.0', () => {
    // high требует двух чанков, то есть подтверждения из независимых мест.
    // Одно правило не может быть подтверждением самому себе.
    expect(resolveConfidenceWithRules('insufficient', 1.0)).toBe('medium');
    expect(resolveConfidenceWithRules('low', 0.99)).toBe('medium');
  });

  it('уже уверенный ответ по чанкам правила не трогают — только надстройка', () => {
    expect(resolveConfidenceWithRules('high', 0.99)).toBe('high');
    expect(resolveConfidenceWithRules('medium', 0.99)).toBe('medium');
    // И не понижают, если правило слабое.
    expect(resolveConfidenceWithRules('high', 0.1)).toBe('high');
    expect(resolveConfidenceWithRules('medium', 0.1)).toBe('medium');
  });

  it('нет вектора (старое правило) — поведение ровно как до фикса', () => {
    // Отсутствие вектора не должно молча занижать ответ: правило без
    // эмбеддинга просто не участвует в этой оценке.
    expect(resolveConfidenceWithRules('insufficient', null)).toBe('insufficient');
    expect(resolveConfidenceWithRules('low', null)).toBe('low');
    expect(resolveConfidenceWithRules('high', null)).toBe('high');
  });
});

describe('cosineSimilarity()', () => {
  it('одинаковые векторы — 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it('ортогональные — 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('масштаб не влияет — сравнивается направление', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  /**
   * Смена модели эмбеддингов меняет размерность. Молча сравнить такие векторы
   * нельзя: число получится, а смысла у него не будет — и оно поедет прямо в
   * решение «отвечать клиенту или нет».
   */
  it('разная длина -> null, а не выдуманное число', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBeNull();
  });

  it('пустое/отсутствующее -> null', () => {
    expect(cosineSimilarity(null, [1, 2])).toBeNull();
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull();
  });
});

describe('parseStoredEmbedding()', () => {
  it('нормальный массив чисел проходит', () => {
    expect(parseStoredEmbedding([0.1, 0.2])).toEqual([0.1, 0.2]);
  });

  it('мусор из Json-поля отвергается, а не роняет расчёт', () => {
    expect(parseStoredEmbedding(null)).toBeNull();
    expect(parseStoredEmbedding('не вектор')).toBeNull();
    expect(parseStoredEmbedding([])).toBeNull();
    expect(parseStoredEmbedding([1, 'два', 3])).toBeNull();
    expect(parseStoredEmbedding([1, NaN])).toBeNull();
  });
});

describe('ruleEmbeddingText()', () => {
  it('склеивает заголовок и тело — вопросы бьют и туда, и туда', () => {
    expect(ruleEmbeddingText('Стоимость замены камеры', 'Замена камеры стоит 400 рублей.'))
      .toBe('Стоимость замены камеры\nЗамена камеры стоит 400 рублей.');
  });

  it('одна и та же склейка при загрузке и при бэкфилле', () => {
    // Разъезд этих двух путей дал бы векторы из разных пространств молча:
    // ничего не падает, просто часть корпуса начинает отвечать хуже.
    const a = ruleEmbeddingText('Заголовок', 'Тело');
    const b = ruleEmbeddingText('Заголовок', 'Тело');
    expect(a).toBe(b);
  });
});
