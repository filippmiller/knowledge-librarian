import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceSpanSchema, type SourceSpan } from './applicability/extraction';

export const DEPENDENCY_RELATIONS = ['REQUIRES', 'CO_REQUIRED', 'ALTERNATIVE'] as const;
export type DependencyRelation = (typeof DEPENDENCY_RELATIONS)[number];
export type DependencyAuditStatus = 'TRUSTED' | 'PENDING' | 'REJECTED';

export const dependencyRelationSchema = z.enum(DEPENDENCY_RELATIONS);
export const dependencyAuditStatusSchema = z.enum(['TRUSTED', 'PENDING', 'REJECTED']);
export const dependencyEvidenceSchema = z.strictObject({ from: sourceSpanSchema, to: sourceSpanSchema });
export const dependencyEdgeInputSchema = z.strictObject({
  fromUnitId: z.string().min(1),
  toUnitId: z.string().min(1),
  relation: dependencyRelationSchema,
  evidence: dependencyEvidenceSchema,
  auditStatus: dependencyAuditStatusSchema,
});

export interface DependencyEndpoint {
  readonly unitId: string;
  readonly sourceSpan: SourceSpan;
  readonly evidenceByField: Readonly<Record<string, SourceSpan>>;
}

export interface DependencyEdgeInput {
  readonly fromUnitId: string;
  readonly toUnitId: string;
  readonly relation: DependencyRelation;
  readonly evidence: { readonly from: SourceSpan; readonly to: SourceSpan };
  readonly auditStatus: DependencyAuditStatus;
}

export interface DependencyEdge extends DependencyEdgeInput {
  readonly edgeId: string;
}

/** A relation the auditor could not settle even after every repair round,
 * so the builder omitted it instead of guessing (see
 * dependency-graph-builder.ts's final-round handling). Recorded on the
 * published graph so a reader can see exactly what the system chose NOT to
 * assert, and why -- silent omission would hide evidence about what the
 * system does not know. `relation` is null when the finding named a real,
 * known unit pair that never had a proposed edge to begin with (the
 * ambiguity was over whether a relation should exist at all, not over an
 * edge that was actually proposed and then withdrawn); it is one of
 * REQUIRES/CO_REQUIRED/ALTERNATIVE when an actually-proposed edge for that
 * pair was withdrawn. An omitted pair is never traversable: it is excluded
 * from `edges`, `expandDependencyClosure`, and cycle/bounds checks -- this
 * is purely an audit trail, never a graph relation. */
export const dependencyEdgeOmissionSchema = z.strictObject({
  fromUnitId: z.string().min(1),
  toUnitId: z.string().min(1),
  relation: dependencyRelationSchema.nullable(),
  reason: z.string().min(1),
});
export type DependencyEdgeOmission = z.infer<typeof dependencyEdgeOmissionSchema>;

export interface DependencyGraphBounds {
  readonly maxEdges: number;
  readonly maxDegree: number;
}

export interface DependencyGraph {
  readonly units: ReadonlyMap<string, DependencyEndpoint>;
  readonly edges: readonly DependencyEdge[];
  readonly omittedEdges: readonly DependencyEdgeOmission[];
  readonly fingerprint: string;
  readonly bounds: DependencyGraphBounds;
}

export interface DependencyClosureEntry {
  readonly unitId: string;
  readonly depth: number;
  readonly via: readonly DependencyEdge[];
}

export interface DependencyClosure {
  readonly entries: readonly DependencyClosureEntry[];
  readonly truncated: boolean;
}

export const dependencyGraphBoundsSchema = z.strictObject({
  maxEdges: z.number().int().nonnegative(),
  maxDegree: z.number().int().nonnegative(),
});
export const dependencyGraphDocumentSchema = z.strictObject({
  edges: z.array(dependencyEdgeInputSchema).readonly(),
  // Defaulted so a sidecar artifact written before omission-tracking existed
  // still parses (as zero omissions) instead of failing to hydrate.
  omittedEdges: z.array(dependencyEdgeOmissionSchema).readonly().default([]),
  bounds: dependencyGraphBoundsSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DependencyGraphDocument = z.infer<typeof dependencyGraphDocumentSchema>;

const DEFAULT_BOUNDS: DependencyGraphBounds = { maxEdges: 1_000, maxDegree: 50 };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value), 'utf8').digest('hex');
}

function spanKey(span: SourceSpan): string {
  return `${span.anchor}\u0000${span.quote}`;
}

function hasEvidence(unit: DependencyEndpoint, evidence: SourceSpan): boolean {
  const wanted = spanKey(evidence);
  return [unit.sourceSpan, ...Object.values(unit.evidenceByField)].some((span) => spanKey(span) === wanted);
}

function canonicalEdge(input: DependencyEdgeInput): DependencyEdge {
  let edge = input;
  if (input.relation !== 'REQUIRES' && input.fromUnitId.localeCompare(input.toUnitId) > 0) {
    edge = {
      ...input,
      fromUnitId: input.toUnitId,
      toUnitId: input.fromUnitId,
      evidence: { from: input.evidence.to, to: input.evidence.from },
    };
  }
  const edgeId = digest(edge);
  return { ...edge, edgeId };
}

export function createDependencyGraph(options: {
  readonly units: readonly DependencyEndpoint[];
  readonly edges: readonly DependencyEdgeInput[];
  /** Relations the builder considered but deliberately did not assert (see
   * dependencyEdgeOmissionSchema). Never affects traversal, cycle checks, or
   * maxEdges/maxDegree bounds -- purely a recorded audit trail. Defaults to
   * empty so every existing call site is unaffected. */
  readonly omittedEdges?: readonly DependencyEdgeOmission[];
  readonly bounds?: Partial<DependencyGraphBounds>;
}): DependencyGraph {
  const bounds = { ...DEFAULT_BOUNDS, ...options.bounds };
  if (!Number.isInteger(bounds.maxEdges) || bounds.maxEdges < 0 || !Number.isInteger(bounds.maxDegree) || bounds.maxDegree < 0) {
    throw new Error('dependency graph bounds must be non-negative integers');
  }
  if (options.edges.length > bounds.maxEdges) throw new Error(`dependency graph exceeds maxEdges (${bounds.maxEdges})`);
  const units = new Map<string, DependencyEndpoint>();
  for (const unit of options.units) {
    if (units.has(unit.unitId)) throw new Error(`duplicate dependency endpoint: ${unit.unitId}`);
    units.set(unit.unitId, unit);
  }
  const edges = options.edges.map(canonicalEdge).sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  const seen = new Set<string>();
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const from = units.get(edge.fromUnitId);
    const to = units.get(edge.toUnitId);
    if (!from || !to) throw new Error(`dependency edge references missing endpoint: ${edge.fromUnitId} -> ${edge.toUnitId}`);
    if (edge.fromUnitId === edge.toUnitId) throw new Error('dependency edge endpoints must be distinct');
    if (!hasEvidence(from, edge.evidence.from) || !hasEvidence(to, edge.evidence.to)) throw new Error(`forged dependency evidence: ${edge.edgeId}`);
    const duplicateKey = `${edge.relation}\u0000${edge.fromUnitId}\u0000${edge.toUnitId}`;
    if (seen.has(duplicateKey)) throw new Error(`duplicate dependency edge: ${duplicateKey}`);
    seen.add(duplicateKey);
    for (const id of [edge.fromUnitId, edge.toUnitId]) {
      const next = (degree.get(id) ?? 0) + 1;
      if (next > bounds.maxDegree) throw new Error(`dependency endpoint ${id} exceeds maxDegree (${bounds.maxDegree})`);
      degree.set(id, next);
    }
  }
  assertAcyclicRequires(units, edges);
  const omittedEdges = [...(options.omittedEdges ?? [])].sort((a, b) => omissionSortKey(a).localeCompare(omissionSortKey(b)));
  for (const omission of omittedEdges) {
    if (!units.has(omission.fromUnitId) || !units.has(omission.toUnitId)) {
      throw new Error(`dependency omission references missing endpoint: ${omission.fromUnitId} -> ${omission.toUnitId}`);
    }
  }
  const fingerprint = graphFingerprint(units, edges, omittedEdges, bounds);
  return { units, edges, omittedEdges, fingerprint, bounds };
}

function omissionSortKey(omission: DependencyEdgeOmission): string {
  return `${omission.fromUnitId} ${omission.toUnitId} ${omission.relation ?? ''} ${omission.reason}`;
}

function graphFingerprint(
  units: ReadonlyMap<string, DependencyEndpoint>,
  edges: readonly DependencyEdge[],
  omittedEdges: readonly DependencyEdgeOmission[],
  bounds: DependencyGraphBounds
): string {
  const endpointEvidence = [...units.values()].map((unit) => ({
    unitId: unit.unitId,
    sourceSpan: unit.sourceSpan,
    evidenceByField: unit.evidenceByField,
  })).sort((a, b) => a.unitId.localeCompare(b.unitId));
  return digest({
    bounds,
    endpoints: endpointEvidence,
    edges: edges.map(({ edgeId: _edgeId, ...edge }) => edge),
    omittedEdges,
  });
}

export function serializeDependencyGraph(graph: DependencyGraph): DependencyGraphDocument {
  return dependencyGraphDocumentSchema.parse({
    edges: graph.edges.map(({ edgeId: _edgeId, ...edge }) => edge),
    omittedEdges: graph.omittedEdges,
    bounds: graph.bounds,
    fingerprint: graph.fingerprint,
  });
}

export function hydrateDependencyGraph(
  document: unknown,
  units: readonly DependencyEndpoint[]
): DependencyGraph {
  const parsed = dependencyGraphDocumentSchema.parse(document);
  const graph = createDependencyGraph({ units, edges: parsed.edges, omittedEdges: parsed.omittedEdges, bounds: parsed.bounds });
  if (graph.fingerprint !== parsed.fingerprint) throw new Error('dependency graph fingerprint mismatch');
  return graph;
}

function assertAcyclicRequires(units: ReadonlyMap<string, DependencyEndpoint>, edges: readonly DependencyEdge[]): void {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) if (edge.relation === 'REQUIRES') outgoing.set(edge.fromUnitId, [...(outgoing.get(edge.fromUnitId) ?? []), edge.toUnitId]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('REQUIRES dependency cycle detected');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of units.keys()) visit(id);
}

export function expandDependencyClosure(graph: DependencyGraph, seedUnitIds: readonly string[], options: {
  readonly maxUnits?: number;
  readonly maxDepth?: number;
  readonly relations?: readonly DependencyRelation[];
} = {}): DependencyClosure {
  const maxUnits = options.maxUnits ?? 100;
  const maxDepth = options.maxDepth ?? 10;
  if (!Number.isInteger(maxUnits) || maxUnits < 0 || !Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('closure bounds must be non-negative integers');
  const allowedRelations = new Set(options.relations ?? DEPENDENCY_RELATIONS);
  const entries = new Map<string, DependencyClosureEntry>();
  const queue: string[] = [];
  for (const id of [...new Set(seedUnitIds)].sort()) {
    if (!graph.units.has(id)) throw new Error(`closure seed does not exist: ${id}`);
    if (entries.size >= maxUnits) return { entries: [...entries.values()], truncated: true };
    entries.set(id, { unitId: id, depth: 0, via: [] }); queue.push(id);
  }
  let truncated = false;
  while (queue.length) {
    const id = queue.shift()!;
    const current = entries.get(id)!;
    const adjacent = graph.edges.filter((edge) => edge.auditStatus === 'TRUSTED' && allowedRelations.has(edge.relation) && (
      edge.fromUnitId === id || (edge.relation !== 'REQUIRES' && edge.toUnitId === id)
    )).sort((a, b) => {
      const aTarget = a.fromUnitId === id ? a.toUnitId : a.fromUnitId;
      const bTarget = b.fromUnitId === id ? b.toUnitId : b.fromUnitId;
      return aTarget.localeCompare(bTarget) || a.edgeId.localeCompare(b.edgeId);
    });
    for (const edge of adjacent) {
      const target = edge.fromUnitId === id ? edge.toUnitId : edge.fromUnitId;
      if (entries.has(target)) continue;
      if (current.depth >= maxDepth || entries.size >= maxUnits) { truncated = true; continue; }
      entries.set(target, { unitId: target, depth: current.depth + 1, via: [...current.via, edge] });
      queue.push(target);
    }
  }
  return { entries: [...entries.values()], truncated };
}
