import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { ChatMessage } from '@/lib/ai/chat-provider';
import type { PersistedKnowledgeUnit } from './applicability/identity-assignment';
import { createDependencyGraph, type DependencyGraph, type DependencyEdgeInput } from './dependency-graph';
import { z } from 'zod';

export const dependencyEdgeSchema = z.strictObject({
  fromUnitId: z.string().min(1),
  toUnitId: z.string().min(1),
  relation: z.enum(['REQUIRES', 'CO_REQUIRED', 'ALTERNATIVE']),
  evidence: z.strictObject({
    from: z.strictObject({ anchor: z.string().min(1), quote: z.string().min(1) }),
    to: z.strictObject({ anchor: z.string().min(1), quote: z.string().min(1) }),
  }),
  auditStatus: z.enum(['PENDING', 'TRUSTED', 'REJECTED']),
});
export const dependencyGraphSchema = z.strictObject({ edges: z.array(dependencyEdgeSchema) });
export type DependencyGraphProposal = z.infer<typeof dependencyGraphSchema>;

export const dependencyAuditSchema = z.strictObject({
  verdict: z.enum(['PASS', 'REPAIR', 'AMBIGUOUS']),
  findings: z.array(z.strictObject({
    kind: z.enum(['MISSING_EDGE', 'UNSUPPORTED_EDGE', 'WRONG_DIRECTION', 'AMBIGUOUS_RELATION']),
    fromUnitId: z.string().min(1).nullable(),
    toUnitId: z.string().min(1).nullable(),
    explanation: z.string().min(1),
  })),
});
export type DependencyAudit = z.infer<typeof dependencyAuditSchema>;

export interface DependencyGraphStageRequest<T> {
  readonly schema: z.ZodType<T>;
  readonly messages: readonly ChatMessage[];
  readonly requestDigest: string;
}
export type DependencyGraphStage<T> = (request: DependencyGraphStageRequest<T>) => Promise<T>;

export interface DependencyGraphCheckpoint {
  load<T>(stage: string, requestDigest: string, schema: z.ZodType<T>): T | undefined;
  save<T>(stage: string, requestDigest: string, value: T, schema: z.ZodType<T>): void;
}

const journalSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(z.strictObject({ stage: z.string(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), value: z.unknown() })),
});

/** Atomic successful-stage journal. Invalid/torn or digest-mismatched entries are never reused. */
export class FileDependencyGraphCheckpoint implements DependencyGraphCheckpoint {
  constructor(private readonly filePath: string) {}
  load<T>(stage: string, requestDigest: string, schema: z.ZodType<T>): T | undefined {
    if (!existsSync(this.filePath)) return undefined;
    let parsed: z.infer<typeof journalSchema>;
    try { parsed = journalSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8'))); } catch { return undefined; }
    const entry = parsed.entries.find((candidate) => candidate.stage === stage && candidate.requestDigest === requestDigest);
    if (!entry) return undefined;
    const value = schema.safeParse(entry.value);
    return value.success ? value.data : undefined;
  }
  save<T>(stage: string, requestDigest: string, value: T, schema: z.ZodType<T>): void {
    const checked = schema.parse(value);
    let entries: z.infer<typeof journalSchema>['entries'] = [];
    if (existsSync(this.filePath)) {
      try { entries = journalSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8'))).entries; } catch { entries = []; }
    }
    entries = entries.filter((entry) => !(entry.stage === stage && entry.requestDigest === requestDigest));
    entries.push({ stage, requestDigest, value: checked });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }, null, 2), { encoding: 'utf8', flag: 'wx' });
      journalSchema.parse(JSON.parse(readFileSync(temporary, 'utf8')));
      renameSync(temporary, this.filePath);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}

export const DEPENDENCY_GRAPH_BUILDER_POLICY_VERSION = '2026-08-11-audited-dependency-graph-v1';
export const DEPENDENCY_GRAPH_MAX_REPAIRS = 2;

const POLICY = `Build a dependency graph from the complete trusted-unit set. Be neutral and evidence-bound.
REQUIRES means fromUnitId cannot be safely/actionably applied without toUnitId. CO_REQUIRED means both clauses are jointly mandatory peers. ALTERNATIVE means either route can satisfy the same role. Independence is represented by no edge, never by inventing a relation.
Inspect cross-block prerequisites, multiple mandatory clauses within the same procedure, and alternative routes. Do not assume that block boundaries, proximity, ordering, or shared wording imply a relation. Every edge needs evidence from listed units.
Every proposed/repaired edge must use auditStatus "PENDING". Only the deterministic publication boundary may change it to "TRUSTED" after a full PASS audit.`;

function digest(stage: string, messages: readonly ChatMessage[], exactRequestFingerprint: unknown): string {
  return createHash('sha256').update(JSON.stringify({ stage, messages, exactRequestFingerprint }), 'utf8').digest('hex');
}
function unitPayload(units: readonly PersistedKnowledgeUnit[]): string {
  return JSON.stringify([...units].sort((left, right) => left.unitId.localeCompare(right.unitId)).map(({ unitId, statement, sourceSpan, sourceBlockAnchor, parentRuleRef }) =>
    ({ unitId, statement, sourceSpan, sourceBlockAnchor, parentRuleRef })), null, 2);
}
export function buildDependencyProposalMessages(units: readonly PersistedKnowledgeUnit[]): ChatMessage[] {
  return [{
    role: 'system',
    content:
      `${POLICY}\nReturn one global proposal over ALL units in exactly this JSON shape (no extra keys): ` +
      `{"edges":[{"fromUnitId":"...","toUnitId":"...","relation":"REQUIRES|CO_REQUIRED|ALTERNATIVE",` +
      `"evidence":{"from":{"anchor":"...","quote":"..."},"to":{"anchor":"...","quote":"..."}},"auditStatus":"PENDING"}]}. ` +
      'Use exact anchor/quote pairs shown in the units; return an empty edges array when every unit is independent.',
  }, { role: 'user', content: unitPayload(units) }];
}
export function buildDependencyAuditMessages(units: readonly PersistedKnowledgeUnit[], graph: DependencyGraphProposal): ChatMessage[] {
  return [{
    role: 'system',
    content:
      `${POLICY}\nStrictly audit the FULL graph for every missing, unsupported, and wrong-direction edge. ` +
      'Return PASS only when exhaustive; use AMBIGUOUS when evidence cannot settle a material relation. ' +
      'Return exactly {"verdict":"PASS|REPAIR|AMBIGUOUS","findings":[{"kind":"MISSING_EDGE|UNSUPPORTED_EDGE|WRONG_DIRECTION|AMBIGUOUS_RELATION","fromUnitId":"..."|null,"toUnitId":"..."|null,"explanation":"..."}]}. ' +
      'PASS requires an empty findings array. REPAIR requires exact non-null known endpoints.',
  }, { role: 'user', content: JSON.stringify({ units: JSON.parse(unitPayload(units)), graph }, null, 2) }];
}
export function buildDependencyRepairMessages(units: readonly PersistedKnowledgeUnit[], graph: DependencyGraphProposal, audit: DependencyAudit): ChatMessage[] {
  return [{
    role: 'system',
    content:
      `${POLICY}\nPerform only the focused corrections requested by the audit. Return the complete corrected graph; do not make unrelated changes. ` +
      'Use the identical strict {"edges":[...]} contract from the proposal stage, with exact source anchor/quote evidence and auditStatus "PENDING" on every edge. ' +
      'A finding with kind "AMBIGUOUS_RELATION" must be resolved, not left unanswered: either keep or add the edge with real cited evidence from both units that settles the relation, or drop the edge entirely rather than guessing.',
  }, { role: 'user', content: JSON.stringify({ units: JSON.parse(unitPayload(units)), graph, findings: audit.findings }, null, 2) }];
}

export class DependencyGraphBuildError extends Error { constructor(message: string) { super(message); this.name = 'DependencyGraphBuildError'; } }

function validateGraph(graph: DependencyGraphProposal, units: readonly PersistedKnowledgeUnit[]): DependencyGraphProposal {
  const parsed = dependencyGraphSchema.parse(graph);
  const ids = new Set(units.map((unit) => unit.unitId));
  const seen = new Set<string>();
  for (const edge of parsed.edges) {
    if (edge.auditStatus !== 'PENDING') {
      throw new DependencyGraphBuildError('Unaudited proposal/repair edges must have auditStatus PENDING.');
    }
    if (!ids.has(edge.fromUnitId) || !ids.has(edge.toUnitId) || edge.fromUnitId === edge.toUnitId)
      throw new DependencyGraphBuildError('Graph contains an unknown or self-referential unit edge.');
    const key = `${edge.relation}:${edge.fromUnitId}:${edge.toUnitId}`;
    if (seen.has(key)) throw new DependencyGraphBuildError('Graph contains a duplicate edge.');
    seen.add(key);
  }
  // This validates exact evidence ownership, cycles, degree/edge bounds, and
  // relation canonicalization before another paid stage is permitted.
  createDependencyGraph({
    units: units.map((unit) => ({ unitId: unit.unitId, sourceSpan: unit.sourceSpan, evidenceByField: unit.evidenceByField })),
    edges: parsed.edges,
  });
  return parsed;
}

function graphStageSchema(units: readonly PersistedKnowledgeUnit[]): z.ZodType<DependencyGraphProposal> {
  return dependencyGraphSchema.superRefine((graph, ctx) => {
    try {
      validateGraph(graph, units);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function auditStageSchema(units: readonly PersistedKnowledgeUnit[]): z.ZodType<DependencyAudit> {
  const unitIds = new Set(units.map((unit) => unit.unitId));
  return dependencyAuditSchema.superRefine((audit, ctx) => {
    if (audit.verdict === 'PASS' && audit.findings.length !== 0) {
      ctx.addIssue({ code: 'custom', message: 'PASS audit cannot contain findings.' });
    }
    if (audit.verdict === 'REPAIR' && audit.findings.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'REPAIR audit requires focused findings.' });
    }
    if (audit.verdict !== 'REPAIR') return;
    for (const [index, finding] of audit.findings.entries()) {
      if (finding.fromUnitId === null || finding.toUnitId === null) {
        ctx.addIssue({ code: 'custom', path: ['findings', index], message: 'Repair finding requires both endpoints.' });
      } else if (!unitIds.has(finding.fromUnitId) || !unitIds.has(finding.toUnitId)) {
        ctx.addIssue({ code: 'custom', path: ['findings', index], message: 'Repair finding references an unknown endpoint.' });
      }
    }
  });
}

async function runStage<T>(stage: string, messages: readonly ChatMessage[], exactRequestFingerprint: unknown, schema: z.ZodType<T>, call: DependencyGraphStage<T>, checkpoint?: DependencyGraphCheckpoint): Promise<T> {
  const requestDigest = digest(stage, messages, exactRequestFingerprint);
  const restored = checkpoint?.load(stage, requestDigest, schema);
  if (restored !== undefined) return restored;
  const value = schema.parse(await call({ schema, messages, requestDigest }));
  checkpoint?.save(stage, requestDigest, value, schema);
  return value;
}

/** True iff a dependency-audit finding hedges a specific relation rather than
 * describing a concrete proposed/missing edge. MISSING_EDGE, UNSUPPORTED_EDGE
 * and WRONG_DIRECTION always describe one specific edge, so both endpoints
 * are always required for them to be actionable. AMBIGUOUS_RELATION is
 * different: the auditor may be unsure not just how two units relate but
 * precisely *which* unit is involved, so it may legitimately omit an
 * endpoint (see auditStageSchema -- the both-endpoints check there only runs
 * for verdict REPAIR, i.e. it was never meant to bind AMBIGUOUS_RELATION
 * findings emitted under an AMBIGUOUS verdict). */
function isAmbiguousRelationFinding(finding: DependencyAudit['findings'][number]): boolean {
  return finding.kind === 'AMBIGUOUS_RELATION';
}

/** True iff the audit reports an unresolved ambiguity: either the
 * whole-graph verdict itself is AMBIGUOUS, or at least one finding hedges a
 * specific relation (an AMBIGUOUS_RELATION finding can ride along inside an
 * otherwise-ordinary REPAIR verdict, as seen live in
 * scratchpad/aurora-v5/call-trace.jsonl). Checked directly from
 * `verdict`/`findings` every time rather than cached from an earlier round,
 * so the final failure message reflects the *last* audit, not history --
 * mirrors the same reasoning `hasUnresolvedAmbiguity` documents for coverage
 * audits in audited-extraction.ts. */
function hasUnresolvedAmbiguity(audit: DependencyAudit): boolean {
  return audit.verdict === 'AMBIGUOUS' || audit.findings.some(isAmbiguousRelationFinding);
}

export async function buildAuditedDependencyGraph(options: {
  readonly units: readonly PersistedKnowledgeUnit[];
  readonly proposer: DependencyGraphStage<DependencyGraphProposal>;
  readonly auditor: DependencyGraphStage<DependencyAudit>;
  readonly repairer: DependencyGraphStage<DependencyGraphProposal>;
  /** Exact paid-call identity: provider, model, prompts/schema versions, policy and run config. */
  readonly exactRequestFingerprint: unknown;
  readonly checkpoint?: DependencyGraphCheckpoint;
}): Promise<DependencyGraph> {
  if (options.units.length === 0) throw new DependencyGraphBuildError('Trusted units cannot be empty.');
  if (new Set(options.units.map((u) => u.unitId)).size !== options.units.length) throw new DependencyGraphBuildError('Trusted unit IDs must be unique.');
  const orderedUnits = [...options.units].sort((left, right) => left.unitId.localeCompare(right.unitId));
  const validatedGraphSchema = graphStageSchema(orderedUnits);
  const validatedAuditSchema = auditStageSchema(orderedUnits);
  let graph = validateGraph(await runStage('PROPOSAL', buildDependencyProposalMessages(orderedUnits), options.exactRequestFingerprint, validatedGraphSchema, options.proposer, options.checkpoint), orderedUnits);
  for (let repair = 0; repair <= DEPENDENCY_GRAPH_MAX_REPAIRS; repair++) {
    const audit = await runStage(`AUDIT_${repair}`, buildDependencyAuditMessages(orderedUnits, graph), options.exactRequestFingerprint, validatedAuditSchema, options.auditor, options.checkpoint);
    if (audit.verdict === 'PASS') {
      if (audit.findings.length !== 0) throw new DependencyGraphBuildError('PASS audit cannot contain findings.');
      const edges: DependencyEdgeInput[] = graph.edges.map((edge) => ({ ...edge, auditStatus: 'TRUSTED' }));
      return createDependencyGraph({
        units: orderedUnits.map((unit) => ({ unitId: unit.unitId, sourceSpan: unit.sourceSpan, evidenceByField: unit.evidenceByField })),
        edges,
      });
    }
    // AMBIGUOUS (whole-verdict) or an AMBIGUOUS_RELATION finding used to be
    // instant-fatal here, before the repair loop below ever got a chance --
    // the same class of defect already fixed for the extraction coverage
    // auditor (audited-extraction.ts, commit 4b4d9fc): a verdict that means
    // "I'm not sure" was treated the same as silence, when it is exactly the
    // kind of question a focused repair round exists to resolve (goal-shift
    // continuation, 2026-08-11: a live fixture run died here on first audit,
    // see scratchpad/aurora-v5/call-trace.jsonl -- an AMBIGUOUS_RELATION
    // finding rode along inside an otherwise-ordinary REPAIR verdict with
    // five other, perfectly actionable findings, and the whole graph was
    // refused without a single repair attempt). Route it into the same
    // bounded repair loop as any other finding instead: buildDependencyRepairMessages
    // already forwards the complete `audit.findings` list unfiltered, so no
    // separate filtering step is needed here the way audited-extraction.ts
    // needed isActionableCoverageFinding -- every finding kind in this domain
    // is already actionable by repair. Only a REPAIR/AMBIGUOUS verdict with
    // zero findings -- nothing at all to hand the repairer -- still fails
    // immediately below, unchanged from before.
    if (audit.findings.length === 0) throw new DependencyGraphBuildError('Repair verdict requires focused findings.');
    // Both endpoints are still required for every finding kind except
    // AMBIGUOUS_RELATION (see isAmbiguousRelationFinding): relaxing this for
    // ambiguity is precisely what keeps the fix from reintroducing a hard
    // failure by the back door for a legitimately endpoint-less hedge, while
    // MISSING_EDGE/UNSUPPORTED_EDGE/WRONG_DIRECTION -- which always describe
    // one concrete edge -- are held to the original, stricter bar.
    if (audit.findings.some((finding) => !isAmbiguousRelationFinding(finding) && (finding.fromUnitId === null || finding.toUnitId === null)))
      throw new DependencyGraphBuildError('Repair findings must identify both directed endpoints.');
    const unitIds = new Set(orderedUnits.map((unit) => unit.unitId));
    // Any endpoint that IS present -- on any finding kind, ambiguous or not
    // -- must still name a real unit; only a genuinely absent (null)
    // endpoint is exempted, and only because the check above already permits
    // null exclusively for AMBIGUOUS_RELATION findings.
    if (audit.findings.some((finding) =>
      (finding.fromUnitId !== null && !unitIds.has(finding.fromUnitId)) ||
      (finding.toUnitId !== null && !unitIds.has(finding.toUnitId))
    )) throw new DependencyGraphBuildError('Repair findings reference unknown directed endpoints.');
    if (repair === DEPENDENCY_GRAPH_MAX_REPAIRS) {
      // Same bar as before (DEPENDENCY_GRAPH_MAX_REPAIRS is not raised), but
      // the message now says truthfully which kind of non-convergence
      // survived every round instead of always calling it "did not
      // converge" -- a graph that is still ambiguous after a real repair
      // attempt is a different, more diagnosable failure than one that
      // simply never settled.
      throw new DependencyGraphBuildError(
        hasUnresolvedAmbiguity(audit)
          ? `Dependency graph is still ambiguous after ${DEPENDENCY_GRAPH_MAX_REPAIRS} focused repairs; refusing to publish it.`
          : 'Dependency graph did not converge after two focused repairs.'
      );
    }
    graph = validateGraph(await runStage(`REPAIR_${repair + 1}`, buildDependencyRepairMessages(orderedUnits, graph, audit), options.exactRequestFingerprint, validatedGraphSchema, options.repairer, options.checkpoint), orderedUnits);
  }
  throw new DependencyGraphBuildError('Dependency graph did not converge.');
}

/** Observable contract used by artifact and question-journal fingerprints. */
export function dependencyGraphBuilderContractProbe(): unknown {
  const makeUnit = (unitId: string, statement: string): PersistedKnowledgeUnit => ({
    unitId,
    statement,
    sourceSpan: { anchor: unitId, quote: statement },
    evidenceByField: { statement: { anchor: unitId, quote: statement } },
    sourceBlockAnchor: unitId,
    contentHash: `probe-${unitId}`,
    kind: 'PROCEDURE_STEP',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    uncertainties: [],
  });
  const units = [makeUnit('probe-action', 'Action requires approval.'), makeUnit('probe-approval', 'Approval is mandatory.')];
  return {
    version: DEPENDENCY_GRAPH_BUILDER_POLICY_VERSION,
    maxRepairs: DEPENDENCY_GRAPH_MAX_REPAIRS,
    proposal: buildDependencyProposalMessages(units),
    audit: buildDependencyAuditMessages(units, { edges: [] }),
    repair: buildDependencyRepairMessages(units, { edges: [] }, {
      verdict: 'REPAIR',
      findings: [{ kind: 'MISSING_EDGE', fromUnitId: 'probe-action', toUnitId: 'probe-approval', explanation: 'required' }],
    }),
    proposalSchema: dependencyGraphSchema._zod.def,
    auditSchema: dependencyAuditSchema._zod.def,
    semanticValidation: [validateGraph.toString(), auditStageSchema.toString()],
    publication: 'PASS-only; every published edge becomes TRUSTED',
  };
}
