import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  dependencyGraphDocumentSchema,
  type DependencyGraphDocument,
} from '../knowledge/dependency-graph';

export const DEPENDENCY_GRAPH_ARTIFACT_VERSION = '2026-08-11-dependency-graph-artifact-v1' as const;

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const nonempty = z.string().min(1);
const fingerprintSchema = z.strictObject({
  extractionArtifactContentDigest: hex,
  orderedUnitContentHashes: z.array(hex).min(1),
  provider: nonempty,
  model: nonempty,
  prompt: nonempty,
  schema: nonempty,
  policy: nonempty,
});
const bodySchema = z.strictObject({
  artifactVersion: z.literal(DEPENDENCY_GRAPH_ARTIFACT_VERSION),
  fingerprint: fingerprintSchema,
  graph: dependencyGraphDocumentSchema,
});
const artifactSchema = bodySchema.extend({ contentDigest: hex });

export type DependencyGraphArtifactFingerprint = z.infer<typeof fingerprintSchema>;
export type DependencyGraphArtifact = z.infer<typeof artifactSchema>;

export interface DependencyGraphArtifactConfig {
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly schema: string;
  readonly policy: string;
}

export class DependencyGraphArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DependencyGraphArtifactError';
  }
}

function digest(value: unknown): string {
  const stable = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`;
    if (item && typeof item === 'object') {
      return `{${Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
        .join(',')}}`;
    }
    return JSON.stringify(item);
  };
  return createHash('sha256').update(stable(value), 'utf8').digest('hex');
}

/** Hashes exact unit JSON in canonical unitId order, independent of caller order. */
export function computeOrderedUnitContentHashes(units: readonly unknown[]): readonly string[] {
  if (units.length === 0) throw new DependencyGraphArtifactError('Dependency graph requires at least one extraction unit.');
  const keyed = units.map((unit, index) => {
    if (!unit || typeof unit !== 'object' || typeof (unit as { unitId?: unknown }).unitId !== 'string' ||
        (unit as { unitId: string }).unitId.length === 0) {
      throw new DependencyGraphArtifactError(`Extraction unit at index ${index} requires a non-empty unitId.`);
    }
    return { unitId: (unit as { unitId: string }).unitId, unit };
  }).sort((a, b) => a.unitId.localeCompare(b.unitId));
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1].unitId === keyed[index].unitId) {
      throw new DependencyGraphArtifactError(`Duplicate extraction unitId: ${keyed[index].unitId}.`);
    }
  }
  return keyed.map(({ unit }) => digest(unit));
}

export function buildDependencyGraphArtifactFingerprint(
  extractionArtifact: { readonly phase: string; readonly contentDigest: string },
  orderedUnits: readonly unknown[],
  config: DependencyGraphArtifactConfig
): DependencyGraphArtifactFingerprint {
  if (extractionArtifact.phase !== 'COMPLETE') {
    throw new DependencyGraphArtifactError('Dependency graph may only be keyed to a COMPLETE extraction artifact.');
  }
  return fingerprintSchema.parse({
    extractionArtifactContentDigest: extractionArtifact.contentDigest,
    orderedUnitContentHashes: computeOrderedUnitContentHashes(orderedUnits),
    ...config,
  });
}

export function buildDependencyGraphArtifact(
  fingerprint: DependencyGraphArtifactFingerprint,
  graph: DependencyGraphDocument
): DependencyGraphArtifact {
  const parsedGraph = dependencyGraphDocumentSchema.parse(graph);
  if (parsedGraph.edges.some((edge) => edge.auditStatus !== 'TRUSTED')) {
    throw new DependencyGraphArtifactError('Dependency graph artifact may contain only TRUSTED audited edges.');
  }
  const body = bodySchema.parse({ artifactVersion: DEPENDENCY_GRAPH_ARTIFACT_VERSION, fingerprint, graph: parsedGraph });
  return { ...body, contentDigest: digest(body) };
}

export function parseDependencyGraphArtifact(json: string, sourceLabel = 'dependency graph artifact'): DependencyGraphArtifact {
  let raw: unknown;
  try { raw = JSON.parse(json); }
  catch (cause) { throw new DependencyGraphArtifactError(`Invalid JSON in ${sourceLabel}.`, { cause }); }
  const result = artifactSchema.safeParse(raw);
  if (!result.success) throw new DependencyGraphArtifactError(`Invalid ${sourceLabel}: ${result.error.message}`);
  const { contentDigest, ...body } = result.data;
  if (digest(body) !== contentDigest) throw new DependencyGraphArtifactError(`${sourceLabel} content digest mismatch.`);
  return result.data;
}

function assertExactFingerprint(
  saved: DependencyGraphArtifactFingerprint,
  expected: DependencyGraphArtifactFingerprint,
  sourceLabel: string
): void {
  if (JSON.stringify(saved) !== JSON.stringify(expected)) {
    throw new DependencyGraphArtifactError(`${sourceLabel} extraction/config fingerprint mismatch; refusing incompatible reuse.`);
  }
}

export function writeDependencyGraphArtifact(filePath: string, artifact: DependencyGraphArtifact): void {
  // Re-parse before and after writing: callers cannot publish a hand-built or truncated value.
  const serialized = JSON.stringify(artifact, null, 2);
  parseDependencyGraphArtifact(serialized, filePath);
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, serialized, { encoding: 'utf8', flag: 'wx' });
    parseDependencyGraphArtifact(readFileSync(tmp, 'utf8'), tmp);
    renameSync(tmp, filePath);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function loadCompatibleDependencyGraphArtifact(
  filePath: string,
  expected: DependencyGraphArtifactFingerprint
): DependencyGraphArtifact | undefined {
  if (!existsSync(filePath)) return undefined;
  const artifact = parseDependencyGraphArtifact(readFileSync(filePath, 'utf8'), filePath);
  assertExactFingerprint(artifact.fingerprint, fingerprintSchema.parse(expected), filePath);
  return artifact;
}
