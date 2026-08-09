import { describe, expect, it } from 'vitest';
import {
  buildCoverageAuditPromptMessages,
  coverageAuditResponseSchema,
  interpretCoverageAuditResponse,
  type RawCoverageFinding,
} from '../extraction-coverage-auditor';

/**
 * Goal-shift continuation (2026-08-09): a general, oracle-blind completeness
 * check — sees ONLY source block text + units extracted from it, NEVER
 * questions/expected answers/rule ids. Pure prompt-building and response-
 * interpretation logic tested here without any network call, same split as
 * buildExtractionPromptMessages/extractKnowledgeUnits.
 */

describe('buildCoverageAuditPromptMessages — pure, no network', () => {
  it('несёт полный текст блока и statement/quote каждого extracted unit\'а этого блока', () => {
    const messages = buildCoverageAuditPromptMessages('Полный текст исходного блока с правилом.', [
      { statement: 'Правило гласит X.', quote: 'с правилом' },
    ]);
    const user = messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('Полный текст исходного блока с правилом.');
    expect(user.content).toContain('Правило гласит X.');
    expect(user.content).toContain('с правилом');
  });

  it('НЕ содержит ничего похожего на вопрос/ожидаемый ответ — это чисто источник+извлечение', () => {
    const messages = buildCoverageAuditPromptMessages('Текст.', []);
    const full = messages.map((m) => m.content).join(' ');
    expect(full.toLowerCase()).not.toContain('expected_answer');
    expect(full.toLowerCase()).not.toContain('oracle');
  });

  it('пустой список units — валиден (блок мог не дать ни одного unit\'а, это тоже проверяемый случай)', () => {
    expect(() => buildCoverageAuditPromptMessages('Текст.', [])).not.toThrow();
  });
});

describe('interpretCoverageAuditResponse — quote-grounding, не слепое доверие модели', () => {
  const BLOCK_TEXT = 'Нельзя чесать чужой участок кожи без явного согласия того человека.';

  it('finding с quote, которая ДЕЙСТВИТЕЛЬНО является подстрокой блока -> quoteVerified=true', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'UNREPRESENTED_CLAUSE', quote: 'без явного согласия', explanation: 'условие согласия не извлечено' },
    ];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.findings[0].quoteVerified).toBe(true);
  });

  it('finding с quote, которой НЕТ в тексте блока (модель придумала/перефразировала) -> quoteVerified=false, но finding НЕ отбрасывается молча', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'UNREPRESENTED_CLAUSE', quote: 'этой фразы тут вообще нет', explanation: 'x' },
    ];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].quoteVerified).toBe(false);
  });

  it('все findings COVERED -> hasGap=false', () => {
    const raw: RawCoverageFinding[] = [{ verdict: 'COVERED', quote: '', explanation: 'всё покрыто' }];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.hasGap).toBe(false);
  });

  it('хотя бы один POSSIBLE_OMISSION -> hasGap=true', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'COVERED', quote: '', explanation: 'x' },
      { verdict: 'POSSIBLE_OMISSION', quote: 'без явного согласия', explanation: 'может быть пропущено' },
    ];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.hasGap).toBe(true);
  });

  it('хотя бы один UNREPRESENTED_CLAUSE -> hasGap=true', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'UNREPRESENTED_CLAUSE', quote: 'без явного согласия', explanation: 'x' },
    ];
    expect(interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw).hasGap).toBe(true);
  });

  it('AMBIGUOUS в одиночку -> hasGap=false (неоднозначность не то же самое, что подтверждённый пропуск), но остаётся видимой в findings', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'AMBIGUOUS', quote: 'без явного согласия', explanation: 'не уверен' },
    ];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.hasGap).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it('пустой список findings -> hasGap=false (вырожденный случай, не отсутствие проверки)', () => {
    expect(interpretCoverageAuditResponse('b1', BLOCK_TEXT, []).hasGap).toBe(false);
  });
});

describe('coverageAuditResponseSchema — explanation ключ ПРОПУЩЕН целиком для COVERED, тот же класс LLM-выдачи, что уже нормализован для uncertainties/facets/triggerCondition/numericConstraint', () => {
  // goal-shift continuation (2026-08-09), full-smoke2 run, anthropic/claude-sonnet-5:
  // модель вернула {"findings": [{"verdict": "COVERED", "quote": ""}]} — без ключа
  // explanation вообще (нечего объяснять, когда ничего не пропущено). Схема требовала
  // explanation: z.string() безусловно -> StructuredOutputError валил весь прогон.
  it('finding без ключа explanation -> валиден, explanation становится \'\'', () => {
    const parsed = coverageAuditResponseSchema.safeParse({
      findings: [{ verdict: 'COVERED', quote: '' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.findings[0].explanation).toBe('');
  });

  it('finding с explanation: null -> тоже валиден, становится \'\'', () => {
    const parsed = coverageAuditResponseSchema.safeParse({
      findings: [{ verdict: 'COVERED', quote: '', explanation: null }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.findings[0].explanation).toBe('');
  });

  it('finding с реальным explanation — не подменяется пустой строкой', () => {
    const parsed = coverageAuditResponseSchema.safeParse({
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'x', explanation: 'условие не извлечено' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.findings[0].explanation).toBe('условие не извлечено');
  });
});
