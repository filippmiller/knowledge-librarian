import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: openaiCreate } } },
  CHAT_MODEL: 'gpt-4o',
}));

import {
  auditBlockCoverage,
  buildCoverageAuditPromptMessages,
  coverageAuditNeedsReview,
  coverageAuditResponseSchema,
  interpretCoverageAuditResponse,
  type BlockCoverageAuditResult,
  type RawCoverageFinding,
} from '../extraction-coverage-auditor';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { StructuredOutputError } from '@/lib/ai/structured-output';

/**
 * `callAnthropic` (chat-provider.ts) теперь читает SSE (translation-gy3), а
 * не плоский JSON — этот хелпер эмитит настоящую последовательность фреймов
 * (message_start → content_block_delta → message_delta → message_stop),
 * ОДНИМ content_block_delta на весь текст, чтобы rawResponseText
 * реконструировался байт-в-байт. Раньше этот файл не имел общего хелпера —
 * 3 теста ниже собирали bespoke `new Response(...)` вручную.
 */
function anthropicOk(
  text: string,
  usage: { input_tokens: number; output_tokens: number }
): Response {
  const frames: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: 'message_stop' },
  ];
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('');
  return new Response(body, { status: 200 });
}

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

  it('передаёт аудитору полную applicability/numeric/identity структуру, не только statement', () => {
    const messages = buildCoverageAuditPromptMessages('Вне дома допускается исключение не более трёх циклов.', [{
      kind: 'EXCEPTION_RULE',
      statement: 'Вне дома действует исключение.',
      quote: 'Вне дома допускается исключение',
      extractionRef: 'exception',
      parentExtractionRef: 'base',
      triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
      numericConstraint: { factKey: 'maximum cycles', value: 3, unit: 'cycles' },
    }]);
    const user = messages.find((message) => message.role === 'user')!.content;

    expect(user).toContain('"kind":"EXCEPTION_RULE"');
    expect(user).toContain('"parentExtractionRef":"base"');
    expect(user).toContain('"fact":"privacyContext","equals":"PUBLIC"');
    expect(user).toContain('"value":3,"unit":"cycles"');
  });

  it.each([
    ['b9 privacy', 'В транспорте разрешено узкое послабление.', 'privacyContext=PUBLIC'],
    ['b13 consent', 'Помощь разрешена только после ясного согласия.', 'consentStatus=EXPLICIT'],
    ['b14 reachability', 'Если человек не может дотянуться рукой, допускается помощь.', 'reachability=LIMITED'],
  ])('%s: structural audit требует trigger field, даже если условие пересказано statement', (_name, text, expected) => {
    const messages = buildCoverageAuditPromptMessages(text, [{
      kind: 'PROCEDURE_STEP',
      statement: text,
      quote: text,
      extractionRef: 'u1',
      parentExtractionRef: null,
      triggerCondition: null,
      numericConstraint: null,
    }]);
    const system = messages.find((message) => message.role === 'system')!.content;

    expect(system).toContain(expected);
    expect(system).toContain('structured field отсутствует');
    expect(system).toContain('UNREPRESENTED_CLAUSE');
  });

  it('Q04 cycles: structural audit закрепляет canonical unit cycles, а не times', () => {
    const system = buildCoverageAuditPromptMessages('Не более трёх циклов.', []).find((message) => message.role === 'system')!.content;
    expect(system).toContain('canonical unit — "cycles" (не "times")');
  });

  it('b3 lexical cardinality: одно короткое действие в TERM_DEFINITION не требует numericConstraint', () => {
    const messages = buildCoverageAuditPromptMessages('«Почесание» — одно короткое действие.', [{
      kind: 'TERM_DEFINITION',
      statement: '«Почесание» — это одно короткое действие.',
      quote: '«Почесание» — одно короткое действие',
      extractionRef: 'term', parentExtractionRef: null,
      triggerCondition: null, numericConstraint: null,
    }]);
    const system = messages.find((message) => message.role === 'system')!.content;
    expect(system).toContain('ТОЛЬКО для определения лексического аспекта термина');
    expect(system).toContain('не возвращай omission из-за numericConstraint=null');
    expect(system).toContain('почесание — одно короткое действие');
  });

  it('b9 operational occurrence count remains auditable as times', () => {
    const system = buildCoverageAuditPromptMessages(
      'Разрешено один раз прижать ладонь.', []
    ).find((message) => message.role === 'system')!.content;
    expect(system).toContain('допустимое количество действий/случаев');
    expect(system).toContain('«прижать один раз»');
    expect(system).toContain('корректно использует "times"');
  });

  it('b6 presentation-only no-water alternative is explicitly covered when verbatim condition and exact uncertainty survive', () => {
    const text = 'При отсутствии воды допустим кожный антисептик.';
    const messages = buildCoverageAuditPromptMessages(text, [{
      kind: 'PROCEDURE_STEP',
      statement: text,
      quote: text,
      extractionRef: 'antiseptic',
      parentExtractionRef: null,
      triggerCondition: null,
      numericConstraint: null,
      uncertainties: [{
        kind: 'UNRECOGNIZED_TRIGGER_CONDITION',
        description: 'условие отсутствия воды не входит в закрытый каталог trigger-фактов',
        quote: 'При отсутствии воды',
      }],
    }]);
    const system = messages.find((message) => message.role === 'system')!.content;
    const user = messages.find((message) => message.role === 'user')!.content;

    expect(system).toContain('PRESENTATION-ONLY условие');
    expect(system).toContain('«При отсутствии воды допустим кожный антисептик»');
    expect(system).toContain('не требуй для него выдуманный trigger или parent');
    expect(user).toContain('"kind":"UNRECOGNIZED_TRIGGER_CONDITION"');
    expect(user).toContain('"quote":"При отсутствии воды"');
  });

  it('true override without executable trigger remains a gap despite uncertainty', () => {
    const system = buildCoverageAuditPromptMessages(
      'Вместо обязательного мытья рук можно всегда использовать антисептик.',
      [{
        kind: 'PROCEDURE_STEP',
        statement: 'Вместо обязательного мытья рук можно всегда использовать антисептик.',
        quote: 'Вместо обязательного мытья рук можно всегда использовать антисептик.',
        extractionRef: 'override', parentExtractionRef: null,
        triggerCondition: null, numericConstraint: null,
        uncertainties: [{
          kind: 'UNRECOGNIZED_TRIGGER_CONDITION',
          description: 'условие не структурировано',
          quote: 'Вместо обязательного мытья рук',
        }],
      }]
    ).find((message) => message.role === 'system')!.content;

    expect(system).toContain('настоящим override');
    expect(system).toContain('без исполнимого каталогизированного triggerCondition');
    expect(system).toContain('это всё ещё структурный пробел');
    expect(system).toContain('uncertainty не превращает неисполняемое исключение в доверенное');
  });

  it('TERM_DEFINITION with an operational maximum is not exempt from numeric completeness', () => {
    const system = buildCoverageAuditPromptMessages(
      'Термин «короткая серия» означает не более трёх действий за эпизод.', []
    ).find((message) => message.role === 'system')!.content;
    expect(system).toContain('определение одновременно устанавливает применимый рабочий предел/порог');
    expect(system).toContain('не более трёх действий за эпизод');
    expect(system).toContain('по-прежнему обязан иметь numericConstraint');
  });

  it('b3 mixed definition + prohibition deterministically requires a sibling PROCEDURE_STEP', () => {
    const messages = buildCoverageAuditPromptMessages(
      '«Расчёсывание» означает чрезмерное воздействие и не допускается.',
      [{
        kind: 'TERM_DEFINITION',
        statement: 'Расчёсывание означает чрезмерное воздействие и не допускается.',
        quote: '«Расчёсывание» означает чрезмерное воздействие и не допускается',
        extractionRef: 'term', parentExtractionRef: null,
        triggerCondition: null, numericConstraint: null,
      }]
    );
    const system = messages.find((message) => message.role === 'system')!.content;
    expect(system).toContain('требует двух sibling units');
    expect(system).toContain('отдельный PROCEDURE_STEP');
    expect(system).toContain('верни UNREPRESENTED_CLAUSE');
    expect(system).toContain('НИКОГДА не AMBIGUOUS');
    expect(system).toContain('совместное расположение в одной фразе не создаёт parent');
    expect(system).not.toContain('kind="PROHIBITION"');
  });

  it('pure definition without normative semantics stays eligible for COVERED', () => {
    const system = buildCoverageAuditPromptMessages(
      '«Почёсывание» — несколько мягких повторяющихся движений.',
      [{
        kind: 'TERM_DEFINITION',
        statement: 'Почёсывание — несколько мягких повторяющихся движений.',
        quote: '«Почёсывание» — несколько мягких повторяющихся движений',
        extractionRef: 'term', parentExtractionRef: null,
        triggerCondition: null, numericConstraint: null,
      }]
    ).find((message) => message.role === 'system')!.content;
    expect(system).toContain('одновременно определяет термин И устанавливает самостоятельный нормативный');
    expect(system).toContain('Если ничего не пропущено, верни РОВНО ОДНУ находку с verdict "COVERED"');
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

  // W1-C (2026-08-10): схема теперь ОТКЛОНЯЕТ `{"findings": []}`, и каждое
  // такое отклонение стоит повторного вызова аудита. Промпт обязан прямо
  // требовать непустой список, иначе мы платим за повторы за то, что модели
  // никогда не сказали.
  it('системный промпт прямо запрещает пустой findings — иначе новая проверка схемы оплачивается повторами вызова', () => {
    const system = buildCoverageAuditPromptMessages('Текст.', []).find((m) => m.role === 'system')!;
    expect(system.content).toContain('Пустой список findings');
  });

  it('передаёт HEADING provenance и разрешает COVERED только для тематического структурного заголовка', () => {
    const messages = buildCoverageAuditPromptMessages('Порядок безопасной работы', [], 'HEADING');
    const user = messages.find((m) => m.role === 'user')!;
    const system = messages.find((m) => m.role === 'system')!;
    expect(user.content).toContain('Канонический тип блока: HEADING');
    expect(system.content).toContain('только называет раздел или тему');

    const result = interpretCoverageAuditResponse('b-heading', 'Порядок безопасной работы', [
      { verdict: 'COVERED', quote: '', explanation: 'только название темы' },
    ]);
    expect(coverageAuditNeedsReview(result)).toBe(false);
  });

  it('не освобождает нормативный HEADING от coverage finding', () => {
    const text = 'Запрещено продолжать процедуру при боли';
    const messages = buildCoverageAuditPromptMessages(text, [], 'HEADING');
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('запретом, обязанностью, исключением');

    const result = interpretCoverageAuditResponse('b-heading-rule', text, [
      { verdict: 'UNREPRESENTED_CLAUSE', quote: text, explanation: 'самостоятельный запрет не представлен' },
    ]);
    expect(result.hasGap).toBe(true);
    expect(coverageAuditNeedsReview(result)).toBe(true);
  });

  it('не требует unit для точного fixture disclaimer о вымышленном тестовом документе', () => {
    const text =
      'Назначение: вымышленный документ для проверки семантического поиска и извлечения правил. Он не является медицинской рекомендацией.';
    const messages = buildCoverageAuditPromptMessages(text, [], 'PARAGRAPH');
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('пометки о вымышленности/тестовом характере');
    expect(system.content).toContain('не является медицинской рекомендацией');
    expect(system.content).toContain('если они не меняют допустимый operational answer');

    const result = interpretCoverageAuditResponse('b2', text, [
      { verdict: 'COVERED', quote: '', explanation: 'неоперационные provenance/testing metadata и disclaimer' },
    ]);
    expect(result.hasGap).toBe(false);
    expect(coverageAuditNeedsReview(result)).toBe(false);
  });

  it('disclaimer не скрывает содержащийся в нём операционный запрет', () => {
    const text = 'Дисклеймер: при боли запрещено продолжать процедуру.';
    const result = interpretCoverageAuditResponse('b-disclaimer-rule', text, [
      { verdict: 'UNREPRESENTED_CLAUSE', quote: 'при боли запрещено продолжать процедуру', explanation: 'операционный запрет не представлен' },
    ]);
    expect(result.hasGap).toBe(true);
    expect(coverageAuditNeedsReview(result)).toBe(true);
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
});

/**
 * Fail-closed семантика (план docs/plans/2026-08-10-cost-and-reliability-hardening.md,
 * W1-C). Аудитор — ЕДИНСТВЕННЫЙ механизм, обеспечивающий обещание «ни одно
 * правило не потеряно молча из исходного документа». До этой правки он
 * проваливался ОТКРЫТО в двух местах:
 *
 * 1. `findings: []` давал `hasGap=false`, то есть блок записывался как
 *    полностью покрытый — хотя промпт требует явного вердикта COVERED, и
 *    молчание моделью НЕ предусмотрено ни для одного случая.
 * 2. AMBIGUOUS не влиял ни на что: «я не уверен, пропущено ли» приводило к
 *    публикации без единого следа.
 *
 * Оба случая — это «аудит НЕ подтвердил, что блок чист», и обращаться с ними
 * как с подтверждением чистоты нельзя. `hasGap` при этом сохраняет прежний
 * смысл (подтверждённый пропуск, триггер focused re-extraction в
 * audited-extraction.ts) — различие вердиктов не схлопывается в один флаг.
 */
describe('interpretCoverageAuditResponse — fail closed: молчание и неуверенность аудитора не равны «покрыто»', () => {
  const BLOCK_TEXT = 'Нельзя чесать чужой участок кожи без явного согласия того человека.';

  it('пустой список findings -> unresolved=true: промпт требует явного COVERED, поэтому «ни одной находки» — аномалия, а не «сообщать нечего»', () => {
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, []);
    expect(result.unresolved).toBe(true);
  });

  it('пустой список findings -> hasGap остаётся false: «аудитор не ответил» и «подтверждён пропуск» — разные утверждения, и повторное извлечение блока тут чинить нечего (нет находки, которая говорила бы что искать)', () => {
    expect(interpretCoverageAuditResponse('b1', BLOCK_TEXT, []).hasGap).toBe(false);
  });

  it('AMBIGUOUS -> unresolved=true при hasGap=false: нерешённая неуверенность больше не проходит молча', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'AMBIGUOUS', quote: 'без явного согласия', explanation: 'не уверен' },
    ];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.hasGap).toBe(false);
    expect(result.unresolved).toBe(true);
  });

  it('все findings COVERED -> unresolved=false: единственный способ признать блок чистым — явный вердикт модели', () => {
    const raw: RawCoverageFinding[] = [{ verdict: 'COVERED', quote: '', explanation: 'всё покрыто' }];
    expect(interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw).unresolved).toBe(false);
  });

  it('подтверждённый пропуск -> unresolved=false: вид вердикта остаётся различим, «пропуск» не подменяется «неуверенностью»', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'UNREPRESENTED_CLAUSE', quote: 'без явного согласия', explanation: 'условие не извлечено' },
    ];
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
    expect(result.hasGap).toBe(true);
    expect(result.unresolved).toBe(false);
  });

  it('COVERED вместе с AMBIGUOUS -> unresolved=true: одна уверенная находка не отменяет неразрешённую', () => {
    const raw: RawCoverageFinding[] = [
      { verdict: 'COVERED', quote: '', explanation: 'x' },
      { verdict: 'AMBIGUOUS', quote: 'без явного согласия', explanation: 'не уверен' },
    ];
    expect(interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw).unresolved).toBe(true);
  });
});

/**
 * `coverageAuditNeedsReview` — ЕДИНСТВЕННОЕ определение «блок чист», которым
 * обязан пользоваться вызывающий, решающий, можно ли публиковать блок.
 * Выводится из `findings`, а не читает флаг: результат аудита может прийти
 * из руками собранной фикстуры (`auditor`-депенденси в
 * audited-extraction.test.ts) или из сохранённого coverage-audit.json — там
 * необязательного `unresolved` нет вовсе, и предикат, читающий флаг, принял
 * бы `undefined` за «чисто». То есть ровно тот fail-open, который эта задача
 * и закрывает.
 */
describe('coverageAuditNeedsReview — политика «что считается чистым блоком» в одном месте', () => {
  const BLOCK_TEXT = 'Нельзя чесать чужой участок кожи без явного согласия того человека.';

  it('все findings COVERED -> false: блок чист', () => {
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, [
      { verdict: 'COVERED', quote: '', explanation: 'всё покрыто' },
    ]);
    expect(coverageAuditNeedsReview(result)).toBe(false);
  });

  it('AMBIGUOUS -> true, хотя hasGap=false: неуверенность аудитора не пропускает блок молча', () => {
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, [
      { verdict: 'AMBIGUOUS', quote: 'без явного согласия', explanation: 'не уверен' },
    ]);
    expect(result.hasGap).toBe(false);
    expect(coverageAuditNeedsReview(result)).toBe(true);
  });

  it('подтверждённый пропуск -> true', () => {
    const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, [
      { verdict: 'POSSIBLE_OMISSION', quote: 'без явного согласия', explanation: 'x' },
    ]);
    expect(coverageAuditNeedsReview(result)).toBe(true);
  });

  it('результат, собранный РУКАМИ без поля unresolved, с пустым findings -> true: отсутствие флага не читается как «чисто»', () => {
    const handBuilt: BlockCoverageAuditResult = { blockAnchor: 'b1', findings: [], hasGap: false };
    expect(handBuilt.unresolved).toBeUndefined();
    expect(coverageAuditNeedsReview(handBuilt)).toBe(true);
  });

  it('needsReview === hasGap || unresolved для любой комбинации вердиктов — два поля и предикат не могут разойтись', () => {
    const combos: RawCoverageFinding[][] = [
      [],
      [{ verdict: 'COVERED', quote: '', explanation: '' }],
      [{ verdict: 'AMBIGUOUS', quote: 'без явного согласия', explanation: '' }],
      [{ verdict: 'POSSIBLE_OMISSION', quote: 'без явного согласия', explanation: '' }],
      [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'без явного согласия', explanation: '' }],
      [
        { verdict: 'COVERED', quote: '', explanation: '' },
        { verdict: 'AMBIGUOUS', quote: 'без явного согласия', explanation: '' },
      ],
      [
        { verdict: 'UNREPRESENTED_CLAUSE', quote: 'без явного согласия', explanation: '' },
        { verdict: 'AMBIGUOUS', quote: 'того человека', explanation: '' },
      ],
    ];
    for (const raw of combos) {
      const result = interpretCoverageAuditResponse('b1', BLOCK_TEXT, raw);
      expect(coverageAuditNeedsReview(result)).toBe(result.hasGap || result.unresolved === true);
    }
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

  // W1-C (2026-08-10): `{"findings": []}` — это НАРУШЕНИЕ протокола, а не вердикт.
  // Промпт требует отдельной находки COVERED на весь блок, когда ничего не
  // пропущено, поэтому «ни одной находки» не означает ничего и не может быть
  // записано как «покрыто». Отклоняем на уровне схемы: SCHEMA_MISMATCH —
  // ровно тот класс отказа, ради которого у вызывающего (withStructuredRetry в
  // run-aurora-fixture.ts, 6 попыток) уже есть ограниченный повтор, и стоит он
  // одного повторного вызова аудита, а не целого focused re-extraction блока.
  it('{"findings": []} -> схема ОТКЛОНЯЕТ ответ: молчание модели не является валидным вердиктом', () => {
    const parsed = coverageAuditResponseSchema.safeParse({ findings: [] });
    expect(parsed.success).toBe(false);
  });

  it('одна находка -> схема принимает: отклоняется именно пустота, а не короткий ответ', () => {
    const parsed = coverageAuditResponseSchema.safeParse({ findings: [{ verdict: 'COVERED', quote: '' }] });
    expect(parsed.success).toBe(true);
  });
});

describe('auditBlockCoverage — реальный сетевой путь несёт attempts (Task 37, cost ledger)', () => {
  function runConfig(): ExtractionRunConfig {
    return {
      provider: 'anthropic',
      model: 'claude-test-primary',
      promptVersion: 'test-prompt-v1',
      fallbackPolicy: 'NONE',
      extractionSchemaVersion: 'test-v1',
    };
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('AI_PROVIDER', 'anthropic');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    openaiCreate.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('результат несёт attempts с реальным usage — иначе cost ledger не может посчитать стоимость этого вызова', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ findings: [{ verdict: 'COVERED', quote: '' }] }), {
        input_tokens: 321,
        output_tokens: 12,
      })
    );

    const result = await auditBlockCoverage({
      blockAnchor: 'b1',
      blockText: 'Текст блока.',
      extractedStatements: [],
      runConfig: runConfig(),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts?.[0].usage).toEqual({ inputTokens: 321, outputTokens: 12 });
  });

  // Call-trace log (2026-08-10): та же дисциплина, что и attempts выше — без
  // requestMessages/rawResponseText пользователь не может сопоставить
  // конкретный вердикт аудита с тем, что именно спросили и что реально
  // ответила модель.
  it('результат несёт requestMessages и rawResponseText — источник для call-trace log', async () => {
    const rawResponse = JSON.stringify({ findings: [{ verdict: 'COVERED', quote: '' }] });
    fetchMock.mockResolvedValue(anthropicOk(rawResponse, { input_tokens: 321, output_tokens: 12 }));

    const result = await auditBlockCoverage({
      blockAnchor: 'b1',
      blockText: 'Текст блока.',
      extractedStatements: [],
      runConfig: runConfig(),
    });

    expect(result.requestMessages).toBeDefined();
    expect(result.requestMessages?.some((m) => m.content.includes('Текст блока.'))).toBe(true);
    expect(result.rawResponseText).toBe(rawResponse);
  });

  // W1-C (2026-08-10), сквозная проверка fail-closed пути: единственная
  // гарантия «правило не потеряно молча» держится на том, что блок НИКОГДА не
  // попадает в результат как покрытый на основании пустого ответа. Проверка на
  // уровне схемы (выше) обязана доходить до вызывающего исключением, а не
  // тихим `hasGap: false`.
  it('модель вернула {"findings": []} -> вызов падает StructuredOutputError, а не возвращает блок как покрытый', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ findings: [] }), { input_tokens: 100, output_tokens: 5 })
    );

    await expect(
      auditBlockCoverage({
        blockAnchor: 'b1',
        blockText: 'Текст блока.',
        extractedStatements: [],
        runConfig: runConfig(),
      })
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});
