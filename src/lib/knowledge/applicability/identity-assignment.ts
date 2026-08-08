import {
  computeContentHash,
  computeSourceBlockAnchor,
  computeUnitId,
  resolveEvidenceOffsets,
} from './identity';
import type { ExtractedKnowledgeUnit } from './extraction';

/**
 * Реальное место unit'а в источнике — по нему считается `sourceBlockAnchor`.
 * `anchor` здесь — та же caller-метка, что `unit.sourceSpan.anchor` (PR E);
 * связь по этому полю чисто для lookup, посчитанный `sourceBlockAnchor`
 * (`identity.ts`) — отдельное, криптографическое значение, не сама метка.
 */
export interface SourceBlockLocation {
  readonly anchor: string;
  readonly text: string;
  readonly sectionPath: string;
  readonly blockStart: number;
  readonly blockEnd: number;
}

/**
 * `extractionRef`/`parentExtractionRef` (сырой уровень, `extraction.ts`) не
 * переживают persistence — preflight C (translation-djc): `extractionRef` не
 * identity, а `parentRuleRef` здесь ВСЕГДА либо настоящий `unitId` родителя
 * этого же прогона, либо `null` (если unit самостоятелен, либо
 * `parentExtractionRef` не резолвился — не должно происходить для units,
 * прошедших `validateParentRefs`, но эта функция не полагается на это молча,
 * см. `resolveParentRuleRefs`).
 */
export interface PersistedKnowledgeUnit
  extends Omit<ExtractedKnowledgeUnit, 'extractionRef' | 'parentExtractionRef'> {
  readonly sourceBlockAnchor: string;
  readonly unitId: string;
  readonly contentHash: string;
  readonly parentRuleRef: string | null;
}

export interface UnresolvedEvidence {
  readonly unit: ExtractedKnowledgeUnit;
  readonly reason: string;
}

export interface AmbiguousDuplicate {
  readonly unitId: string;
  readonly units: readonly PersistedKnowledgeUnit[];
}

export interface IdentityAssignmentResult {
  readonly units: readonly PersistedKnowledgeUnit[];
  readonly ambiguousDuplicates: readonly AmbiguousDuplicate[];
  readonly unresolvedEvidence: readonly UnresolvedEvidence[];
}

interface ResolvedUnit {
  readonly unit: ExtractedKnowledgeUnit;
  readonly sourceBlockAnchor: string;
  readonly unitId: string;
  readonly contentHash: string;
}

/**
 * Назначает `sourceBlockAnchor`/`unitId`/`contentHash` каждому unit'у и
 * обнаруживает ambiguous duplicate (PR F, план §3): два unit'а, схлопнувшиеся
 * в один и тот же `unitId` (то есть один и тот же `kind` + один и тот же
 * evidence span), НЕ получают случайный LLM-ordinal, чтобы их развести —
 * оба уходят в `ambiguousDuplicates` на человеческое решение.
 */
export function assignIdentity(
  units: readonly ExtractedKnowledgeUnit[],
  blocksByAnchor: ReadonlyMap<string, SourceBlockLocation>,
  sourceRevisionHash: string
): IdentityAssignmentResult {
  const resolved: ResolvedUnit[] = [];
  const unresolvedEvidence: UnresolvedEvidence[] = [];

  for (const unit of units) {
    const block = blocksByAnchor.get(unit.sourceSpan.anchor);
    if (!block) {
      unresolvedEvidence.push({
        unit,
        reason: `sourceSpan.anchor "${unit.sourceSpan.anchor}" не найден среди известных блоков документа`,
      });
      continue;
    }

    const offsets = resolveEvidenceOffsets(block.text, unit.sourceSpan.quote);
    if (!offsets) {
      unresolvedEvidence.push({
        unit,
        reason: `quote "${unit.sourceSpan.quote}" не найдена дословно в блоке "${block.anchor}" — ошибка экстракции, не повод для эвристики`,
      });
      continue;
    }

    const sourceBlockAnchor = computeSourceBlockAnchor(
      sourceRevisionHash,
      block.sectionPath,
      block.blockStart,
      block.blockEnd
    );
    // Абсолютные офсеты источника (block.blockStart + локальный офсет), как
    // того требует план ("offsets исходного текста") — а не офсеты внутри
    // одного блока, которые совпали бы у двух РАЗНЫХ блоков с одинаковым
    // локальным положением цитаты.
    const absoluteStart = block.blockStart + offsets.start;
    const absoluteEnd = block.blockStart + offsets.end;
    const unitId = computeUnitId(sourceBlockAnchor, absoluteStart, absoluteEnd, unit.kind);
    const contentHash = computeContentHash(unit);

    resolved.push({ unit, sourceBlockAnchor, unitId, contentHash });
  }

  const unitIdByExtractionRef = new Map(resolved.map((r) => [r.unit.extractionRef, r.unitId]));
  const persisted = resolved.map((r) => toPersistedUnit(r, unitIdByExtractionRef));

  const byUnitId = new Map<string, PersistedKnowledgeUnit[]>();
  for (const u of persisted) {
    const group = byUnitId.get(u.unitId);
    if (group) group.push(u);
    else byUnitId.set(u.unitId, [u]);
  }

  const unambiguous: PersistedKnowledgeUnit[] = [];
  const ambiguousDuplicates: AmbiguousDuplicate[] = [];
  for (const [unitId, group] of byUnitId) {
    if (group.length > 1) {
      ambiguousDuplicates.push({ unitId, units: group });
    } else {
      unambiguous.push(group[0]);
    }
  }

  return { units: unambiguous, ambiguousDuplicates, unresolvedEvidence };
}

/**
 * Строит persisted-запись из `ResolvedUnit`, заменяя `parentExtractionRef`
 * (сырая, per-run ссылка) на настоящий `unitId` родителя (preflight C,
 * translation-djc) — по карте `extractionRef -> unitId`, построенной по ВСЕМ
 * `resolved` units ЭТОГО прогона (до разделения на `ambiguousDuplicates`:
 * `extractionRef` уникален по построению `validateParentRefs`, так что карта
 * однозначна независимо от того, сколько units делят один
 * `sourceSpan.anchor`).
 *
 * `parentExtractionRef`, не резолвившийся в этой карте (не должно происходить
 * для units, прошедших `validateParentRefs` раньше в пайплайне — та функция
 * это уже проверяет и помечает `DANGLING_PARENT_REF`), даёт `parentRuleRef:
 * null` — НЕ сырую строку: `extractionRef` явно объявлен не-identity полем и
 * не имеет права пережить persistence ни в каком виде.
 */
function toPersistedUnit(
  resolved: ResolvedUnit,
  unitIdByExtractionRef: ReadonlyMap<string, string>
): PersistedKnowledgeUnit {
  const { extractionRef: _extractionRef, parentExtractionRef, ...rest } = resolved.unit;

  const parentRuleRef =
    parentExtractionRef === null
      ? null
      : (unitIdByExtractionRef.get(parentExtractionRef) ?? null);

  return {
    ...rest,
    sourceBlockAnchor: resolved.sourceBlockAnchor,
    unitId: resolved.unitId,
    contentHash: resolved.contentHash,
    parentRuleRef,
  };
}
