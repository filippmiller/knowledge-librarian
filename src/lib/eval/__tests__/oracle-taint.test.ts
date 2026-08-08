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
 * pre-retrieval hardening, Step 9. Раньше `taintedShingleCount` был ЕДИНЫМ
 * пулом шинглов от ВСЕХ секретов сразу — секрет короче `shingleSize` слов
 * даёт ПУСТОЕ множество шинглов (`shingles()`, `i + size <= words.length`
 * никогда не выполняется), и такой секрет НИЧЕГО не добавляет в общий пул,
 * а значит `assertClean` его не ловит вообще, даже если он утечёт дословно —
 * при этом `taintedShingleCount > 0` (за счёт ДРУГИХ секретов) создаёт
 * ложное ощущение, что защита работает для всех.
 */
describe('buildOracleTaintDetector — per-secret coverage (pre-retrieval hardening, Step 9)', () => {
  const LONG_SOURCE = 'документ не содержит вообще никаких похожих слов на эту тему совсем ни разу нигде';

  it('короткий secret (< shingleSize слов) — не даёт нулевую защиту: guard=EXACT_SUBSTRING (safe shorter-secret mechanism), не UNGUARDED', () => {
    const oracle: OracleCase[] = [
      {
        id: 'q-short',
        question: 'вопрос',
        expectedRuleIds: [1],
        expectedAnswer: 'зелёныйуникальныйключ',
        matchReason: 'причина',
        negativeCases: [],
      },
    ];
    const d = buildOracleTaintDetector({ oracle, sourceText: LONG_SOURCE });
    const entries = d.secretCoverage.filter((e) => e.caseId === 'q-short');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.guard !== 'UNGUARDED')).toBe(true);
  });

  it('короткий secret, защищённый через EXACT_SUBSTRING, всё равно ловит дословную утечку в payload (не просто отчёт, а реальная защита)', () => {
    const oracle: OracleCase[] = [
      {
        id: 'q-short',
        question: 'вопрос',
        expectedRuleIds: [1],
        expectedAnswer: 'зелёныйуникальныйключ',
        matchReason: 'причина короче восьми слов тут',
        negativeCases: [],
      },
    ];
    const d = buildOracleTaintDetector({ oracle, sourceText: LONG_SOURCE });
    expect(() => d.assertClean({ answer: 'ответ содержит зелёныйуникальныйключ внутри текста' }, 'test')).toThrow(
      /oracle/i
    );
  });

  it('secret, чьё точное написание дословно есть в источнике, — честно репортится UNGUARDED (не подделываем защиту, которой нет)', () => {
    const oracle: OracleCase[] = [
      {
        id: 'q-sourced',
        question: 'вопрос',
        expectedRuleIds: [1],
        expectedAnswer: 'общееслово',
        matchReason: 'ещё одна причина',
        negativeCases: [],
      },
    ];
    const d = buildOracleTaintDetector({
      oracle,
      sourceText: 'в тексте документа буквально есть слово общееслово прямо здесь',
    });
    const entry = d.secretCoverage.find((e) => e.caseId === 'q-sourced' && e.field === 'expectedAnswer')!;
    expect(entry.guard).toBe('UNGUARDED');
    expect(d.unguardedSecretCount).toBeGreaterThan(0);
  });

  it('secretCoverage покрывает negativeCases по caseId/negativeIndex, не только верхнеуровневые поля', () => {
    const oracle: OracleCase[] = [
      {
        id: 'q1',
        question: 'вопрос',
        expectedRuleIds: [1],
        expectedAnswer: 'основной ответ достаточно длинный чтобы иметь восемь слов точно',
        matchReason: 'основная причина тоже достаточно длинная чтобы иметь восемь слов',
        negativeCases: [
          {
            id: 'neg1',
            question: 'негативный вопрос',
            expectedBehavior: 'must_clarify',
            expectedAnswer: 'негативныйсекрет',
            matchReason: 'причина негатива короче восьми слов тут',
          },
        ],
      },
    ];
    const d = buildOracleTaintDetector({ oracle, sourceText: LONG_SOURCE });
    const negEntry = d.secretCoverage.find((e) => e.caseId === 'q1' && e.negativeIndex === 0 && e.field === 'expectedAnswer');
    expect(negEntry).toBeDefined();
    expect(negEntry?.guard).not.toBe('UNGUARDED');
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

  it('per-secret coverage посчитан для каждого expectedAnswer/matchReason реального пакета, включая negativeCases — не пропущен молча', () => {
    // Ровно два поля на кейс (expectedAnswer, matchReason) + два поля на
    // каждый negativeCase — secretCoverage обязан покрывать ВСЕ, не только
    // верхнеуровневые (Step 9: "every protected expectedAnswer/matchReason
    // contributes coverage OR is explicitly handled").
    const expectedFieldCount =
      oracle.length * 2 + oracle.reduce((n, c) => n + c.negativeCases.length * 2, 0);
    expect(detector.secretCoverage.length).toBe(expectedFieldCount);
  });

  it('репортит unguardedSecretCount на реальном пакете — не обязательно 0, но обязано быть КОНЕЧНЫМ известным числом, не тихим пропуском (Step 9: "expose/report unguarded secrets", не "force to zero")', () => {
    expect(Number.isFinite(detector.unguardedSecretCount)).toBe(true);
    expect(detector.unguardedSecretCount).toBeGreaterThanOrEqual(0);
    if (detector.unguardedSecretCount > 0) {
      const unguarded = detector.secretCoverage.filter((e) => e.guard === 'UNGUARDED');
      // eslint-disable-next-line no-console -- диагностика для финального отчёта, не тестовый шум по умолчанию
      console.warn(
        `oracle-taint: ${detector.unguardedSecretCount} secret field(s) не защищены ни shingle, ни exact-substring механизмом (совпадают дословно с источником):`,
        unguarded.map((e) => `${e.caseId}/${e.field}${e.negativeIndex !== null ? `[neg${e.negativeIndex}]` : ''}`)
      );
    }
  });
});
