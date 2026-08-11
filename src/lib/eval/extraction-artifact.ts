/**
 * Reusable extraction artifact for the aurora benchmark (W1-A, plan
 * `docs/plans/2026-08-10-cost-and-reliability-hardening.md`).
 *
 * WHY. An owner audit found $19.79 burned in one day across 12 benchmark runs
 * that re-extracted the SAME fixture document 31 times while the work actually
 * being debugged was retrieval and answering. Extraction + coverage audit is
 * ~20 of the ~56 metered calls in a run (36%), and every one of them is waste
 * when extraction is not what's under test.
 *
 * WHY A PURPOSE-BUILT ARTIFACT, NOT `evaluation-snapshot.json`. The runner
 * already writes `evaluation-snapshot.json` and `persisted-units.json` per
 * run, and reusing those directly was the obvious cheap option. It is not
 * safe. `EvaluationSnapshotMetadata` carries eight fields — source hashes,
 * parser version, extraction provider/model/prompt/schema version — and
 * NOTHING about the rest of the pipeline that decided which units exist:
 * batch size, the coverage auditor's model/prompt/policy, the focused-repair
 * drop rule, the identity algorithm, or the embedding model. Reusing a
 * snapshot would therefore silently accept units produced at `batchSize=1` by
 * a pre-W1-C auditor as equivalent to today's — the exact "confidently wrong
 * benchmark conclusion" this feature must not create. The snapshot is instead
 * EMBEDDED here verbatim, so it stays the single source of truth for units,
 * wrapped in a fingerprint that covers everything that shaped them, plus the
 * candidate embeddings (which the runner otherwise recomputes every run).
 *
 * WHY BEHAVIOURAL PROBES. Four of the things a saved extraction depends on
 * have no version constant to read: the auditor's prompt text, the auditor's
 * gap/`unresolved` policy, the focused-repair quote-overlap rule, and the
 * identity algorithm. A hand-maintained `POLICY_VERSION = '3'` next to each
 * would be exactly the field somebody forgets to bump. `computePipelineProbes`
 * instead RUNS each pure function over a fixed probe input and hashes the
 * result, so the fingerprint changes when the behaviour changes, whether or
 * not anyone remembered. W1-C (`b542fe2`) landing mid-flight — empty findings
 * and `AMBIGUOUS` now block publication — is precisely the class of change
 * this catches for free.
 *
 * REFUSAL, NOT REPAIR. Every mismatch throws. There is no "reuse what still
 * matches" path and there must not be: a partially-valid extraction produces a
 * benchmark number that looks real and is not.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import type { ModelInfo } from '@/lib/ai/embedding-provider';
import type { BatchExtractionLog } from '@/lib/knowledge/batch-extraction';
import {
  buildFocusedRepairPromptMessages,
  FOCUSED_REPAIR_MAX_ROUNDS,
  focusedRepairDuplicatesExistingUnit,
  refineCoextensiveEvidence,
  type FocusedRetryLog,
} from '@/lib/knowledge/audited-extraction';
import {
  buildCoverageAuditPromptMessages,
  coverageAuditNeedsReview,
  interpretCoverageAuditResponse,
  type BlockCoverageAuditResult,
  type CoverageVerdict,
  type RawCoverageFinding,
} from '@/lib/knowledge/extraction-coverage-auditor';
import { buildExtractionPromptMessages } from '@/lib/knowledge/knowledge-unit-extractor';
import { extractedKnowledgeUnitSchema, type ExtractedKnowledgeUnit } from '@/lib/knowledge/applicability/extraction';
import {
  assignIdentity,
  type PersistedKnowledgeUnit,
  type SourceBlockLocation,
} from '@/lib/knowledge/applicability/identity-assignment';
import { buildRetrievalText } from '@/lib/knowledge/applicability/retrieval-text';
import type { EmbeddedCandidate, RetrievalCandidate } from '@/lib/knowledge/semantic-retrieval';

import type { EvaluationKnowledgeSnapshot } from './evaluation-snapshot';

/** Bumped whenever the artifact's SHAPE changes. Part of the fingerprint, so
 *  an artifact from an older shape is refused rather than half-read. */
export const EXTRACTION_ARTIFACT_VERSION = '2026-08-10-extraction-artifact-v6';

export type ExtractionArtifactPhase = 'SEMANTIC_CHECKPOINT' | 'COMPLETE';

/** Единственная формулировка выхода из любого отказа — чтобы «что делать»
 *  не пришлось угадывать ни на одном из путей refuse. */
const REMEDIATION =
  'Перезапустите бенчмарк с --fresh-extraction (или без --reuse-extraction), чтобы получить свежую экстракцию и новый артефакт.';

// ────────────────────────────── ошибки ──────────────────────────────

/** Артефакт нечитаем, повреждён, из другой версии или несовместим с текущим
 *  прогоном по составу units/эмбеддингов. */
export class ExtractionArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionArtifactError';
  }
}

export interface FingerprintFieldMismatch {
  readonly field: keyof ExtractionFingerprint;
  readonly saved: string | number;
  readonly current: string | number;
}

/** Артефакт сам по себе корректен, но снят при ДРУГОЙ конфигурации пайплайна.
 *  Отдельный класс от `ExtractionArtifactError`, потому что это не поломка, а
 *  устаревание — и вызывающему может понадобиться отличить одно от другого. */
export class ExtractionArtifactMismatchError extends ExtractionArtifactError {
  readonly mismatches: readonly FingerprintFieldMismatch[];

  constructor(message: string, mismatches: readonly FingerprintFieldMismatch[]) {
    super(message);
    this.name = 'ExtractionArtifactMismatchError';
    this.mismatches = mismatches;
  }
}

// ──────────────────────── поведенческие пробы ────────────────────────

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const PROBE_BLOCK_TEXT =
  'Документ подаётся в оригинале. Если заявитель находится за рубежом, допускается нотариальная копия. ' +
  'Срок оформления — не более 5 рабочих дней.';

/** Прогоняет РЕАЛЬНЫЙ билдер промпта аудитора на фиксированном входе и хеширует
 *  результат: любое изменение текста системного промпта или формы user-сообщения
 *  меняет отпечаток, без ручной константы версии, которую забывают поднять. */
function probeAuditPrompt(): string {
  const messages = buildCoverageAuditPromptMessages(PROBE_BLOCK_TEXT, [
    { statement: 'Документ подаётся в оригинале.', quote: 'Документ подаётся в оригинале' },
  ]);
  return sha256(JSON.stringify(messages));
}

/** Binds reuse to the actual extraction prompt text and generated catalogs,
 * not merely to a manually maintained prompt-version label. */
function probeExtractionPrompt(): string {
  return sha256(
    JSON.stringify(buildExtractionPromptMessages([{ anchor: 'probe-anchor', text: PROBE_BLOCK_TEXT }]))
  );
}

/**
 * Прогоняет ПОЛИТИКУ аудитора (`interpretCoverageAuditResponse`) по матрице
 * вердиктов и хеширует полученные `hasGap`/`unresolved`/`quoteVerified`.
 *
 * Именно эта проба ловит W1-C (`b542fe2`): пустой список находок и `AMBIGUOUS`
 * перестали означать «покрыто». Экстракция, снятая ДО этого изменения, не
 * проходила focused-repair там, где сегодня прошла бы, — то есть содержит
 * другой состав units при том же промпте и той же модели.
 */
function probeAuditPolicy(): string {
  const cases: readonly RawCoverageFinding[][] = [
    [],
    [{ verdict: 'COVERED', quote: '', explanation: '' }],
    [{ verdict: 'AMBIGUOUS', quote: 'нотариальная копия', explanation: 'не уверен' }],
    [{ verdict: 'POSSIBLE_OMISSION', quote: 'не более 5 рабочих дней', explanation: 'срок' }],
    [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'за рубежом', explanation: 'условие' }],
    [
      { verdict: 'COVERED', quote: '', explanation: '' },
      { verdict: 'AMBIGUOUS', quote: 'цитата, которой нет в блоке', explanation: 'невериф.' },
    ],
  ];
  const observed = cases.map((findings) => {
    const result: BlockCoverageAuditResult = interpretCoverageAuditResponse('probe-anchor', PROBE_BLOCK_TEXT, findings);
    return {
      hasGap: result.hasGap,
      unresolved: result.unresolved ?? null,
      verdicts: result.findings.map((f) => [f.verdict as CoverageVerdict, f.quoteVerified] as const),
    };
  });
  return sha256(JSON.stringify(observed));
}

/** Правило focused-repair «цитата перекрывает уже покрытый диапазон → отбросить»
 *  живёт в `quoteSpansOverlap`. План (Wave 2+) прямо намечает его изменение —
 *  units, снятые при старом правиле, тогда перестанут быть воспроизводимыми. */
function probeFocusedRepairPolicy(): string {
  const existing = probeExtractedUnit();
  const candidates = [
    probeExtractedUnit({ extractionRef: 'same', statement: '  ДОКУМЕНТ подаётся в оригинале.  ' }),
    probeExtractedUnit({ extractionRef: 'different-statement', statement: 'Допускается нотариальная копия.' }),
    probeExtractedUnit({
      extractionRef: 'same-no-overlap',
      sourceSpan: { anchor: 'probe-anchor', quote: 'не более 5 рабочих дней' },
    }),
  ];
  const prompt = buildFocusedRepairPromptMessages({
    block: { anchor: 'probe-anchor', text: PROBE_BLOCK_TEXT },
    findings: [{
      verdict: 'UNREPRESENTED_CLAUSE',
      quote: 'за рубежом',
      explanation: 'recognized applicability missing from triggerCondition',
      quoteVerified: true,
    }],
    existingUnits: [existing],
  });
  return sha256(JSON.stringify({
    duplicateDecisions: candidates.map((candidate) =>
      focusedRepairDuplicatesExistingUnit(PROBE_BLOCK_TEXT, candidate, [existing])
    ),
    prompt,
    maxRounds: FOCUSED_REPAIR_MAX_ROUNDS,
    mandatoryFullStructureReaudit: true,
    mergePolicy: 'full-unit-non-lossy-two-pass-parent-remap-with-grounded-malformed-exception-parent-clear-and-ambiguity-normalization',
  }));
}

/** Post-paid-extraction evidence refinement changes persisted source spans,
 * identities and retrieval text. Probe the real pure transformation so final
 * trusted artifacts invalidate while raw paid-response checkpoints remain
 * reusable and can be re-refined locally. */
function probeEvidenceRefinementPolicy(): string {
  const broadQuote = PROBE_BLOCK_TEXT;
  const units = [
    probeExtractedUnit({
      extractionRef: 'refine-a',
      statement: 'Документ подаётся в оригинале.',
      sourceSpan: { anchor: 'probe-anchor', quote: broadQuote },
      evidenceByField: { statement: { anchor: 'probe-anchor', quote: broadQuote } },
    }),
    probeExtractedUnit({
      extractionRef: 'refine-b',
      statement: 'Если заявитель находится за рубежом, допускается нотариальная копия.',
      sourceSpan: { anchor: 'probe-anchor', quote: broadQuote },
      evidenceByField: { statement: { anchor: 'probe-anchor', quote: broadQuote } },
    }),
  ];
  const refined = refineCoextensiveEvidence(units);
  return sha256(
    JSON.stringify(refined.map((unit) => [unit.sourceSpan.quote, unit.evidenceByField.statement?.quote ?? null]))
  );
}

function probeGraphIntegrityPolicy(): string {
  const make = (
    unitId: string,
    parentRuleRef: string | null,
    overrides: Partial<PersistedKnowledgeUnit> = {}
  ): PersistedKnowledgeUnit => ({
    kind: 'PROCEDURE_STEP',
    statement: `probe ${unitId}`,
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef,
    sourceSpan: { anchor: 'probe-anchor', quote: 'Документ подаётся в оригинале' },
    evidenceByField: { statement: { anchor: 'probe-anchor', quote: 'Документ подаётся в оригинале' } },
    uncertainties: [],
    sourceBlockAnchor: `probe-block-${unitId}`,
    unitId,
    contentHash: `probe-hash-${unitId}`,
    ...overrides,
  });
  const trigger = (value: 'PUBLIC' | 'PRIVATE') => ({
    all: [{ fact: 'privacyContext' as const, equals: value }],
  });
  const cases: readonly (readonly PersistedKnowledgeUnit[])[] = [
    [make('root', null), make('child', 'root'), make('leaf', 'child')],
    [make('dangling', 'missing')],
    [make('self', 'self')],
    [make('a', 'b'), make('b', 'a')],
    [make('root', null, { triggerCondition: trigger('PUBLIC') }), make('child', 'root', { triggerCondition: trigger('PRIVATE') })],
    [
      make('root', null, { triggerCondition: trigger('PRIVATE') }),
      make('exception', 'root', { kind: 'EXCEPTION_RULE', triggerCondition: trigger('PUBLIC') }),
    ],
  ];
  return sha256(
    JSON.stringify(
      cases.map((units) => {
        try {
          assertTrustedGraphIntegrity(units, 'probe');
          return 'OK';
        } catch (error) {
          return error instanceof ExtractionArtifactError ? error.message.split('.')[0] : String(error);
        }
      })
    )
  );
}

const PROBE_BLOCK: SourceBlockLocation = {
  anchor: 'probe-anchor',
  text: PROBE_BLOCK_TEXT,
  sectionPath: 'Раздел 1 > Подраздел 2',
  structuralPath: 'body/0/3',
  blockStart: 120,
  blockEnd: 120 + PROBE_BLOCK_TEXT.length,
};

function probeExtractedUnit(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Документ подаётся в оригинале.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    extractionRef: 'probe-1',
    parentExtractionRef: null,
    sourceSpan: { anchor: 'probe-anchor', quote: 'Документ подаётся в оригинале' },
    evidenceByField: { statement: { anchor: 'probe-anchor', quote: 'Документ подаётся в оригинале' } },
    uncertainties: [],
    ...overrides,
  };
}

/** `unitId`/`contentHash`/`sourceBlockAnchor` — то, чем units СВЯЗЫВАЮТСЯ между
 *  прогонами (и чем `source-rule-id-by-unit.json` и `engine-results.json`
 *  ссылаются друг на друга). Смена алгоритма делает сохранённые id чужими. */
function probeIdentityAlgorithm(): string {
  const result = assignIdentity(
    [
      probeExtractedUnit(),
      probeExtractedUnit({
        extractionRef: 'probe-2',
        parentExtractionRef: 'probe-1',
        statement: 'Срок оформления — не более 5 рабочих дней.',
        numericConstraint: { factKey: 'processing_days_max', value: 5, unit: 'рабочих дней' },
        sourceSpan: { anchor: 'probe-anchor', quote: 'не более 5 рабочих дней' },
        evidenceByField: { statement: { anchor: 'probe-anchor', quote: 'не более 5 рабочих дней' } },
      }),
    ],
    new Map([['probe-anchor', PROBE_BLOCK]]),
    'probe-source-revision-hash'
  );
  return sha256(
    JSON.stringify(
      result.units.map((u) => [u.unitId, u.contentHash, u.sourceBlockAnchor, u.parentRuleRef])
    )
  );
}

/**
 * Текст, который РЕАЛЬНО уходит в эмбеддинг. Единственная проба, влияющая на
 * переиспользование ВЕКТОРОВ, а не только units: изменение состава
 * `buildRetrievalText` делает каждый кэшированный вектор описанием других слов
 * при том же `unitId`. Проба намеренно задействует все ветки построения —
 * title, родитель, цитату, facets, trigger, числовое ограничение.
 */
function probeRetrievalText(): string {
  const parent: PersistedKnowledgeUnit = {
    ...probeExtractedUnit(),
    sourceBlockAnchor: 'probe-block',
    unitId: 'probe-parent',
    contentHash: 'probe-parent-hash',
    parentRuleRef: null,
  };
  const child: PersistedKnowledgeUnit = {
    ...probeExtractedUnit({
      title: 'Срок оформления',
      statement: 'Срок оформления — не более 5 рабочих дней.',
      facets: { documentForm: 'ORIGINAL' },
      triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PRIVATE' }] },
      numericConstraint: { factKey: 'processing_days_max', value: 5, unit: 'рабочих дней' },
      sourceSpan: { anchor: 'probe-anchor', quote: 'не более 5 рабочих дней' },
    }),
    sourceBlockAnchor: 'probe-block',
    unitId: 'probe-child',
    contentHash: 'probe-child-hash',
    parentRuleRef: 'probe-parent',
  };
  const byId = new Map([parent, child].map((u) => [u.unitId, u]));
  return sha256(JSON.stringify([buildRetrievalText(parent, byId), buildRetrievalText(child, byId)]));
}

export interface PipelineProbeFingerprints {
  readonly extractionPromptFingerprint: string;
  readonly auditPromptFingerprint: string;
  readonly auditPolicyFingerprint: string;
  readonly focusedRepairPolicyFingerprint: string;
  /** Paid-call contract only: response/schema acceptance. Exact prompt is
   * bound separately by each journal requestDigest. Deliberately excludes
   * offline merge/maxRounds/final-publication policy. */
  readonly focusedRepairPaidStageFingerprint: string;
  readonly evidenceRefinementFingerprint: string;
  readonly graphIntegrityPolicyFingerprint: string;
  readonly identityAlgorithmFingerprint: string;
  readonly retrievalTextFingerprint: string;
}

/** Все поведенческие пробы одним вызовом — чтобы вызывающий не мог случайно
 *  пропустить одну. Чистая, без сети; безопасно звать до платных вызовов. */
export function computePipelineProbes(): PipelineProbeFingerprints {
  return {
    extractionPromptFingerprint: probeExtractionPrompt(),
    auditPromptFingerprint: probeAuditPrompt(),
    auditPolicyFingerprint: probeAuditPolicy(),
    focusedRepairPolicyFingerprint: probeFocusedRepairPolicy(),
    focusedRepairPaidStageFingerprint: sha256(JSON.stringify({
      schema: extractedKnowledgeUnitSchema._zod.def,
      accepted: extractedKnowledgeUnitSchema.safeParse(probeExtractedUnit()).success,
      rejectsBlankStatement: extractedKnowledgeUnitSchema.safeParse(probeExtractedUnit({ statement: ' ' })).success,
    })),
    evidenceRefinementFingerprint: probeEvidenceRefinementPolicy(),
    graphIntegrityPolicyFingerprint: probeGraphIntegrityPolicy(),
    identityAlgorithmFingerprint: probeIdentityAlgorithm(),
    retrievalTextFingerprint: probeRetrievalText(),
  };
}

// ───────────────────────────── отпечаток ─────────────────────────────

/**
 * Всё, что определяет, КАКИЕ units и КАКИЕ векторы получились. Плоская запись
 * из строк и чисел намеренно: `computeFingerprintDigest` обходит её по ключам,
 * поэтому новое поле участвует в дайджесте с момента добавления, без правки
 * функции хеширования (тест `EVERY field participates` это сторожит).
 */
export interface ExtractionFingerprint {
  readonly artifactVersion: string;
  // Источник.
  readonly sourceRevisionHash: string;
  readonly canonicalTextHash: string;
  readonly parserVersion: string;
  readonly blockCount: number;
  // Экстракция.
  readonly extractionProvider: string;
  readonly extractionModel: string;
  readonly extractionPromptVersion: string;
  readonly extractionPromptFingerprint: string;
  readonly extractionSchemaVersion: string;
  readonly extractionMaxTokens: number;
  readonly extractionBatchSize: number;
  // Аудит полноты.
  readonly auditProvider: string;
  readonly auditModel: string;
  readonly auditPromptVersion: string;
  readonly auditPromptFingerprint: string;
  readonly auditPolicyFingerprint: string;
  // Политики, у которых нет константы версии (см. пробы выше).
  readonly focusedRepairPolicyFingerprint: string;
  readonly evidenceRefinementFingerprint: string;
  readonly graphIntegrityPolicyFingerprint: string;
  readonly identityAlgorithmFingerprint: string;
  readonly retrievalTextFingerprint: string;
  // Эмбеддинги.
  readonly embeddingProvider: string;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
}

/** Канонический дайджест: ключи сортируются, поэтому порядок полей в объекте
 *  на значение не влияет, а любое РЕАЛЬНО присутствующее поле — влияет. */
export function computeFingerprintDigest(fingerprint: ExtractionFingerprint): string {
  const entries = Object.keys(fingerprint)
    .sort()
    .map((key) => [key, (fingerprint as unknown as Record<string, unknown>)[key]]);
  return sha256(JSON.stringify(entries));
}

export function diffFingerprints(
  saved: ExtractionFingerprint,
  current: ExtractionFingerprint
): FingerprintFieldMismatch[] {
  const fields = [...new Set([...Object.keys(saved), ...Object.keys(current)])].sort() as (keyof ExtractionFingerprint)[];
  const mismatches: FingerprintFieldMismatch[] = [];
  for (const field of fields) {
    if (saved[field] !== current[field]) {
      mismatches.push({ field, saved: saved[field], current: current[field] });
    }
  }
  return mismatches;
}

/**
 * Отказ ГРОМКИЙ и адресный: каждое разошедшееся поле со СВОИМ сохранённым и
 * текущим значением. Молчаливое продолжение здесь стоило бы дороже, чем весь
 * сэкономленный этой фичей бюджет: бенчмарк выдал бы правдоподобное число,
 * посчитанное по units, которых сегодняшний пайплайн не произвёл бы.
 */
export function assertFingerprintMatches(
  saved: ExtractionFingerprint,
  current: ExtractionFingerprint,
  sourceLabel: string
): void {
  const mismatches = diffFingerprints(saved, current);
  if (mismatches.length === 0) return;

  const lines = mismatches.map((m) => `  - ${m.field}: сохранено "${m.saved}", сейчас "${m.current}"`);
  throw new ExtractionArtifactMismatchError(
    `Артефакт извлечения "${sourceLabel}" снят при ДРУГОЙ конфигурации пайплайна — ` +
      `переиспользовать его нельзя, иначе бенчмарк посчитает уверенно неверный результат ` +
      `по units, которых текущий пайплайн бы не произвёл.\n` +
      `Расхождений: ${mismatches.length}\n${lines.join('\n')}\n${REMEDIATION}`,
    mismatches
  );
}

// ───────────────────────────── артефакт ─────────────────────────────

/** Одна попытка структурированного вызова — журнал ретраев прогона.
 *  Живёт здесь, а не в скрипте, потому что артефакт его переносит. */
export interface ExtractionAttemptLog {
  readonly attempt: number;
  readonly outcome: 'SUCCESS' | 'SCHEMA_MISMATCH' | 'TRUNCATED_JSON' | 'NETWORK_ERROR' | 'OTHER_ERROR';
  readonly message: string | null;
}

/** Вектор кандидата + текст, по которому он посчитан. Текст хранится ИМЕННО
 *  чтобы при загрузке сверить его с пересчитанным: `unitId` совпадающий, а
 *  текст разошедшийся — это вектор про другие слова. */
export interface StoredEmbedding {
  readonly unitId: string;
  readonly retrievalText: string;
  readonly embedding: readonly number[];
}

export interface ExtractionArtifact {
  readonly artifactVersion: string;
  readonly phase: ExtractionArtifactPhase;
  readonly savedAt: string;
  readonly sourceDocPath: string;
  readonly fingerprint: ExtractionFingerprint;
  /** Дайджест СОБСТВЕННОГО `fingerprint` — ловит артефакт, у которого поля
   *  отпечатка поправили руками, чтобы «подошло». */
  readonly fingerprintDigest: string;
  /** Digest of all semantically relevant persisted content. Volatile location
   * and timestamp fields are deliberately excluded. */
  readonly contentDigest: string;
  readonly snapshot: EvaluationKnowledgeSnapshot;
  readonly embeddingModel: ModelInfo;
  readonly embeddings: readonly StoredEmbedding[];
  readonly extractionAttemptLog: readonly ExtractionAttemptLog[];
  readonly batchLogs: readonly BatchExtractionLog[];
  readonly auditResults: readonly BlockCoverageAuditResult[];
  readonly focusedRetryLogs: readonly FocusedRetryLog[];
}

export interface BuildExtractionArtifactInput {
  readonly phase: ExtractionArtifactPhase;
  readonly fingerprint: ExtractionFingerprint;
  readonly sourceDocPath: string;
  readonly snapshot: EvaluationKnowledgeSnapshot;
  readonly embeddingModel: ModelInfo;
  readonly embeddings: readonly StoredEmbedding[];
  readonly extractionAttemptLog: readonly ExtractionAttemptLog[];
  readonly batchLogs: readonly BatchExtractionLog[];
  readonly auditResults: readonly BlockCoverageAuditResult[];
  readonly focusedRetryLogs: readonly FocusedRetryLog[];
}

/** Artifact publication boundary: each source block must be represented once
 * in the extraction batches and have at least one audit. Re-audits (for
 * taint replacement) are allowed, but every persisted audit — including the
 * final one — must be explicitly clean. This prevents an earlier clean audit
 * from masking a later regression. */
export function assertTrustedCompleteness(
  batchLogs: readonly BatchExtractionLog[],
  auditResults: readonly BlockCoverageAuditResult[],
  expectedBlockCount: number,
  label: string
): void {
  if (!Number.isInteger(expectedBlockCount) || expectedBlockCount < 1) {
    throw new ExtractionArtifactError(
      `Артефакт "${label}": fingerprint.blockCount обязан быть целым >= 1. ${REMEDIATION}`
    );
  }
  const expectedAnchors = new Set<string>();
  for (const [batchIndex, log] of batchLogs.entries()) {
    if (!Number.isInteger(log.batchIndex) || !Array.isArray(log.blockAnchors) || log.blockAnchors.length === 0) {
      throw new ExtractionArtifactError(`Артефакт "${label}": batchLogs[${batchIndex}] повреждён. ${REMEDIATION}`);
    }
    for (const anchor of log.blockAnchors) {
      if (typeof anchor !== 'string' || anchor.length === 0 || expectedAnchors.has(anchor)) {
        throw new ExtractionArtifactError(
          `Артефакт "${label}": anchor блока "${String(anchor)}" пуст или встречается в batchLogs больше одного раза. ${REMEDIATION}`
        );
      }
      expectedAnchors.add(anchor);
    }
  }
  if (expectedAnchors.size === 0) {
    throw new ExtractionArtifactError(`Артефакт "${label}": batchLogs не содержит ни одного блока. ${REMEDIATION}`);
  }
  if (expectedAnchors.size !== expectedBlockCount) {
    throw new ExtractionArtifactError(
      `Артефакт "${label}": batchLogs покрывает ${expectedAnchors.size} уникальных блоков, ` +
        `но fingerprint.blockCount требует ${expectedBlockCount}; trusted artifact неполон. ${REMEDIATION}`
    );
  }

  const auditCountByAnchor = new Map<string, number>();
  for (const [index, audit] of auditResults.entries()) {
    if (
      typeof audit !== 'object' || audit === null || typeof audit.blockAnchor !== 'string' ||
      !Array.isArray(audit.findings) || typeof audit.hasGap !== 'boolean'
    ) {
      throw new ExtractionArtifactError(`Артефакт "${label}": auditResults[${index}] повреждён. ${REMEDIATION}`);
    }
    if (!expectedAnchors.has(audit.blockAnchor)) {
      throw new ExtractionArtifactError(
        `Артефакт "${label}": аудит ссылается на неизвестный блок "${audit.blockAnchor}". ${REMEDIATION}`
      );
    }
    if (audit.hasGap || audit.unresolved === true || coverageAuditNeedsReview(audit)) {
      throw new ExtractionArtifactError(
        `Артефакт "${label}": блок "${audit.blockAnchor}" не имеет чистого COVERED-аудита; trusted artifact запрещён. ${REMEDIATION}`
      );
    }
    auditCountByAnchor.set(audit.blockAnchor, (auditCountByAnchor.get(audit.blockAnchor) ?? 0) + 1);
  }

  const missing = [...expectedAnchors].filter((anchor) => !auditCountByAnchor.has(anchor));
  if (missing.length > 0) {
    throw new ExtractionArtifactError(
      `Артефакт "${label}": нет финального чистого аудита блоков: ${missing.join(', ')}. ${REMEDIATION}`
    );
  }
}

/** Semantic publication invariant. An exception without both a parent rule
 * and an executable trigger cannot participate safely in applicability: it
 * silently behaves like missing knowledge and turns answerable cases into
 * HOLD. Reject it; never guess/reclassify at this boundary. */
export function assertTrustedSemanticIntegrity(
  units: readonly PersistedKnowledgeUnit[],
  label: string
): void {
  const malformed = units.filter(
    (unit) => unit.kind === 'EXCEPTION_RULE' && (unit.parentRuleRef === null || unit.triggerCondition === null)
  );
  if (malformed.length === 0) return;

  const details = malformed.map((unit) => {
    const missing = [
      ...(unit.parentRuleRef === null ? ['parentRuleRef'] : []),
      ...(unit.triggerCondition === null ? ['triggerCondition'] : []),
    ];
    return `${unit.unitId} (anchor=${unit.sourceBlockAnchor}, нет ${missing.join('+')})`;
  });
  throw new ExtractionArtifactError(
    `Артефакт "${label}": malformed EXCEPTION_RULE запрещён на trusted boundary: ${details.join('; ')}. ${REMEDIATION}`
  );
}

/** Validates the persisted parent graph and structural trigger inheritance.
 * An EXCEPTION_RULE's edge points at the rule it overrides, not at a
 * structural parent, so trigger inheritance deliberately stops at that edge. */
export function assertTrustedGraphIntegrity(
  units: readonly PersistedKnowledgeUnit[],
  label: string
): void {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));

  for (const unit of units) {
    if (unit.parentRuleRef === null) continue;
    if (unit.parentRuleRef === unit.unitId) {
      throw new ExtractionArtifactError(
        `Артефакт "${label}": self-parent запрещён: ${unit.unitId} -> ${unit.parentRuleRef}. ${REMEDIATION}`
      );
    }
    if (!byId.has(unit.parentRuleRef)) {
      throw new ExtractionArtifactError(
        `Артефакт "${label}": dangling parent edge: ${unit.unitId} -> ${unit.parentRuleRef}. ${REMEDIATION}`
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (unit: PersistedKnowledgeUnit, path: readonly string[]): void => {
    if (visited.has(unit.unitId)) return;
    if (visiting.has(unit.unitId)) {
      const cycleStart = path.indexOf(unit.unitId);
      const cycle = [...path.slice(cycleStart), unit.unitId];
      throw new ExtractionArtifactError(
        `Артефакт "${label}": cycle в parent graph: ${cycle.join(' -> ')}. ${REMEDIATION}`
      );
    }
    visiting.add(unit.unitId);
    if (unit.parentRuleRef !== null) visit(byId.get(unit.parentRuleRef)!, [...path, unit.unitId]);
    visiting.delete(unit.unitId);
    visited.add(unit.unitId);
  };
  for (const unit of units) visit(unit, []);

  for (const unit of units) {
    const requiredByFact = new Map<string, { value: unknown; unitId: string }>();
    let current: PersistedKnowledgeUnit | undefined = unit;
    while (current !== undefined) {
      for (const clause of current.triggerCondition?.all ?? []) {
        const prior = requiredByFact.get(clause.fact);
        if (prior !== undefined && prior.value !== clause.equals) {
          throw new ExtractionArtifactError(
            `Артефакт "${label}": contradictory inherited trigger для ${unit.unitId}: ` +
              `${clause.fact}=${String(prior.value)} (${prior.unitId}) против ${clause.fact}=${String(clause.equals)} (${current.unitId}). ${REMEDIATION}`
          );
        }
        requiredByFact.set(clause.fact, { value: clause.equals, unitId: current.unitId });
      }
      // This edge is an override target, never structural inheritance.
      if (current.kind === 'EXCEPTION_RULE') break;
      current = current.parentRuleRef === null ? undefined : byId.get(current.parentRuleRef);
    }
  }
}

export function buildExtractionArtifact(input: BuildExtractionArtifactInput): ExtractionArtifact {
  assertTrustedCompleteness(input.batchLogs, input.auditResults, input.fingerprint.blockCount, input.sourceDocPath);
  assertTrustedSemanticIntegrity(input.snapshot.units, input.sourceDocPath);
  assertTrustedGraphIntegrity(input.snapshot.units, input.sourceDocPath);
  const artifactWithoutDigest = {
    artifactVersion: EXTRACTION_ARTIFACT_VERSION,
    phase: input.phase,
    savedAt: new Date().toISOString(),
    sourceDocPath: input.sourceDocPath,
    fingerprint: input.fingerprint,
    fingerprintDigest: computeFingerprintDigest(input.fingerprint),
    snapshot: input.snapshot,
    embeddingModel: input.embeddingModel,
    embeddings: input.embeddings,
    extractionAttemptLog: input.extractionAttemptLog,
    batchLogs: input.batchLogs,
    auditResults: input.auditResults,
    focusedRetryLogs: input.focusedRetryLogs,
  };
  if (input.phase === 'SEMANTIC_CHECKPOINT' && input.embeddings.length !== 0) {
    throw new ExtractionArtifactError('SEMANTIC_CHECKPOINT не должен содержать частичный набор embeddings.');
  }
  if (input.phase === 'COMPLETE' && input.embeddings.length === 0) {
    throw new ExtractionArtifactError('COMPLETE extraction artifact обязан содержать embeddings.');
  }
  return { ...artifactWithoutDigest, contentDigest: computeArtifactContentDigest(artifactWithoutDigest) };
}

/** Stable recursive JSON representation: object keys sort, array order stays
 * significant (unit and embedding order is part of the artifact contract). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

type DigestibleArtifact = Omit<ExtractionArtifact, 'contentDigest'>;

export function computeArtifactContentDigest(artifact: DigestibleArtifact | ExtractionArtifact): string {
  const { savedAt: _savedAt, sourceDocPath: _sourceDocPath, contentDigest: _contentDigest, ...content } =
    artifact as ExtractionArtifact;
  return sha256(JSON.stringify(canonicalize(content)));
}

export function serializeExtractionArtifact(artifact: ExtractionArtifact): string {
  return JSON.stringify(artifact, null, 2);
}

function requireString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExtractionArtifactError(`Артефакт "${label}": поле ${field} обязано быть непустой строкой. ${REMEDIATION}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExtractionArtifactError(`Артефакт "${label}": поле ${field} обязано быть числом. ${REMEDIATION}`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], field: string, label: string): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new ExtractionArtifactError(
      `Артефакт "${label}": ${field} не соответствует строгой схеме ` +
        `(нет: ${missing.join(', ') || '—'}; неизвестны: ${extra.join(', ') || '—'}). ${REMEDIATION}`
    );
  }
}

/** Поля отпечатка перечислены ЯВНО (а не «всё, что нашлось в JSON»): артефакт
 *  с лишним или недостающим полем — из другой версии схемы отпечатка, и
 *  сравнивать его с текущей конфигурацией нельзя. */
const FINGERPRINT_STRING_FIELDS = [
  'artifactVersion',
  'sourceRevisionHash',
  'canonicalTextHash',
  'parserVersion',
  'extractionProvider',
  'extractionModel',
  'extractionPromptVersion',
  'extractionPromptFingerprint',
  'extractionSchemaVersion',
  'auditProvider',
  'auditModel',
  'auditPromptVersion',
  'auditPromptFingerprint',
  'auditPolicyFingerprint',
  'focusedRepairPolicyFingerprint',
  'evidenceRefinementFingerprint',
  'graphIntegrityPolicyFingerprint',
  'identityAlgorithmFingerprint',
  'retrievalTextFingerprint',
  'embeddingProvider',
  'embeddingModel',
] as const;

const FINGERPRINT_NUMBER_FIELDS = [
  'blockCount',
  'extractionMaxTokens',
  'extractionBatchSize',
  'embeddingDimensions',
] as const;

function parseFingerprint(raw: unknown, label: string): ExtractionFingerprint {
  if (typeof raw !== 'object' || raw === null) {
    throw new ExtractionArtifactError(`Артефакт "${label}": отсутствует блок fingerprint. ${REMEDIATION}`);
  }
  const source = raw as Record<string, unknown>;
  const expected = new Set<string>([...FINGERPRINT_STRING_FIELDS, ...FINGERPRINT_NUMBER_FIELDS]);
  const extra = Object.keys(source).filter((k) => !expected.has(k));
  if (extra.length > 0) {
    throw new ExtractionArtifactError(
      `Артефакт "${label}": в fingerprint неизвестные поля (${extra.join(', ')}) — он снят другой версией схемы отпечатка. ${REMEDIATION}`
    );
  }
  const out: Record<string, string | number> = {};
  for (const field of FINGERPRINT_STRING_FIELDS) out[field] = requireString(source[field], `fingerprint.${field}`, label);
  for (const field of FINGERPRINT_NUMBER_FIELDS) out[field] = requireNumber(source[field], `fingerprint.${field}`, label);
  return out as unknown as ExtractionFingerprint;
}

function parseUnits(raw: unknown, label: string): readonly PersistedKnowledgeUnit[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ExtractionArtifactError(
      `Артефакт "${label}": snapshot.units пуст — вырожденная экстракция выглядела бы как чистое переиспользование. ${REMEDIATION}`
    );
  }
  for (const [i, value] of raw.entries()) {
    const unit = value as Partial<PersistedKnowledgeUnit> | null;
    if (
      typeof unit !== 'object' ||
      unit === null ||
      typeof unit.unitId !== 'string' ||
      typeof unit.contentHash !== 'string' ||
      typeof unit.sourceBlockAnchor !== 'string' ||
      typeof unit.statement !== 'string'
    ) {
      throw new ExtractionArtifactError(
        `Артефакт "${label}": snapshot.units[${i}] не похож на PersistedKnowledgeUnit. ${REMEDIATION}`
      );
    }
  }
  // Единственное приведение на границе JSON: форма проверена выше настолько,
  // насколько её вообще можно проверить, не дублируя здесь всю схему
  // extraction.ts. Дальше целостность держит `fingerprintDigest`.
  return raw as readonly PersistedKnowledgeUnit[];
}

function parseEmbeddings(raw: unknown, label: string): readonly StoredEmbedding[] {
  if (!Array.isArray(raw)) {
    throw new ExtractionArtifactError(`Артефакт "${label}": embeddings обязан быть массивом. ${REMEDIATION}`);
  }
  return raw.map((value, i) => {
    const entry = value as Partial<StoredEmbedding> | null;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.unitId !== 'string' ||
      typeof entry.retrievalText !== 'string' ||
      !Array.isArray(entry.embedding) ||
      entry.embedding.length === 0 ||
      !entry.embedding.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new ExtractionArtifactError(
        `Артефакт "${label}": embeddings[${i}] повреждён (ожидались unitId, retrievalText и непустой числовой вектор). ${REMEDIATION}`
      );
    }
    return { unitId: entry.unitId, retrievalText: entry.retrievalText, embedding: entry.embedding };
  });
}

export function parseExtractionArtifact(json: string, sourceLabel: string): ExtractionArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}" не читается как JSON: ${err instanceof Error ? err.message : String(err)}. ${REMEDIATION}`
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": ожидался JSON-объект. ${REMEDIATION}`);
  }
  const source = raw as Record<string, unknown>;
  assertExactKeys(
    source,
    [
      'artifactVersion', 'phase', 'savedAt', 'sourceDocPath', 'fingerprint', 'fingerprintDigest', 'contentDigest',
      'snapshot', 'embeddingModel', 'embeddings', 'extractionAttemptLog', 'batchLogs', 'auditResults',
      'focusedRetryLogs',
    ],
    'корень',
    sourceLabel
  );

  const artifactVersion = requireString(source.artifactVersion, 'artifactVersion', sourceLabel);
  if (artifactVersion !== EXTRACTION_ARTIFACT_VERSION) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}" версии "${artifactVersion}", текущая — "${EXTRACTION_ARTIFACT_VERSION}". ${REMEDIATION}`
    );
  }
  const phase = requireString(source.phase, 'phase', sourceLabel);
  if (phase !== 'SEMANTIC_CHECKPOINT' && phase !== 'COMPLETE') {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": неизвестная phase "${phase}". ${REMEDIATION}`);
  }

  const fingerprint = parseFingerprint(source.fingerprint, sourceLabel);
  const storedDigest = requireString(source.fingerprintDigest, 'fingerprintDigest', sourceLabel);
  const actualDigest = computeFingerprintDigest(fingerprint);
  if (storedDigest !== actualDigest) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}": fingerprintDigest не сходится с самим fingerprint ` +
        `(записан ${storedDigest}, посчитан ${actualDigest}) — поля отпечатка правили вручную. ${REMEDIATION}`
    );
  }

  const snapshotRaw = source.snapshot;
  if (typeof snapshotRaw !== 'object' || snapshotRaw === null) {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": отсутствует snapshot. ${REMEDIATION}`);
  }
  const snapshotSource = snapshotRaw as Record<string, unknown>;
  assertExactKeys(
    snapshotSource,
    [
      'sourceRevisionHash', 'canonicalTextHash', 'parserVersion', 'extractionRunId', 'extractionProvider',
      'extractionModel', 'extractionPromptVersion', 'extractionSchemaVersion', 'humanReviewed', 'units',
    ],
    'snapshot',
    sourceLabel
  );
  if (snapshotSource.humanReviewed !== false) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}": snapshot.humanReviewed обязан быть false — EvaluationKnowledgeSnapshot по определению неотревьюен. ${REMEDIATION}`
    );
  }

  const snapshot: EvaluationKnowledgeSnapshot = {
    sourceRevisionHash: requireString(snapshotSource.sourceRevisionHash, 'snapshot.sourceRevisionHash', sourceLabel),
    canonicalTextHash: requireString(snapshotSource.canonicalTextHash, 'snapshot.canonicalTextHash', sourceLabel),
    parserVersion: requireString(snapshotSource.parserVersion, 'snapshot.parserVersion', sourceLabel),
    extractionRunId: requireString(snapshotSource.extractionRunId, 'snapshot.extractionRunId', sourceLabel),
    extractionProvider: requireString(snapshotSource.extractionProvider, 'snapshot.extractionProvider', sourceLabel),
    extractionModel: requireString(snapshotSource.extractionModel, 'snapshot.extractionModel', sourceLabel),
    extractionPromptVersion: requireString(
      snapshotSource.extractionPromptVersion,
      'snapshot.extractionPromptVersion',
      sourceLabel
    ),
    extractionSchemaVersion: requireString(
      snapshotSource.extractionSchemaVersion,
      'snapshot.extractionSchemaVersion',
      sourceLabel
    ),
    humanReviewed: false,
    units: parseUnits(snapshotSource.units, sourceLabel),
  };

  const embeddingModelRaw = source.embeddingModel;
  if (typeof embeddingModelRaw !== 'object' || embeddingModelRaw === null) {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": отсутствует embeddingModel. ${REMEDIATION}`);
  }
  const embeddingModelSource = embeddingModelRaw as Record<string, unknown>;
  assertExactKeys(
    embeddingModelSource,
    embeddingModelSource.dimensions === undefined ? ['provider', 'model'] : ['provider', 'model', 'dimensions'],
    'embeddingModel',
    sourceLabel
  );
  const embeddingModel: ModelInfo = {
    provider: requireString(embeddingModelSource.provider, 'embeddingModel.provider', sourceLabel),
    model: requireString(embeddingModelSource.model, 'embeddingModel.model', sourceLabel),
    ...(embeddingModelSource.dimensions === undefined
      ? {}
      : { dimensions: requireNumber(embeddingModelSource.dimensions, 'embeddingModel.dimensions', sourceLabel) }),
  };

  const requireArray = <T>(value: unknown, field: string): readonly T[] => {
    if (!Array.isArray(value)) {
      throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": ${field} обязан быть массивом. ${REMEDIATION}`);
    }
    return value as T[];
  };

  const parsed: ExtractionArtifact = {
    artifactVersion,
    phase,
    savedAt: requireString(source.savedAt, 'savedAt', sourceLabel),
    sourceDocPath: requireString(source.sourceDocPath, 'sourceDocPath', sourceLabel),
    fingerprint,
    fingerprintDigest: storedDigest,
    contentDigest: requireString(source.contentDigest, 'contentDigest', sourceLabel),
    snapshot,
    embeddingModel,
    embeddings: parseEmbeddings(source.embeddings, sourceLabel),
    // Журналы прошлого прогона переносятся как есть: они только пишутся в
    // артефакты прогона для сопоставимости отчётов и НИКОГДА не подаются в
    // CostLedger повторно — те токены оплачены в исходном прогоне, и
    // засчитать их снова значило бы завысить стоимость переиспользующего.
    extractionAttemptLog: requireArray<ExtractionAttemptLog>(source.extractionAttemptLog, 'extractionAttemptLog'),
    batchLogs: requireArray<BatchExtractionLog>(source.batchLogs, 'batchLogs'),
    auditResults: requireArray<BlockCoverageAuditResult>(source.auditResults, 'auditResults'),
    focusedRetryLogs: requireArray<FocusedRetryLog>(source.focusedRetryLogs, 'focusedRetryLogs'),
  };
  assertTrustedSemanticIntegrity(parsed.snapshot.units, sourceLabel);
  assertTrustedGraphIntegrity(parsed.snapshot.units, sourceLabel);
  if (parsed.phase === 'SEMANTIC_CHECKPOINT' && parsed.embeddings.length !== 0) {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": semantic checkpoint содержит частичные embeddings. ${REMEDIATION}`);
  }
  if (parsed.phase === 'COMPLETE' && parsed.embeddings.length === 0) {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": COMPLETE не содержит embeddings. ${REMEDIATION}`);
  }
  assertTrustedCompleteness(parsed.batchLogs, parsed.auditResults, parsed.fingerprint.blockCount, sourceLabel);
  const actualContentDigest = computeArtifactContentDigest(parsed);
  if (parsed.contentDigest !== actualContentDigest) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}": contentDigest не сходится с содержимым ` +
        `(записан ${parsed.contentDigest}, посчитан ${actualContentDigest}) — snapshot, units, embeddings или журналы повреждены. ${REMEDIATION}`
    );
  }
  return parsed;
}

export function writeExtractionArtifact(filePath: string, artifact: ExtractionArtifact): void {
  const serialized = serializeExtractionArtifact(artifact);
  // Validate exactly what will reach disk before replacing a known-good file.
  parseExtractionArtifact(serialized, `${filePath} (предзапись)`);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    // Catch truncation/storage surprises before the atomic checkpoint.
    parseExtractionArtifact(readFileSync(tempPath, 'utf8'), tempPath);
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Temp may not have been created or rename already consumed it.
    }
    throw err;
  }
}

/**
 * Читает, валидирует и СВЕРЯЕТ артефакт с текущей конфигурацией одним шагом —
 * чтобы не осталось пути «прочитал и забыл сверить».
 */
export function readExtractionArtifact(
  filePath: string,
  currentFingerprint: ExtractionFingerprint
): ExtractionArtifact {
  let json: string;
  try {
    json = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ExtractionArtifactError(
      `--reuse-extraction: не удалось прочитать артефакт "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const artifact = parseExtractionArtifact(json, filePath);
  assertFingerprintMatches(artifact.fingerprint, currentFingerprint, filePath);
  return artifact;
}

/**
 * Возвращает кэшированные векторы в порядке ТЕКУЩЕГО списка кандидатов.
 *
 * Отпечаток уже сторожит «изменился алгоритм построения retrievalText». Эти
 * проверки — про конкретный набор: тот же алгоритм на других units даст другой
 * состав, и вектор, привязанный к `unitId`, молча описывал бы не тот текст.
 */
export function restoreEmbeddedCandidates(
  artifact: ExtractionArtifact,
  currentCandidates: readonly RetrievalCandidate[],
  currentModel: ModelInfo,
  sourceLabel: string
): EmbeddedCandidate[] {
  if (artifact.phase !== 'COMPLETE') {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}" — только semantic checkpoint: retrieval запрещён до завершения embeddings. ${REMEDIATION}`
    );
  }
  const saved = artifact.embeddingModel;
  if (
    saved.provider !== currentModel.provider ||
    saved.model !== currentModel.model ||
    saved.dimensions !== currentModel.dimensions
  ) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}": векторы посчитаны моделью ${saved.provider}/${saved.model} (dim ${saved.dimensions ?? '?'}), ` +
        `сейчас настроена ${currentModel.provider}/${currentModel.model} (dim ${currentModel.dimensions ?? '?'}) — ` +
        `cosine similarity между разными моделями бессмысленна. ${REMEDIATION}`
    );
  }

  const byUnitId = new Map(artifact.embeddings.map((e) => [e.unitId, e]));
  if (byUnitId.size !== artifact.embeddings.length) {
    throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": в embeddings есть дублирующиеся unitId. ${REMEDIATION}`);
  }

  const missing = currentCandidates.filter((c) => !byUnitId.has(c.unitId)).map((c) => c.unitId);
  const currentIds = new Set(currentCandidates.map((c) => c.unitId));
  const orphaned = artifact.embeddings.filter((e) => !currentIds.has(e.unitId)).map((e) => e.unitId);
  if (missing.length > 0 || orphaned.length > 0) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}": состав кандидатов не совпадает с кэшем векторов ` +
        `(без вектора: ${missing.join(', ') || '—'}; лишних в кэше: ${orphaned.join(', ') || '—'}). ${REMEDIATION}`
    );
  }

  return currentCandidates.map((c) => {
    const stored = byUnitId.get(c.unitId);
    if (stored === undefined) {
      throw new ExtractionArtifactError(`Артефакт "${sourceLabel}": нет вектора для ${c.unitId}. ${REMEDIATION}`);
    }
    if (stored.retrievalText !== c.retrievalText) {
      throw new ExtractionArtifactError(
        `Артефакт "${sourceLabel}": retrievalText юнита ${c.unitId} разошёлся с сохранённым — ` +
          `кэшированный вектор описывает другой текст. ${REMEDIATION}`
      );
    }
    if (currentModel.dimensions !== undefined && stored.embedding.length !== currentModel.dimensions) {
      throw new ExtractionArtifactError(
        `Артефакт "${sourceLabel}": вектор юнита ${c.unitId} длины ${stored.embedding.length}, ожидалось ${currentModel.dimensions}. ${REMEDIATION}`
      );
    }
    return { unitId: c.unitId, retrievalText: c.retrievalText, embedding: [...stored.embedding], embeddingModel: currentModel };
  });
}
