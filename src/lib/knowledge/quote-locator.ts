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

/**
 * Наборы записаны прямо, но набор кавычек уже один раз терял U+201C и U+201D:
 * в редакторе они неотличимы от обычных `"`, а без них цитата из Word не
 * находилась вовсе — Word кавычки загибает, а модель при извлечении отдаёт
 * прямые. Проверка на месте: `scripts/verify-quote-locator.ts`.
 */
const DOUBLE_QUOTES = '«»“”„‟″"';
const SINGLE_QUOTES = "‘’‚‛′'";
const DASHES = '–—−‑‒―';
/**
 * Невидимое, что приезжает из PDF и Word: мягкий перенос, символы нулевой
 * ширины, BOM. Заданы кодами, а не символами: в тексте файла их не видно, и
 * набор молча терялся бы при любой правке — ровно так уже потерялись U+201C
 * и U+201D из набора кавычек выше.
 */
const INVISIBLE_CODES = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/** Ниже этой длины совпадение начала перестаёт быть доказательством. */
const MIN_PARTIAL_CHARS = 20;
/** И ниже этой доли цитаты — тоже. */
const MIN_PARTIAL_SHARE = 0.4;

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
  /**
   * Столь же хорошее совпадение нашлось ещё где-то в документе — подсвечено
   * первое, и это догадка. Оператору про догадку надо сказать: процент
   * совпадения сам по себе читается как доказательство места.
   */
  ambiguous: boolean;
}

/**
 * Нормализованная копия текста + карта обратно в исходные индексы. Карта нужна,
 * чтобы подсветить исходный текст, а не нормализованный.
 */
interface Normalized {
  text: string;
  /** starts[i] — где в исходной строке начинается символ, давший символ i. */
  starts: number[];
  /** ends[i] — где он кончается: у суррогатной пары это +2, а не +1. */
  ends: number[];
}

function normalize(source: string): Normalized {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace = false;
  let at = 0;

  // Обход по кодовым символам, а не по юнитам: иначе суррогатная пара делится
  // пополам и подсветка может оборваться на половине символа.
  for (const cp of source) {
    const from = at;
    const to = at + cp.length;
    at = to;

    // Пробелы схлопываются: в DOCX-таблицах ячейки разъезжаются переносами,
    // а модель при извлечении склеивает их одним пробелом. `\s` покрывает и
    // неразрывный U+00A0, которым Word разделяет число и единицу.
    if (/\s/.test(cp)) {
      if (chars.length > 0) pendingSpace = true;
      continue;
    }
    if (INVISIBLE_CODES.has(cp.codePointAt(0)!)) continue;

    let piece = cp.toLowerCase();
    if (DOUBLE_QUOTES.includes(piece)) piece = '"';
    else if (SINGLE_QUOTES.includes(piece)) piece = "'";
    else if (DASHES.includes(piece)) piece = '-';
    else if (piece === 'ё') piece = 'е';

    if (pendingSpace) {
      // Схлопнутый пробел кончается там же, где начинается следующий символ:
      // совпадение, оборвавшееся на пробеле, не должно утаскивать в подсветку
      // первую букву следующего слова.
      chars.push(' ');
      starts.push(from);
      ends.push(from);
      pendingSpace = false;
    }

    // У части символов toLowerCase даёт больше одного юникодного юнита
    // ('İ' → 'i' + U+0307). Карта ведётся по юнитам — одна запись на каждый
    // выданный символ: иначе она разъезжается с текстом, и подсветка съезжает
    // на всём, что идёт после такого символа.
    for (let k = 0; k < piece.length; k++) {
      chars.push(piece[k]);
      starts.push(from);
      ends.push(to);
    }
  }

  return { text: chars.join(''), starts, ends };
}

/** Конец подсветки в исходном тексте по последнему нормализованному символу. */
function originalEnd(norm: Normalized, normEndExclusive: number): number {
  const lastIdx = normEndExclusive - 1;
  if (lastIdx < 0) return 0;
  return norm.ends[lastIdx];
}

/** Сколько символов цитаты подряд совпадает с текстом, начиная с позиции `at`. */
function agreementLength(text: string, quote: string, at: number): number {
  let n = 0;
  while (n < quote.length && at + n < text.length && text[at + n] === quote[n]) n++;
  return n;
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
    return {
      start: exactIdx,
      end: exactIdx + trimmed.length,
      kind: 'exact',
      coverage: 1,
      ambiguous: text.indexOf(trimmed, exactIdx + 1) !== -1,
    };
  }

  const normText = normalize(text);
  const normQuote = normalize(trimmed).text;
  if (!normQuote) return null;

  const normIdx = normText.text.indexOf(normQuote);
  if (normIdx !== -1) {
    return {
      start: normText.starts[normIdx],
      end: originalEnd(normText, normIdx + normQuote.length),
      kind: 'normalized',
      coverage: 1,
      ambiguous: normText.text.indexOf(normQuote, normIdx + 1) !== -1,
    };
  }

  const minLength = Math.max(MIN_PARTIAL_CHARS, Math.ceil(normQuote.length * MIN_PARTIAL_SHARE));
  if (normQuote.length <= minLength) return null;

  // Начало цитаты может встречаться в документе много раз («В соответствии с…»,
  // шапка таблицы, повторённый заголовок раздела). Берём место, где цитата
  // продолжается дольше всего, и считаем, сколько мест дотянули до того же
  // максимума: если их несколько, подсветка — догадка, и оператор должен это
  // видеть. Перебор по вхождениям начала, а не укорачивание цитаты с конца:
  // выбор места тот же, но за один проход вместо прохода на каждую длину.
  const seed = normQuote.slice(0, minLength);
  let bestPos = -1;
  let bestLen = 0;
  let bestCount = 0;
  for (let from = 0; ; ) {
    const idx = normText.text.indexOf(seed, from);
    if (idx === -1) break;
    const len = agreementLength(normText.text, normQuote, idx);
    if (len > bestLen) {
      bestPos = idx;
      bestLen = len;
      bestCount = 1;
    } else if (len === bestLen) {
      bestCount++;
    }
    from = idx + 1;
  }
  if (bestPos === -1) return null;

  // Хвостовой пробел в подсветку не берём — он ничего не доказывает.
  let matched = bestLen;
  while (matched > 0 && normQuote[matched - 1] === ' ') matched--;
  if (matched < minLength) return null;

  return {
    start: normText.starts[bestPos],
    end: originalEnd(normText, bestPos + matched),
    kind: 'partial',
    coverage: matched / normQuote.length,
    ambiguous: bestCount > 1,
  };
}

/**
 * True iff `quoteA` and `quoteB` occupy overlapping spans of `text` — either
 * direction (one a substring of the other) or a partial shift. Both quotes
 * must actually locate in `text`; an unlocatable quote can't be proven to
 * overlap anything, so it's treated as non-overlapping rather than throwing
 * — same "can't prove it, don't claim it" discipline as `locateQuote` itself.
 *
 * General-purpose extension of `locateQuote`'s own domain, not duplicated
 * business logic: two independent callers need exactly this check —
 * `audited-extraction.ts`'s focused-retry dedup (does a re-extracted unit's
 * quote already overlap an existing unit's quote for the same block) and
 * the oracle-taint auto-retry's targeted per-block resample (does a fresh
 * candidate's quote still overlap whatever originally tripped the check).
 */
export function quoteSpansOverlap(text: string, quoteA: string, quoteB: string): boolean {
  const a = locateQuote(text, quoteA);
  const b = locateQuote(text, quoteB);
  if (a === null || b === null) return false;
  return a.start < b.end && b.start < a.end;
}
