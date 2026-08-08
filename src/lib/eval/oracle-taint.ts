/**
 * Рантайм-граница изоляции oracle (план §0.3 №2/№3, Beads translation-yz9).
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ СТАТИЧЕСКИХ ВОРОТ. Ворота в `oracle-isolation.test.ts`
 * доказывают, что продуктовый код не ИМПОРТИРУЕТ oracle. Они принципиально не
 * могут доказать другое: раннер, которому чтение oracle разрешено (§0.3 №3),
 * не передал `expectedAnswer` во вход движка, в extraction prompt или в
 * reviewed JSONL. В этом случае все статические проверки зелены, а движок
 * получает ответ напрямую — и прогон недействителен.
 *
 * ЧТО СЧИТАЕТСЯ СЕКРЕТОМ. `question` — НЕ секрет: вопрос и есть законный вход
 * движка. Секрет — `expectedAnswer` и `matchReason` (и то же у negative-кейсов):
 * знание того, КАКОЙ ответ ожидается и ПОЧЕМУ.
 *
 * ПОЧЕМУ ВЫЧИТАЕТСЯ ИСХОДНЫЙ ТЕКСТ. Ожидаемый ответ выведен из правила, поэтому
 * лексически сильно пересекается с DOCX («подушечками двух или трёх пальцев»
 * есть и там, и там). Прямое сопоставление n-грамм срабатывало бы на законно
 * извлечённых units. Поэтому из шинглов oracle вычитаются шинглы источника:
 * остаётся текст, который МОГ появиться только из oracle. Совпадение с ним —
 * настоящая утечка, а не общий словарь предметной области.
 */

import type { OracleCase } from './semantic-rule-oracle';

/**
 * Длина шингла в словах. Ниже — растут ложные срабатывания на общем словаре
 * документа; выше — утечка короткой, но выдающей формулировки проходит мимо.
 * Восемь слов — фраза, которую нельзя воспроизвести случайно, но которая
 * заметно короче предложения.
 */
const DEFAULT_SHINGLE_SIZE = 8;

export interface OracleTaintOptions {
  readonly oracle: readonly OracleCase[];
  /** Полный текст исходного DOCX: движок имеет на него право. */
  readonly sourceText: string;
  readonly shingleSize?: number;
}

export interface OracleTaintDetector {
  /** Бросает исключение, если payload содержит текст, выводимый только из oracle. */
  assertClean(payload: unknown, label: string): void;
  /** Размер словаря «только-oracle» шинглов. Ноль означал бы неработающую проверку. */
  readonly taintedShingleCount: number;
}

/** Регистр, пунктуация и кратные пробелы не должны служить обходом проверки. */
function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}

function shingles(words: readonly string[], size: number): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) {
    result.add(words.slice(i, i + size).join(' '));
  }
  return result;
}

/** Секреты oracle. `question` намеренно исключён — это вход движка, а не ответ. */
function collectSecrets(oracle: readonly OracleCase[]): string[] {
  const secrets: string[] = [];
  for (const testCase of oracle) {
    secrets.push(testCase.expectedAnswer, testCase.matchReason);
    for (const negative of testCase.negativeCases) {
      secrets.push(negative.expectedAnswer, negative.matchReason);
    }
  }
  return secrets;
}

/** Собирает все строки payload, включая вложенные объекты и массивы. */
function collectStrings(payload: unknown, into: string[]): void {
  if (typeof payload === 'string') {
    into.push(payload);
    return;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectStrings(item, into);
    return;
  }
  if (payload !== null && typeof payload === 'object') {
    for (const value of Object.values(payload)) collectStrings(value, into);
  }
}

export function buildOracleTaintDetector({
  oracle,
  sourceText,
  shingleSize = DEFAULT_SHINGLE_SIZE,
}: OracleTaintOptions): OracleTaintDetector {
  const sourceShingles = shingles(normalize(sourceText), shingleSize);

  const tainted = new Set<string>();
  for (const secret of collectSecrets(oracle)) {
    for (const shingle of shingles(normalize(secret), shingleSize)) {
      if (!sourceShingles.has(shingle)) tainted.add(shingle);
    }
  }

  return {
    taintedShingleCount: tainted.size,

    assertClean(payload: unknown, label: string): void {
      if (tainted.size === 0) return;

      const strings: string[] = [];
      collectStrings(payload, strings);

      for (const value of strings) {
        for (const shingle of shingles(normalize(value), shingleSize)) {
          if (tainted.has(shingle)) {
            throw new Error(
              `Утечка oracle в «${label}»: обнаружена формулировка, выводимая только из ключа — «${shingle}». ` +
                'Прогон недействителен (план §0.3).'
            );
          }
        }
      }
    },
  };
}
