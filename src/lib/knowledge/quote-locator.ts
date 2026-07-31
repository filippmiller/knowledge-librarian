/**
 * Поиск цитаты правила (`Rule.sourceSpan.quote`) в тексте документа-источника.
 *
 * Дословный `indexOf` тут почти не работает: на живой базе (замер по 500 свежим
 * активным правилам с документом) дословно нашлось 179, после нормализации
 * пробелов/кавычек/тире — ещё 196, по началу цитаты — ещё 42, и 82 не нашлось
 * вовсе (модель при извлечении пересобирала строки таблиц: «УКРАИНСКИЙ 540 1640
 * | 640 1740 …» — такого куска в тексте нет). Поэтому у совпадения есть степень,
 * и она честно доезжает до оператора: «частично» — не то же самое, что «сверил».
 */

/** Степень совпадения цитаты с текстом документа. */
export type QuoteMatchKind =
  /** Цитата найдена символ в символ. */
  | 'exact'
  /** Совпала после схлопывания пробелов и унификации кавычек/тире. */
  | 'normalized'
  /** Совпало только начало цитаты — остальное в тексте не найдено. */
  | 'partial';

export interface QuoteMatch {
  /** Границы в исходном тексте — то, что подсвечиваем. */
  start: number;
  end: number;
  kind: QuoteMatchKind;
  /** Доля цитаты, которая реально совпала (1 для exact/normalized). */
  coverage: number;
}

/**
 * Нормализованная копия текста + карта «индекс в нормализованном → индекс в
 * исходном». Карта нужна, чтобы подсветить исходный текст, а не нормализованный.
 */
interface Normalized {
  text: string;
  /** map[i] — позиция в исходной строке, откуда взят символ i. */
  map: number[];
}

function normalize(source: string): Normalized {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    let ch = raw.toLowerCase();

    if (/\s| /.test(ch)) {
      // Пробелы схлопываются: в DOCX-таблицах ячейки разъезжаются переносами,
      // а модель при извлечении склеивает их одним пробелом.
      if (chars.length > 0) pendingSpace = true;
      continue;
    }

    if ('«»""„"'.includes(ch)) ch = '"';
    else if ('–—−‑'.includes(ch)) ch = '-';
    else if (ch === 'ё') ch = 'е';

    if (pendingSpace) {
      chars.push(' ');
      map.push(i);
      pendingSpace = false;
    }
    chars.push(ch);
    map.push(i);
  }

  return { text: chars.join(''), map };
}

/** Конец подсветки в исходном тексте по последнему нормализованному символу. */
function originalEnd(norm: Normalized, normEndExclusive: number): number {
  const lastIdx = normEndExclusive - 1;
  if (lastIdx < 0) return 0;
  return norm.map[lastIdx] + 1;
}

/**
 * Ищет цитату в тексте. Возвращает null, если не нашлось даже начало —
 * тогда вызывающий обязан сказать оператору, что сверки не произошло.
 */
export function locateQuote(text: string, quote: string | null | undefined): QuoteMatch | null {
  const trimmed = quote?.trim();
  if (!text || !trimmed) return null;

  const exactIdx = text.indexOf(trimmed);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + trimmed.length, kind: 'exact', coverage: 1 };
  }

  const normText = normalize(text);
  const normQuote = normalize(trimmed).text;
  if (!normQuote) return null;

  const normIdx = normText.text.indexOf(normQuote);
  if (normIdx !== -1) {
    return {
      start: normText.map[normIdx],
      end: originalEnd(normText, normIdx + normQuote.length),
      kind: 'normalized',
      coverage: 1,
    };
  }

  // Частичное совпадение: укорачиваем цитату с конца, пока не найдём начало.
  // Ниже 40% и короче 20 символов совпадение перестаёт быть доказательством —
  // случайных «в соответствии с» в документе сколько угодно.
  const minLength = Math.max(20, Math.ceil(normQuote.length * 0.4));
  for (let len = normQuote.length - 1; len >= minLength; len--) {
    const prefix = normQuote.slice(0, len);
    const idx = normText.text.indexOf(prefix);
    if (idx !== -1) {
      return {
        start: normText.map[idx],
        end: originalEnd(normText, idx + prefix.length),
        kind: 'partial',
        coverage: len / normQuote.length,
      };
    }
  }

  return null;
}
