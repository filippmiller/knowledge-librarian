import { describe, expect, it } from 'vitest';
import {
  ORACLE_PACK_DIR,
  SOURCE_DOCX_FILENAME,
  loadSemanticRuleOracle,
  parseSemanticRuleOracle,
} from '../semantic-rule-oracle';

/**
 * План §0.3: acceptance pack — 10 основных кейсов (Q01–Q10) и 6 negative-кейсов.
 *
 * Этот модуль читает oracle и доступен ТОЛЬКО раннеру/грейдеру (правило
 * изоляции №3). Движок не должен импортировать его ни прямо, ни транзитивно —
 * это проверяется отдельным тестом изоляции.
 */

describe('parseSemanticRuleOracle', () => {
  it('разбирает snake_case из фикстуры в camelCase доменного типа', () => {
    const cases = parseSemanticRuleOracle(
      '{"id":"Q01","question":"в?","expected_rule_ids":[1],"expected_answer":"о","match_reason":"м"}'
    );

    expect(cases).toHaveLength(1);
    expect(cases[0]).toEqual({
      id: 'Q01',
      question: 'в?',
      expectedRuleIds: [1],
      expectedAnswer: 'о',
      matchReason: 'м',
      negativeCases: [],
    });
  });

  it('разбирает вложенные negative-кейсы', () => {
    const cases = parseSemanticRuleOracle(
      '{"id":"Q05","question":"в?","expected_rule_ids":[5],"expected_answer":"о","match_reason":"м",' +
        '"negativeCases":[{"id":"Q05-N1","question":"вн?","expected_behavior":"must_not_apply",' +
        '"expected_answer":"он","match_reason":"мн"}]}'
    );

    expect(cases[0].negativeCases).toEqual([
      {
        id: 'Q05-N1',
        question: 'вн?',
        expectedBehavior: 'must_not_apply',
        expectedAnswer: 'он',
        matchReason: 'мн',
      },
    ]);
  });

  it('отвергает неизвестное expected_behavior', () => {
    expect(() =>
      parseSemanticRuleOracle(
        '{"id":"Q05","question":"в?","expected_rule_ids":[5],"expected_answer":"о","match_reason":"м",' +
          '"negativeCases":[{"id":"Q05-X","question":"вн?","expected_behavior":"must_explode",' +
          '"expected_answer":"он","match_reason":"мн"}]}'
      )
    ).toThrow();
  });

  it('отвергает лишнее поле — oracle читается строго', () => {
    expect(() =>
      parseSemanticRuleOracle(
        '{"id":"Q01","question":"в?","expected_rule_ids":[1],"expected_answer":"о","match_reason":"м","hint":"утечка"}'
      )
    ).toThrow();
  });

  it('отвергает поле из одних пробелов — грейдер остался бы с пустым ожиданием', () => {
    expect(() =>
      parseSemanticRuleOracle(
        '{"id":"Q01","question":"в?","expected_rule_ids":[1],"expected_answer":"   ","match_reason":"м"}'
      )
    ).toThrow();
    expect(() =>
      parseSemanticRuleOracle(
        '{"id":"Q01","question":"\\t","expected_rule_ids":[1],"expected_answer":"о","match_reason":"м"}'
      )
    ).toThrow();
  });

  it('отвергает expected_rule_ids вне диапазона 1–10', () => {
    expect(() =>
      parseSemanticRuleOracle(
        '{"id":"Q01","question":"в?","expected_rule_ids":[11],"expected_answer":"о","match_reason":"м"}'
      )
    ).toThrow();
  });
});

describe('loadSemanticRuleOracle — реальная зафиксированная в git фикстура', () => {
  it('загружает ровно 10 основных кейсов Q01–Q10', () => {
    const cases = loadSemanticRuleOracle();

    expect(cases.map((c) => c.id)).toEqual([
      'Q01',
      'Q02',
      'Q03',
      'Q04',
      'Q05',
      'Q06',
      'Q07',
      'Q08',
      'Q09',
      'Q10',
    ]);
  });

  it('каждый кейс ожидает ровно одно правило, совпадающее с его номером', () => {
    const cases = loadSemanticRuleOracle();

    for (const [index, testCase] of cases.entries()) {
      expect(testCase.expectedRuleIds).toEqual([index + 1]);
    }
  });

  it('содержит ровно 6 negative-кейсов из §0.3', () => {
    const negatives = loadSemanticRuleOracle().flatMap((c) => c.negativeCases);

    expect(negatives.map((n) => `${n.id}:${n.expectedBehavior}`)).toEqual([
      'Q01-M1:must_clarify',
      'Q04-N1:must_not_apply',
      'Q05-N1:must_not_apply',
      'Q05-M1:must_clarify',
      'Q09-N1:must_not_apply',
      'Q10-N1:must_not_apply',
    ]);
  });

  it('DOCX — единственный файл пакета, разрешённый движку', () => {
    expect(SOURCE_DOCX_FILENAME).toBe(
      'uchebnaya_instrukciya_semanticheskoe_izvlechenie_pravil.docx'
    );
    expect(ORACLE_PACK_DIR).toMatch(/semantic-rule-extraction-test-pack$/);
  });
});
