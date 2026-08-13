import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJsonl, toJsonl } from '../jsonl';

const itemSchema = z.strictObject({ id: z.string(), value: z.number() });

describe('toJsonl / parseJsonl — round-trip, читаемо без тулинга', () => {
  it('пустой массив -> пустая строка', () => {
    expect(toJsonl([])).toBe('');
  });

  it('round-trip сохраняет данные', () => {
    const items = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
    const text = toJsonl(items);
    expect(parseJsonl(text, itemSchema)).toEqual(items);
  });

  it('одна строка = один валидный JSON-объект (plain JSONL, читаемо построчно)', () => {
    const text = toJsonl([{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(() => JSON.parse(lines[1])).not.toThrow();
  });

  it('пустые строки между записями игнорируются при parse', () => {
    const text = '{"id":"a","value":1}\n\n{"id":"b","value":2}\n';
    expect(parseJsonl(text, itemSchema)).toEqual([{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
  });

  it('битая строка JSON — ошибка с номером строки, не тихий пропуск', () => {
    const text = '{"id":"a","value":1}\nне json\n';
    expect(() => parseJsonl(text, itemSchema)).toThrow(/строк.*2|line 2/i);
  });

  it('строка, не проходящая схему, — ошибка с номером строки, не тихий пропуск', () => {
    const text = '{"id":"a","value":1}\n{"id":"b","value":"не число"}\n';
    expect(() => parseJsonl(text, itemSchema)).toThrow(/строк.*2|line 2/i);
  });
});
