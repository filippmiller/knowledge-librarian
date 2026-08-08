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

/**
 * Каким механизмом ЭТОТ конкретный секрет защищён (pre-retrieval hardening,
 * Step 9). Раньше был только ОДИН пул шинглов от ВСЕХ секретов сразу —
 * секрет короче `shingleSize` слов давал пустое множество шинглов и
 * НИЧЕГО не добавлял в пул, значит `assertClean` не ловил его утечку вообще,
 * а `taintedShingleCount > 0` (за счёт других секретов) выглядело так, будто
 * защита работает для всех.
 *
 * - `SHINGLE` — секрет ≥ shingleSize слов, хотя бы один его шингл уникален
 *   для oracle (не встречается в sourceText) — защищён общим механизмом.
 * - `EXACT_SUBSTRING` — шинглы не сработали (секрет короче shingleSize ИЛИ
 *   каждое его 8-словное окно уже есть в источнике), но ПОЛНЫЙ нормализованный
 *   текст секрета сам по себе НЕ встречается в источнике — защищён точным
 *   поиском подстроки целиком (safe shorter-secret mechanism).
 * - `UNGUARDED` — точное написание секрета дословно есть в источнике. Не
 *   отличить его утечку от легитимного цитирования источника никаким
 *   текстовым механизмом — честно репортится, не подделывается.
 */
export type SecretGuardKind = 'SHINGLE' | 'EXACT_SUBSTRING' | 'UNGUARDED';

export interface SecretCoverageEntry {
  readonly caseId: string;
  readonly field: 'expectedAnswer' | 'matchReason';
  /** `null` — поле самого кейса; индекс — поле `negativeCases[negativeIndex]`. */
  readonly negativeIndex: number | null;
  readonly guard: SecretGuardKind;
}

export interface OracleTaintDetector {
  /** Бросает исключение, если payload содержит текст, выводимый только из oracle. */
  assertClean(payload: unknown, label: string): void;
  /** Размер словаря «только-oracle» шинглов. Ноль означал бы неработающую проверку. */
  readonly taintedShingleCount: number;
  /** Как защищён КАЖДЫЙ отдельный секрет — не только совокупный пул. */
  readonly secretCoverage: readonly SecretCoverageEntry[];
  /** Секреты без рабочей защиты (см. `SecretGuardKind.UNGUARDED`). */
  readonly unguardedSecretCount: number;
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

interface AttributedSecret {
  readonly caseId: string;
  readonly field: 'expectedAnswer' | 'matchReason';
  readonly negativeIndex: number | null;
  readonly text: string;
}

/** Секреты oracle, с атрибуцией для per-secret coverage. `question`
 *  намеренно исключён — это вход движка, а не ответ. */
function collectSecrets(oracle: readonly OracleCase[]): AttributedSecret[] {
  const secrets: AttributedSecret[] = [];
  for (const testCase of oracle) {
    secrets.push({ caseId: testCase.id, field: 'expectedAnswer', negativeIndex: null, text: testCase.expectedAnswer });
    secrets.push({ caseId: testCase.id, field: 'matchReason', negativeIndex: null, text: testCase.matchReason });
    testCase.negativeCases.forEach((negative, i) => {
      secrets.push({ caseId: testCase.id, field: 'expectedAnswer', negativeIndex: i, text: negative.expectedAnswer });
      secrets.push({ caseId: testCase.id, field: 'matchReason', negativeIndex: i, text: negative.matchReason });
    });
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
  const normalizedSourceText = normalize(sourceText).join(' ');

  const tainted = new Set<string>();
  /** Полные нормализованные фразы секретов, защищённых точным поиском
   *  подстроки — отдельно от `tainted` (тот хранит ФИКСИРОВАННЫЕ 8-словные
   *  окна, а не произвольную длину). */
  const taintedPhrases = new Set<string>();
  const secretCoverage: SecretCoverageEntry[] = [];

  for (const secret of collectSecrets(oracle)) {
    const secretWords = normalize(secret.text);
    const secretShingles = shingles(secretWords, shingleSize);
    let contributedShingle = false;
    for (const shingle of secretShingles) {
      if (!sourceShingles.has(shingle)) {
        tainted.add(shingle);
        contributedShingle = true;
      }
    }

    let guard: SecretGuardKind;
    if (contributedShingle) {
      guard = 'SHINGLE';
    } else {
      const normalizedSecret = secretWords.join(' ');
      if (normalizedSecret.length > 0 && !normalizedSourceText.includes(normalizedSecret)) {
        taintedPhrases.add(normalizedSecret);
        guard = 'EXACT_SUBSTRING';
      } else {
        // Дословное написание секрета либо пусто, либо буквально есть в
        // источнике — ни shingle, ни exact-substring механизм не отличит его
        // утечку от легитимного цитирования источника. Честно репортится,
        // не подделывается (Step 9: "expose/report unguarded secrets").
        guard = 'UNGUARDED';
      }
    }

    secretCoverage.push({
      caseId: secret.caseId,
      field: secret.field,
      negativeIndex: secret.negativeIndex,
      guard,
    });
  }

  const unguardedSecretCount = secretCoverage.filter((e) => e.guard === 'UNGUARDED').length;

  return {
    taintedShingleCount: tainted.size,
    secretCoverage,
    unguardedSecretCount,

    assertClean(payload: unknown, label: string): void {
      if (tainted.size === 0 && taintedPhrases.size === 0) return;

      const strings: string[] = [];
      collectStrings(payload, strings);

      for (const value of strings) {
        if (tainted.size > 0) {
          for (const shingle of shingles(normalize(value), shingleSize)) {
            if (tainted.has(shingle)) {
              throw new Error(
                `Утечка oracle в «${label}»: обнаружена формулировка, выводимая только из ключа — «${shingle}». ` +
                  'Прогон недействителен (план §0.3).'
              );
            }
          }
        }
        if (taintedPhrases.size > 0) {
          const normalizedValue = normalize(value).join(' ');
          for (const phrase of taintedPhrases) {
            if (phrase.length > 0 && normalizedValue.includes(phrase)) {
              throw new Error(
                `Утечка oracle в «${label}»: обнаружена короткая формулировка, выводимая только из ключа — «${phrase}». ` +
                  'Прогон недействителен (план §0.3).'
              );
            }
          }
        }
      }
    },
  };
}
