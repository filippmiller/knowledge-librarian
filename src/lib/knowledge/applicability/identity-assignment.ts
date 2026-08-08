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

export interface PersistedKnowledgeUnit extends ExtractedKnowledgeUnit {
  readonly sourceBlockAnchor: string;
  readonly unitId: string;
  readonly contentHash: string;
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
  const resolved: PersistedKnowledgeUnit[] = [];
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

    resolved.push({ ...unit, sourceBlockAnchor, unitId, contentHash });
  }

  const byUnitId = new Map<string, PersistedKnowledgeUnit[]>();
  for (const u of resolved) {
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

  const finalUnits = resolveParentRuleRefs(unambiguous);

  return { units: finalUnits, ambiguousDuplicates, unresolvedEvidence };
}

/**
 * `parentRuleRef` (PR E) обязана ссылаться на `unitId`, построенный этим
 * модулем, ИЛИ на сырой source anchor, если родительский unit ещё не прошёл
 * экстракцию (план §3, PR F). Переписывает ссылку в `unitId`, когда ровно
 * ОДИН unit этого прогона занимает anchor, на который ссылается
 * `parentRuleRef` — иначе (ноль или несколько кандидатов, т.е. неоднозначно,
 * кто именно родитель) оставляет сырой anchor: угадывание родителя из
 * нескольких кандидатов было бы тем же самым классом ошибки, что и случайный
 * LLM-ordinal у ambiguous duplicate.
 */
function resolveParentRuleRefs(
  units: readonly PersistedKnowledgeUnit[]
): PersistedKnowledgeUnit[] {
  const candidatesByAnchor = new Map<string, string[]>();
  for (const u of units) {
    const list = candidatesByAnchor.get(u.sourceSpan.anchor);
    if (list) list.push(u.unitId);
    else candidatesByAnchor.set(u.sourceSpan.anchor, [u.unitId]);
  }

  return units.map((u) => {
    if (u.parentRuleRef === null) return u;
    // Сам unit тоже мог оказаться на этом anchor (его собственный
    // sourceSpan.anchor совпадает с parentRuleRef, который он указал) — это
    // не кандидат в родители самому себе, исключается ДО подсчёта
    // однозначности, а не после.
    const candidates = (candidatesByAnchor.get(u.parentRuleRef) ?? []).filter(
      (id) => id !== u.unitId
    );
    if (candidates.length !== 1) return u;
    return { ...u, parentRuleRef: candidates[0] };
  });
}
