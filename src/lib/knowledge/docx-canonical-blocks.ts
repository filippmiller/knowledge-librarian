import { createHash } from 'node:crypto';
import { DOMParser, onWarningStopParsing, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { SourceBlockLocation } from './applicability/identity-assignment';

/**
 * Canonical DOCX -> blocks-with-offsets (H slice 5b, план §3 PR H, Beads
 * translation-yz9).
 *
 * ЗАЧЕМ НЕ `parseDocument()` (`document-parser.ts`). Та функция идёт через
 * `mammoth.extractRawText()` и затем `normalizeParsedText()` — вторая
 * ВСТАВЛЯЕТ и УБИРАЕТ пробелы (склейка предложений без пробела, разрывы после
 * заглавных букв и т.д.), то есть текст, который видит экстрактор, физически
 * не совпадает посимвольно с исходником. `resolveEvidenceOffsets`
 * (`applicability/identity.ts`) требует буквального `indexOf` цитаты в
 * `block.text` — на нормализованном тексте это требование невыполнимо
 * систематически, не только в редких случаях.
 *
 * ПОЧЕМУ СВОЙ XML-обход, а не внутренние модули mammoth. `mammoth` даёт только
 * `extractRawText`/`convertToHtml` — оба теряют посимвольное соответствие
 * офсетов источнику. Внутренние модули (`mammoth/lib/docx/body-reader.js`
 * и т.д.) не являются публичным контрактом пакета. Здесь используется тот же
 * набор зависимостей, что и внутри mammoth (`jszip` + `@xmldom/xmldom`, уже
 * транзитивные зависимости этого проекта), но нужен полный контроль над
 * офсетами, которого публичный API mammoth не даёт.
 *
 * Гранулярность блока — один абзац (`w:p`), включая абзацы внутри ячеек
 * таблиц. `sectionPath` — breadcrumb активных заголовков (`w:pStyle` =
 * `HeadingN`/`Title`) плюс позиция внутри таблицы, если применимо; при
 * отсутствии заголовков — `'(root)'`.
 */

/** ECMA-376 Transitional — namespace, который реально пишет Word. */
const W_NS_TRANSITIONAL = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** ISO/IEC 29500 Strict — легальный вариант того же формата (независимое
 *  ревью, Codex, находка #1): Open XML SDK нормализует его в Transitional
 *  при чтении, мы обязаны распознавать оба, а не только частый случай. */
const W_NS_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const W_NAMESPACES: ReadonlySet<string> = new Set([W_NS_TRANSITIONAL, W_NS_STRICT]);
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** Unicode OBJECT REPLACEMENT CHARACTER — стандартный маркер "здесь было
 *  инлайновое нетекстовое содержимое" (символьный шрифт `w:sym`, формула
 *  OMML и т.п.), НЕ пустая строка. Независимое ревью (Codex, находка #5)
 *  поймало реальный риск: без маркера соседние run'ы склеиваются в НОВОЕ
 *  слово, которого нет в документе ("не" + [символ] + "допускается" ->
 *  "недопускается") — и это слово потом резолвится `resolveEvidenceOffsets`
 *  как будто оно настоящая цитата источника. */
const OBJECT_REPLACEMENT_CHARACTER = '￼';

function isWNamespace(namespaceURI: string | null): boolean {
  return namespaceURI !== null && W_NAMESPACES.has(namespaceURI);
}

/** Между блоками в `canonicalText` — сам разделитель НЕ входит ни в один
 *  блок (offset-диапазоны блоков в него не попадают). */
const BLOCK_SEPARATOR = '\n\n';

/** Свойства/технические элементы, не несущие текста абзаца — не должны
 *  протекать в `paragraphText` при рекурсии. `moveFrom` — не свойство, а
 *  маркер отслеживания правок: содержимое дублирует `moveTo` в другом месте
 *  документа (независимое ревью, находка #4) — Final-представление документа
 *  показывает только пункт назначения перемещения. */
const NON_TEXT_LOCAL_NAMES = new Set([
  'pPr',
  'rPr',
  'tblPr',
  'tblGrid',
  'trPr',
  'tcPr',
  'bookmarkStart',
  'bookmarkEnd',
  'proofErr',
  'commentRangeStart',
  'commentRangeEnd',
  'commentReference',
  'fldChar',
  'instrText',
  'lastRenderedPageBreak',
  'sectPr',
  'moveFrom',
]);

export interface CanonicalDocxDocument {
  /** sha256 (полный, hex) сырых байт DOCX — идентичность источника для
   *  committed review manifest (план §3 PR H): та же ревизия документа даёт
   *  тот же hash, любая правка байт документа — другой. */
  readonly sourceRevisionHash: string;
  readonly canonicalText: string;
  readonly blocks: readonly SourceBlockLocation[];
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isW(element: Element, localName: string): boolean {
  return isWNamespace(element.namespaceURI) && element.localName === localName;
}

function firstChildByLocalName(element: Element, localName: string): Element | null {
  for (const child of element.children) {
    if (isW(child, localName)) return child;
  }
  return null;
}

function childrenByLocalName(element: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (const child of element.children) {
    if (isW(child, localName)) result.push(child);
  }
  return result;
}

function firstChildByNS(element: Element, namespaceURI: string, localName: string): Element | null {
  for (const child of element.children) {
    if (child.namespaceURI === namespaceURI && child.localName === localName) return child;
  }
  return null;
}

/**
 * Единая политика обхода "неизвестных" обёрток — используется и при сборке
 * текста абзаца (`collectParagraphText`), и при обходе структуры документа
 * (`walkChildren`), чтобы оба обхода теряли/дублировали содержимое ОДИНАКОВО.
 *
 * `mc:AlternateContent` — единственная обёртка со СПЕЦИАЛЬНОЙ политикой: она
 * намеренно содержит НЕСКОЛЬКО альтернативных представлений одного и того же
 * содержимого (`mc:Choice` для конкретных расширений + `mc:Fallback` как
 * гарантированно понятный вариант). Обход ОБЕИХ веток задвоил бы текст — тот
 * же выбор, что и в mammoth (`docx/body-reader.js`: `readChildElements(element
 * .firstOrEmpty("mc:Fallback"))`), не собственная эвристика с нуля.
 *
 * Любая другая обёртка (`w:sdt`/`w:sdtContent`, `w:customXml`, `w:smartTag`,
 * `w:ins`, `w:moveTo`, неизвестное расширение вендора) — прозрачна: обход
 * идёт в её собственных детей без изменений.
 */
function childrenToVisit(element: Element): Iterable<Element> {
  if (element.namespaceURI === MC_NS && element.localName === 'AlternateContent') {
    const fallback = firstChildByNS(element, MC_NS, 'Fallback');
    return fallback === null ? [] : fallback.children;
  }
  return element.children;
}

/**
 * Рекурсивно собирает текст абзаца из его run-ов, включая обёртки
 * (`w:hyperlink`, `w:ins`, `w:sdt`/`w:sdtContent` и т.п.) — они не несут
 * текста сами, но их дети (`w:r`) несут.
 *
 * Иностранное (не-`w:`) поддерево, которое не дало НИ ОДНОГО текстового
 * фрагмента (математика OMML, VML/DrawingML-графика без распознанного
 * текста), получает `OBJECT_REPLACEMENT_CHARACTER` вместо тишины — иначе
 * соседние run'ы склеиваются в слово, которого нет в документе (независимое
 * ревью, Codex, находка #5). Проверяется по длине `out` до/после рекурсии —
 * не по перечислению всех возможных "пустых" случаев, единая политика на
 * любое неизвестное расширение, а не список частных случаев.
 */
function collectParagraphText(element: Element, out: string[]): void {
  if (!isWNamespace(element.namespaceURI)) {
    const before = out.length;
    for (const child of childrenToVisit(element)) collectParagraphText(child, out);
    if (out.length === before) out.push(OBJECT_REPLACEMENT_CHARACTER);
    return;
  }

  switch (element.localName) {
    case 't':
      out.push(element.textContent ?? '');
      return;
    case 'tab':
      out.push('\t');
      return;
    case 'br':
    case 'cr':
      out.push('\n');
      return;
    case 'noBreakHyphen':
      out.push('‑');
      return;
    case 'softHyphen':
      out.push('­');
      return;
    case 'sym':
      out.push(OBJECT_REPLACEMENT_CHARACTER);
      return;
    default:
      if (NON_TEXT_LOCAL_NAMES.has(element.localName ?? '')) return;
      for (const child of childrenToVisit(element)) collectParagraphText(child, out);
  }
}

function paragraphText(p: Element): string {
  const out: string[] = [];
  collectParagraphText(p, out);
  return out.join('');
}

/** Изолированный разбор одного `<w:p>` XML-фрагмента — для юнит-тестов
 *  сборки текста абзаца без накладных расходов на весь DOCX-архив. */
export function extractParagraphText(paragraphXml: string): string {
  const root = parseXmlDocumentElement(paragraphXml, 'extractParagraphText');
  return paragraphText(root);
}

/**
 * `DOMParser.parseFromString` на `@xmldom/xmldom` бросает `ParseError` (не
 * возвращает документ с `documentElement === null`) для мусорного XML — но
 * БЕЗ кастомного `onError` восстанавливаемые проблемы (например, валидный
 * корень + мусор ПОСЛЕ закрывающего тега) только печатаются в `console.error`
 * и разбор продолжается на частичном дереве (независимое ревью, Codex,
 * находка #7) — то есть повреждённый `word/document.xml` мог бы тихо отдать
 * НЕПОЛНЫЙ `canonicalText` без единого исключения. `onWarningStopParsing`
 * (экспорт самого `@xmldom/xmldom`) останавливает разбор на ЛЮБОм уровне —
 * `warning`, не только `error`/`fatalError` — что оправдано именно для
 * `word/document.xml`: у корректно сформированного DOCX парсер не должен
 * печатать вообще ничего, любой репорт — сигнал повреждения источника,
 * который обязан остановить конвейер, а не тихо продолжить на частичных
 * данных, где строится юридически значимый ответ.
 */
function parseXmlDocumentElement(xml: string, caller: string): Element {
  let root: Element | null;
  try {
    root = new DOMParser({ onError: onWarningStopParsing }).parseFromString(xml, 'text/xml')
      .documentElement;
  } catch (cause) {
    throw new Error(
      `${caller}: не удалось разобрать XML: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  if (root === null) {
    throw new Error(`${caller}: не удалось разобрать XML — документ пуст`);
  }
  return root;
}

/** `Heading1`..`Heading9` -> 1..9, `Title` -> 0, иначе — не заголовок. Ищет
 *  ПРОГРАММНЫЙ `w:styleId` (см. `w:pStyle/@w:val`), не отображаемое имя стиля
 *  из `styles.xml` — эти ID стабильны независимо от локали Word. */
function headingLevelOf(p: Element): number | null {
  const pPr = firstChildByLocalName(p, 'pPr');
  if (pPr === null) return null;
  const pStyle = firstChildByLocalName(pPr, 'pStyle');
  if (pStyle === null) return null;
  const styleId =
    pStyle.getAttributeNS(W_NS_TRANSITIONAL, 'val') ?? pStyle.getAttributeNS(W_NS_STRICT, 'val');
  if (styleId === 'Title') return 0;
  const match = /^Heading([1-9])$/.exec(styleId ?? '');
  return match ? Number(match[1]) : null;
}

interface HeadingFrame {
  readonly level: number;
  readonly title: string;
}

interface WalkState {
  readonly headingStack: HeadingFrame[];
  tableCounter: number;
}

interface BlockBuilder {
  readonly parts: string[];
  offset: number;
  readonly blocks: SourceBlockLocation[];
  anchorCounter: number;
}

function sectionPathOf(headingStack: readonly HeadingFrame[], tableContext: readonly string[]): string {
  // Заголовок с whitespace-only текстом даёт title === '' после trim — не
  // должен попадать в breadcrumb как пустой сегмент (независимое ревью,
  // находка #6): иначе контракт "нет заголовков -> '(root)'" нарушается для
  // потомков пустого заголовка (получили бы '' вместо '(root)').
  const parts = [...headingStack.map((h) => h.title), ...tableContext].filter(
    (part) => part.length > 0
  );
  return parts.length > 0 ? parts.join(' / ') : '(root)';
}

function emitParagraphBlock(builder: BlockBuilder, text: string, sectionPath: string): void {
  if (text.length === 0) return;
  const blockStart = builder.offset;
  builder.parts.push(text);
  builder.offset += text.length;
  builder.blocks.push({
    anchor: `b${builder.anchorCounter++}`,
    text,
    sectionPath,
    blockStart,
    blockEnd: builder.offset,
  });
  builder.parts.push(BLOCK_SEPARATOR);
  builder.offset += BLOCK_SEPARATOR.length;
}

function walkChildren(
  elements: Iterable<Element>,
  state: WalkState,
  tableContext: readonly string[],
  builder: BlockBuilder
): void {
  for (const child of elements) {
    const localName = isWNamespace(child.namespaceURI) ? child.localName : null;

    if (localName === null) {
      // Не-`w:` обёртка на уровне body/ячейки (`mc:AlternateContent` и
      // т.п.) — та же политика `childrenToVisit`, что и внутри абзаца, иначе
      // Choice+Fallback задвоили бы содержимое здесь по-другому, чем внутри
      // `collectParagraphText` (независимое ревью, находка #2).
      walkChildren(childrenToVisit(child), state, tableContext, builder);
      continue;
    }

    if (localName === 'p') {
      const text = paragraphText(child);
      const level = headingLevelOf(child);

      // Заголовок обязан вытолкнуть устаревшие заголовки своего или более
      // глубокого уровня из стека ДО вычисления собственного sectionPath —
      // иначе "Раздел C" (Heading1) унаследовал бы breadcrumb закрытых
      // "Раздел A / Раздел A.1", которые ему уже не предки.
      if (level !== null) {
        while (
          state.headingStack.length > 0 &&
          state.headingStack[state.headingStack.length - 1].level >= level
        ) {
          state.headingStack.pop();
        }
      }

      emitParagraphBlock(builder, text, sectionPathOf(state.headingStack, tableContext));

      if (level !== null) {
        state.headingStack.push({ level, title: text.trim() });
      }
      continue;
    }

    if (localName === 'tbl') {
      const tableIndex = state.tableCounter++;
      const rows = childrenByLocalName(child, 'tr');
      rows.forEach((row, rowIndex) => {
        const cells = childrenByLocalName(row, 'tc');
        cells.forEach((cell, cellIndex) => {
          const cellContext = [
            ...tableContext,
            `table[${tableIndex + 1}]/row[${rowIndex + 1}]/cell[${cellIndex + 1}]`,
          ];
          walkChildren(cell.children, state, cellContext, builder);
        });
      });
      continue;
    }

    if (localName === 'sectPr') continue;

    // Любая другая обёртка в пространстве `w:` (`w:sdt`/`w:sdtContent`,
    // `w:customXml`, `w:ins`, `w:moveTo`, будущее расширение) — прозрачна:
    // абзацы/таблицы внутри нее не должны молча теряться (независимое
    // ревью, находка #1). `w:moveFrom` намеренно НЕ сюда — его подтекст на
    // уровне тела документа не встречается (он оборачивает run'ы внутри
    // абзаца, см. `NON_TEXT_LOCAL_NAMES`).
    walkChildren(child.children, state, tableContext, builder);
  }
}

/**
 * Разбирает DOCX-буфер в каноническую строку документа и блоки с офсетами в
 * ней (`SourceBlockLocation` — контракт `applicability/identity-assignment.ts`,
 * PR F). Результат подходит напрямую как вход `assignIdentity` (через
 * `new Map(doc.blocks.map(b => [b.anchor, b]))`) и как `SourceBlock[]` для
 * `extractKnowledgeUnits` (структурное подмножество полей).
 */
export async function extractCanonicalDocxBlocks(buffer: Buffer): Promise<CanonicalDocxDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXmlFile = zip.file('word/document.xml');
  if (documentXmlFile === null) {
    throw new Error(
      'extractCanonicalDocxBlocks: word/document.xml не найден в архиве — это не DOCX или архив повреждён'
    );
  }

  const xml = await documentXmlFile.async('string');
  const root = parseXmlDocumentElement(xml, 'extractCanonicalDocxBlocks');
  const body = firstChildByLocalName(root, 'body');
  if (body === null) {
    throw new Error('extractCanonicalDocxBlocks: <w:body> не найден в word/document.xml');
  }

  const builder: BlockBuilder = { parts: [], offset: 0, blocks: [], anchorCounter: 0 };
  const state: WalkState = { headingStack: [], tableCounter: 0 };
  walkChildren(body.children, state, [], builder);

  return {
    sourceRevisionHash: sha256Hex(buffer),
    canonicalText: builder.parts.join(''),
    blocks: builder.blocks,
  };
}
