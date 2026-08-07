import { z } from 'zod';
import { extractedKnowledgeUnitSchema } from './extraction';
import type { PersistedKnowledgeUnit } from './identity-assignment';
import { nonBlankString } from './text';

/**
 * `ExtractedKnowledgeUnit` + три identity-поля (`identity-assignment.ts`).
 * `.and()`, не `.extend()`: `extractedKnowledgeUnitSchema` — `ZodEffects`
 * (несёт `superRefine` на facets/evidenceByField), у которого нет `.extend()`;
 * пересечение схем сохраняет обе проверки — базовую и добавленные ID-поля.
 */
export const persistedKnowledgeUnitSchema = extractedKnowledgeUnitSchema.and(
  z.strictObject({
    sourceBlockAnchor: nonBlankString('sourceBlockAnchor не может быть пустым'),
    unitId: nonBlankString('unitId не может быть пустым'),
    contentHash: nonBlankString('contentHash не может быть пустым'),
  })
);

type Assert<T extends true> = T;
type _PersistedUnitSchemaMatches = Assert<
  z.infer<typeof persistedKnowledgeUnitSchema> extends PersistedKnowledgeUnit ? true : false
>;
