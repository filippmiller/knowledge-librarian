import { describe, expect, it } from 'vitest';
import {
  createDependencyGraph,
  hydrateDependencyGraph,
  expandDependencyClosure,
  serializeDependencyGraph,
  type DependencyEdgeInput,
  type DependencyEndpoint,
} from '../dependency-graph';

const unit = (unitId: string, anchor = unitId, quote = `evidence ${unitId}`): DependencyEndpoint => ({
  unitId,
  sourceSpan: { anchor, quote },
  evidenceByField: { statement: { anchor, quote } },
});

const edge = (
  from: DependencyEndpoint,
  to: DependencyEndpoint,
  relation: DependencyEdgeInput['relation'],
  auditStatus: DependencyEdgeInput['auditStatus'] = 'TRUSTED'
): DependencyEdgeInput => ({
  fromUnitId: from.unitId,
  toUnitId: to.unitId,
  relation,
  evidence: { from: from.sourceSpan, to: to.sourceSpan },
  auditStatus,
});

describe('dependency graph integrity and closure', () => {
  it('Q01-like REQUIRES recursively adds a prerequisite only in its declared direction', () => {
    const procedure = unit('procedure');
    const privatePlace = unit('private-place');
    const graph = createDependencyGraph({ units: [procedure, privatePlace], edges: [edge(procedure, privatePlace, 'REQUIRES')] });
    expect(expandDependencyClosure(graph, ['procedure']).entries.map((entry) => entry.unitId)).toEqual(['procedure', 'private-place']);
    expect(expandDependencyClosure(graph, ['private-place']).entries.map((entry) => entry.unitId)).toEqual(['private-place']);
  });

  it('Q10 cross-block CO_REQUIRED links consent, stop, force and time recursively', () => {
    const units = ['helper', 'consent', 'stop', 'force', 'time'].map((id) => unit(id, `block-${id}`));
    const graph = createDependencyGraph({ units, edges: units.slice(1).map((peer) => edge(units[0], peer, 'CO_REQUIRED')) });
    expect(expandDependencyClosure(graph, ['consent']).entries.map((entry) => entry.unitId)).toEqual(['consent', 'helper', 'force', 'stop', 'time']);
  });

  it('Q02 conditional ALTERNATIVE is symmetric and does not pull an unrelated same-anchor unit', () => {
    const standard = unit('standard', 'same');
    const conditional = unit('conditional', 'same');
    const unrelated = unit('unrelated', 'same');
    const graph = createDependencyGraph({ units: [standard, conditional, unrelated], edges: [edge(conditional, standard, 'ALTERNATIVE')] });
    expect(expandDependencyClosure(graph, ['standard']).entries.map((entry) => entry.unitId)).toEqual(['standard', 'conditional']);
    expect(expandDependencyClosure(graph, ['conditional']).entries.map((entry) => entry.unitId)).toEqual(['conditional', 'standard']);
  });

  it('normalizes undirected pairs, rejects reverse duplicates, and has an order-independent fingerprint', () => {
    const a = unit('a'); const b = unit('b');
    const ab = edge(a, b, 'CO_REQUIRED'); const ba = edge(b, a, 'CO_REQUIRED');
    expect(() => createDependencyGraph({ units: [a, b], edges: [ab, ba] })).toThrow(/duplicate/);
    expect(createDependencyGraph({ units: [a, b], edges: [ab] }).fingerprint)
      .toBe(createDependencyGraph({ units: [b, a], edges: [ba] }).fingerprint);
  });

  it('rejects missing/self endpoints, REQUIRES cycles, and forged evidence', () => {
    const a = unit('a'); const b = unit('b');
    expect(() => createDependencyGraph({ units: [a], edges: [{ ...edge(a, b, 'REQUIRES') }] })).toThrow(/missing endpoint/);
    expect(() => createDependencyGraph({ units: [a], edges: [edge(a, a, 'REQUIRES')] })).toThrow(/distinct/);
    expect(() => createDependencyGraph({ units: [a, b], edges: [edge(a, b, 'REQUIRES'), edge(b, a, 'REQUIRES')] })).toThrow(/cycle/);
    expect(() => createDependencyGraph({ units: [a, b], edges: [{ ...edge(a, b, 'REQUIRES'), evidence: { from: { anchor: 'a', quote: 'invented' }, to: b.sourceSpan } }] })).toThrow(/forged/);
  });

  it('only traverses TRUSTED edges and enforces graph and closure bounds', () => {
    const a = unit('a'); const b = unit('b'); const c = unit('c');
    expect(expandDependencyClosure(createDependencyGraph({ units: [a, b], edges: [edge(a, b, 'REQUIRES', 'PENDING')] }), ['a']).entries).toHaveLength(1);
    expect(() => createDependencyGraph({ units: [a, b], edges: [edge(a, b, 'REQUIRES')], bounds: { maxEdges: 0 } })).toThrow(/maxEdges/);
    expect(() => createDependencyGraph({ units: [a, b, c], edges: [edge(a, b, 'CO_REQUIRED'), edge(a, c, 'CO_REQUIRED')], bounds: { maxDegree: 1 } })).toThrow(/maxDegree/);
    const graph = createDependencyGraph({ units: [a, b, c], edges: [edge(a, b, 'REQUIRES'), edge(b, c, 'REQUIRES')] });
    expect(expandDependencyClosure(graph, ['a'], { maxUnits: 2 })).toMatchObject({ truncated: true, entries: [{ unitId: 'a' }, { unitId: 'b' }] });
    expect(expandDependencyClosure(graph, ['a'], { maxDepth: 1 })).toMatchObject({ truncated: true, entries: [{ unitId: 'a' }, { unitId: 'b' }] });
  });

  it('strictly serializes and hydrates a fingerprint bound to endpoints and bounds', () => {
    const a = unit('a'); const b = unit('b');
    const graph = createDependencyGraph({ units: [a, b], edges: [edge(a, b, 'REQUIRES')] });
    const document = serializeDependencyGraph(graph);
    expect(hydrateDependencyGraph(document, [b, a]).fingerprint).toBe(graph.fingerprint);
    expect(() => hydrateDependencyGraph({ ...document, extra: true }, [a, b])).toThrow();
    expect(() => hydrateDependencyGraph(document, [{ ...a, sourceSpan: { anchor: 'a', quote: 'changed' } }, b])).toThrow(/forged|fingerprint/);
    expect(createDependencyGraph({ units: [a, b], edges: [edge(a, b, 'REQUIRES')], bounds: { maxDegree: 2 } }).fingerprint).not.toBe(graph.fingerprint);
  });
});
