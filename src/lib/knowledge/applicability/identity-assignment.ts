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
  /** Breadcrumb заголовков — семантические метаданные (человекочитаемый
   *  контекст, review packet), НЕ участвует в `sourceBlockAnchor` (Step 3,
   *  независимое ревью PR #76: см. `computeSourceBlockAnchor`). */
  readonly sectionPath: string;
  /** Позиционный путь в дереве документа — структурный дискриминатор
   *  `sourceBlockAnchor`, а не `sectionPath`. */
  readonly structuralPath: string;
  readonly blockStart: number;
  readonly blockEnd: number;
}

/**
 * `extractionRef`/`parentExtractionRef` (сырой уровень, `extraction.ts`) не
 * переживают persistence — preflight C (translation-djc): `extractionRef` не
 * identity, а `parentRuleRef` здесь ВСЕГДА либо настоящий `unitId` родителя
 * этого же прогона, либо `null` (если unit самостоятелен, либо
 * `parentExtractionRef` не резолвился — не должно происходить для units,
 * прошедших `validateParentRefs` (которая с P0-фикса translation-rbj сама
 * обнуляет невалидные ссылки), но эта функция не полагается на это молча,
 * см. `safeUnitIdByExtractionRef`/`toPersistedUnit`).
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
      block.structuralPath,
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

  const unitIdByExtractionRef = safeUnitIdByExtractionRef(resolved);
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
 * `extractionRef -> unitId`, ОТКАЗОУСТОЙЧИВАЯ к дублям, даже если
 * `validateParentRefs` не вызывалась перед `assignIdentity` (P0,
 * translation-rbj, независимое ревью PR #76: `assignIdentity` — экспортируемая
 * функция, ничто на уровне типов не заставляет вызывающего сначала
 * провалидировать). Обычный `new Map(...)` при задвоенном `extractionRef`
 * молча оставил бы ПОСЛЕДНЕГО кандидата (last-write-wins, зависимо от порядка
 * LLM output) — здесь любой `extractionRef`, встретившийся у >1 `resolved`
 * unit'а, вообще НЕ попадает в карту: `.get()` для него честно вернёт
 * `undefined`, что `toPersistedUnit` уже трактует как "родитель не резолвился".
 */
function safeUnitIdByExtractionRef(resolved: readonly ResolvedUnit[]): ReadonlyMap<string, string> {
  const grouped = new Map<string, string[]>();
  for (const r of resolved) {
    const list = grouped.get(r.unit.extractionRef);
    if (list) list.push(r.unitId);
    else grouped.set(r.unit.extractionRef, [r.unitId]);
  }

  const safe = new Map<string, string>();
  for (const [extractionRef, unitIds] of grouped) {
    if (unitIds.length === 1) safe.set(extractionRef, unitIds[0]);
  }
  return safe;
}

/**
 * Строит persisted-запись из `ResolvedUnit`, заменяя `parentExtractionRef`
 * (сырая, per-run ссылка) на настоящий `unitId` родителя (preflight C,
 * translation-djc) — по карте `extractionRef -> unitId`
 * (`safeUnitIdByExtractionRef`, устойчивой к дублям).
 *
 * `parentExtractionRef`, не резолвившийся в этой карте (задвоен, не
 * существует — не должно происходить для units, прошедших
 * `validateParentRefs` раньше в пайплайне, та функция это уже проверяет и
 * помечает `DANGLING_PARENT_REF`, а с P0-фикса ещё и обнуляет само поле — но
 * эта функция не полагается на это молча, см. `safeUnitIdByExtractionRef`),
 * даёт `parentRuleRef: null` — НЕ сырую строку: `extractionRef` явно объявлен
 * не-identity полем и не имеет права пережить persistence ни в каком виде.
 *
 * Самоссылка (`parentExtractionRef === extractionRef`) отдельно исключена
 * ДО обращения к карте: без этой проверки unit, чьё evidence резолвилось,
 * автоматически резолвил бы САМ СЕБЯ через карту (его собственный
 * `extractionRef` там ЕСТЬ) — `parentRuleRef === unitId`, то есть persisted
 * self-reference, ровно тот класс бага, который обнаружило независимое
 * ревью PR #76.
 */
function toPersistedUnit(
  resolved: ResolvedUnit,
  unitIdByExtractionRef: ReadonlyMap<string, string>
): PersistedKnowledgeUnit {
  const { extractionRef, parentExtractionRef, ...rest } = resolved.unit;

  const parentRuleRef =
    parentExtractionRef === null || parentExtractionRef === extractionRef
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
