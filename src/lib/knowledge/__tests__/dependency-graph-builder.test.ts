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
  DependencyGraphBuildError,
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

  // --- conservative convergence: drop solely-ambiguous edges instead of discarding the whole graph ---
  // Motivating live failure: scratchpad/aurora-v7.log /
  // scratchpad/aurora-v7/call-trace.jsonl. The final AUDIT_2 response there
  // is a REPAIR verdict with five findings -- WRONG_DIRECTION,
  // UNSUPPORTED_EDGE, MISSING_EDGE, UNSUPPORTED_EDGE, and ONE
  // AMBIGUOUS_RELATION (31d54a3b64736657 -> 0f2a7c950991a0c4, "it is unclear
  // whether 31d54a3b64736657 should also REQUIRES-link to 0f2a7c950991a0c4
  // ... evidence does not clearly settle which units the example targets").
  // Because that set is MIXED, isPureAmbiguity is false for it and this
  // fix does not rescue that particular run (see the "does NOT drop..." test
  // below) -- the earlier aurora-v5 trace is what a PURE case looks like:
  // its single AMBIGUOUS_RELATION finding ("It is unclear whether the
  // general interpretive definition of 'допускается' (28c466edc64bb222)
  // should be modeled as REQUIRES toward the specific exception clause
  // b4a9f07af40342af, or whether the dependency runs the opposite way") rode
  // alongside FIVE other actionable findings on ITS first audit, but nothing
  // stops all six from being the ONLY findings on some later, final round.

  it('drops the sole surviving AMBIGUOUS_RELATION edge after the final repair, re-audits once, and on PASS publishes the remaining edges as TRUSTED while recording the drop', async () => {
    const proposer = async () => proposal();
    const auditor = vi.fn()
      .mockResolvedValueOnce(repairAudit) // AUDIT_0: ordinary MISSING_EDGE act->consent, forces REPAIR_1
      .mockResolvedValueOnce({
        verdict: 'REPAIR',
        findings: [{ kind: 'MISSING_EDGE', fromUnitId: 'consent', toUnitId: 'stop', explanation: 'Stop is a prerequisite of consent handling.' }],
      }) // AUDIT_1: another ordinary repair, forces REPAIR_2
      .mockResolvedValueOnce({
        verdict: 'REPAIR',
        findings: [{
          kind: 'AMBIGUOUS_RELATION', fromUnitId: 'consent', toUnitId: 'stop',
          explanation: 'Unclear whether consent requires stop, or the dependency runs the opposite way.',
        }],
      }) // AUDIT_2 (final round, repair === DEPENDENCY_GRAPH_MAX_REPAIRS): pure ambiguity, single finding
      .mockResolvedValueOnce(pass); // AUDIT_AMBIGUOUS_DROP: PASS once the ambiguous edge is gone
    const repairer = vi.fn()
      .mockResolvedValueOnce(proposal(edge('act', 'consent'))) // REPAIR_1
      .mockResolvedValueOnce(proposal(edge('act', 'consent'), edge('consent', 'stop'))); // REPAIR_2
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    expect(auditor).toHaveBeenCalledTimes(4);
    expect(repairer).toHaveBeenCalledTimes(2);
    // The ambiguous consent->stop edge is gone; act->consent survives, TRUSTED.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromUnitId: 'act', toUnitId: 'consent', relation: 'REQUIRES', auditStatus: 'TRUSTED' });
    // The drop is recorded, not silently discarded.
    expect(graph.omittedEdges).toHaveLength(1);
    expect(graph.omittedEdges[0]).toMatchObject({
      fromUnitId: 'consent', toUnitId: 'stop', relation: 'REQUIRES',
      reason: 'Unclear whether consent requires stop, or the dependency runs the opposite way.',
    });
  });

  it('matches by UNORDERED unit pair, not direction: drops an edge stored in the opposite direction from the one the finding names -- the real aurora-v5 ambiguity was precisely about which direction is correct', async () => {
    const ambiguousDirection: DependencyAudit = {
      verdict: 'REPAIR',
      findings: [{
        kind: 'AMBIGUOUS_RELATION', fromUnitId: 'consent', toUnitId: 'stop',
        explanation: 'Unclear whether consent requires stop, or stop requires consent.',
      }],
    };
    const proposer = async () => proposal(edge('stop', 'consent')); // stored stop -> consent, the OTHER direction
    const auditor = vi.fn()
      .mockResolvedValueOnce(ambiguousDirection)
      .mockResolvedValueOnce(ambiguousDirection)
      .mockResolvedValueOnce(ambiguousDirection) // AUDIT_2, final round: still the same single pure-ambiguity finding
      .mockResolvedValueOnce(pass);
    const repairer = vi.fn(async () => proposal(edge('stop', 'consent')));
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    expect(graph.edges).toHaveLength(0);
    expect(graph.omittedEdges).toHaveLength(1);
    // Recorded with the edge's OWN stored direction (stop -> consent), not
    // the finding's direction (consent -> stop) -- the omission documents
    // what was actually withdrawn, not how the auditor happened to phrase it.
    expect(graph.omittedEdges[0]).toMatchObject({ fromUnitId: 'stop', toUnitId: 'consent', relation: 'REQUIRES' });
  });

  it('records a `relation: null` omission -- not a failure -- when a final-round AMBIGUOUS_RELATION finding names a real, known unit pair that never had a proposed edge; matches the live aurora-v7 finding shape (31d54a3b64736657 -> 0f2a7c950991a0c4 matched zero edges in that run\'s REPAIR_2 graph)', async () => {
    const neverProposedPair: DependencyAudit = {
      verdict: 'AMBIGUOUS',
      findings: [{
        kind: 'AMBIGUOUS_RELATION', fromUnitId: 'consent', toUnitId: 'stop',
        explanation: 'Unclear whether consent should also link to stop; evidence does not settle it.',
      }],
    };
    const proposer = async () => proposal(edge('act', 'consent'));
    const auditor = vi.fn()
      .mockResolvedValueOnce(neverProposedPair)
      .mockResolvedValueOnce(neverProposedPair)
      .mockResolvedValueOnce(neverProposedPair) // AUDIT_2, final round
      .mockResolvedValueOnce(pass);
    const repairer = vi.fn(async () => proposal(edge('act', 'consent')));
    const graph = await buildAuditedDependencyGraph({ units, proposer, auditor, repairer, exactRequestFingerprint: fingerprint });
    // The one real edge survives untouched -- there was never a consent->stop
    // edge to drop in the first place.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromUnitId: 'act', toUnitId: 'consent', auditStatus: 'TRUSTED' });
    expect(graph.omittedEdges).toHaveLength(1);
    expect(graph.omittedEdges[0]).toMatchObject({
      fromUnitId: 'consent', toUnitId: 'stop', relation: null,
      reason: 'Unclear whether consent should also link to stop; evidence does not settle it.',
    });
  });

  it('after dropping the only-surviving AMBIGUOUS_RELATION pair and re-auditing once, still fails closed if that re-audit does not PASS either -- with a message distinct from "did not converge", "requires focused findings", and the old immediate-ambiguous message', async () => {
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
    expect(caught).toBeInstanceOf(DependencyGraphBuildError);
    const message = (caught as Error).message;
    expect(message).toMatch(/ambiguous/i);
    expect(message).not.toMatch(/did not converge/i);
    expect(message).not.toMatch(/requires focused findings/i);
    // Distinct from the old immediate-ambiguous message -- this graph was
    // specifically given a drop-and-re-audit chance, and that is what failed.
    expect(message).not.toBe(`Dependency graph is still ambiguous after ${DEPENDENCY_GRAPH_MAX_REPAIRS} focused repairs; refusing to publish it.`);
    // One extra call beyond MAX_REPAIRS+1 -- the post-drop re-audit -- proves
    // the graceful-degradation path was actually attempted, not skipped.
    expect(auditor).toHaveBeenCalledTimes(DEPENDENCY_GRAPH_MAX_REPAIRS + 2);
  });

  it('fails closed -- without guessing -- when a final-round AMBIGUOUS_RELATION finding has a null endpoint and so cannot be tied to one specific edge to drop', async () => {
    const proposer = async () => proposal();
    const repairer = async () => proposal();
    const nullEndpointFinding: DependencyAudit = {
      verdict: 'AMBIGUOUS',
      findings: [{ kind: 'AMBIGUOUS_RELATION', fromUnitId: null, toUnitId: 'stop', explanation: 'Unclear which other unit besides stop is even involved.' }],
    };
    const auditor = vi.fn(async () => nullEndpointFinding);
    let caught: unknown;
    try {
      await buildAuditedDependencyGraph({ units, proposer, repairer, auditor, exactRequestFingerprint: fingerprint });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DependencyGraphBuildError);
    expect((caught as Error).message).toMatch(/null endpoint/i);
    expect((caught as Error).message).toMatch(/cannot be tied to one specific edge/i);
    // No post-drop re-audit call: an unidentifiable finding is never
    // "resolved" by dropping, so paying for one more audit call would be
    // pointless -- the failure happens locally and deterministically,
    // exactly MAX_REPAIRS+1 audits, zero extra provider spend.
    expect(auditor).toHaveBeenCalledTimes(DEPENDENCY_GRAPH_MAX_REPAIRS + 1);
  });

  it('does NOT drop-and-retry when an AMBIGUOUS_RELATION finding survives alongside an ordinary MISSING_EDGE/UNSUPPORTED_EDGE/WRONG_DIRECTION finding -- fails exactly as before, matching the live aurora-v7 trace shape (WRONG_DIRECTION + two UNSUPPORTED_EDGE + MISSING_EDGE + one AMBIGUOUS_RELATION all survived its final audit together)', async () => {
    const proposer = async () => proposal();
    const repairer = async () => proposal();
    const mixedFinalAudit: DependencyAudit = {
      verdict: 'REPAIR',
      findings: [
        { kind: 'WRONG_DIRECTION', fromUnitId: 'act', toUnitId: 'consent', explanation: 'Direction looks backwards.' },
        { kind: 'AMBIGUOUS_RELATION', fromUnitId: 'consent', toUnitId: 'stop', explanation: 'Unclear whether consent requires stop or the reverse.' },
      ],
    };
    const auditor = vi.fn(async () => mixedFinalAudit);
    let caught: unknown;
    try {
      await buildAuditedDependencyGraph({ units, proposer, repairer, auditor, exactRequestFingerprint: fingerprint });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DependencyGraphBuildError);
    // Byte-identical to the message the ORIGINAL all-or-nothing code produced
    // for this shape -- proves a mixed finding set gets no new escape hatch.
    expect((caught as Error).message).toBe(
      `Dependency graph is still ambiguous after ${DEPENDENCY_GRAPH_MAX_REPAIRS} focused repairs; refusing to publish it.`
    );
    // No post-drop re-audit call: exactly MAX_REPAIRS+1, unchanged from
    // before this fix -- an ordinary defect riding along must still block
    // publication outright.
    expect(auditor).toHaveBeenCalledTimes(DEPENDENCY_GRAPH_MAX_REPAIRS + 1);
  });

  it('a MISSING_EDGE finding surviving every repair round (no ambiguity at all) still fails closed exactly as before', async () => {
    const proposer = async () => proposal();
    const repairer = async () => proposal();
    const auditor = vi.fn(async () => repairAudit);
    await expect(buildAuditedDependencyGraph({ units, proposer, repairer, auditor, exactRequestFingerprint: fingerprint }))
      .rejects.toThrow('Dependency graph did not converge after two focused repairs.');
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
