import { describe, expect, it } from 'vitest';
import { buildTariffContext } from '@/lib/knowledge/tariff-context';
import type { TariffRecord } from '@/lib/knowledge/tariffs';

function tariff(overrides: Partial<TariffRecord>): TariffRecord {
  return {
    naturalKey: 'k',
    section: 'APOSTILLE_SPB',
    sectionTitle: 'Апостиль в СПб',
    serviceName: 'Апостиль',
    authority: null,
    termText: null,
    conditions: null,
    amount: 3500,
    amountKind: 'FIXED',
    percent: null,
    percentBase: null,
    baseFeeAmount: null,
    unit: 'PER_DOCUMENT',
    currency: 'RUB',
    priceText: '3500 ₽',
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    audience: 'ALL',
    footnote: null,
    language: null,
    complexityCategory: null,
    direction: null,
    turnaround: null,
    includesNotary: false,
    isActive: true,
    synonyms: [],
    ...overrides,
  } as TariffRecord;
}

// Аудит 2026-08-13 (1.3): в разделе APOSTILLE_SPB лежат и строки ЗАГС СПб,
// и строки ЗАГС ЛО — без фильтра ЛО-сроки попадали в промпт СПб-вопроса.
describe('buildTariffContext — строки чужого учреждения режутся', () => {
  const spbRow = tariff({
    naturalKey: 'spb',
    serviceName: 'Апостиль на свидетельство ЗАГС СПб',
    termText: '2 недели',
  });
  const loRow = tariff({
    naturalKey: 'lo',
    serviceName: 'Апостиль на свидетельство ЗАГС',
    termText: '1–1,5 недели',
    footnote: 'Документы, выданные в Ленинградской области, апостилируются в отдельном комитете.',
  });
  const neutralRow = tariff({
    naturalKey: 'neutral',
    serviceName: 'Апостиль на справку',
    termText: '2 недели',
  });

  it('вопрос про СПб не получает ЛО-строку, нейтральные строки остаются', () => {
    const context = buildTariffContext('Сколько стоит апостиль в КЗАГС СПб?', [
      spbRow,
      loRow,
      neutralRow,
    ]);
    expect(context.count).toBeGreaterThan(0);
    expect(context.block).not.toContain('Ленинградской области');
    expect(context.block).toContain('ЗАГС СПб');
    expect(context.block).toContain('Апостиль на справку');
  });

  it('вопрос без учреждения получает все строки', () => {
    const context = buildTariffContext('Сколько стоит апостиль на свидетельство?', [
      spbRow,
      loRow,
      neutralRow,
    ]);
    expect(context.block).toContain('Ленинградской области');
  });
});
