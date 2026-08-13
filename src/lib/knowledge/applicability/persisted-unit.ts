import { z } from 'zod';
import { checkExtractionCoreInvariants, extractedKnowledgeUnitCoreSchema } from './extraction';
import type { PersistedKnowledgeUnit } from './identity-assignment';
import { nonBlankString } from './text';

/**
 * `extractedKnowledgeUnitCoreSchema` (общие поля сырого и persisted unit'а,
 * `extraction.ts`) + четыре identity-поля persisted-слоя. `.extend()`, не
 * `.and()` со СЫРОЙ схемой: сырая схема несёт `extractionRef`/
 * `parentExtractionRef`, которые НЕ переживают persistence (preflight C,
 * translation-djc) — persisted unit несёт вместо них `sourceBlockAnchor`/
 * `unitId`/`contentHash`/`parentRuleRef`. `checkExtractionCoreInvariants` —
 * та же функция, что применяет сырая схема, не копия проверки.
 */
export const persistedKnowledgeUnitSchema = extractedKnowledgeUnitCoreSchema
  .extend({
    sourceBlockAnchor: nonBlankString('sourceBlockAnchor не может быть пустым'),
    unitId: nonBlankString('unitId не может быть пустым'),
    contentHash: nonBlankString('contentHash не может быть пустым'),
    parentRuleRef: nonBlankString('parentRuleRef не может быть пустой строкой').nullable(),
  })
  .superRefine(checkExtractionCoreInvariants);

type Assert<T extends true> = T;
type _PersistedUnitSchemaMatches = Assert<
  z.infer<typeof persistedKnowledgeUnitSchema> extends PersistedKnowledgeUnit ? true : false
>;
