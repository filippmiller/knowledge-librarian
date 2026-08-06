/**
 * Прогон корпуса на ПОДСТАВНОМ движке: ни базы, ни ключей моделей.
 *
 * Проверяем ровно то, ради чего затевался PR A3: расположение берётся из
 * решения продовой политики доставки, вердикт — из матрицы, gate падает по
 * классам регрессий и не падает больше ни на чём, а результаты ключуются
 * стабильным id.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { CLIENT_HOLDING_ANSWER } from '@/lib/ai/delivery-decision';
import {
  createEngineAsk,
  evaluateAssertions,
  indexById,
  parseCorpus,
  resolveEvalDelivery,
  runCorpus,
  summarize,
  type AskFn,
  type EvalCase,
  type EvalEngineRequest,
} from '../corpus';
import { computeExitCode } from '../disposition';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.resolve(HERE, '../../ai/__tests__/fixtures/eval-corpus.json');

function makeAnswer(overrides: Partial<EnhancedAnswerResult> = {}): EnhancedAnswerResult {
  return {
    answer: 'текст ответа',
    confidence: 0.7,
    confidenceLevel: 'high',
    needsClarification: false,
    citations: [],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: 'q',
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
    answerSource: 'knowledge_base',
    requiresHumanReview: false,
    ...overrides,
  };
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-1',
    category: 'test',
    question: 'вопрос',
    audience: 'internal',
    source: 'test',
    expectedDisposition: 'MUST_PASS',
    expect: {},
    ...overrides,
  };
}

/** Движок, всегда отдающий один и тот же ответ. */
function askWith(answer: EnhancedAnswerResult): AskFn {
  return vi.fn(async () => answer);
}

describe('фикстура корпуса', () => {
  const corpus = parseCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));

  it('разбирается и не пуста', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('у КАЖДОГО кейса задана явная expectedDisposition', () => {
    const raw = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Array<Record<string, unknown>>;
    for (const entry of raw) {
      expect(
        typeof entry.expectedDisposition === 'string' && entry.expectedDisposition.length > 0,
        `кейс ${String(entry.id)} без expectedDisposition`
      ).toBe(true);
    }
  });

  it('ни один known-good кейс не остался без явного ожидания', () => {
    const knownGood = corpus.filter((c) => c.category === 'known-good');
    expect(knownGood.length).toBe(6);
    for (const c of knownGood) {
      expect(['MUST_PASS', 'MUST_HOLD', 'MAY_HOLD', 'KNOWN_FAIL']).toContain(
        c.expectedDisposition
      );
    }
    // Метки расставлены по смыслу кейса, а не одной на всех.
    expect(new Set(knownGood.map((c) => c.expectedDisposition)).size).toBeGreaterThan(1);
    expect(
      knownGood.find((c) => c.id === 'knowngood-nostrification-codex22')?.expectedDisposition
    ).toBe('MAY_HOLD');
  });

  it('id уникальны', () => {
    expect(new Set(corpus.map((c) => c.id)).size).toBe(corpus.length);
  });

  it('снятое поле requiresClarificationOrHold больше не принимается', () => {
    expect(() =>
      parseCorpus([
        {
          id: 'x',
          category: 'c',
          question: 'q',
          audience: 'internal',
          source: 's',
          expectedDisposition: 'MUST_HOLD',
          expect: { requiresClarificationOrHold: true },
        },
      ])
    ).toThrow(/разбор/);
  });

  it('кейс без expectedDisposition не разбирается', () => {
    expect(() =>
      parseCorpus([
        { id: 'x', category: 'c', question: 'q', audience: 'internal', source: 's', expect: {} },
      ])
    ).toThrow(/expectedDisposition/);
  });

  it('дублирующийся id не разбирается', () => {
    const one = {
      id: 'dup',
      category: 'c',
      question: 'q',
      audience: 'internal',
      source: 's',
      expectedDisposition: 'MUST_PASS',
      expect: {},
    };
    expect(() => parseCorpus([one, { ...one }])).toThrow(/дублирующийся id/i);
  });

  it('дубликат id не глушит остальные проблемы корпуса', () => {
    const base = {
      id: 'dup',
      category: 'c',
      question: 'q',
      audience: 'internal',
      source: 's',
      expectedDisposition: 'MUST_PASS',
      expect: {},
    };
    try {
      parseCorpus([base, { ...base, expect: { unknownCheck: 1 } }]);
      throw new Error('ожидалась ошибка разбора');
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toMatch(/дублирующийся id/i);
      expect(message).toMatch(/неизвестная проверка/);
    }
  });

  it('строка из одних пробелов значением не считается', () => {
    expect(() =>
      parseCorpus([
        {
          id: '   ',
          category: 'c',
          question: 'q',
          audience: 'internal',
          source: 's',
          expectedDisposition: 'MUST_PASS',
          expect: {},
        },
      ])
    ).toThrow(/непустая строка/);
  });
});

describe('расположение = решение продовой политики доставки', () => {
  it('уверенный ответ из базы → DIRECT_ANSWER', async () => {
    const [record] = await runCorpus([makeCase()], askWith(makeAnswer()));
    expect(record.deliveryDecision).toBe('answer');
    expect(record.actualDisposition).toBe('DIRECT_ANSWER');
    expect(record.caseResult).toBe('PASS');
  });

  it('сценарное уточнение → HOLD (clarify)', async () => {
    const answer = makeAnswer({
      confidence: 0,
      confidenceLevel: 'insufficient',
      needsClarification: true,
      scenarioClarification: {
        atNodeKey: 'apostille_region',
        prompt: 'Где выдан документ?',
        options: [{ id: 'spb', label: 'СПб', targetScenarioKey: 'apostille_spb' }],
      },
    });
    const [record] = await runCorpus(
      [makeCase({ expectedDisposition: 'MUST_HOLD' })],
      askWith(answer)
    );
    expect(record.deliveryDecision).toBe('clarify');
    expect(record.actualDisposition).toBe('HOLD');
    expect(record.caseResult).toBe('PASS');
  });

  it('требуется проверка человеком → HOLD (escalate)', async () => {
    const [record] = await runCorpus(
      [makeCase({ expectedDisposition: 'MUST_HOLD' })],
      askWith(makeAnswer({ requiresHumanReview: true }))
    );
    expect(record.deliveryDecision).toBe('escalate');
    expect(record.actualDisposition).toBe('HOLD');
  });

  it('голый needsClarification удержанием НЕ считается — прод такой ответ отправит', async () => {
    // Прежняя эвристика корпуса считала это удержанием и расходилась с продом.
    const [record] = await runCorpus(
      [makeCase()],
      askWith(makeAnswer({ needsClarification: true }))
    );
    expect(record.deliveryDecision).toBe('answer');
    expect(record.actualDisposition).toBe('DIRECT_ANSWER');
  });

  it('исключение движка → ERROR и FAIL, даже у KNOWN_FAIL', async () => {
    const ask: AskFn = vi.fn(async () => {
      throw new Error('движок упал');
    });
    const [record] = await runCorpus([makeCase({ expectedDisposition: 'KNOWN_FAIL' })], ask);
    expect(record.actualDisposition).toBe('ERROR');
    expect(record.caseResult).toBe('FAIL');
    expect(record.engineError).toBe('движок упал');
    expect(record.answer).toBeNull();
  });
});

describe('safety и подмена текста для клиента', () => {
  const leaky = makeAnswer({ answer: 'Адрес партнёра: Орёл, 302028' });
  const forbidden = { forbiddenSubstrings: ['Орёл', '302028'] };

  it('утечка в отправленном ответе роняет кейс даже при MAY_HOLD', async () => {
    const [record] = await runCorpus(
      [makeCase({ audience: 'internal', expectedDisposition: 'MAY_HOLD', expect: forbidden })],
      askWith(leaky)
    );
    expect(record.actualDisposition).toBe('DIRECT_ANSWER');
    expect(record.caseResult).toBe('FAIL');
    expect(record.safetyFailures).toHaveLength(2);
  });

  it('утечка в удержанном ответе внутренней аудитории всё равно роняет кейс', async () => {
    // Сотруднику черновик уходит целиком: подмена работает только для клиента.
    const [record] = await runCorpus(
      [makeCase({ audience: 'internal', expectedDisposition: 'MUST_HOLD', expect: forbidden })],
      askWith(makeAnswer({ ...leaky, requiresHumanReview: true }))
    );
    expect(record.actualDisposition).toBe('HOLD');
    expect(record.caseResult).toBe('FAIL');
  });

  it('клиенту удержанный черновик подменяется — утечки нет, но предупреждение остаётся', async () => {
    const [record] = await runCorpus(
      [makeCase({ audience: 'client', expectedDisposition: 'MAY_HOLD', expect: forbidden })],
      askWith(makeAnswer({ ...leaky, requiresHumanReview: true }))
    );
    expect(record.answer?.withheld).toBe(true);
    expect(record.answer?.outbound).toBe(CLIENT_HOLDING_ANSWER);
    expect(record.safetyFailures).toEqual([]);
    expect(record.draftSafetyWarnings).toHaveLength(2);
    expect(record.caseResult).toBe('PASS');
  });

  it('resolveEvalDelivery не подменяет текст для внутренней аудитории', () => {
    const delivery = resolveEvalDelivery(makeAnswer({ requiresHumanReview: true }), 'internal');
    expect(delivery.decision).toBe('escalate');
    expect(delivery.withheld).toBe(false);
    expect(delivery.outboundAnswer).toBe(delivery.draftAnswer);
  });
});

describe('проверки утверждений', () => {
  it('minConfidence / answerSourceIn / expectedSubstrings считаются по черновику', () => {
    const answer = makeAnswer({ answer: 'мы доставляем курьером', confidence: 0.3 });
    const evalCase = makeCase({
      expect: {
        expectedSubstrings: ['курьер'],
        minConfidence: 0.5,
        answerSourceIn: ['deterministic_guardrail'],
      },
    });
    const outcome = evaluateAssertions(evalCase, answer, resolveEvalDelivery(answer, 'internal'));
    expect(outcome.qualityFailures).toHaveLength(2);
    expect(outcome.qualityFailures.join(' ')).toMatch(/уверенность/);
    expect(outcome.qualityFailures.join(' ')).toMatch(/answerSource/);
    expect(outcome.safetyFailures).toEqual([]);
  });
});

describe('gate: exit 1 по классам регрессий, 0 в остальных случаях', () => {
  const clarifying = makeAnswer({
    confidence: 0,
    confidenceLevel: 'insufficient',
    needsClarification: true,
    scenarioClarification: { atNodeKey: 'n', prompt: 'p', options: [] },
  });

  async function verdictOf(evalCase: EvalCase, ask: AskFn) {
    const records = await runCorpus([evalCase], ask);
    return {
      caseResult: records[0].caseResult,
      gate: computeExitCode('gate', [records[0].caseResult]),
      baseline: computeExitCode('baseline', [records[0].caseResult]),
    };
  }

  it('MUST_PASS → удержание: FAIL, gate 1', async () => {
    const v = await verdictOf(makeCase({ expectedDisposition: 'MUST_PASS' }), askWith(clarifying));
    expect(v.caseResult).toBe('FAIL');
    expect(v.gate).toBe(1);
    expect(v.baseline).toBe(0);
  });

  it('MUST_PASS → прямой ответ с проваленной проверкой: FAIL, gate 1', async () => {
    const v = await verdictOf(
      makeCase({ expectedDisposition: 'MUST_PASS', expect: { minConfidence: 0.9 } }),
      askWith(makeAnswer({ confidence: 0.6 }))
    );
    expect(v.caseResult).toBe('FAIL');
    expect(v.gate).toBe(1);
  });

  it('MUST_HOLD → прямой ответ: FAIL, gate 1', async () => {
    const v = await verdictOf(makeCase({ expectedDisposition: 'MUST_HOLD' }), askWith(makeAnswer()));
    expect(v.caseResult).toBe('FAIL');
    expect(v.gate).toBe(1);
  });

  it('MAY_HOLD → прямой ответ с проваленной проверкой: FAIL, gate 1', async () => {
    const v = await verdictOf(
      makeCase({ expectedDisposition: 'MAY_HOLD', expect: { expectedSubstrings: ['курьер'] } }),
      askWith(makeAnswer())
    );
    expect(v.caseResult).toBe('FAIL');
    expect(v.gate).toBe(1);
  });

  it('KNOWN_FAIL → внезапно прошёл: XPASS, gate 1 (требует ручного пересмотра)', async () => {
    const v = await verdictOf(makeCase({ expectedDisposition: 'KNOWN_FAIL' }), askWith(makeAnswer()));
    expect(v.caseResult).toBe('XPASS');
    expect(v.gate).toBe(1);
    expect(v.baseline).toBe(0);
  });

  it('KNOWN_FAIL → всё ещё падает: XFAIL, gate 0', async () => {
    const v = await verdictOf(
      makeCase({ expectedDisposition: 'KNOWN_FAIL', expect: { expectedSubstrings: ['курьер'] } }),
      askWith(makeAnswer())
    );
    expect(v.caseResult).toBe('XFAIL');
    expect(v.gate).toBe(0);
  });

  it('исключение движка: FAIL, gate 1 при любом ожидании', async () => {
    const throwing: AskFn = vi.fn(async () => {
      throw new Error('boom');
    });
    for (const expectedDisposition of ['MUST_PASS', 'MUST_HOLD', 'MAY_HOLD', 'KNOWN_FAIL'] as const) {
      const v = await verdictOf(makeCase({ expectedDisposition }), throwing);
      expect(v.caseResult).toBe('FAIL');
      expect(v.gate).toBe(1);
      expect(v.baseline).toBe(0);
    }
  });

  it('здоровый прогон: gate 0', async () => {
    const records = await runCorpus(
      [
        makeCase({ id: 'a', expectedDisposition: 'MUST_PASS' }),
        makeCase({ id: 'b', expectedDisposition: 'MAY_HOLD' }),
      ],
      askWith(makeAnswer())
    );
    expect(records.map((r) => r.caseResult)).toEqual(['PASS', 'PASS']);
    expect(computeExitCode('gate', records.map((r) => r.caseResult))).toBe(0);
  });

  it('baseline не падает и на смешанном прогоне из всех классов', async () => {
    const records = await runCorpus(
      [
        makeCase({ id: 'ok', expectedDisposition: 'MUST_PASS' }),
        makeCase({ id: 'fail', expectedDisposition: 'MUST_HOLD' }),
        makeCase({ id: 'xpass', expectedDisposition: 'KNOWN_FAIL' }),
      ],
      askWith(makeAnswer())
    );
    const results = records.map((r) => r.caseResult);
    expect(results).toEqual(['PASS', 'FAIL', 'XPASS']);
    expect(computeExitCode('baseline', results)).toBe(0);
    expect(computeExitCode('gate', results)).toBe(1);
  });
});

describe('результаты ключуются стабильным id, а не порядком в файле', () => {
  it('indexById возвращает кейсы по id', async () => {
    const cases = [makeCase({ id: 'beta' }), makeCase({ id: 'alpha' })];
    const records = await runCorpus(cases, askWith(makeAnswer()));
    const byId = indexById(records);
    expect(Object.keys(byId).sort()).toEqual(['alpha', 'beta']);
    expect(byId.alpha.id).toBe('alpha');
  });

  it('сводка перечисляет id, а не индексы', async () => {
    const records = await runCorpus(
      [makeCase({ id: 'held', expectedDisposition: 'MUST_HOLD' })],
      askWith(makeAnswer())
    );
    expect(summarize(records).failedIds).toEqual(['held']);
    expect(summarize(records).blockingIds).toEqual(['held']);
  });
});

describe('createEngineAsk', () => {
  it('глушит телеметрию на каждом вызове движка', async () => {
    const answerFn = vi.fn<(request: EvalEngineRequest) => Promise<EnhancedAnswerResult>>(
      async () => makeAnswer()
    );
    const ask = createEngineAsk(answerFn);
    await runCorpus(
      [makeCase({ id: 'a', audience: 'client' }), makeCase({ id: 'b', audience: 'internal' })],
      ask
    );

    expect(answerFn).toHaveBeenCalledTimes(2);
    for (const [request] of answerFn.mock.calls) {
      expect(request.telemetryMode).toBe('disabled');
      expect(request.includeDebug).toBe(false);
    }
    expect(answerFn.mock.calls[0][0].audience).toBe('client');
    expect(answerFn.mock.calls[1][0].audience).toBe('internal');
  });
});
