/**
 * Extraction reproducibility / drift gate (translation-bqt, Gate 2 —
 * реализация docs/plans/2026-08-08-reviewed-snapshot-vs-drift-gate-design.md).
 *
 * ЧИСТО ДИАГНОСТИЧЕСКИЙ: `compareExtractionRuns()` никогда не бросает и не
 * возвращает "провал" — только классификацию различий между иммутабельным
 * `ReviewedKnowledgeSnapshot` (`baseline`) и свежим `--stage=extraction`
 * прогоном (`candidate`). В отличие от Gate 1 (`applyReviewManifest`,
 * all-or-nothing), результат этой функции НЕ блокирует retrieval/
 * applicability/synthesis тесты — те продолжают читать `baseline` напрямую.
 *
 * Категории собраны из РЕАЛЬНОГО расхождения run1/run2 этой сессии
 * (`.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md`),
 * не выдуманы: contentHash drift на стабильном unitId (10/36), потеря unit'а
 * целиком без замены (визуально чистые руки — CONTENT_OMISSION), split<->merge
 * на одном source-блоке (FRAGMENTATION_CHANGE), разное богатство
 * triggerCondition на стабильном unitId (TRIGGER_DRIFT), разное присутствие
 * parentRuleRef (PARENT_DRIFT).
 */

import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { ExtractionUncertainty } from '@/lib/knowledge/applicability/extraction';
import type { TriggerClause, TriggerCondition } from '@/lib/knowledge/applicability/trigger';

/**
 * Присутствие unitId по обе стороны сравнения — ортогонально тому, ЧТО
 * именно изменилось в содержании (pre-retrieval hardening, Step 1). Раньше
 * один `UnitDriftStatus` смешивал "unit присутствует в обеих сторонах" И
 * "contentHash не изменился" в одно значение `STABLE`, из-за чего
 * `status='STABLE'` мог сосуществовать с `parentDrift=true` или
 * `uncertaintyDrift=true` — `stableCount` завышался. Присутствие и дрейф
 * содержания теперь раздельные измерения: `identityStatus` отвечает только
 * на "есть ли unit по обе стороны", `UnitDriftDetail`/`fullyStable` — на
 * "изменилось ли что-то в его содержании".
 */
export type IdentityStatus =
  | 'PRESENT_BOTH'
  | 'OMITTED'
  | 'ADDED'
  /** unitId встретился больше одного раза на ОДНОЙ стороне сравнения — не
   *  должно происходить для units, прошедших `assignIdentity` (тот уже
   *  выделяет такие коллизии в `ambiguousDuplicates` и не пускает их дальше),
   *  но эта функция не полагается на это молча (Step 6, независимое ревью PR
   *  #76: "ambiguous cases should report UNKNOWN/REVIEW_REQUIRED rather than
   *  guessing" — тот же класс защиты, что P0 translation-rbj,
   *  `safeUnitIdByExtractionRef`). */
  | 'AMBIGUOUS';

export interface UnitDriftDetail {
  readonly contentChanged: boolean;
  readonly parentChanged: boolean;
  readonly triggerChanged: boolean;
  readonly uncertaintyChanged: boolean;
}

export interface UnitDriftEntry {
  readonly unitId: string;
  readonly identityStatus: IdentityStatus;
  /** `true` iff `identityStatus === 'PRESENT_BOTH'` И ни один из четырёх
   *  `UnitDriftDetail`-флагов не взведён — "стабильно" значит стабильно по
   *  ВСЕМ измерениям сразу, не только по contentHash. */
  readonly fullyStable: boolean;
  readonly sourceBlockAnchor: string | null;
  /** `null`, если identityStatus !== 'PRESENT_BOTH' — нечего сравнивать. */
  readonly detail: UnitDriftDetail | null;
}

/** Один `sourceBlockAnchor`, на котором ОДНОВРЕМЕННО есть и потери, и
 *  добавления — сигнал "модель раздробила/слила единицы иначе", а не чистая
 *  потеря знания (`CONTENT_OMISSION` без пары `CONTENT_ADDITION` на том же
 *  anchor остаётся отдельным, более тревожным сигналом). */
export interface FragmentationChangeGroup {
  readonly sourceBlockAnchor: string;
  readonly omittedUnitIds: readonly string[];
  readonly addedUnitIds: readonly string[];
}

export interface ExtractionDriftReport {
  readonly fullyStableCount: number;
  readonly contentChangedCount: number;
  readonly parentChangedCount: number;
  readonly triggerChangedCount: number;
  readonly uncertaintyChangedCount: number;
  readonly omittedCount: number;
  readonly addedCount: number;
  readonly ambiguousCount: number;
  readonly entries: readonly UnitDriftEntry[];
  readonly fragmentationChanges: readonly FragmentationChangeGroup[];
}

function compareByCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Конъюнкция `all` не зависит от порядка — тот же принцип, что
 *  `computeContentHash` (`identity.ts`) уже применяет к triggerCondition:
 *  перестановка условий той же сутью не должна выглядеть как дрейф. */
function triggerConditionsEqual(a: TriggerCondition | null, b: TriggerCondition | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.all.length !== b.all.length) return false;
  const normalize = (clauses: readonly TriggerClause[]): string[] =>
    clauses.map((c) => `${c.fact} ${String(c.equals)}`).sort(compareByCodeUnits);
  const an = normalize(a.all);
  const bn = normalize(b.all);
  return an.every((v, i) => v === bn[i]);
}

/** Состав `uncertainties` — порядок не значим (тот же массив разных находок). */
function uncertaintiesEqual(
  a: readonly ExtractionUncertainty[],
  b: readonly ExtractionUncertainty[]
): boolean {
  if (a.length !== b.length) return false;
  const normalize = (list: readonly ExtractionUncertainty[]): string[] =>
    list.map((u) => `${u.kind} ${u.description} ${u.quote}`).sort(compareByCodeUnits);
  const an = normalize(a);
  const bn = normalize(b);
  return an.every((v, i) => v === bn[i]);
}

function computeDrift(
  baseline: PersistedKnowledgeUnit,
  candidate: PersistedKnowledgeUnit
): UnitDriftDetail {
  return {
    contentChanged: baseline.contentHash !== candidate.contentHash,
    // parentRuleRef — уже настоящий unitId (или null); unitId стабилен между
    // прогонами того же источника (f(sourceRevisionHash, offsets, kind)),
    // поэтому прямое сравнение строк осмысленно без дополнительного резолва.
    parentChanged: baseline.parentRuleRef !== candidate.parentRuleRef,
    triggerChanged: !triggerConditionsEqual(baseline.triggerCondition, candidate.triggerCondition),
    uncertaintyChanged: !uncertaintiesEqual(baseline.uncertainties, candidate.uncertainties),
  };
}

function isFullyStable(detail: UnitDriftDetail): boolean {
  return !detail.contentChanged && !detail.parentChanged && !detail.triggerChanged && !detail.uncertaintyChanged;
}

function computeFragmentationChanges(
  entries: readonly UnitDriftEntry[]
): FragmentationChangeGroup[] {
  const omittedByAnchor = new Map<string, string[]>();
  const addedByAnchor = new Map<string, string[]>();

  for (const e of entries) {
    if (e.sourceBlockAnchor === null) continue;
    if (e.identityStatus === 'OMITTED') {
      const list = omittedByAnchor.get(e.sourceBlockAnchor);
      if (list) list.push(e.unitId);
      else omittedByAnchor.set(e.sourceBlockAnchor, [e.unitId]);
    } else if (e.identityStatus === 'ADDED') {
      const list = addedByAnchor.get(e.sourceBlockAnchor);
      if (list) list.push(e.unitId);
      else addedByAnchor.set(e.sourceBlockAnchor, [e.unitId]);
    }
  }

  const anchors = new Set([...omittedByAnchor.keys(), ...addedByAnchor.keys()]);
  const groups: FragmentationChangeGroup[] = [];
  for (const anchor of anchors) {
    const omitted = omittedByAnchor.get(anchor) ?? [];
    const added = addedByAnchor.get(anchor) ?? [];
    if (omitted.length > 0 && added.length > 0) {
      groups.push({ sourceBlockAnchor: anchor, omittedUnitIds: omitted, addedUnitIds: added });
    }
  }
  return groups.sort((x, y) => compareByCodeUnits(x.sourceBlockAnchor, y.sourceBlockAnchor));
}

/** `unitId -> unit`, отказоустойчивая к дублям — тот же класс защиты, что
 *  `safeUnitIdByExtractionRef` (`identity-assignment.ts`, P0 translation-rbj):
 *  обычный `new Map(arr.map(u => [u.unitId, u]))` при задвоенном unitId
 *  молча оставил бы ПОСЛЕДНИЙ элемент (last-write-wins) — другой исчез бы из
 *  сравнения без следа, а оставшийся получил бы вердикт (STABLE/CONTENT_
 *  CHANGE/...), как будто он был единственным. Здесь любой unitId,
 *  встретившийся у >1 unit'а с ЭТОЙ стороны, вообще не попадает в `byId` —
 *  `.get()` честно вернёт `undefined`, а сам unitId отдельно фиксируется в
 *  `duplicated`. */
function safeUnitByUnitId(units: readonly PersistedKnowledgeUnit[]): {
  readonly byId: ReadonlyMap<string, PersistedKnowledgeUnit>;
  readonly duplicated: ReadonlySet<string>;
} {
  const grouped = new Map<string, PersistedKnowledgeUnit[]>();
  for (const u of units) {
    const list = grouped.get(u.unitId);
    if (list) list.push(u);
    else grouped.set(u.unitId, [u]);
  }

  const byId = new Map<string, PersistedKnowledgeUnit>();
  const duplicated = new Set<string>();
  for (const [unitId, list] of grouped) {
    if (list.length === 1) byId.set(unitId, list[0]);
    else duplicated.add(unitId);
  }
  return { byId, duplicated };
}

export function compareExtractionRuns(
  baseline: readonly PersistedKnowledgeUnit[],
  candidate: readonly PersistedKnowledgeUnit[]
): ExtractionDriftReport {
  const { byId: baselineById, duplicated: baselineDuplicated } = safeUnitByUnitId(baseline);
  const { byId: candidateById, duplicated: candidateDuplicated } = safeUnitByUnitId(candidate);
  const allIds = new Set([
    ...baselineById.keys(),
    ...candidateById.keys(),
    ...baselineDuplicated,
    ...candidateDuplicated,
  ]);

  const entries: UnitDriftEntry[] = [];
  for (const id of allIds) {
    // Задвоенность на ЛЮБОЙ стороне делает сам unitId неоднозначным для
    // сравнения целиком — какой из нескольких units с этим unitId сравнивать
    // с другой стороной, неизвестно, и это НЕ то же самое, что "unit пропал"
    // (CONTENT_OMISSION) или "unit появился" (CONTENT_ADDITION): отдельная,
    // более настораживающая категория, требующая человеческого разбора
    // ВЫШЕ по пайплайну (assignIdentity/ambiguousDuplicates), не просто
    // молчаливого исключения отсюда.
    if (baselineDuplicated.has(id) || candidateDuplicated.has(id)) {
      entries.push({ unitId: id, identityStatus: 'AMBIGUOUS', fullyStable: false, sourceBlockAnchor: null, detail: null });
      continue;
    }

    const b = baselineById.get(id);
    const c = candidateById.get(id);

    if (b !== undefined && c === undefined) {
      entries.push({
        unitId: id,
        identityStatus: 'OMITTED',
        fullyStable: false,
        sourceBlockAnchor: b.sourceBlockAnchor,
        detail: null,
      });
    } else if (b === undefined && c !== undefined) {
      entries.push({
        unitId: id,
        identityStatus: 'ADDED',
        fullyStable: false,
        sourceBlockAnchor: c.sourceBlockAnchor,
        detail: null,
      });
    } else if (b !== undefined && c !== undefined) {
      const detail = computeDrift(b, c);
      entries.push({
        unitId: id,
        identityStatus: 'PRESENT_BOTH',
        fullyStable: isFullyStable(detail),
        sourceBlockAnchor: c.sourceBlockAnchor,
        detail,
      });
    }
  }

  entries.sort((a, b) => compareByCodeUnits(a.unitId, b.unitId));

  return {
    fullyStableCount: entries.filter((e) => e.fullyStable).length,
    contentChangedCount: entries.filter((e) => e.detail?.contentChanged === true).length,
    parentChangedCount: entries.filter((e) => e.detail?.parentChanged === true).length,
    triggerChangedCount: entries.filter((e) => e.detail?.triggerChanged === true).length,
    uncertaintyChangedCount: entries.filter((e) => e.detail?.uncertaintyChanged === true).length,
    omittedCount: entries.filter((e) => e.identityStatus === 'OMITTED').length,
    addedCount: entries.filter((e) => e.identityStatus === 'ADDED').length,
    ambiguousCount: entries.filter((e) => e.identityStatus === 'AMBIGUOUS').length,
    entries,
    fragmentationChanges: computeFragmentationChanges(entries),
  };
}
