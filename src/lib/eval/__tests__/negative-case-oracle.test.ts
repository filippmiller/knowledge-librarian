import { describe, expect, it } from 'vitest';
import {
  KNOWN_REASON_CODES,
  loadNegativeCaseOracle,
  parseNegativeCaseOracle,
} from '../negative-case-oracle';
import { loadSemanticRuleOracle } from '../semantic-rule-oracle';

/**
 * План §0.3 [R4a]: «Machine-readable oracle для 6 negative-кейсов».
 *
 * Без этих полей у negative-кейса есть только `expected_behavior` и текст: по
 * ним проверяется красивая проза, но НЕ доказывается, что applicability engine
 * принял верное решение. Для `Q05-N1` нужно утверждать, что правило 5 не было
 * выбрано, — а не что модель удачно написала «нет».
 *
 * Sidecar, а не правка `test_cases_semantic_rules.jsonl`: поставленный
 * acceptance pack остаётся нетронутым, а правило изоляции сводится к одной
 * проверяемой фразе — «движку разрешён только DOCX».
 */

const line = (extra: string) =>
  `{"id":"Q05-N1","expectedDisposition":"DIRECT_ANSWER"${extra}}`;

describe('parseNegativeCaseOracle', () => {
  it('разбирает минимальную запись', () => {
    expect(parseNegativeCaseOracle(line(''))).toEqual([
      { id: 'Q05-N1', expectedDisposition: 'DIRECT_ANSWER' },
    ]);
  });

  it('разбирает полную запись', () => {
    const [parsed] = parseNegativeCaseOracle(
      line(
        ',"requiredCandidateRuleIds":[1,3,5],"requiredSelectedRuleIds":[1,3],' +
          '"forbiddenSelectedRuleIds":[5],"expectedReasonCodes":["exception_trigger_inactive"],' +
          '"numericAssertions":[{"value":3,"unit":"seconds"}]'
      )
    );

    expect(parsed.requiredCandidateRuleIds).toEqual([1, 3, 5]);
    expect(parsed.forbiddenSelectedRuleIds).toEqual([5]);
    expect(parsed.numericAssertions).toEqual([{ value: 3, unit: 'seconds' }]);
  });

  it('ОТВЕРГАЕТ несуществующий reason code — иначе ворота ждут того, чего движок не выдаёт', () => {
    expect(() =>
      parseNegativeCaseOracle(line(',"expectedReasonCodes":["public_place_condition_not_satisfied"]'))
    ).toThrow();
  });

  it('принимает реальные коды из реестров B2', () => {
    expect(() =>
      parseNegativeCaseOracle(
        line(',"expectedReasonCodes":["privacyContext_violated","exception_trigger_inactive"]')
      )
    ).not.toThrow();
  });

  it('отвергает неизвестный expectedDisposition', () => {
    expect(() =>
      parseNegativeCaseOracle('{"id":"Q05-N1","expectedDisposition":"MAYBE"}')
    ).toThrow();
  });

  it('отвергает номер правила вне 1–10', () => {
    expect(() => parseNegativeCaseOracle(line(',"requiredSelectedRuleIds":[11]'))).toThrow();
  });

  it('отвергает правило, одновременно обязательное и запрещённое', () => {
    expect(() =>
      parseNegativeCaseOracle(line(',"requiredSelectedRuleIds":[5],"forbiddenSelectedRuleIds":[5]'))
    ).toThrow(/5/);
  });

  it('отвергает лишнее поле', () => {
    expect(() => parseNegativeCaseOracle(line(',"hint":"утечка"'))).toThrow();
  });
});

describe('loadNegativeCaseOracle — реальный sidecar', () => {
  it('покрывает РОВНО те 6 negative-кейсов, что есть в основном oracle', () => {
    const mainIds = loadSemanticRuleOracle()
      .flatMap((c) => c.negativeCases)
      .map((n) => n.id)
      .sort();
    const sidecarIds = loadNegativeCaseOracle()
      .map((n) => n.id)
      .sort();

    expect(sidecarIds).toEqual(mainIds);
  });

  it('каждый must_clarify ожидает HOLD, каждый must_not_apply — DIRECT_ANSWER', () => {
    const behaviorById = new Map(
      loadSemanticRuleOracle()
        .flatMap((c) => c.negativeCases)
        .map((n) => [n.id, n.expectedBehavior])
    );

    for (const entry of loadNegativeCaseOracle()) {
      const expected = behaviorById.get(entry.id) === 'must_clarify' ? 'HOLD' : 'DIRECT_ANSWER';
      expect(entry.expectedDisposition, `${entry.id}`).toBe(expected);
    }
  });

  it('Q05-N1 требует исключить правило 5 — иначе кейс проверяет только прозу', () => {
    const q05n1 = loadNegativeCaseOracle().find((n) => n.id === 'Q05-N1');

    expect(q05n1?.requiredCandidateRuleIds).toContain(5);
    expect(q05n1?.forbiddenSelectedRuleIds).toContain(5);
  });

  it('Q04-N1 несёт все три числа правила 4 — совместное покрытие', () => {
    const q04n1 = loadNegativeCaseOracle().find((n) => n.id === 'Q04-N1');

    expect(q04n1?.numericAssertions?.map((a) => a.value).sort((a, b) => a - b)).toEqual([3, 15, 30]);
  });

  it('все коды причин из sidecar существуют в реестрах B2', () => {
    for (const entry of loadNegativeCaseOracle()) {
      for (const code of entry.expectedReasonCodes ?? []) {
        expect(KNOWN_REASON_CODES).toContain(code);
      }
    }
  });
});
