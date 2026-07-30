/**
 * Проверка заземления рискованных утверждений.
 *
 * Владелец определил ошибку как противоречие фактам, и самые дорогие
 * противоречия — числовые: цена, срок, процент предоплаты. Модель синтезирует
 * ответ из цитат, но ничто не мешает ей сложить два тарифа, перенести цифру из
 * соседней строки прайса или назвать срок, которого в источниках не было.
 * Уверенность движка тут не помогает: это максимум семантической близости
 * найденных чанков, а не вероятность того, что число верное.
 *
 * Поэтому проверка чисто механическая: каждое число, поданное клиенту как
 * деньги, срок или процент, обязано встречаться в цитатах. Не «похожее», а то
 * же самое. Не встречается — утверждение не подтверждено, и ответ уходит
 * человеку.
 *
 * Это НЕ проверка правильности: цитата может быть из устаревшего прайса.
 * Это проверка происхождения — она отсекает выдуманное и посчитанное, оставляя
 * ошибки разметки для других контролей.
 */

/** Число вместе с единицей, которая делает его утверждением о деньгах или сроке. */
export interface RiskyClaim {
  /** Нормализованное число: «27 500» и «27500» — одно и то же. */
  value: string;
  kind: 'money' | 'duration' | 'percent';
  /** Фрагмент ответа вокруг числа — для операторского разбора. */
  context: string;
}

/**
 * Пробелы внутри числа бывают обычные, неразрывные и тонкие: «35 400», «35 400»,
 * «35 400». Для сравнения все они убираются, иначе цитата и ответ не совпадут
 * из-за типографики.
 */
function normalizeNumber(raw: string): string {
  return raw.replace(/[\s   ]/g, '').replace(/,/g, '.');
}

/** Весь текст, из которого ответ имел право брать числа. */
function buildGroundingCorpus(citations: string[]): string {
  return citations.join('\n').replace(/[\s   ]+/g, ' ');
}

const MONEY = /(\d[\d\s   ]*(?:[.,]\d+)?)\s*(?:₽|руб\.?|рублей|рубля|р\.)/giu;
const DURATION =
  /(\d[\d\s   ]*(?:[.,]\d+)?)\s*(?:-|–|—)?\s*(?:календарн[а-яё]*\s+|рабоч[а-яё]*\s+)?(дн[еяй][а-яё]*|день|недел[а-яё]+|месяц[а-яё]*|час[а-яё]*|минут[а-яё]*)/giu;
const PERCENT = /(\d[\d\s   ]*(?:[.,]\d+)?)\s*(?:%|процент[а-яё]*)/giu;

function collect(
  text: string,
  pattern: RegExp,
  kind: RiskyClaim['kind'],
  into: Map<string, RiskyClaim>
): void {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const value = normalizeNumber(m[1]);
    if (!value || value === '0') continue;
    const key = `${kind}:${value}`;
    if (into.has(key)) continue;
    const from = Math.max(0, m.index - 40);
    into.set(key, {
      value,
      kind,
      context: text.slice(from, Math.min(text.length, m.index + m[0].length + 40)).replace(/\s+/g, ' ').trim(),
    });
  }
}

export function extractRiskyClaims(answer: string): RiskyClaim[] {
  const found = new Map<string, RiskyClaim>();
  collect(answer, MONEY, 'money', found);
  collect(answer, DURATION, 'duration', found);
  collect(answer, PERCENT, 'percent', found);
  return [...found.values()];
}

export interface GroundingVerdict {
  grounded: boolean;
  /** Утверждения, чьих чисел нет ни в одной цитате. */
  ungrounded: RiskyClaim[];
  /** Сколько рискованных утверждений всего — для оценки, насколько ответ «числовой». */
  total: number;
}

/**
 * Год в дате («прайс от 01.01.2026») и номер правила не являются утверждением о
 * деньгах или сроке, но могут попасть в выборку как число рядом с единицей.
 * Такие случаи отсеиваются тем, что ищется точное совпадение в цитатах: если
 * число пришло из цитаты, оно там и найдётся.
 */
export function checkClaimGrounding(answer: string, citationQuotes: string[]): GroundingVerdict {
  const claims = extractRiskyClaims(answer);
  if (claims.length === 0) return { grounded: true, ungrounded: [], total: 0 };

  const corpus = buildGroundingCorpus(citationQuotes);
  const corpusCompact = normalizeNumber(corpus);

  const ungrounded = claims.filter((claim) => {
    // Границы по цифрам обязательны: простое вхождение засчитало бы «110»
    // внутри «1100», то есть выдуманная цена прошла бы как подтверждённая.
    // Сравнение идёт по сжатому корпусу, поэтому «27 500» в цитате находит
    // «27500» в ответе и наоборот.
    const escaped = claim.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`(?<!\\d)${escaped}(?!\\d)`, 'u').test(corpusCompact);
  });

  return { grounded: ungrounded.length === 0, ungrounded, total: claims.length };
}
