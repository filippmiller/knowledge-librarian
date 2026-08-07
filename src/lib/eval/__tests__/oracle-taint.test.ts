import { describe, expect, it } from 'vitest';
import { buildOracleTaintDetector } from '../oracle-taint';
import type { OracleCase } from '../semantic-rule-oracle';

/**
 * РАНТАЙМ-ГРАНИЦА изоляции oracle (план §0.3 №2/№3).
 *
 * Статические ворота доказывают, что движок не ИМПОРТИРУЕТ oracle. Они ничего
 * не говорят о том, что раннер — которому чтение oracle разрешено — не передаст
 * `expectedAnswer` во вход движка. Тогда все статические проверки зелены, а
 * движок получает ответ на блюде.
 */

const SOURCE_TEXT = [
  '3. Допустимая техника. Почесание выполняют подушечками двух или трёх пальцев',
  'короткими плавными движениями. Нельзя использовать ногти как скребок.',
].join(' ');

const ORACLE: OracleCase[] = [
  {
    id: 'Q03',
    question: 'Чем безопаснее снять неприятное ощущение?',
    expectedRuleIds: [3],
    expectedAnswer:
      'Разрешены только подушечками двух или трёх пальцев. Ногти, карточки и другие твёрдые предметы использовать нельзя.',
    matchReason: 'Вопрос не употребляет слово чесать, но перечисляет разрешённый способ.',
    negativeCases: [],
  },
];

const detector = () => buildOracleTaintDetector({ oracle: ORACLE, sourceText: SOURCE_TEXT });

describe('buildOracleTaintDetector', () => {
  it('пропускает вопрос — это законный вход движка, а не секрет', () => {
    expect(() =>
      detector().assertClean({ question: ORACLE[0].question }, 'engine input')
    ).not.toThrow();
  });

  it('пропускает текст из исходного документа — движок имеет на него право', () => {
    expect(() =>
      detector().assertClean(
        { retrievalText: 'Почесание выполняют подушечками двух или трёх пальцев' },
        'engine input'
      )
    ).not.toThrow();
  });

  it('ловит формулировку, которая есть ТОЛЬКО в ожидаемом ответе', () => {
    expect(() =>
      detector().assertClean(
        { hint: 'Ногти, карточки и другие твёрдые предметы использовать нельзя' },
        'engine input'
      )
    ).toThrow(/oracle/i);
  });

  it('ловит утечку match_reason', () => {
    expect(() =>
      detector().assertClean({ note: ORACLE[0].matchReason }, 'extraction prompt')
    ).toThrow(/oracle/i);
  });

  it('называет место утечки — иначе отладка прогона слепая', () => {
    expect(() =>
      detector().assertClean({ note: ORACLE[0].matchReason }, 'extraction prompt')
    ).toThrow(/extraction prompt/);
  });

  it('обходит вложенные объекты и массивы', () => {
    expect(() =>
      detector().assertClean(
        { messages: [{ content: { text: ORACLE[0].matchReason } }] },
        'engine input'
      )
    ).toThrow(/oracle/i);
  });

  it('не срабатывает на пустом и примитивном payload', () => {
    const d = detector();
    expect(() => d.assertClean({}, 'x')).not.toThrow();
    expect(() => d.assertClean(null, 'x')).not.toThrow();
    expect(() => d.assertClean(42, 'x')).not.toThrow();
  });

  it('нормализует регистр и пробелы — тривиальная переделка не обходит проверку', () => {
    expect(() =>
      detector().assertClean(
        { note: '  НОГТИ,   КАРТОЧКИ и другие  ТВЁРДЫЕ предметы использовать нельзя ' },
        'engine input'
      )
    ).toThrow(/oracle/i);
  });

  it('короткое совпадение слов не считается утечкой — иначе ложные срабатывания', () => {
    expect(() => detector().assertClean({ note: 'предметы использовать' }, 'x')).not.toThrow();
  });
});

/**
 * Детектор с пустым словарём прошёл бы все юнит-тесты выше и не ловил бы
 * ничего. Проверяем на настоящем oracle и настоящем DOCX: словарь непустой,
 * и при этом законный текст правил его не задевает.
 */
describe('buildOracleTaintDetector на реальном пакете', () => {
  const realDetector = async () => {
    const { loadSemanticRuleOracle } = await import('../semantic-rule-oracle');
    const { loadSourceRulesFromDocx } = await import('../source-rule-segmentation');
    const rules = await loadSourceRulesFromDocx();
    return {
      detector: buildOracleTaintDetector({
        oracle: loadSemanticRuleOracle(),
        sourceText: rules.map((r) => r.text).join('\n'),
      }),
      rules,
    };
  };

  it('словарь «только-oracle» непустой — иначе проверка ничего не стережёт', async () => {
    const { detector: d } = await realDetector();

    expect(d.taintedShingleCount).toBeGreaterThan(0);
  });

  it('текст любого исходного правила НЕ считается утечкой', async () => {
    const { detector: d, rules } = await realDetector();

    for (const rule of rules) {
      expect(() => d.assertClean({ retrievalText: rule.text }, `rule ${rule.sourceRuleId}`)).not.toThrow();
    }
  });

  it('каждый вопрос Q01–Q10 НЕ считается утечкой — вопрос идёт в движок', async () => {
    const { loadSemanticRuleOracle } = await import('../semantic-rule-oracle');
    const { detector: d } = await realDetector();

    for (const testCase of loadSemanticRuleOracle()) {
      expect(() => d.assertClean({ question: testCase.question }, testCase.id)).not.toThrow();
    }
  });

  it('ожидаемый ответ любого кейса ЛОВИТСЯ как утечка', async () => {
    const { loadSemanticRuleOracle } = await import('../semantic-rule-oracle');
    const { detector: d } = await realDetector();

    for (const testCase of loadSemanticRuleOracle()) {
      expect(
        () => d.assertClean({ leaked: testCase.expectedAnswer }, testCase.id),
        `${testCase.id}: ожидаемый ответ прошёл мимо детектора`
      ).toThrow(/oracle/i);
    }
  });
});
