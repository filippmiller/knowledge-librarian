import { describe, expect, it } from 'vitest';
import { interpretCoverageAuditResponse } from '../../src/lib/knowledge/extraction-coverage-auditor';
import { coverageAuditGateReasons } from '../run-extraction';

describe('run-extraction coverage publication gate', () => {
  it('clears only an explicit COVERED verdict', () => {
    const audit = interpretCoverageAuditResponse('b0', 'Правило.', [
      { verdict: 'COVERED', quote: '', explanation: 'Покрыто.' },
    ]);

    expect(coverageAuditGateReasons([audit])).toEqual([]);
  });

  it.each([
    { label: 'empty response', findings: [] },
    {
      label: 'ambiguous response',
      findings: [{ verdict: 'AMBIGUOUS' as const, quote: 'Правило.', explanation: 'Не уверен.' }],
    },
    {
      label: 'confirmed omission',
      findings: [
        { verdict: 'UNREPRESENTED_CLAUSE' as const, quote: 'Правило.', explanation: 'Пропущено.' },
      ],
    },
  ])('fails closed for $label', ({ findings }) => {
    const audit = interpretCoverageAuditResponse('b-risk', 'Правило.', findings);

    expect(coverageAuditGateReasons([audit])).toEqual([
      '1 block(ов) не получили окончательный COVERED verdict: b-risk',
    ]);
  });
});
