import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersistedKnowledgeUnit } from '../applicability/identity-assignment';
import {
  buildAuditedDependencyGraph,
  buildDependencyProposalMessages,
  buildDependencyRepairMessages,
  DEPENDENCY_GRAPH_MAX_REPAIRS,
  FileDependencyGraphCheckpoint,
  type DependencyAudit,
  type DependencyGraphProposal,
  type DependencyGraphStageRequest,
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

  it('routes an AMBIGUOUS verdict into repair instead of an immediate throw, and publishes TRUSTED edges once a later audit passes', async () => {
    const proposer = async () => proposal();
    const ambiguousAudit: DependencyAudit = {
      verdict: 'AMBIGUOUS',
      findings: [{
        kind: 'AMBIGUOUS_RELATION', fromUnitId: 'act', toUnitId: 'stop',
        explanation: 'Unclear whether act requires stop directly or only through consent.',
      }],
    };
    const auditor = vi.fn().mockResolvedValueOnce(ambiguousAudit).mockResolvedValueOnce(pass);
    let capturedRepairRequest: DependencyGraphStageRequest<DependencyGraphProposal> | undefined;
    const repairer = async (request: DependencyGraphStageRequest<DependencyGraphProposal>) => {
      capturedRepairRequest = request;
      return proposal(edge('act', 'stop'));
    };
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    // Entered repair at all -- the old code threw on the first AUDIT_0 call
    // and never reached the repairer or a second audit.
    expect(auditor).toHaveBeenCalledTimes(2);
    expect(capturedRepairRequest).toBeDefined();
    const userMessage = capturedRepairRequest!.messages.find((message) => message.role === 'user')!;
    expect(userMessage.content).toContain('AMBIGUOUS_RELATION');
    expect(userMessage.content).toContain('Unclear whether act requires stop directly or only through consent.');
    // Resolved by repair, then PASSed -- publishes with TRUSTED, same as any
    // other repaired edge.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromUnitId: 'act', toUnitId: 'stop', auditStatus: 'TRUSTED' });
  });

  it('does not trip the both-endpoints guard for an AMBIGUOUS_RELATION finding with a null endpoint', async () => {
    const proposer = async () => proposal();
    const nullEndpointAmbiguousAudit: DependencyAudit = {
      verdict: 'AMBIGUOUS',
      findings: [{
        kind: 'AMBIGUOUS_RELATION', fromUnitId: null, toUnitId: 'stop',
        explanation: 'Unclear which other unit besides stop is even involved.',
      }],
    };
    const auditor = vi.fn().mockResolvedValueOnce(nullEndpointAmbiguousAudit).mockResolvedValueOnce(pass);
    const repairer = async () => proposal();
    // Must not throw "Repair findings must identify both directed
    // endpoints." -- that check is deliberately exempted for
    // AMBIGUOUS_RELATION findings, since the auditor may be unsure precisely
    // which unit is involved, not only how it relates.
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    expect(graph.edges).toHaveLength(0);
    expect(auditor).toHaveBeenCalledTimes(2);
  });

  it('an AMBIGUOUS_RELATION finding riding along inside an ordinary REPAIR verdict does not immediately fail the build (matches the live aurora-v5 trace shape)', async () => {
    const proposer = async () => proposal();
    const mixedAudit: DependencyAudit = {
      verdict: 'REPAIR',
      findings: [
        { kind: 'MISSING_EDGE', fromUnitId: 'act', toUnitId: 'consent', explanation: 'Consent is a prerequisite.' },
        { kind: 'AMBIGUOUS_RELATION', fromUnitId: 'consent', toUnitId: 'stop', explanation: 'Unclear whether consent requires stop.' },
      ],
    };
    const auditor = vi.fn().mockResolvedValueOnce(mixedAudit).mockResolvedValueOnce(pass);
    const repairer = async () => proposal(edge('act', 'consent'));
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    expect(graph.edges).toHaveLength(1);
    expect(auditor).toHaveBeenCalledTimes(2);
  });

  it('still fails closed when ambiguity survives every repair round, with a message distinct from "did not converge" and "requires focused findings"', async () => {
    const proposer = async () => proposal();
    const repairer = async () => proposal();
    const alwaysAmbiguous: DependencyAudit = {
      verdict: 'AMBIGUOUS',
      findings: [{ kind: 'AMBIGUOUS_RELATION', fromUnitId: 'act', toUnitId: 'stop', explanation: 'Still unclear after repair.' }],
    };
    const auditor = vi.fn(async () => alwaysAmbiguous);
    let caught: unknown;
    try {
      await buildAuditedDependencyGraph({ units, proposer, repairer, auditor, exactRequestFingerprint: fingerprint });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/ambiguous/i);
    expect(message).toContain(`after ${DEPENDENCY_GRAPH_MAX_REPAIRS} focused repairs`);
    expect(message).not.toMatch(/did not converge/i);
    expect(message).not.toMatch(/requires focused findings/i);
    // Bounded: exactly MAX_REPAIRS+1 audits (AUDIT_0..AUDIT_MAX), never more
    // -- DEPENDENCY_GRAPH_MAX_REPAIRS is not raised by this fix.
    expect(auditor).toHaveBeenCalledTimes(DEPENDENCY_GRAPH_MAX_REPAIRS + 1);
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

  it('repair prompt tells the model how to resolve an AMBIGUOUS_RELATION finding', () => {
    const prompt = buildDependencyRepairMessages(units, proposal(), repairAudit)[0]!.content;
    expect(prompt).toMatch(/AMBIGUOUS_RELATION/);
    expect(prompt).toMatch(/real cited evidence/i);
    expect(prompt).toMatch(/drop the edge entirely/i);
  });

  // --- aurora-v6 forged-evidence repair failure (scratchpad/aurora-v6/call-trace.jsonl) ---
  // Root cause was case (a), a prompt/contract gap, not guard hallucination or
  // spanKey normalisation: the rejected edge (edgeId b0baef49...,
  // 31d54a3b64736657 -> b4a9f07af40342af) cited evidence.from as
  // "разрешённое краткое надавливание в общественном месте не превращается в
  // разрешение на полноценное чесание через одежду" -- a real, verbatim,
  // contiguous substring of unit 31d54a3b64736657's actual sourceSpan (per
  // scripts/fixtures/.../extraction-artifact.json and the literal unit
  // payload sent to the model in that same call), but not the WHOLE listed
  // quote (it drops the leading clause and trailing period). The prompt never
  // told the model that citing a sub-quote of a multi-clause span is
  // forbidden, and never showed evidenceByField at all (only sourceSpan) --
  // so a model choosing the semantically-relevant clause out of a two-clause
  // span was never told that was non-compliant, and had no visibility into
  // any OTHER real per-field span it might otherwise have cited instead.

  it('sends every citable span per unit -- sourceSpan AND each evidenceByField entry -- not sourceSpan alone (previously evidenceByField was never shown, so a unit\'s only OTHER real evidence was undiscoverable by the model)', () => {
    const richUnit = {
      unitId: 'rich',
      statement: 'General priority rule; a specific example illustrates it.',
      sourceSpan: span('General rule applies. For example, the specific example applies.'),
      evidenceByField: {
        statement: span('General rule applies. For example, the specific example applies.'),
        triggerCondition: { anchor: 'block', quote: 'the specific example applies' },
      },
      sourceBlockAnchor: 'source', contentHash: 'rich', parentRuleRef: null,
    } as unknown as PersistedKnowledgeUnit;
    const proposalUserContent = buildDependencyProposalMessages([richUnit])[1]!.content;
    expect(proposalUserContent).toContain('"evidenceByField"');
    expect(proposalUserContent).toContain('"triggerCondition"');
    expect(proposalUserContent).toContain('the specific example applies');
    const repairUserContent = buildDependencyRepairMessages([richUnit], proposal(), repairAudit)[1]!.content;
    expect(repairUserContent).toContain('"triggerCondition"');
    expect(repairUserContent).toContain('the specific example applies');
  });

  it('tells the model plainly that a cited span must be an exact, complete, unedited listed span -- never a trimmed sub-quote', () => {
    for (const prompt of [
      buildDependencyProposalMessages(units)[0]!.content,
      buildDependencyRepairMessages(units, proposal(), repairAudit)[0]!.content,
    ]) {
      expect(prompt).toMatch(/character for character/i);
      expect(prompt).toMatch(/sub-quote/i);
      expect(prompt).toMatch(/(trim|shorten)/i);
    }
  });

  it('still rejects a real but partial sub-quote of a multi-clause sourceSpan as forged -- reproduces the live aurora-v6 repair failure verbatim, proving the anti-forgery guard was not loosened into a substring match by showing more evidence in the prompt', async () => {
    const multiClause = {
      unitId: 'multi', statement: 'x',
      sourceSpan: span('Если к ситуации подходят несколько пунктов, применяются все, а специальное правило имеет приоритет над общим. Например, разрешённое краткое надавливание в общественном месте не превращается в разрешение на полноценное чесание через одежду.'),
      evidenceByField: { statement: span('Если к ситуации подходят несколько пунктов, применяются все, а специальное правило имеет приоритет над общим. Например, разрешённое краткое надавливание в общественном месте не превращается в разрешение на полноценное чесание через одежду.') },
      sourceBlockAnchor: 'source', contentHash: 'multi', parentRuleRef: null,
    } as unknown as PersistedKnowledgeUnit;
    const target = units[0]!;
    // The exact substring the live model cited: real text, but missing the
    // leading clause and trailing period of the listed quote.
    const trimmedSubQuote = { anchor: 'block', quote: 'разрешённое краткое надавливание в общественном месте не превращается в разрешение на полноценное чесание через одежду' };
    const proposer = async () => ({
      edges: [{ ...edge(multiClause.unitId, target.unitId), evidence: { from: trimmedSubQuote, to: target.sourceSpan } }],
    });
    await expect(buildAuditedDependencyGraph({
      units: [...units, multiClause], proposer, exactRequestFingerprint: fingerprint,
      auditor: async () => pass, repairer: async () => proposal(),
    })).rejects.toThrow(/forged dependency evidence/i);
  });

  it('accepts the same edge once the FULL listed span is cited verbatim instead of a trimmed sub-quote', async () => {
    const multiClause = {
      unitId: 'multi', statement: 'x',
      sourceSpan: span('Если к ситуации подходят несколько пунктов, применяются все, а специальное правило имеет приоритет над общим. Например, разрешённое краткое надавливание в общественном месте не превращается в разрешение на полноценное чесание через одежду.'),
      evidenceByField: { statement: span('Если к ситуации подходят несколько пунктов, применяются все, а специальное правило имеет приоритет над общим. Например, разрешённое краткое надавливание в общественном месте не превращается в разрешение на полноценное чесание через одежду.') },
      sourceBlockAnchor: 'source', contentHash: 'multi', parentRuleRef: null,
    } as unknown as PersistedKnowledgeUnit;
    const target = units[0]!;
    const proposer = async () => ({
      edges: [{ ...edge(multiClause.unitId, target.unitId), evidence: { from: multiClause.sourceSpan, to: target.sourceSpan } }],
    });
    const graph = await buildAuditedDependencyGraph({
      units: [...units, multiClause], proposer, exactRequestFingerprint: fingerprint,
      auditor: async () => pass, repairer: async () => proposal(),
    });
    expect(graph.edges).toHaveLength(1);
  });
});
