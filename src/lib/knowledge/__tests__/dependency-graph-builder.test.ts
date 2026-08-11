import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersistedKnowledgeUnit } from '../applicability/identity-assignment';
import {
  buildAuditedDependencyGraph,
  buildDependencyProposalMessages,
  FileDependencyGraphCheckpoint,
  type DependencyAudit,
  type DependencyGraphProposal,
} from '../dependency-graph-builder';

const span = (quote: string) => ({ anchor: 'block', quote });
const units = ['act', 'consent', 'stop'].map((unitId) => ({
  unitId, statement: unitId, sourceSpan: span(unitId), evidenceByField: { statement: span(unitId) },
  sourceBlockAnchor: 'source', contentHash: unitId, parentRuleRef: null,
})) as unknown as PersistedKnowledgeUnit[];
const edge = (fromUnitId: string, toUnitId: string): DependencyGraphProposal['edges'][number] => ({
  fromUnitId, toUnitId, relation: 'REQUIRES', auditStatus: 'PENDING',
  evidence: { from: span(fromUnitId), to: span(toUnitId) },
});
const proposal = (...edges: DependencyGraphProposal['edges']): DependencyGraphProposal => ({ edges });
const pass: DependencyAudit = { verdict: 'PASS', findings: [] };
const repairAudit: DependencyAudit = { verdict: 'REPAIR', findings: [{
  kind: 'MISSING_EDGE', fromUnitId: 'act', toUnitId: 'consent', explanation: 'Consent is a prerequisite.',
}] };
const fingerprint = { provider: 'test', model: 'fixed', prompt: 'v1', schema: 'v1', policy: 'none', config: {} };
let temporaryDirectory: string | undefined;
afterEach(() => { if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true }); temporaryDirectory = undefined; });

describe('buildAuditedDependencyGraph', () => {
  it('proposes globally, repairs twice at most, and mandatorily re-audits each repair', async () => {
    const proposer = vi.fn(async () => proposal());
    const auditor = vi.fn()
      .mockResolvedValueOnce(repairAudit)
      .mockResolvedValueOnce({ ...repairAudit, findings: [{ ...repairAudit.findings[0]!, toUnitId: 'stop' }] })
      .mockResolvedValueOnce(pass);
    const repairer = vi.fn()
      .mockResolvedValueOnce(proposal(edge('act', 'consent')))
      .mockResolvedValueOnce(proposal(edge('act', 'consent'), edge('act', 'stop')));
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    expect(graph.edges).toHaveLength(2);
    expect(auditor).toHaveBeenCalledTimes(3);
    expect(repairer).toHaveBeenCalledTimes(2);
    expect(buildDependencyProposalMessages(units)[0]!.content).toContain('ALL units');
  });

  it('fails closed on ambiguity and non-convergence', async () => {
    const proposer = async () => proposal();
    const repairer = async () => proposal();
    await expect(buildAuditedDependencyGraph({ units, proposer, repairer, exactRequestFingerprint: fingerprint,
      auditor: async () => ({ verdict: 'AMBIGUOUS', findings: [{ kind: 'AMBIGUOUS_RELATION', fromUnitId: 'act', toUnitId: 'stop', explanation: '?' }] }),
    })).rejects.toThrow(/ambiguous/i);
    await expect(buildAuditedDependencyGraph({ units, proposer, repairer, exactRequestFingerprint: fingerprint, auditor: async () => repairAudit }))
      .rejects.toThrow(/did not converge/i);
  });

  it('rejects forged evidence before paying for an audit', async () => {
    const auditor = vi.fn(async () => pass);
    await expect(buildAuditedDependencyGraph({ units, exactRequestFingerprint: fingerprint, auditor, repairer: async () => proposal(),
      proposer: async () => ({ edges: [{ ...edge('act', 'consent'), evidence: { from: span('forged'), to: span('consent') } }] }),
    })).rejects.toThrow(/forged dependency evidence/i);
    expect(auditor).not.toHaveBeenCalled();
  });

  it('atomically resumes each successful exact-digest stage without another paid call', async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'dependency-builder-'));
    const checkpoint = new FileDependencyGraphCheckpoint(path.join(temporaryDirectory, 'journal.json'));
    const proposer = vi.fn(async () => proposal(edge('act', 'consent')));
    const auditor = vi.fn(async () => pass);
    const repairer = vi.fn(async () => proposal());
    const options = { units, proposer, auditor, repairer, checkpoint, exactRequestFingerprint: fingerprint };
    await buildAuditedDependencyGraph(options);
    await buildAuditedDependencyGraph(options);
    expect(proposer).toHaveBeenCalledTimes(1);
    expect(auditor).toHaveBeenCalledTimes(1);
    await buildAuditedDependencyGraph({ ...options, exactRequestFingerprint: { ...fingerprint, model: 'changed' } });
    expect(proposer).toHaveBeenCalledTimes(2);
    expect(auditor).toHaveBeenCalledTimes(2);
  });

  it('never checkpoints a schema-valid but semantically forged paid response', async () => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'dependency-builder-'));
    const checkpoint = new FileDependencyGraphCheckpoint(path.join(temporaryDirectory, 'journal.json'));
    const proposer = vi.fn()
      .mockResolvedValueOnce({
        edges: [{
          ...edge('act', 'consent'),
          evidence: { from: span('forged'), to: span('consent') },
        }],
      })
      .mockResolvedValueOnce(proposal(edge('act', 'consent')));
    const options = {
      units,
      proposer,
      auditor: async () => pass,
      repairer: async () => proposal(),
      checkpoint,
      exactRequestFingerprint: fingerprint,
    };
    await expect(buildAuditedDependencyGraph(options)).rejects.toThrow(/forged dependency evidence/i);
    await expect(buildAuditedDependencyGraph(options)).resolves.toMatchObject({ edges: [expect.any(Object)] });
    expect(proposer).toHaveBeenCalledTimes(2);
  });

  it('neutral prompts cover cross-block prerequisites, same-procedure clauses, alternatives, and independence', () => {
    const prompt = buildDependencyProposalMessages(units)[0]!.content;
    expect(prompt).toMatch(/cross-block prerequisites/i);
    expect(prompt).toMatch(/multiple mandatory clauses within the same procedure/i);
    expect(prompt).toMatch(/alternative routes/i);
    expect(prompt).toMatch(/Independence is represented by no edge/i);
    expect(prompt).toMatch(/auditStatus "PENDING"/i);
    expect(buildDependencyProposalMessages([...units].reverse()))
      .toEqual(buildDependencyProposalMessages(units));
  });
});
