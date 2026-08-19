import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  corpusWhere,
  DEFAULT_CORPUS_ID,
  resolveCorpusId,
} from '../corpus';

/**
 * Изоляция корпусов (translation-0lr).
 *
 * ДО этого поля данные не разделялись НИЧЕМ: в схеме не было ни `tenantId`, ни
 * `organizationId`, фильтр по доменам в движке выключен намеренно (четыре
 * домена покрывали 161 правило из 163), а дерево сценариев знает только про
 * апостиль и переводы — всё остальное падало в открытый поиск по всей базе.
 * Практическое следствие, измеренное в песочнице: залив документ про ремонт
 * велосипедов в ту же базу, клиент бюро получал бы ответ из чужого документа.
 *
 * Здесь проверяется контракт разделителя. Сквозная проверка «велосипедное
 * знание не доходит до клиента бюро» требует живой БД и живёт в интеграционном
 * прогоне; тесты ниже стерегут то, что можно проверить детерминированно —
 * чтобы разделитель нельзя было незаметно ослабить рефакторингом.
 */
describe('resolveCorpusId()', () => {
  it('без явного значения — корпус по умолчанию, то есть сегодняшнее поведение бюро', () => {
    expect(resolveCorpusId()).toBe(DEFAULT_CORPUS_ID);
    expect(resolveCorpusId(undefined)).toBe(DEFAULT_CORPUS_ID);
    expect(resolveCorpusId(null)).toBe(DEFAULT_CORPUS_ID);
  });

  /**
   * Пустая строка НЕ должна означать «искать везде». Именно так выглядит
   * забытый параметр: значение технически передали, оно пустое, и предикат
   * `corpusId = ''` не совпал бы ни с чем — или, что хуже, был бы выброшен как
   * «пустой фильтр». Дефолт здесь безопаснее: хуже всего молча расширить
   * область поиска.
   */
  it('пустая строка и пробелы откатываются к дефолту, а не снимают фильтр', () => {
    expect(resolveCorpusId('')).toBe(DEFAULT_CORPUS_ID);
    expect(resolveCorpusId('   ')).toBe(DEFAULT_CORPUS_ID);
  });

  it('явный корпус уважается', () => {
    expect(resolveCorpusId('bike-shop')).toBe('bike-shop');
    expect(resolveCorpusId('  bike-shop  ')).toBe('bike-shop');
  });
});

describe('corpusWhere()', () => {
  it('всегда даёт непустой предикат — фильтр нельзя получить «никаким»', () => {
    // Пустой объект в Prisma означает «без ограничений». Если бы функция могла
    // его вернуть, изоляция исчезала бы молча, а вызывающий код выглядел бы
    // корректным: `...corpusWhere(x)` на месте.
    const where = corpusWhere(resolveCorpusId());
    expect(Object.keys(where)).toEqual(['corpusId']);
    expect(where.corpusId).toBe(DEFAULT_CORPUS_ID);
  });

  it('предикаты разных корпусов не совпадают', () => {
    expect(corpusWhere('aurora')).not.toEqual(corpusWhere('bike-shop'));
  });

  it('корпус бюро и чужой корпус — разные значения', () => {
    expect(resolveCorpusId('bike-shop')).not.toBe(DEFAULT_CORPUS_ID);
  });
});

describe('прокидка corpusId в запасные ветки поиска', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/ai/vector-search.ts'), 'utf8');

  it('searchSimilarChunks передаёт corpusId в pgvector и in-memory', () => {
    const start = src.indexOf('export async function searchSimilarChunks(');
    const end = src.indexOf('export async function searchByKeywords(');
    const fn = src.slice(start, end);
    expect(fn).toMatch(/searchSimilarChunksPgvector\([\s\S]*?corpusId/);
    expect((fn.match(/searchSimilarChunksInMemory\([\s\S]*?corpusId/g) ?? []).length).toBe(2);
  });

  it('searchByKeywords передаёт corpusId в оба запасных вызова', () => {
    const start = src.indexOf('export async function searchByKeywords(');
    const end = src.indexOf('async function searchByKeywordTerms(');
    const fn = src.slice(start, end);
    expect(fn).toContain('searchByKeywordTerms(query, domainSlugs, limit, scenarioAncestors, audience, corpusId)');
    expect((fn.match(/searchByKeywordTerms\([^)]*corpusId\)/g) ?? []).length).toBe(2);
  });
});
