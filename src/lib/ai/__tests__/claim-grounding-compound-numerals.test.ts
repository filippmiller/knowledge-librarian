import { describe, expect, it } from 'vitest';
import { checkClaimGrounding, extractRiskyClaims } from '../claim-grounding';

/**
 * Найдено адверсариальным ревью (ChatGPT) поверх H slice 5a, подтверждено
 * эмпирическим прогоном перед исправлением.
 *
 * `GAP` («одно необязательное слово между числом и единицей», нужен для
 * «15 полных секунд») не отличал обычное слово-заполнитель от ВТОРОГО
 * числительного слова. «Двадцати пяти секунд» разбиралось как числительное
 * «двадцати» (20) + GAP молча съедал «пяти» как будто это прилагательное —
 * составное числительное теряло вторую часть целиком, а не отвергалось.
 *
 * Последствие — не только неверное значение, а СКВОЗНАЯ дыра: «тридцати двух
 * минут» против источника «30 минут» давало grounded=true, потому что после
 * потери «двух» оставалось верное «тридцать» (30). Выдуманное число проходило
 * заземление, если его первое слово совпадало с реальным числом источника.
 */

const secondsSource = ['Не дольше 15 секунд подряд.'];

describe('составные числительные (десяток + единица)', () => {
  it('«двадцать пять» разбирается как 25, а не как 20 с потерянным хвостом', () => {
    const claims = extractRiskyClaims('Не дольше двадцати пяти секунд.');

    expect(claims).toEqual([
      expect.objectContaining({ value: '25', unit: 'second' }),
    ]);
  });

  it('«тридцать два» разбирается как 32, а не усекается до 30', () => {
    const claims = extractRiskyClaims('Не дольше тридцати двух минут.');

    expect(claims).toEqual([expect.objectContaining({ value: '32', unit: 'minute' })]);
  });

  it('РЕГРЕССИЯ БЕЗОПАСНОСТИ: выдуманные «тридцать два» не проходят заземление против source «30»', () => {
    const result = checkClaimGrounding('Не дольше тридцати двух минут.', [
      'Не дольше 30 минут.',
    ]);

    expect(result.grounded).toBe(false);
    expect(result.ungrounded).toEqual([expect.objectContaining({ value: '32' })]);
  });

  it('верное составное число («двадцать пять») проходит, когда источник совпадает', () => {
    const result = checkClaimGrounding('Не дольше двадцати пяти секунд.', [
      'Не дольше 25 секунд.',
    ]);

    expect(result.grounded).toBe(true);
  });

  it('«двадцати пяти секунд» верно провален против source «15 секунд» — по правильной причине', () => {
    const result = checkClaimGrounding('Не дольше двадцати пяти секунд.', secondsSource);

    expect(result.grounded).toBe(false);
    // Причина обязана быть «25 не подтверждено», а не случайно совпавшее «20».
    expect(result.ungrounded).toEqual([expect.objectContaining({ value: '25' })]);
  });
});

describe('простые числительные не ломаются составной обработкой', () => {
  it('одиночное «пятнадцати секунд» по-прежнему даёт 15', () => {
    expect(extractRiskyClaims('Не дольше пятнадцати секунд.')).toEqual([
      expect.objectContaining({ value: '15', unit: 'second' }),
    ]);
  });

  it('«три цикла» по-прежнему даёт 3, не путается с «тридцать»', () => {
    expect(extractRiskyClaims('Максимум три цикла.')).toEqual([
      expect.objectContaining({ value: '3', unit: 'cycle' }),
    ]);
  });
});

describe('составное числительное с нестандартным пробелом между частями', () => {
  it('РЕГРЕССИЯ (найдено вторым ревью): двойной пробел не создаёт паразитное «5» рядом с «25»', () => {
    const claims = extractRiskyClaims('Не дольше двадцати  пяти секунд.');

    expect(claims).toEqual([expect.objectContaining({ value: '25', unit: 'second' })]);
  });

  it('таб между частями составного числа тоже не создаёт паразитное значение', () => {
    const claims = extractRiskyClaims('Не дольше двадцати\tпяти секунд.');

    expect(claims).toEqual([expect.objectContaining({ value: '25', unit: 'second' })]);
  });
});

describe('обычное слово-заполнитель между числом и единицей не задето', () => {
  it('«15 полных секунд» по-прежнему даёт 15 — заполнитель не числительное', () => {
    expect(extractRiskyClaims('Не дольше 15 полных секунд.')).toEqual([
      expect.objectContaining({ value: '15', unit: 'second' }),
    ]);
  });

  it('«трёх таких циклов» по-прежнему даёт 3', () => {
    expect(extractRiskyClaims('Максимум трёх таких циклов.')).toEqual([
      expect.objectContaining({ value: '3', unit: 'cycle' }),
    ]);
  });
});
