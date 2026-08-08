import { describe, expect, it } from 'vitest';
import { triggerFactCatalog } from '../prompt-catalogs';

/**
 * `helperPresent` — единственный булев триггер-факт (TRIGGER_FACT_REGISTRY,
 * trigger-facts.ts). Потребители этого каталога расходятся в том, какого
 * типа значение им реально нужно от модели:
 * - query-frame-extractor.ts (PR D) просит СТРОКУ ("true"/"false") — сырое
 *   извлечение всегда типизировано как rawValue:string, парсинг в boolean
 *   происходит кодом (query-frame-builder.ts resolveTriggerFactRawValue).
 * - knowledge-unit-extractor.ts (PR E) передаёт значение НАПРЯМУЮ в
 *   `triggerConditionSchema` (переиспользован из B2, trigger.ts), где
 *   `equals` для helperPresent — `z.boolean()`. Просить модель за строку
 *   здесь значило бы гарантированно ловить SCHEMA_MISMATCH на каждом
 *   исключении с helperPresent — находка независимого ревью (Grok) этой
 *   сессии.
 */
describe('triggerFactCatalog', () => {
  it('по умолчанию (D-контекст) helperPresent описан как строка в кавычках', () => {
    const catalog = triggerFactCatalog();
    expect(catalog).toContain('"true"');
    expect(catalog).toContain('"false"');
  });

  it('с booleanAsJsonLiteral=true (E-контекст) helperPresent описан как JSON-литерал без кавычек', () => {
    const catalog = triggerFactCatalog({ booleanAsJsonLiteral: true });
    expect(catalog).not.toContain('"true"');
    expect(catalog).not.toContain('"false"');
    expect(catalog).toMatch(/\btrue\b.*\bfalse\b|\bfalse\b.*\btrue\b/);
  });

  it('оба варианта перечисляют все ключи TRIGGER_FACT_REGISTRY', () => {
    for (const catalog of [triggerFactCatalog(), triggerFactCatalog({ booleanAsJsonLiteral: true })]) {
      expect(catalog).toContain('privacyContext');
      expect(catalog).toContain('consentStatus');
      expect(catalog).toContain('reachability');
      expect(catalog).toContain('helperPresent');
    }
  });
});
