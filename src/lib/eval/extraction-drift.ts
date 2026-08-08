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

export type UnitDriftStatus = 'STABLE' | 'CONTENT_CHANGE' | 'CONTENT_OMISSION' | 'CONTENT_ADDITION';

export interface UnitDriftDetail {
  readonly contentHashChanged: boolean;
  readonly parentDrift: boolean;
  readonly triggerDrift: boolean;
  readonly uncertaintyDrift: boolean;
}

export interface UnitDriftEntry {
  readonly unitId: string;
  readonly status: UnitDriftStatus;
  readonly sourceBlockAnchor: string | null;
  /** `null` для CONTENT_OMISSION/CONTENT_ADDITION — нечего сравнивать. */
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
  readonly stableCount: number;
  readonly contentChangedCount: number;
  readonly omittedCount: number;
  readonly addedCount: number;
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
    contentHashChanged: baseline.contentHash !== candidate.contentHash,
    // parentRuleRef — уже настоящий unitId (или null); unitId стабилен между
    // прогонами того же источника (f(sourceRevisionHash, offsets, kind)),
    // поэтому прямое сравнение строк осмысленно без дополнительного резолва.
    parentDrift: baseline.parentRuleRef !== candidate.parentRuleRef,
    triggerDrift: !triggerConditionsEqual(baseline.triggerCondition, candidate.triggerCondition),
    uncertaintyDrift: !uncertaintiesEqual(baseline.uncertainties, candidate.uncertainties),
  };
}

function computeFragmentationChanges(
  entries: readonly UnitDriftEntry[]
): FragmentationChangeGroup[] {
  const omittedByAnchor = new Map<string, string[]>();
  const addedByAnchor = new Map<string, string[]>();

  for (const e of entries) {
    if (e.sourceBlockAnchor === null) continue;
    if (e.status === 'CONTENT_OMISSION') {
      const list = omittedByAnchor.get(e.sourceBlockAnchor);
      if (list) list.push(e.unitId);
      else omittedByAnchor.set(e.sourceBlockAnchor, [e.unitId]);
    } else if (e.status === 'CONTENT_ADDITION') {
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

export function compareExtractionRuns(
  baseline: readonly PersistedKnowledgeUnit[],
  candidate: readonly PersistedKnowledgeUnit[]
): ExtractionDriftReport {
  const baselineById = new Map(baseline.map((u) => [u.unitId, u]));
  const candidateById = new Map(candidate.map((u) => [u.unitId, u]));
  const allIds = new Set([...baselineById.keys(), ...candidateById.keys()]);

  const entries: UnitDriftEntry[] = [];
  for (const id of allIds) {
    const b = baselineById.get(id);
    const c = candidateById.get(id);

    if (b !== undefined && c === undefined) {
      entries.push({
        unitId: id,
        status: 'CONTENT_OMISSION',
        sourceBlockAnchor: b.sourceBlockAnchor,
        detail: null,
      });
    } else if (b === undefined && c !== undefined) {
      entries.push({
        unitId: id,
        status: 'CONTENT_ADDITION',
        sourceBlockAnchor: c.sourceBlockAnchor,
        detail: null,
      });
    } else if (b !== undefined && c !== undefined) {
      const detail = computeDrift(b, c);
      entries.push({
        unitId: id,
        status: detail.contentHashChanged ? 'CONTENT_CHANGE' : 'STABLE',
        sourceBlockAnchor: c.sourceBlockAnchor,
        detail,
      });
    }
  }

  entries.sort((a, b) => compareByCodeUnits(a.unitId, b.unitId));

  return {
    stableCount: entries.filter((e) => e.status === 'STABLE').length,
    contentChangedCount: entries.filter((e) => e.status === 'CONTENT_CHANGE').length,
    omittedCount: entries.filter((e) => e.status === 'CONTENT_OMISSION').length,
    addedCount: entries.filter((e) => e.status === 'CONTENT_ADDITION').length,
    entries,
    fragmentationChanges: computeFragmentationChanges(entries),
  };
}
