import { describe, expect, it } from 'vitest';
import { searchLexical } from '../lexical-search';

/**
 * In-memory аналог `searchByKeywords` (vector-search.ts) — тот SQL по
 * DocChunk невызываем над in-memory JSONL (PR G). Та же токенизация
 * (нижний регистр, кириллица+латиница, слова короче 3 символов отброшены).
 */

describe('searchLexical', () => {
  const CANDIDATES = [
    { id: 'a', text: 'Апостиль на свидетельство о рождении в СПб' },
    { id: 'b', text: 'Перевод паспорта на английский язык' },
    { id: 'c', text: 'Апостиль на диплом в Москве' },
  ];

  it('находит кандидатов по пересечению слов, сортирует по убыванию совпадений', () => {
    const result = searchLexical('апостиль диплом', CANDIDATES);
    expect(result[0].id).toBe('c'); // "апостиль" + "диплом" = 2 совпадения
    expect(result.map((r) => r.id)).toContain('a'); // только "апостиль" = 1
  });

  it('кандидат без единого совпадения не попадает в результат', () => {
    const result = searchLexical('апостиль', CANDIDATES);
    expect(result.map((r) => r.id)).not.toContain('b');
  });

  it('регистр не важен', () => {
    const result = searchLexical('АПОСТИЛЬ', CANDIDATES);
    expect(result.map((r) => r.id)).toContain('a');
  });

  it('слова короче 3 символов игнорируются (как в searchByKeywords)', () => {
    const result = searchLexical('на в о', CANDIDATES);
    expect(result).toEqual([]);
  });

  it('пустой запрос — пустой результат', () => {
    expect(searchLexical('', CANDIDATES)).toEqual([]);
  });

  it('пустой список кандидатов — пустой результат', () => {
    expect(searchLexical('апостиль', [])).toEqual([]);
  });
});
