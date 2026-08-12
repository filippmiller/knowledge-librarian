import fs from 'node:fs';

/**
 * Оракул для РЕАЛЬНЫХ документов.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФОРМАТ. Учебный оракул (`semantic-rule-oracle.ts`) опознаёт
 * ожидаемое через `expectedRuleIds` — номера правил, которые
 * `segmentSourceRules` вычитывает из заголовков вида "7. Название.".
 * Замерено на живых файлах бюро: **14 из 15 реальных инструкций дают НОЛЬ
 * таких правил** (единственное исключение — документ с случайным нумерованным
 * списком). Значит вся постадийная воронка грейдера
 * (`missingFromExtraction/Candidates/TopK/Selected`, `RETRIEVAL_MISS`,
 * `RERANK_MISS`) на реальном корпусе структурно неприменима: она сравнивала бы
 * с пустым множеством и объявляла пропущенным всё.
 *
 * Поэтому ожидаемое здесь описывается не НОМЕРОМ правила, а НАБЛЮДАЕМЫМИ
 * свойствами ответа. Это те же четыре планки, которые владелец назвал
 * определением «правильного ответа»:
 *
 * 1. верный текст      → `requiredFacts` присутствуют, `forbiddenFacts` нет
 * 2. верная ссылка     → процитирован ожидаемый документ
 * 3. спрашивает при неоднозначности → `expectedDisposition: 'CLARIFY'`
 * 4. отказывается, когда не знает   → `expectedDisposition: 'REFUSE'`
 *
 * ПОЧЕМУ ФАКТЫ, А НЕ СУДЬЯ-LLM. Проверка фактов детерминированна, бесплатна и
 * её нельзя подогнать: «Фурштатская 52» либо есть в ответе, либо нет.
 * LLM-судья на своём же выходе — это прокси, а проект уже заплатил семью
 * прогонами за оптимизацию прокси вместо метрики. Судья допустим позже как
 * ДОПОЛНЕНИЕ, но не как основной вердикт.
 */

/** Что система обязана сделать с вопросом. Сознательно грубее внутренних
 *  диспозиций движка: оракул описывает ОБЯЗАТЕЛЬСТВО ПЕРЕД ПОЛЬЗОВАТЕЛЕМ, а
 *  не внутреннее состояние. Отображение на диспозиции движка живёт в грейдере,
 *  чтобы переименование внутренней диспозиции не переписывало оракул. */
export const REAL_CORPUS_EXPECTATIONS = ['ANSWER', 'CLARIFY', 'REFUSE'] as const;
export type RealCorpusExpectation = (typeof REAL_CORPUS_EXPECTATIONS)[number];

export interface RealCorpusOracleCase {
  readonly id: string;
  readonly question: string;
  readonly expect: RealCorpusExpectation;
  /** Подстроки, которые ОБЯЗАНЫ встретиться в ответе. Сравнение
   *  регистронезависимое с нормализацией пробелов — но не морфологическое:
   *  оракул обязан задавать форму, которая реально встречается. */
  readonly requiredFacts: readonly string[];
  /** Подстроки, которых в ответе быть НЕ ДОЛЖНО. Именно здесь ловится самый
   *  дорогой для бюро класс ошибки — маршрутизация в неверный орган
   *  (замерено в прошлой батарее: ответ про ЛО цитировал МинЮст). */
  readonly forbiddenFacts: readonly string[];
  /** Фрагменты имён документов, один из которых обязан быть процитирован.
   *  Пусто — цитата не проверяется (осознанный отказ, а не забывчивость). */
  readonly expectedSourceDocs: readonly string[];
  /** Почему ожидание именно такое. Обязательно: оракул на реальном домене
   *  проверяет ЧЕЛОВЕК, и он должен видеть основание, не поднимая исходник. */
  readonly rationale: string;
  /** `true` — факт подтверждён источником; `false` — черновик агента, ждёт
   *  проверки владельцем. Прогон с непроверенными кейсами разрешён, но
   *  грейдер обязан считать их отдельно: смешать их с проверенными значило бы
   *  выдать догадку за замер. */
  readonly ownerValidated: boolean;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Разбирает JSONL. Любая структурная аномалия — исключение, а не пропуск
 *  строки: молча выброшенный кейс завысил бы долю пройденных. */
export function parseRealCorpusOracle(raw: string): RealCorpusOracleCase[] {
  const cases: RealCorpusOracleCase[] = [];
  const seen = new Set<string>();

  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`real-corpus oracle: строка ${index + 1} не JSON: ${(error as Error).message}`);
    }
    const c = parsed as Record<string, unknown>;

    if (typeof c.id !== 'string' || c.id.length === 0) {
      throw new Error(`real-corpus oracle: строка ${index + 1} без "id"`);
    }
    if (seen.has(c.id)) {
      throw new Error(`real-corpus oracle: дубль id "${c.id}" на строке ${index + 1}`);
    }
    if (typeof c.question !== 'string' || c.question.trim().length === 0) {
      throw new Error(`real-corpus oracle: кейс "${c.id}" без текста вопроса`);
    }
    if (!REAL_CORPUS_EXPECTATIONS.includes(c.expect as RealCorpusExpectation)) {
      throw new Error(
        `real-corpus oracle: кейс "${c.id}" имеет expect="${String(c.expect)}", допустимо ${REAL_CORPUS_EXPECTATIONS.join('|')}`
      );
    }
    if (!isStringArray(c.requiredFacts) || !isStringArray(c.forbiddenFacts) || !isStringArray(c.expectedSourceDocs)) {
      throw new Error(`real-corpus oracle: кейс "${c.id}" — requiredFacts/forbiddenFacts/expectedSourceDocs обязаны быть массивами строк`);
    }
    if (typeof c.rationale !== 'string' || c.rationale.trim().length === 0) {
      throw new Error(`real-corpus oracle: кейс "${c.id}" без rationale — обоснование обязательно, его проверяет человек`);
    }
    if (typeof c.ownerValidated !== 'boolean') {
      throw new Error(`real-corpus oracle: кейс "${c.id}" без ownerValidated — черновик и проверенный факт нельзя смешивать молча`);
    }
    // ANSWER без единого требуемого факта не проверяет НИЧЕГО: такой кейс
    // прошёл бы на любом непустом ответе и завысил бы счёт.
    if (c.expect === 'ANSWER' && c.requiredFacts.length === 0) {
      throw new Error(`real-corpus oracle: кейс "${c.id}" ожидает ANSWER, но не задаёт ни одного requiredFacts — такой кейс не проверяет ничего`);
    }

    cases.push({
      id: c.id,
      question: c.question,
      expect: c.expect as RealCorpusExpectation,
      requiredFacts: c.requiredFacts,
      forbiddenFacts: c.forbiddenFacts,
      expectedSourceDocs: c.expectedSourceDocs,
      rationale: c.rationale,
      ownerValidated: c.ownerValidated,
    });
    seen.add(c.id);
  }

  if (cases.length === 0) throw new Error('real-corpus oracle: файл не содержит ни одного кейса');
  return cases;
}

export function loadRealCorpusOracle(jsonlPath: string): RealCorpusOracleCase[] {
  return parseRealCorpusOracle(fs.readFileSync(jsonlPath, 'utf8'));
}

/** Нормализация для сравнения фактов: регистр и пробельные последовательности
 *  не значимы, всё остальное значимо. Намеренно НЕ морфологическая — «удобная»
 *  нормализация превратила бы «не на оригинал» в совпадение с «на оригинал». */
export function normalizeForFactMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function factPresent(answerText: string, fact: string): boolean {
  return normalizeForFactMatch(answerText).includes(normalizeForFactMatch(fact));
}
