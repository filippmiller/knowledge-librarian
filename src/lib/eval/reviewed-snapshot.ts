/**
 * Immutable reviewed knowledge snapshot (translation-bqt, реализация
 * docs/plans/2026-08-08-reviewed-snapshot-vs-drift-gate-design.md).
 *
 * Тонкая обёртка над `applyReviewManifest` (Gate 1, `review-manifest.ts`) —
 * СЕМАНТИКА ТОГО GATE'А НЕ МЕНЯЕТСЯ: qualification либо проходит целиком,
 * либо не создаёт ничего (design note "Что НЕ меняется"). Разница — то, ЧТО
 * происходит ПОСЛЕ успеха: вместо того, чтобы вызывающий код каждый раз
 * заново гонял `--stage=extraction` + `applyReviewManifest` перед КАЖДЫМ
 * retrieval/applicability/synthesis прогоном (что на реальных данных
 * проваливается почти всегда — см. отчёт
 * `.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md`,
 * 10/36 contentHash drift между двумя идентичными по конфигурации
 * прогонами), успешный результат материализуется в артефакт, который
 * retrieval/applicability/synthesis читают НАПРЯМУЮ, никогда не запуская
 * LLM-экстракцию заново.
 *
 * `sourceRuleId` (evaluation-only provenance, план §0.3) сознательно
 * возвращается ОТДЕЛЬНЫМ полем результата (`sourceRuleByUnitId`), не внутри
 * `snapshot.units` — snapshot.units это именно то, что видит
 * retrieval/applicability движок, и oracle-производная информация не имеет
 * права там оказаться ни в каком виде.
 */

import { applyReviewManifest, type ManifestGateFailure, type ReviewManifestEntry } from './review-manifest';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

export interface SnapshotProvenance {
  readonly sourceRevisionHash: string;
  readonly parserVersion: string;
  readonly extractionProvider: string;
  readonly extractionModel: string;
  readonly extractionPromptVersion: string;
  readonly extractionSchemaVersion: string;
}

export interface ReviewedKnowledgeSnapshot extends SnapshotProvenance {
  /** Когда этот снимок был материализован (успешное прохождение Gate 1). */
  readonly qualifiedAt: string;
  /** Единственный trusted вход для retrieval/applicability/synthesis. */
  readonly units: readonly PersistedKnowledgeUnit[];
}

export type BuildSnapshotResult =
  | {
      readonly ok: true;
      readonly snapshot: ReviewedKnowledgeSnapshot;
      readonly sourceRuleByUnitId: ReadonlyMap<string, number>;
    }
  | { readonly ok: false; readonly failures: readonly ManifestGateFailure[] };

/**
 * `qualifiedAt` принимается параметром (не `new Date().toISOString()`
 * внутри) — функция остаётся чистой и детерминированно тестируемой; вызывающий
 * CLI-код (будущий `--stage=qualify` раннер) вычисляет метку времени один раз
 * в своём `main()`, как уже делает `test-extraction-pack.ts` для `ranAt`.
 */
export function buildReviewedSnapshot(
  freshUnits: readonly PersistedKnowledgeUnit[],
  manifest: readonly ReviewManifestEntry[],
  provenance: SnapshotProvenance,
  qualifiedAt: string
): BuildSnapshotResult {
  const gate = applyReviewManifest(freshUnits, manifest);

  if (!gate.ok) {
    return { ok: false, failures: gate.failures };
  }

  return {
    ok: true,
    snapshot: {
      ...provenance,
      qualifiedAt,
      units: gate.confirmed,
    },
    sourceRuleByUnitId: gate.sourceRuleByUnitId,
  };
}
