/**
 * Evaluation-only knowledge snapshot (goal shift 2026-08-08, ChatGPT
 * feedback + corrected prompt).
 *
 * `ReviewedKnowledgeSnapshot` (`reviewed-snapshot.ts`) stays the trusted,
 * human-gated production artifact — its semantics are UNCHANGED by this
 * file. `EvaluationKnowledgeSnapshot` is a second, explicitly unreviewed
 * artifact for the true end-to-end benchmark: extraction runs without
 * waiting for an oracle-blind human, `humanReviewed: false` is a literal
 * type (not `boolean`), so nothing can construct one claiming otherwise.
 *
 * It is structurally INCOMPATIBLE with `ReviewedKnowledgeSnapshot` — no
 * shared required-field superset (`qualificationArtifactHash`/`qualifiedAt`
 * vs. `extractionRunId`/`humanReviewed`), proven at compile time below — so
 * a future production ingestion path typed to accept `ReviewedKnowledgeSnapshot`
 * cannot silently accept this instead.
 */

import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { ReviewedKnowledgeSnapshot } from './reviewed-snapshot';

export interface EvaluationSnapshotMetadata {
  readonly sourceRevisionHash: string;
  readonly canonicalTextHash: string;
  readonly parserVersion: string;
  /** Identifies WHICH independent extraction run produced this snapshot —
   *  the benchmark runs several (Step 3: "each extraction run must be
   *  independent") and must never conflate their units. */
  readonly extractionRunId: string;
  readonly extractionProvider: string;
  readonly extractionModel: string;
  readonly extractionPromptVersion: string;
  readonly extractionSchemaVersion: string;
}

export interface EvaluationKnowledgeSnapshot extends EvaluationSnapshotMetadata {
  readonly humanReviewed: false;
  readonly units: readonly PersistedKnowledgeUnit[];
}

export function buildEvaluationSnapshot(
  metadata: EvaluationSnapshotMetadata,
  units: readonly PersistedKnowledgeUnit[]
): EvaluationKnowledgeSnapshot {
  // Тот же класс защиты, что `empty_extraction` в review-manifest.ts:
  // вырожденный "успех" на пустой экстракции скрыл бы сломанный пайплайн, а
  // не провалившийся результат прогона.
  if (units.length === 0) {
    throw new Error(
      'buildEvaluationSnapshot: units пуст — свежая экстракция не выдала ни одного unit, проверять нечего'
    );
  }
  return { ...metadata, humanReviewed: false, units };
}

type Assert<T extends true> = T;
/** Компиляционное доказательство границы: EvaluationKnowledgeSnapshot НЕ
 *  подходит там, где типизированный код требует ReviewedKnowledgeSnapshot. */
type _EvaluationSnapshotNotAssignableToReviewed = Assert<
  EvaluationKnowledgeSnapshot extends ReviewedKnowledgeSnapshot ? false : true
>;
