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

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import type { ModelInfo } from '@/lib/ai/embedding-provider';
import type { BatchExtractionLog } from '@/lib/knowledge/batch-extraction';
import type { FocusedRetryLog } from '@/lib/knowledge/audited-extraction';
import {
  buildCoverageAuditPromptMessages,
  interpretCoverageAuditResponse,
  type BlockCoverageAuditResult,
  type CoverageVerdict,
  type RawCoverageFinding,
} from '@/lib/knowledge/extraction-coverage-auditor';
import { quoteSpansOverlap } from '@/lib/knowledge/quote-locator';
import type { ExtractedKnowledgeUnit } from '@/lib/knowledge/applicability/extraction';
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
export const EXTRACTION_ARTIFACT_VERSION = '2026-08-10-extraction-artifact-v1';

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
  const pairs: readonly (readonly [string, string])[] = [
    ['Документ подаётся в оригинале', 'Документ подаётся в оригинале'],
    ['Документ подаётся', 'Документ подаётся в оригинале'],
    ['Документ подаётся в оригинале', 'допускается нотариальная копия'],
    ['не более 5 рабочих дней', 'Срок оформления — не более 5 рабочих дней'],
    ['такой цитаты в блоке нет', 'Документ подаётся в оригинале'],
  ];
  return sha256(JSON.stringify(pairs.map(([a, b]) => quoteSpansOverlap(PROBE_BLOCK_TEXT, a, b))));
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
  readonly auditPromptFingerprint: string;
  readonly auditPolicyFingerprint: string;
  readonly focusedRepairPolicyFingerprint: string;
  readonly identityAlgorithmFingerprint: string;
  readonly retrievalTextFingerprint: string;
}

/** Все пять проб одним вызовом — чтобы у скрипта не было выбора взять четыре
 *  из пяти. Чистая, без сети; безопасно звать до любого платного вызова. */
export function computePipelineProbes(): PipelineProbeFingerprints {
  return {
    auditPromptFingerprint: probeAuditPrompt(),
    auditPolicyFingerprint: probeAuditPolicy(),
    focusedRepairPolicyFingerprint: probeFocusedRepairPolicy(),
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
  readonly savedAt: string;
  readonly sourceDocPath: string;
  readonly fingerprint: ExtractionFingerprint;
  /** Дайджест СОБСТВЕННОГО `fingerprint` — ловит артефакт, у которого поля
   *  отпечатка поправили руками, чтобы «подошло». */
  readonly fingerprintDigest: string;
  readonly snapshot: EvaluationKnowledgeSnapshot;
  readonly embeddingModel: ModelInfo;
  readonly embeddings: readonly StoredEmbedding[];
  readonly extractionAttemptLog: readonly ExtractionAttemptLog[];
  readonly batchLogs: readonly BatchExtractionLog[];
  readonly auditResults: readonly BlockCoverageAuditResult[];
  readonly focusedRetryLogs: readonly FocusedRetryLog[];
}

export interface BuildExtractionArtifactInput {
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

export function buildExtractionArtifact(input: BuildExtractionArtifactInput): ExtractionArtifact {
  return {
    artifactVersion: EXTRACTION_ARTIFACT_VERSION,
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
  'extractionSchemaVersion',
  'auditProvider',
  'auditModel',
  'auditPromptVersion',
  'auditPromptFingerprint',
  'auditPolicyFingerprint',
  'focusedRepairPolicyFingerprint',
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

  const artifactVersion = requireString(source.artifactVersion, 'artifactVersion', sourceLabel);
  if (artifactVersion !== EXTRACTION_ARTIFACT_VERSION) {
    throw new ExtractionArtifactError(
      `Артефакт "${sourceLabel}" версии "${artifactVersion}", текущая — "${EXTRACTION_ARTIFACT_VERSION}". ${REMEDIATION}`
    );
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
  const embeddingModel: ModelInfo = {
    provider: requireString(embeddingModelSource.provider, 'embeddingModel.provider', sourceLabel),
    model: requireString(embeddingModelSource.model, 'embeddingModel.model', sourceLabel),
    ...(embeddingModelSource.dimensions === undefined
      ? {}
      : { dimensions: requireNumber(embeddingModelSource.dimensions, 'embeddingModel.dimensions', sourceLabel) }),
  };

  const asArray = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as T[]) : []);

  return {
    artifactVersion,
    savedAt: requireString(source.savedAt, 'savedAt', sourceLabel),
    sourceDocPath: requireString(source.sourceDocPath, 'sourceDocPath', sourceLabel),
    fingerprint,
    fingerprintDigest: storedDigest,
    snapshot,
    embeddingModel,
    embeddings: parseEmbeddings(source.embeddings, sourceLabel),
    // Журналы прошлого прогона переносятся как есть: они только пишутся в
    // артефакты прогона для сопоставимости отчётов и НИКОГДА не подаются в
    // CostLedger повторно — те токены оплачены в исходном прогоне, и
    // засчитать их снова значило бы завысить стоимость переиспользующего.
    extractionAttemptLog: asArray<ExtractionAttemptLog>(source.extractionAttemptLog),
    batchLogs: asArray<BatchExtractionLog>(source.batchLogs),
    auditResults: asArray<BlockCoverageAuditResult>(source.auditResults),
    focusedRetryLogs: asArray<FocusedRetryLog>(source.focusedRetryLogs),
  };
}

export function writeExtractionArtifact(filePath: string, artifact: ExtractionArtifact): void {
  writeFileSync(filePath, serializeExtractionArtifact(artifact), 'utf8');
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
