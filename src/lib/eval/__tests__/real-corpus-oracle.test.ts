import { describe, expect, it } from 'vitest';

import {
  factPresent,
  normalizeForFactMatch,
  parseRealCorpusOracle,
} from '../real-corpus-oracle';

const CASE = {
  id: 'A01',
  question: 'Где апостилировать свидетельство о браке, выданное в Санкт-Петербурге?',
  expect: 'ANSWER',
  requiredFacts: ['Фурштатская'],
  forbiddenFacts: ['МинЮст'],
  expectedSourceDocs: ['Апостил'],
  rationale: 'тетрадь стажёра, с. 10',
  ownerValidated: true,
};

const line = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...CASE, ...overrides });

describe('parseRealCorpusOracle', () => {
  it('разбирает валидный кейс', () => {
    const [parsed] = parseRealCorpusOracle(line());
    expect(parsed.id).toBe('A01');
    expect(parsed.forbiddenFacts).toEqual(['МинЮст']);
    expect(parsed.ownerValidated).toBe(true);
  });

  it('пустые строки пропускаются, кейсы не теряются', () => {
    expect(parseRealCorpusOracle(`${line()}\n\n${line({ id: 'A02' })}\n`)).toHaveLength(2);
  });

  it('ANSWER без requiredFacts отвергается — такой кейс прошёл бы на любом ответе', () => {
    expect(() => parseRealCorpusOracle(line({ requiredFacts: [] }))).toThrow(/не проверяет ничего/);
  });

  it('CLARIFY без requiredFacts допустим — там проверяется диспозиция', () => {
    expect(parseRealCorpusOracle(line({ expect: 'CLARIFY', requiredFacts: [] }))).toHaveLength(1);
  });

  it('дубль id — исключение, а не тихая перезапись', () => {
    expect(() => parseRealCorpusOracle(`${line()}\n${line()}`)).toThrow(/дубль id/);
  });

  it('отсутствие ownerValidated — исключение: черновик нельзя выдать за проверенный факт', () => {
    const { ownerValidated: _omit, ...withoutFlag } = CASE;
    expect(() => parseRealCorpusOracle(JSON.stringify(withoutFlag))).toThrow(/ownerValidated/);
  });

  it('отсутствие rationale — исключение: обоснование проверяет человек', () => {
    expect(() => parseRealCorpusOracle(line({ rationale: '  ' }))).toThrow(/rationale/);
  });

  it('неизвестный expect отвергается', () => {
    expect(() => parseRealCorpusOracle(line({ expect: 'MAYBE' }))).toThrow(/expect=/);
  });

  it('битый JSON называет номер строки', () => {
    expect(() => parseRealCorpusOracle(`${line()}\n{не json`)).toThrow(/строка 2/);
  });

  it('пустой файл — исключение, а не ноль кейсов', () => {
    expect(() => parseRealCorpusOracle('\n \n')).toThrow(/ни одного кейса/);
  });
});

describe('factPresent', () => {
  it('регистр и пробелы не значимы', () => {
    expect(factPresent('Адрес: ул. ФУРШТАТСКАЯ,   52', 'фурштатская, 52')).toBe(true);
  });

  it('отрицание НЕ схлопывается с утверждением', () => {
    // Морфологическая «умная» нормализация сделала бы эти строки совпадающими
    // и превратила бы провал в успех. Сравнение обязано остаться буквальным.
    expect(factPresent('апостиль ставится не на оригинал', 'ставится на оригинал')).toBe(false);
  });

  it('отсутствующий факт не находится', () => {
    expect(factPresent('Обратитесь в КЗАГС', 'МинЮст')).toBe(false);
  });

  it('normalizeForFactMatch схлопывает только пробельные последовательности', () => {
    expect(normalizeForFactMatch('  А\n\tБ   В ')).toBe('а б в');
  });
});
