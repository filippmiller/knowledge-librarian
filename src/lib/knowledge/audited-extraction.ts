/**
 * Composes bounded-batch extraction (batch-extraction.ts) with the
 * oracle-blind completeness auditor (extraction-coverage-auditor.ts):
 * every source block gets audited after the batch pass, and a confirmed
 * gap triggers exactly ONE bounded, focused re-extraction of just that
 * block — never a loop, never "retry until the benchmark score improves"
 * (explicitly out of scope by design, not merely by convention).
 *
 * Focused-retry units are namespaced into their own isolated identity
 * space (`focused-{anchor}-...`) with `parentExtractionRef` forced to
 * `null`: they were extracted without seeing the original batch pass's
 * units, so any parent reference they invent could only coincidentally
 * match a real id, never legitimately. Making that failure mode
 * IMPOSSIBLE (not merely unlikely) matches the rest of this module's
 * discipline (batch-extraction.ts's cross-batch namespacing does the same).
 */

import { isDeepStrictEqual } from 'node:util';

import {
  extractKnowledgeUnits,
  type ExtractKnowledgeUnitsOptions,
  type ExtractKnowledgeUnitsResult,
  type SourceBlock,
} from './knowledge-unit-extractor';
import {
  extractKnowledgeUnitsInBatches,
  type BatchExtractionLog,
  type BatchExtractor,
  type BatchExtractionCheckpoint,
} from './batch-extraction';
import {
  auditBlockCoverage,
  coverageAuditNeedsReview,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
  type CoverageFinding,
} from './extraction-coverage-auditor';
import { validateParentRefs } from './applicability/extraction-parent-refs';
import { extractedKnowledgeUnitSchema, type ExtractedKnowledgeUnit } from './applicability/extraction';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import type { ChatMessage } from '@/lib/ai/chat-provider';
import { structured } from '@/lib/ai/structured-output';
import { quoteSpansOverlap } from './quote-locator';
import { z } from 'zod';

export interface FocusedRetryLog {
  readonly blockAnchor: string;
  readonly triggeredBy: readonly CoverageFinding[];
  readonly additionalUnitCount: number;
}

export interface AuditedExtractionResult {
  readonly units: ExtractedKnowledgeUnit[];
  readonly batchLogs: readonly BatchExtractionLog[];
  readonly auditResults: readonly BlockCoverageAuditResult[];
  readonly focusedRetryLogs: readonly FocusedRetryLog[];
}

type CoverageAuditor = (options: AuditBlockCoverageOptions) => Promise<BlockCoverageAuditResult>;
type FocusedRepairExtractor = (options: FocusedRepairOptions) => Promise<ExtractKnowledgeUnitsResult>;

export interface FocusedRepairOptions extends Omit<ExtractKnowledgeUnitsOptions, 'blocks'> {
  readonly block: SourceBlock;
  readonly findings: readonly CoverageFinding[];
  readonly existingUnits: readonly ExtractedKnowledgeUnit[];
}

export interface AuditedExtractionDeps {
  readonly extractor?: BatchExtractor;
  readonly repairExtractor?: FocusedRepairExtractor;
  readonly auditor?: CoverageAuditor;
  readonly initialExtractionCheckpoint?: BatchExtractionCheckpoint;
  readonly paidStageCheckpoint?: AuditedExtractionCheckpoint;
}

export type CoverageAuditStage = 'INITIAL_AUDIT' | 'FINAL_AUDIT';
export const FOCUSED_REPAIR_MAX_ROUNDS = 3;

export interface AuditedExtractionCheckpoint {
  loadAudit(stage: CoverageAuditStage, options: AuditBlockCoverageOptions): BlockCoverageAuditResult | undefined;
  saveAudit(stage: CoverageAuditStage, options: AuditBlockCoverageOptions, result: BlockCoverageAuditResult): void;
  loadRepair(options: FocusedRepairOptions): readonly ExtractedKnowledgeUnit[] | undefined;
  saveRepair(options: FocusedRepairOptions, units: readonly ExtractedKnowledgeUnit[]): void;
}

const focusedRepairResponseSchema = z.strictObject({
  units: z.array(extractedKnowledgeUnitSchema).readonly(),
});

const FOCUSED_REPAIR_SYSTEM_PROMPT = `Ты исправляешь КОНКРЕТНЫЕ пропуски в уже выполненном извлечении единиц знания из одного блока.

Верни ТОЛЬКО units, необходимые для findings. Обычно это новые units. Но если finding требует исправить structured fields существующего unit (kind, triggerCondition, parentExtractionRef или numericConstraint), ОБЯЗАТЕЛЬНО повторно используй extractionRef именно этого существующего unit и верни полную исправленную версию; statement можно уточнить/перефразировать при том же доказательстве. Новый самостоятельный unit обязан получить новый extractionRef, которого нет в списке «Уже извлечено». При исправлении ОБЯЗАТЕЛЬНО скопируй без изменений каждый уже заполненный field, который finding не требует менять: facets, triggerCondition, numericConstraint, parentExtractionRef и соответствующий evidenceByField. null/{} не означает удалить старое значение. Удаление заполненного structured field этим repair-контрактом не поддерживается. Одно существующее правило можно исправить в несколько units: ровно первый повторно использует existing extractionRef для замены, дополнительные получают новые refs, самостоятельные отличающиеся statements и evidence. Одинаковый ref с другим anchor или непересекающимся evidence будет отклонён fail-closed.
kind — СТРОГО одно из: "PROCEDURE_STEP", "EXCEPTION_RULE", "TERM_DEFINITION", "DELIVERY_RULE", "PRICE_RULE". Значения "fact", "disclaimer", "rule", "note" и любые другие ЗАПРЕЩЕНЫ. Если текст является оговоркой или фактом, выбери ближайший допустимый kind по функции знания; не изобретай новый enum.
Если finding указывает самостоятельный запрет/обязанность внутри фразы с определением, добавь отдельный sibling kind="PROCEDURE_STEP" для нормативной семантики; существующий TERM_DEFINITION не заменяй и искусственный parent к нему не создавай.

numericConstraint — null либо ТОЧНО объект {"factKey":"что измеряется","value":2,"unit":"fingers"}. Ключи min/max/from/to/range/values ЗАПРЕЩЕНЫ. Наблюдавшийся неверный ответ {"min":2,"max":3,"unit":"..."} повторять ЗАПРЕЩЕНО. Для диапазона или альтернативы («два или три пальца») верни отдельный unit на КАЖДОЕ значение: один с value=2 и один с value=3, у каждого ровно один factKey/value/unit. Первый исправленный unit может повторить statement существующего unit для безопасной замены; каждый дополнительный unit обязан иметь отличающийся statement и точную отдельную sourceSpan.quote для своего числового токена (например «двух» и «трёх»), чтобы identity не столкнулась. evidenceByField.statement при этом может цитировать полную общую фразу. Если разделение исказило бы смысл, numericConstraint=null и добавь UNRECOGNIZED_NUMERIC_CONSTRAINT; никогда не кодируй диапазон через min/max.
Для unit: "cycles" используй ТОЛЬКО когда исходный текст прямо считает циклы или целые повторяющиеся последовательности. Количество отдельных действий/случаев (например «прижать один раз») имеет unit="times", не "cycles".

Каждый unit обязан иметь ТОЧНО эту объектную форму (без дополнительных ключей):
{"kind":"PROCEDURE_STEP","statement":"...","facets":{},"triggerCondition":null,"numericConstraint":null,"extractionRef":"r1","parentExtractionRef":null,"sourceSpan":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"},"evidenceByField":{"statement":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"}},"uncertainties":[]}

sourceSpan — именно объект {"anchor":"...","quote":"..."}, НЕ строка. sourceSpan.anchor и каждый evidenceByField.*.anchor должны ТОЧНО совпадать с данным anchor. Все quote должны быть непустыми дословными фрагментами исходного блока. evidenceByField.statement обязателен; evidence для каждого заполненного facets/triggerCondition/numericConstraint также обязательно.
triggerCondition — null либо ТОЧНО {"all":[{"fact":"...","equals":...}]}. Закрытый каталог:
- privacyContext: "PRIVATE" | "PUBLIC"
- consentStatus: "EXPLICIT" | "ABSENT"
- reachability: "LIMITED" | "NORMAL"
- helperPresent: true | false (JSON boolean, не строка)
Если исходное условие выражается этим каталогом, запрещено оставлять его только прозой в statement.

Если новое правило является узким исключением/послаблением, которое изменяет уже извлечённое базовое правило: kind="EXCEPTION_RULE", triggerCondition обязателен, parentExtractionRef обязан быть extractionRef базового unit из списка «Уже извлечено». Если base и exception оба создаются этим repair-ответом, parentExtractionRef ссылается на extractionRef нового base. Самостоятельное условное действие, не изменяющее базовое правило, остаётся PROCEDURE_STEP и не получает искусственного parent.
extractionRef каждого нового unit уникален в этом ответе.
uncertainties — всегда массив объектов ТОЧНО формы {"kind":"OTHER","description":"...","quote":"дословная цитата"}. uncertainty.kind — СТРОГО одно из: "UNRECOGNIZED_TRIGGER_CONDITION", "UNRECOGNIZED_NUMERIC_CONSTRAINT", "AMBIGUOUS_FACET", "DANGLING_PARENT_REF", "DUPLICATE_EXTRACTION_REF", "OTHER". Строки вместо объектов запрещены.
Не изобретай значения. Если finding нельзя уверенно структурировать, сохрани правило с явной uncertainty.

Ответ СТРОГО JSON: {"units": [...]}`;

/** Compact, finding-scoped prompt. Deliberately excludes the full-document
 * extraction catalog: schema validation remains identical, while the model
 * is asked only to fill omissions named by the auditor. */
export function buildFocusedRepairPromptMessages(options: Pick<FocusedRepairOptions, 'block' | 'findings' | 'existingUnits'>): ChatMessage[] {
  const existing = options.existingUnits.map((u) => ({
    extractionRef: u.extractionRef,
    kind: u.kind,
    statement: u.statement,
    facets: u.facets,
    sourceSpan: u.sourceSpan,
    evidenceByField: u.evidenceByField,
    parentExtractionRef: u.parentExtractionRef,
    triggerCondition: u.triggerCondition,
    numericConstraint: u.numericConstraint,
    uncertainties: u.uncertainties,
  }));
  const findings = options.findings.map(({ verdict, quote, explanation }) => ({ verdict, quote, explanation }));
  return [
    { role: 'system', content: FOCUSED_REPAIR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Anchor: ${options.block.anchor}\n\nИсходный блок:\n${options.block.text}\n\nУже извлечено:\n${JSON.stringify(existing)}\n\nИсправь только эти findings:\n${JSON.stringify(findings)}`,
    },
  ];
}

export async function extractFocusedRepairUnits(options: FocusedRepairOptions): Promise<ExtractKnowledgeUnitsResult> {
  const structuredResult = await structured<{ units: readonly ExtractedKnowledgeUnit[] }>({
    schema: focusedRepairResponseSchema,
    messages: buildFocusedRepairPromptMessages(options),
    runConfig: options.runConfig,
    maxTokens: Math.min(options.maxTokens ?? 4_000, 4_000),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.signal && { signal: options.signal }),
  });
  return {
    units: validateParentRefs(
      structuredResult.data.units,
      new Set(options.existingUnits.map((unit) => unit.extractionRef))
    ),
    structuredResult,
  };
}

/** Stable, deterministic identity component for semantic deduplication.
 *  Evidence overlap alone is never enough: one broad source span may support
 *  several distinct rules, including a clause recovered only by repair. */
function normalizeSemanticStatement(statement: string): string {
  return statement.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

/** Full semantic equality boundary for an explicit-ref replacement. The ref
 * itself remains stable; every other schema field is publication-relevant. */
export function focusedReplacementChangesExistingUnit(
  existing: ExtractedKnowledgeUnit,
  replacement: ExtractedKnowledgeUnit
): boolean {
  return !isDeepStrictEqual(existing, replacement);
}

function toAuditStatement(unit: ExtractedKnowledgeUnit) {
  return {
    kind: unit.kind,
    statement: unit.statement,
    quote: unit.sourceSpan.quote,
    extractionRef: unit.extractionRef,
    parentExtractionRef: unit.parentExtractionRef,
    triggerCondition: unit.triggerCondition,
    numericConstraint: unit.numericConstraint,
    uncertainties: unit.uncertainties,
  };
}

/** Turns only evidence-grounded ambiguity about an objectively malformed
 * exception into an actionable structural gap. The provider verdict remains
 * journaled verbatim; this is deterministic orchestration policy. */
export function normalizeMalformedExceptionAmbiguities(
  result: BlockCoverageAuditResult,
  block: SourceBlock,
  units: readonly ExtractedKnowledgeUnit[]
): BlockCoverageAuditResult {
  if (result.blockAnchor !== block.anchor) return result;
  const malformed = units.filter((unit) =>
    unit.kind === 'EXCEPTION_RULE' &&
    unit.sourceSpan.anchor === block.anchor &&
    (unit.parentExtractionRef === null || unit.triggerCondition === null)
  );
  const findings = result.findings.map((finding) => {
    if (
      finding.verdict !== 'AMBIGUOUS' ||
      finding.quote.length === 0 ||
      !finding.quoteVerified ||
      !malformed.some((unit) =>
        quoteSpansOverlap(block.text, finding.quote, unit.sourceSpan.quote)
      )
    ) return finding;
    return { ...finding, verdict: 'UNREPRESENTED_CLAUSE' as const };
  });
  return {
    ...result,
    findings,
    hasGap: findings.some((finding) =>
      finding.verdict === 'POSSIBLE_OMISSION' || finding.verdict === 'UNREPRESENTED_CLAUSE'
    ),
    unresolved: findings.some((finding) => finding.verdict === 'AMBIGUOUS'),
  };
}

/** Canonicalize a common provider synonym without touching the paid raw
 * response. The semantic guard prevents ordinary counts from becoming
 * cycles merely because their unit happened to be `times`. */
export function normalizeExtractedNumericUnits(unit: ExtractedKnowledgeUnit): ExtractedKnowledgeUnit {
  const numeric = unit.numericConstraint;
  if (numeric === null || numeric.unit.toLocaleLowerCase('en-US') !== 'times') return unit;
  const cycleSemantics = `${numeric.factKey} ${unit.statement}`.normalize('NFKC').toLocaleLowerCase('ru-RU');
  if (!/(cycle|цикл)/u.test(cycleSemantics)) return unit;
  return { ...unit, numericConstraint: { ...numeric, unit: 'cycles' } };
}

interface TokenSpan {
  readonly normalized: string;
  readonly start: number;
  readonly end: number;
}

function tokenSpans(text: string): TokenSpan[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    normalized: match[0].normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е'),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function longestStatementBackedSpan(quote: string, statement: string): { start: number; end: number; quote: string } | null {
  const quoteTokens = tokenSpans(quote);
  const statementTokens = tokenSpans(statement).map((token) => token.normalized);
  for (let length = quoteTokens.length; length >= 3; length--) {
    for (let start = 0; start + length <= quoteTokens.length; start++) {
      const sequence = quoteTokens.slice(start, start + length).map((token) => token.normalized);
      const present = statementTokens.some((_, statementStart) =>
        sequence.every((token, index) => statementTokens[statementStart + index] === token)
      );
      if (!present) continue;
      const first = quoteTokens[start];
      const last = quoteTokens[start + length - 1];
      return { start: first.start, end: last.end, quote: quote.slice(first.start, last.end) };
    }
  }
  return null;
}

/** Splits a broad shared evidence window only when every distinct unit has a
 * provable, non-overlapping verbatim clause also present in its statement.
 * If proof is incomplete, returns the original units so assignIdentity's
 * ambiguity gate remains authoritative. */
export function refineCoextensiveEvidence(units: readonly ExtractedKnowledgeUnit[]): ExtractedKnowledgeUnit[] {
  const groups = new Map<string, number[]>();
  units.forEach((unit, index) => {
    const key = JSON.stringify([unit.kind, unit.sourceSpan.anchor, unit.sourceSpan.quote]);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const refined = [...units];
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const broadQuote = units[indexes[0]].sourceSpan.quote;
    const spans = indexes.map((index) => longestStatementBackedSpan(broadQuote, units[index].statement));
    if (spans.some((span) => span === null)) continue;
    const proven = spans as { start: number; end: number; quote: string }[];
    const overlaps = proven.some((span, index) =>
      proven.some((other, otherIndex) => index !== otherIndex && span.start < other.end && other.start < span.end)
    );
    if (overlaps) continue;
    indexes.forEach((unitIndex, spanIndex) => {
      const unit = units[unitIndex];
      const narrowed = proven[spanIndex].quote;
      const statementEvidence = unit.evidenceByField.statement;
      refined[unitIndex] = {
        ...unit,
        sourceSpan: { ...unit.sourceSpan, quote: narrowed },
        evidenceByField: {
          ...unit.evidenceByField,
          ...(statementEvidence &&
            statementEvidence.anchor === unit.sourceSpan.anchor &&
            statementEvidence.quote === broadQuote && {
              statement: { ...statementEvidence, quote: narrowed },
            }),
        },
      };
    });
  }
  return refined;
}

/** Public pure policy boundary so artifact fingerprints can probe the exact
 * focused-repair dedup rule rather than one lower-level ingredient of it. */
export function focusedRepairDuplicatesExistingUnit(
  blockText: string,
  candidate: ExtractedKnowledgeUnit,
  existingUnits: readonly ExtractedKnowledgeUnit[]
): boolean {
  const candidateStatement = normalizeSemanticStatement(candidate.statement);
  return existingUnits.some(
    (existing) =>
      normalizeSemanticStatement(existing.statement) === candidateStatement &&
      quoteSpansOverlap(blockText, candidate.sourceSpan.quote, existing.sourceSpan.quote)
  );
}

export async function extractKnowledgeUnitsWithCompletenessAudit(
  blocks: readonly SourceBlock[],
  batchSize: number,
  optionsPerBatch: Omit<ExtractKnowledgeUnitsOptions, 'blocks'>,
  auditRunConfig: ExtractionRunConfig,
  deps: AuditedExtractionDeps = {}
): Promise<AuditedExtractionResult> {
  const extractor = deps.extractor ?? extractKnowledgeUnits;
  // Never fall back to the batch extractor here: real runners inject a
  // retrying/instrumented batch extractor, and doing so would silently bring
  // the full-document system prompt back for a one-finding repair.
  const repairExtractor = deps.repairExtractor ?? extractFocusedRepairUnits;
  const auditor = deps.auditor ?? auditBlockCoverage;

  const { units: initialUnits, batchLogs } = await extractKnowledgeUnitsInBatches(
    blocks,
    batchSize,
    optionsPerBatch,
    extractor,
    deps.initialExtractionCheckpoint
  );

  const unitsByBlockAnchor = new Map<string, ExtractedKnowledgeUnit[]>();
  for (const u of initialUnits) {
    const list = unitsByBlockAnchor.get(u.sourceSpan.anchor) ?? [];
    list.push(u);
    unitsByBlockAnchor.set(u.sourceSpan.anchor, list);
  }

  const auditResults: BlockCoverageAuditResult[] = [];
  const focusedRetryLogs: FocusedRetryLog[] = [];
  const additionalUnits: ExtractedKnowledgeUnit[] = [];
  const replacementsByExtractionRef = new Map<string, ExtractedKnowledgeUnit>();

  for (const block of blocks) {
    const unitsForBlock = unitsByBlockAnchor.get(block.anchor) ?? [];
    const initialAuditOptions: AuditBlockCoverageOptions = {
      blockAnchor: block.anchor,
      blockText: block.text,
      ...(block.kind !== undefined && { blockKind: block.kind }),
      extractedStatements: unitsForBlock.map(toAuditStatement),
      runConfig: auditRunConfig,
    };
    const restoredInitialAudit = deps.paidStageCheckpoint?.loadAudit('INITIAL_AUDIT', initialAuditOptions);
    const rawAudit = restoredInitialAudit ?? await auditor(initialAuditOptions);
    if (restoredInitialAudit === undefined) deps.paidStageCheckpoint?.saveAudit('INITIAL_AUDIT', initialAuditOptions, rawAudit);
    const audit = normalizeMalformedExceptionAmbiguities(rawAudit, block, unitsForBlock);
    if (!coverageAuditNeedsReview(audit)) {
      auditResults.push(audit);
      continue;
    }

    if (!audit.hasGap) {
      throw new Error(`Coverage audit did not clear block ${block.anchor}: explicit COVERED verdict required`);
    }

    let pendingAudit = audit;
    let currentUnitsForBlock = unitsForBlock;
    let blockCleared = false;
    for (let repairRound = 1; repairRound <= FOCUSED_REPAIR_MAX_ROUNDS; repairRound += 1) {
    const repairOptions: FocusedRepairOptions = {
      ...optionsPerBatch,
      block,
      findings: pendingAudit.findings.filter(
        (finding) => finding.verdict === 'POSSIBLE_OMISSION' || finding.verdict === 'UNREPRESENTED_CLAUSE'
      ),
      existingUnits: repairRound === 1
        ? initialUnits
        : initialUnits.map((unit) => replacementsByExtractionRef.get(unit.extractionRef) ?? unit).concat(additionalUnits),
    };
    if (repairOptions.findings.length === 0) {
      throw new Error(`Coverage audit did not clear block ${block.anchor}: no actionable findings`);
    }
    const restoredRepair = deps.paidStageCheckpoint?.loadRepair(repairOptions);
    const retryResult = restoredRepair === undefined
      ? await repairExtractor(repairOptions)
      : { units: [...restoredRepair], structuredResult: {} as never };
    if (restoredRepair === undefined) deps.paidStageCheckpoint?.saveRepair(repairOptions, retryResult.units);
    // The retry re-extracts the WHOLE block from scratch without seeing the
    // original batch pass's units — a confirmed gap (even a minor one, like
    // one missing adjective) makes it re-derive content the original pass
    // ALREADY covered, not just the genuinely missing part. Real observed
    // effect (goal-shift continuation, 2026-08-09, full-smoke6 benchmark run):
    // one source rule ended up with 5 near-duplicate root-level units instead
    // of the 1-2 a human curator would produce, purely from this. Drop a
    // retry unit only when BOTH its normalized semantic statement matches
    // and its evidence overlaps. Overlap by itself is not duplication: one
    // broad quote can contain multiple independent clauses.
    const coveredUnits = [...currentUnitsForBlock];
    const keptUnits: ExtractedKnowledgeUnit[] = [];
    const replacementTargetByRepairRef = new Map<string, ExtractedKnowledgeUnit>();
    for (const candidate of retryResult.units) {
      const explicitRefMatch = currentUnitsForBlock.find(
        (existing) => existing.extractionRef === candidate.extractionRef
      );
      if (explicitRefMatch !== undefined) {
        if (
          candidate.sourceSpan.anchor !== explicitRefMatch.sourceSpan.anchor ||
          !quoteSpansOverlap(block.text, candidate.sourceSpan.quote, explicitRefMatch.sourceSpan.quote)
        ) {
          throw new Error(
            `Focused structural repair for block ${block.anchor} reused extractionRef ${candidate.extractionRef} without overlapping evidence`
          );
        }
        replacementTargetByRepairRef.set(candidate.extractionRef, explicitRefMatch);
        continue;
      }
      const matches = currentUnitsForBlock.filter((existing) =>
        focusedRepairDuplicatesExistingUnit(block.text, candidate, [existing])
      );
      if (matches.length > 1) {
        throw new Error(
          `Focused structural repair for block ${block.anchor} matched ${matches.length} existing units; refusing ambiguous replacement`
        );
      }
      if (matches.length === 1) replacementTargetByRepairRef.set(candidate.extractionRef, matches[0]);
    }
    const remapRepairParent = (parent: string | null): string | null =>
      parent === null ? null : replacementTargetByRepairRef.get(parent)?.extractionRef ?? parent;

    for (const candidate of retryResult.units) {
      const existing = replacementTargetByRepairRef.get(candidate.extractionRef);
      if (existing !== undefined) {
        const preserveFacets = Object.keys(candidate.facets).length === 0 && Object.keys(existing.facets).length > 0;
        const preserveTrigger = candidate.triggerCondition === null && existing.triggerCondition !== null;
        const preserveNumeric = candidate.numericConstraint === null && existing.numericConstraint !== null;
        const actionableFindingOverlapsExisting = pendingAudit.findings.some((finding) =>
          (finding.verdict === 'POSSIBLE_OMISSION' || finding.verdict === 'UNREPRESENTED_CLAUSE') &&
          finding.quoteVerified && finding.quote.length > 0 &&
          [existing.sourceSpan, ...Object.values(existing.evidenceByField)].some((evidence) =>
            evidence.anchor === block.anchor &&
            quoteSpansOverlap(block.text, finding.quote, evidence.quote)
          )
        );
        const mayClearMalformedExceptionParent =
          existing.kind === 'EXCEPTION_RULE' &&
          (existing.parentExtractionRef === null || existing.triggerCondition === null) &&
          candidate.kind !== 'EXCEPTION_RULE' &&
          candidate.parentExtractionRef === null &&
          actionableFindingOverlapsExisting;
        const preserveParent = candidate.parentExtractionRef === null &&
          existing.parentExtractionRef !== null &&
          !mayClearMalformedExceptionParent;
        const replacement: ExtractedKnowledgeUnit = {
          ...candidate,
          extractionRef: existing.extractionRef,
          facets: preserveFacets ? existing.facets : candidate.facets,
          triggerCondition: preserveTrigger ? existing.triggerCondition : candidate.triggerCondition,
          numericConstraint: preserveNumeric ? existing.numericConstraint : candidate.numericConstraint,
          parentExtractionRef: preserveParent
            ? existing.parentExtractionRef
            : remapRepairParent(candidate.parentExtractionRef),
          evidenceByField: {
            ...candidate.evidenceByField,
            ...(preserveFacets && existing.evidenceByField.facets && { facets: existing.evidenceByField.facets }),
            ...(preserveTrigger && existing.evidenceByField.triggerCondition && { triggerCondition: existing.evidenceByField.triggerCondition }),
            ...(preserveNumeric && existing.evidenceByField.numericConstraint && { numericConstraint: existing.evidenceByField.numericConstraint }),
          },
        };
        if (focusedReplacementChangesExistingUnit(existing, replacement)) {
          replacementsByExtractionRef.set(existing.extractionRef, replacement);
        }
        continue;
      }
      const remappedCandidate = {
        ...candidate,
        parentExtractionRef: remapRepairParent(candidate.parentExtractionRef),
      };
      if (focusedRepairDuplicatesExistingUnit(block.text, remappedCandidate, coveredUnits)) continue;
      coveredUnits.push(remappedCandidate);
      keptUnits.push(remappedCandidate);
    }

    const retryRefs = new Set(keptUnits.map((unit) => unit.extractionRef));
    const existingRefs = new Set([...initialUnits, ...additionalUnits].map((unit) => unit.extractionRef));
    const focusedRef = (ref: string) => `focused-${block.anchor}-${repairRound === 1 ? '' : `r${repairRound}-`}${ref}`;
    const namespaced = keptUnits.map((u) => ({
      ...u,
      extractionRef: focusedRef(u.extractionRef),
      parentExtractionRef:
        u.parentExtractionRef === null
          ? null
          : retryRefs.has(u.parentExtractionRef)
            ? focusedRef(u.parentExtractionRef)
            : existingRefs.has(u.parentExtractionRef)
              ? u.parentExtractionRef
              : u.parentExtractionRef,
    }));
    const validMergedRefs = new Set([
      ...existingRefs,
      ...namespaced.map((unit) => unit.extractionRef),
      ...replacementsByExtractionRef.keys(),
    ]);
    for (const unit of [
      ...replacementsByExtractionRef.values(),
      ...namespaced,
    ]) {
      if (unit.parentExtractionRef !== null && !validMergedRefs.has(unit.parentExtractionRef)) {
        throw new Error(
          `Focused repair for block ${block.anchor} left dangling parent ref ${unit.parentExtractionRef}`
        );
      }
    }
    additionalUnits.push(...namespaced);
    focusedRetryLogs.push({
      blockAnchor: block.anchor,
      triggeredBy: pendingAudit.findings.filter(
        (f) => f.verdict === 'POSSIBLE_OMISSION' || f.verdict === 'UNREPRESENTED_CLAUSE'
      ),
      additionalUnitCount: namespaced.length,
    });

    const repairedUnitsForBlock = currentUnitsForBlock.map(
      (unit) => replacementsByExtractionRef.get(unit.extractionRef) ?? unit
    );
    const finalAuditOptions: AuditBlockCoverageOptions = {
      blockAnchor: block.anchor,
      blockText: block.text,
      ...(block.kind !== undefined && { blockKind: block.kind }),
      extractedStatements: [...repairedUnitsForBlock, ...namespaced].map(toAuditStatement),
      runConfig: auditRunConfig,
    };
    const restoredFinalAudit = deps.paidStageCheckpoint?.loadAudit('FINAL_AUDIT', finalAuditOptions);
    const rawFinalAudit = restoredFinalAudit ?? await auditor(finalAuditOptions);
    if (restoredFinalAudit === undefined) deps.paidStageCheckpoint?.saveAudit('FINAL_AUDIT', finalAuditOptions, rawFinalAudit);
    const finalAudit = normalizeMalformedExceptionAmbiguities(
      rawFinalAudit,
      block,
      [...repairedUnitsForBlock, ...namespaced]
    );
    if (coverageAuditNeedsReview(finalAudit)) {
      if (!finalAudit.hasGap) {
        throw new Error(`Focused repair did not clear block ${block.anchor}: final explicit COVERED verdict required`);
      }
      if (repairRound === FOCUSED_REPAIR_MAX_ROUNDS) {
        throw new Error(
          `Focused repair did not clear block ${block.anchor}: ${FOCUSED_REPAIR_MAX_ROUNDS}-round limit exhausted`
        );
      }
      pendingAudit = finalAudit;
      currentUnitsForBlock = [...repairedUnitsForBlock, ...namespaced];
      continue;
    }
    auditResults.push(finalAudit);
    blockCleared = true;
    break;
    }
    if (!blockCleared) {
      throw new Error(
        `Focused repair did not clear block ${block.anchor}: ${FOCUSED_REPAIR_MAX_ROUNDS}-round limit exhausted`
      );
    }
  }

  const repairedUnits = [...initialUnits, ...additionalUnits].map(
    (unit) => replacementsByExtractionRef.get(unit.extractionRef) ?? unit
  );
  const units = validateParentRefs(
    refineCoextensiveEvidence(repairedUnits.map(normalizeExtractedNumericUnits))
  );

  return { units, batchLogs, auditResults, focusedRetryLogs };
}
