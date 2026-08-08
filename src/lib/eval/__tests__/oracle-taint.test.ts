import { beforeAll, describe, expect, it } from 'vitest';
import { buildOracleTaintDetector, type OracleTaintDetector } from '../oracle-taint';
import type { OracleCase } from '../semantic-rule-oracle';
import type { SourceRule } from '../source-rule-segmentation';

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
 *
 * Загрузка ОДИН раз в `beforeAll`, не заново в каждом `it()` (Step 7,
 * независимое ревью PR #76 — диагностика ранее замеченной нестабильности
 * этого файла под полной параллельной нагрузкой сьюта). Раньше каждый из
 * четырёх тестов ниже независимо гонял `mammoth.extractRawText` по реальному
 * DOCX + `fs.readFileSync` по реальному oracle JSONL — вживую замерено: 1-й
 * (холодный) вызов в изоляции ~1.1с, под полной параллельной нагрузкой
 * сьюта ~2.5с — уже половина от дефолтного `testTimeout` (5000мс) vitest,
 * и это НЕ гонка за общее состояние (результат всегда корректен при
 * завершении), а исчерпание запаса времени под таймаут диска/CPU-разогрева
 * под нагрузкой. `beforeAll` не только убирает трёхкратную избыточную
 * повторную работу (тот же DOCX/oracle не меняется между тестами одного
 * файла), но и переносит стоимость под `hookTimeout` — эмпирически
 * проверено (`_scratch-hook-timeout-probe`, вручную, не оставлено в
 * репозитории): 6-секундный `beforeAll` проходит без таймаута, то есть
 * бюджет заметно щедрее дефолтного `testTimeout`.
 */
describe('buildOracleTaintDetector на реальном пакете', () => {
  let detector: OracleTaintDetector;
  let rules: SourceRule[];
  let oracle: OracleCase[];

  beforeAll(async () => {
    const { loadSemanticRuleOracle } = await import('../semantic-rule-oracle');
    const { loadSourceRulesFromDocx } = await import('../source-rule-segmentation');
    rules = await loadSourceRulesFromDocx();
    oracle = loadSemanticRuleOracle();
    detector = buildOracleTaintDetector({
      oracle,
      sourceText: rules.map((r) => r.text).join('\n'),
    });
  });

  it('словарь «только-oracle» непустой — иначе проверка ничего не стережёт', () => {
    expect(detector.taintedShingleCount).toBeGreaterThan(0);
  });

  it('текст любого исходного правила НЕ считается утечкой', () => {
    for (const rule of rules) {
      expect(() =>
        detector.assertClean({ retrievalText: rule.text }, `rule ${rule.sourceRuleId}`)
      ).not.toThrow();
    }
  });

  it('каждый вопрос Q01–Q10 НЕ считается утечкой — вопрос идёт в движок', () => {
    for (const testCase of oracle) {
      expect(() => detector.assertClean({ question: testCase.question }, testCase.id)).not.toThrow();
    }
  });

  it('ожидаемый ответ любого кейса ЛОВИТСЯ как утечка', () => {
    for (const testCase of oracle) {
      expect(
        () => detector.assertClean({ leaked: testCase.expectedAnswer }, testCase.id),
        `${testCase.id}: ожидаемый ответ прошёл мимо детектора`
      ).toThrow(/oracle/i);
    }
  });
});
