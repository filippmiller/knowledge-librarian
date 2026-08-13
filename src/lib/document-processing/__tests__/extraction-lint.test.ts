import { describe, expect, it } from 'vitest';
import { lintRule } from '@/lib/document-processing/extraction-lint';

describe('lintRule — polarity_conflict', () => {
  it('помечает правило, у которого тело инвертирует собственную цитату', () => {
    const warnings = lintRule({
      ruleCode: 'R-INV',
      title: 'Запись на подачу',
      body: 'Для подачи документов в КЗАГС предварительная запись требуется.',
      sourceQuote: 'ЗАПИСЬ НА ПОДАЧУ НЕ ТРЕБУЕТСЯ!!! Можно прийти в часы приёма.',
    });
    expect(warnings.some((w) => w.kind === 'polarity_conflict')).toBe(true);
  });

  it('не помечает согласованные заголовок, цитату и тело', () => {
    const warnings = lintRule({
      ruleCode: 'R-OK',
      title: 'Запись не требуется',
      body: 'Запись на подачу не требуется, документы принимают в порядке живой очереди.',
      sourceQuote: 'ЗАПИСЬ НА ПОДАЧУ НЕ ТРЕБУЕТСЯ!!! Можно прийти в часы приёма.',
    });
    expect(warnings.some((w) => w.kind === 'polarity_conflict')).toBe(false);
  });

  it('не помечает смешанное предложение, если цитата про один из двух предикатов', () => {
    const warnings = lintRule({
      ruleCode: 'R-MIX',
      title: 'Документы на подачу',
      body: 'Паспорт требуется, запись не требуется.',
      sourceQuote: 'Запись на подачу не требуется. Паспорт возьмите с собой.',
    });
    expect(warnings.some((w) => w.kind === 'polarity_conflict')).toBe(false);
  });
});

describe('lintRule — адрес в теле должен быть в цитате', () => {
  it('ловит подмену адреса, которую числовая проверка пропускает', () => {
    const warnings = lintRule({
      ruleCode: 'R-ADDR',
      title: 'Адрес Минюста',
      body: 'Минюст принимает документы по адресу Исаакиевская площадь 11.',
      sourceQuote: 'Приём документов Минюста: ул. Оптиков, 35к1.',
    });
    expect(warnings.some((w) => w.kind === 'hallucinated_fact' && /исаакиевская/i.test(w.detail))).toBe(
      true
    );
  });
});
