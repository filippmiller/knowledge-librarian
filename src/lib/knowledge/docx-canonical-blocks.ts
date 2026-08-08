import { createHash } from 'node:crypto';
import { DOMParser, onWarningStopParsing, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { SourceBlockLocation } from './applicability/identity-assignment';

/**
 * Canonical DOCX v2 — DOCX -> CanonicalDocument (continuation session, план
 * продолжения Aurora v2, Beads translation-yz9, preflight обязателен раньше
 * этого модуля).
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
 * набор зависимостей, что и внутри mammoth (`jszip` + `@xmldom/xmldom`), но
 * нужен полный контроль над офсетами, которого публичный API mammoth не даёт.
 *
 * Гранулярность блока — один абзац (`w:p`), включая абзацы внутри ячеек
 * таблиц. `sectionPath` — breadcrumb активных заголовков (`w:pStyle` =
 * `HeadingN`/`Title`), НЕ включает позицию в таблице (та живёт отдельно, в
 * `structuralPath`) и НЕ использует строковый sentinel вида `'(root)'` —
 * пустой массив уже однозначно значит «нет активных заголовков».
 *
 * ВСЕ нормализации, применяемые к тексту, ниже по файлу и версионируются
 * `CANONICAL_DOCX_PARSER_VERSION`:
 * - концы строк — нормализует сам `@xmldom/xmldom` при разборе XML
 *   (`normalizeLineEndings`, стандарт XML 1.1 §2.11) ДО того, как текст
 *   попадает в `<w:t>`;
 * - `w:tab` -> `\t`, `w:br`/`w:cr` -> `\n`, `w:noBreakHyphen` -> U+2011,
 *   `w:softHyphen` -> U+00AD — буквальные символы OOXML, не эвристика;
 * - NBSP (U+00A0) внутри `<w:t>` НЕ нормализуется — проходит буквально, как
 *   часть исходного текста;
 * - split runs (несколько `<w:r>` подряд в одном `<w:p>`) склеиваются без
 *   вставки разделителя — так, как их видит человек, читающий документ;
 * - между блоками (абзацами/ячейками) — `BLOCK_SEPARATOR`, ВНЕ диапазона
 *   любого блока;
 * - неизвестное/нетекстовое содержимое (символьные шрифты, формулы OMML,
 *   нераспознанные namespace) заменяется `OBJECT_REPLACEMENT_CHARACTER`, а
 *   не тишиной — иначе соседние run'ы склеились бы в слово, которого нет в
 *   документе; каждая такая замена также попадает в `warnings`.
 */

/** Версия этого модуля-нормализатора. Меняется при ЛЮБОМ изменении того, как
 *  текст извлекается/нормализуется (в т.ч. изменение сегментации на блоки) —
 *  `sourceRevisionHash` включает её, поэтому смена логики парсера сама по
 *  себе меняет производные identity, даже если исходный DOCX не менялся. */
export const CANONICAL_DOCX_PARSER_VERSION = '2.0.0';

/** ECMA-376 Transitional — namespace, который реально пишет Word. */
const W_NS_TRANSITIONAL = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** ISO/IEC 29500 Strict — легальный вариант того же формата: Open XML SDK
 *  нормализует его в Transitional при чтении, распознаём оба. */
const W_NS_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const W_NAMESPACES: ReadonlySet<string> = new Set([W_NS_TRANSITIONAL, W_NS_STRICT]);
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** Unicode OBJECT REPLACEMENT CHARACTER — стандартный маркер "здесь было
 *  инлайновое нетекстовое содержимое", НЕ пустая строка: без маркера соседние
 *  run'ы склеиваются в НОВОЕ слово, которого нет в документе ("не" +
 *  [символ] + "допускается" -> "недопускается"), и это слово потом
 *  резолвится `resolveEvidenceOffsets` как будто оно настоящая цитата
 *  источника. */
const OBJECT_REPLACEMENT_CHARACTER = '￼';

/** Между блоками в `canonicalText` — сам разделитель НЕ входит ни в один
 *  блок (offset-диапазоны блоков в него не попадают). */
const BLOCK_SEPARATOR = '\n\n';

/** Свойства/технические элементы, не несущие текста абзаца — не должны
 *  протекать в `paragraphText` при рекурсии. */
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
]);

export type CanonicalBlockKind = 'HEADING' | 'PARAGRAPH' | 'LIST_ITEM' | 'TABLE_CELL' | 'OTHER';

export interface CanonicalBlock {
  readonly anchor: string;
  readonly kind: CanonicalBlockKind;
  readonly text: string;
  /** Breadcrumb активных заголовков (`w:pStyle` = `HeadingN`/`Title`), НЕ
   *  включает позицию в таблице. Пустой массив = нет активных заголовков —
   *  без строкового sentinel. */
  readonly sectionPath: readonly string[];
  /** Позиционный путь в дереве документа (`body/p[3]`,
   *  `body/tbl[0]/tr[1]/tc[0]/p[0]`) — ВСЕГДА присутствует и стабилен между
   *  прогонами того же DOCX, независимо от заголовков. Прозрачные обёртки
   *  (`w:sdt`, `w:customXml`, `mc:AlternateContent`→`mc:Fallback`) не
   *  создают собственный сегмент пути — абзац внутри содержит тот же
   *  порядковый номер, что был бы у него без обёртки. */
  readonly structuralPath: string;
  readonly blockStart: number;
  readonly blockEnd: number;
}

export type CanonicalizationWarningCode =
  | 'SYMBOL_NOT_DECODED'
  | 'FOREIGN_CONTENT_PLACEHOLDER'
  | 'ALTERNATE_CONTENT_CHOICE_DISCARDED'
  | 'TRACKED_MOVE_SOURCE_DISCARDED'
  | 'MERGED_TABLE_CELL';

/** Неподдержанная/частично поддержанная структура — НЕ исчезает молча:
 *  каждый такой случай записывается сюда с местом и человекочитаемой
 *  причиной, вместо тихой потери или тихого приближения. */
export interface CanonicalizationWarning {
  readonly code: CanonicalizationWarningCode;
  readonly message: string;
  readonly structuralPath: string;
}

export interface CanonicalDocument {
  readonly parserVersion: string;
  /**
   * Идентичность источника для committed review manifest и
   * `sourceBlockAnchor` (`applicability/identity.ts`) — сознательно НЕ hash
   * сырых байт ZIP-архива: пересохранение того же видимого документа в Word
   * может поменять служебные байты (метаданные, порядок записей в ZIP,
   * timestamps) без изменения содержания, и слепой hash архива дал бы ложный
   * сигнал "документ изменился" на committed review manifest. Вместо этого —
   * `sha256(parserVersion + '\u0000' + canonicalText)` (NUL-разделитель — та
   * же причина, что `identity.ts` использует его для `computeSourceBlockAnchor`:
   * без него ("2.0.0", "0abc") и ("2.0.", "00abc") хэшировались бы одинаково):
   * включает `parserVersion`, потому что смена ЛОГИКИ сегментации на блоки
   * (даже без изменения `canonicalText`) обязана давать другие
   * `blockStart`/`blockEnd`-производные identity, а не молча наследовать старые.
   */
  readonly sourceRevisionHash: string;
  readonly canonicalText: string;
  /** `sha256(canonicalText)` без `parserVersion` — отдельно от
   *  `sourceRevisionHash`: "поменялся ли видимый текст" самостоятельно
   *  полезный вопрос, не всегда требующий знания версии парсера. */
  readonly canonicalTextHash: string;
  readonly blocks: readonly CanonicalBlock[];
  readonly warnings: readonly CanonicalizationWarning[];
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isWNamespace(namespaceURI: string | null): boolean {
  return namespaceURI !== null && W_NAMESPACES.has(namespaceURI);
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
 * же выбор, что и в mammoth (`docx/body-reader.js`). Отброшенный `mc:Choice`
 * фиксируется в `warnings` (`ALTERNATE_CONTENT_CHOICE_DISCARDED`) — не
 * теряется молча, даже если для чистого текста обычно не критичен.
 *
 * Любая другая обёртка (`w:sdt`/`w:sdtContent`, `w:customXml`, `w:smartTag`,
 * `w:ins`, `w:moveTo`, неизвестное расширение вендора) — прозрачна: обход
 * идёт в её собственных детей без изменений и БЕЗ собственного сегмента
 * `structuralPath` (счётчики родителя продолжаются как если бы обёртки не
 * было).
 */
function childrenToVisit(
  element: Element,
  warnings: CanonicalizationWarning[],
  structuralPath: string
): Iterable<Element> {
  if (element.namespaceURI === MC_NS && element.localName === 'AlternateContent') {
    const hasChoice = firstChildByNS(element, MC_NS, 'Choice') !== null;
    const fallback = firstChildByNS(element, MC_NS, 'Fallback');
    if (hasChoice) {
      warnings.push({
        code: 'ALTERNATE_CONTENT_CHOICE_DISCARDED',
        message: 'mc:AlternateContent: использован только mc:Fallback, содержимое mc:Choice отброшено',
        structuralPath,
      });
    }
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
 * текста), получает `OBJECT_REPLACEMENT_CHARACTER` вместо тишины, и попадает
 * в `warnings` (`FOREIGN_CONTENT_PLACEHOLDER`). Проверяется по длине `out`
 * до/после рекурсии — не по перечислению всех возможных "пустых" случаев,
 * единая политика на любое неизвестное расширение.
 */
function collectParagraphText(
  element: Element,
  out: string[],
  warnings: CanonicalizationWarning[],
  structuralPath: string
): void {
  if (!isWNamespace(element.namespaceURI)) {
    const before = out.length;
    for (const child of childrenToVisit(element, warnings, structuralPath)) {
      collectParagraphText(child, out, warnings, structuralPath);
    }
    if (out.length === before) {
      out.push(OBJECT_REPLACEMENT_CHARACTER);
      warnings.push({
        code: 'FOREIGN_CONTENT_PLACEHOLDER',
        message: `нераспознанное содержимое в пространстве имён "${element.namespaceURI ?? ''}" (<${element.localName ?? '?'}>) заменено плейсхолдером — исходный текст/графика не извлечены`,
        structuralPath,
      });
    }
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
      warnings.push({
        code: 'SYMBOL_NOT_DECODED',
        message: 'w:sym (символьный шрифт, например Wingdings/Symbol) не декодирован в текст, заменён плейсхолдером',
        structuralPath,
      });
      return;
    case 'moveFrom':
      // Маркер отслеживания правок, не свойство: содержимое дублирует
      // w:moveTo в другом месте документа — Final-представление показывает
      // только пункт назначения перемещения. Не теряется молча — warning.
      warnings.push({
        code: 'TRACKED_MOVE_SOURCE_DISCARDED',
        message: 'w:moveFrom (источник перемещённого фрагмента правки) исключён из canonical text — виден только w:moveTo (Final view)',
        structuralPath,
      });
      return;
    default:
      if (NON_TEXT_LOCAL_NAMES.has(element.localName ?? '')) return;
      for (const child of childrenToVisit(element, warnings, structuralPath)) {
        collectParagraphText(child, out, warnings, structuralPath);
      }
  }
}

function paragraphText(
  p: Element,
  warnings: CanonicalizationWarning[],
  structuralPath: string
): string {
  const out: string[] = [];
  collectParagraphText(p, out, warnings, structuralPath);
  return out.join('');
}

/** Изолированный разбор одного `<w:p>` XML-фрагмента — для юнит-тестов
 *  сборки текста абзаца без накладных расходов на весь DOCX-архив. */
export function extractParagraphText(paragraphXml: string): string {
  return extractParagraphTextWithWarnings(paragraphXml).text;
}

/** Та же изолированная сборка текста абзаца, но с видимостью в warnings —
 *  для тестов SYMBOL_NOT_DECODED/FOREIGN_CONTENT_PLACEHOLDER/
 *  TRACKED_MOVE_SOURCE_DISCARDED/ALTERNATE_CONTENT_CHOICE_DISCARDED без
 *  накладных расходов на весь DOCX-архив. */
export function extractParagraphTextWithWarnings(
  paragraphXml: string
): { readonly text: string; readonly warnings: readonly CanonicalizationWarning[] } {
  const root = parseXmlDocumentElement(paragraphXml, 'extractParagraphTextWithWarnings');
  const warnings: CanonicalizationWarning[] = [];
  const text = paragraphText(root, warnings, 'test');
  return { text, warnings };
}

/**
 * `DOMParser.parseFromString` на `@xmldom/xmldom` бросает `ParseError` (не
 * возвращает документ с `documentElement === null`) для мусорного XML — но
 * БЕЗ кастомного `onError` восстанавливаемые проблемы (например, валидный
 * корень + мусор ПОСЛЕ закрывающего тега) только печатаются в `console.error`
 * и разбор продолжается на частичном дереве — то есть повреждённый
 * `word/document.xml` мог бы тихо отдать НЕПОЛНЫЙ `canonicalText` без единого
 * исключения. `onWarningStopParsing` (экспорт самого `@xmldom/xmldom`)
 * останавливает разбор на ЛЮБОМ уровне — `warning`, не только
 * `error`/`fatalError` — что оправдано именно для `word/document.xml`: у
 * корректно сформированного DOCX парсер не должен печатать вообще ничего,
 * любой репорт — сигнал повреждения источника, который обязан остановить
 * конвейер, а не тихо продолжить на частичных данных.
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

/** `w:pPr/w:numPr` — абзац входит в нумерованный/маркированный список. */
function hasNumPr(p: Element): boolean {
  const pPr = firstChildByLocalName(p, 'pPr');
  if (pPr === null) return false;
  return firstChildByLocalName(pPr, 'numPr') !== null;
}

/** `w:tcPr/w:vMerge` или `w:tcPr/w:gridSpan` — ячейка объединена с
 *  соседними; позиционные индексы cell[N] могут не совпадать с визуальным
 *  layout (не эмулируем объединение, только предупреждаем). */
function tcHasMerge(tc: Element): boolean {
  const tcPr = firstChildByLocalName(tc, 'tcPr');
  if (tcPr === null) return false;
  return firstChildByLocalName(tcPr, 'vMerge') !== null || firstChildByLocalName(tcPr, 'gridSpan') !== null;
}

function classifyBlockKind(
  p: Element,
  headingLevel: number | null,
  insideTableCell: boolean
): CanonicalBlockKind {
  if (insideTableCell) return 'TABLE_CELL';
  if (headingLevel !== null) return 'HEADING';
  if (hasNumPr(p)) return 'LIST_ITEM';
  return 'PARAGRAPH';
}

interface HeadingFrame {
  readonly level: number;
  readonly title: string;
}

interface WalkState {
  readonly headingStack: HeadingFrame[];
}

interface BlockBuilder {
  readonly parts: string[];
  offset: number;
  readonly blocks: CanonicalBlock[];
  readonly warnings: CanonicalizationWarning[];
  anchorCounter: number;
}

interface WalkContext {
  readonly structuralPrefix: string;
  readonly insideTableCell: boolean;
}

/** Счётчики позиции — ОДИН объект на реальную область видимости (тело
 *  документа или ячейка таблицы), передаётся ПО ССЫЛКЕ через прозрачные
 *  обёртки (`w:sdt` и т.п.), поэтому абзац внутри такой обёртки продолжает
 *  ТУ ЖЕ последовательность `p[N]`, что и снаружи — обёртка невидима для
 *  `structuralPath`, как и для текста. */
interface PathCounters {
  p: number;
  tbl: number;
}

function emitBlock(
  builder: BlockBuilder,
  text: string,
  kind: CanonicalBlockKind,
  sectionPath: readonly string[],
  structuralPath: string
): void {
  if (text.length === 0) return;
  const blockStart = builder.offset;
  builder.parts.push(text);
  builder.offset += text.length;
  builder.blocks.push({
    anchor: `b${builder.anchorCounter++}`,
    kind,
    text,
    sectionPath,
    structuralPath,
    blockStart,
    blockEnd: builder.offset,
  });
  builder.parts.push(BLOCK_SEPARATOR);
  builder.offset += BLOCK_SEPARATOR.length;
}

function walkChildren(
  elements: Iterable<Element>,
  state: WalkState,
  ctx: WalkContext,
  counters: PathCounters,
  builder: BlockBuilder
): void {
  for (const child of elements) {
    const localName = isWNamespace(child.namespaceURI) ? child.localName : null;

    if (localName === null) {
      // Не-`w:` обёртка на уровне body/ячейки (`mc:AlternateContent` и
      // т.п.) — та же политика `childrenToVisit`, что и внутри абзаца, та же
      // область видимости счётчиков (обёртка прозрачна для structuralPath).
      walkChildren(
        childrenToVisit(child, builder.warnings, ctx.structuralPrefix),
        state,
        ctx,
        counters,
        builder
      );
      continue;
    }

    if (localName === 'p') {
      const structuralPath = `${ctx.structuralPrefix}/p[${counters.p++}]`;
      const text = paragraphText(child, builder.warnings, structuralPath);
      const level = headingLevelOf(child);

      // Заголовок обязан вытолкнуть устаревшие заголовки своего или более
      // глубокого уровня из стека ДО вычисления собственного sectionPath —
      // иначе новый Heading1 унаследовал бы breadcrumb закрытых разделов,
      // которые ему уже не предки.
      if (level !== null) {
        while (
          state.headingStack.length > 0 &&
          state.headingStack[state.headingStack.length - 1].level >= level
        ) {
          state.headingStack.pop();
        }
      }

      const sectionPath = state.headingStack.map((h) => h.title).filter((t) => t.length > 0);
      const kind = classifyBlockKind(child, level, ctx.insideTableCell);
      emitBlock(builder, text, kind, sectionPath, structuralPath);

      if (level !== null) {
        state.headingStack.push({ level, title: text.trim() });
      }
      continue;
    }

    if (localName === 'tbl') {
      const tablePrefix = `${ctx.structuralPrefix}/tbl[${counters.tbl++}]`;
      const rows = childrenByLocalName(child, 'tr');
      rows.forEach((row, rowIndex) => {
        const cells = childrenByLocalName(row, 'tc');
        cells.forEach((cell, cellIndex) => {
          const cellPrefix = `${tablePrefix}/tr[${rowIndex}]/tc[${cellIndex}]`;
          if (tcHasMerge(cell)) {
            builder.warnings.push({
              code: 'MERGED_TABLE_CELL',
              message: 'ячейка таблицы использует w:vMerge/w:gridSpan — позиция ячейки может не совпадать с визуальным layout',
              structuralPath: cellPrefix,
            });
          }
          const cellCtx: WalkContext = { structuralPrefix: cellPrefix, insideTableCell: true };
          walkChildren(cell.children, state, cellCtx, { p: 0, tbl: 0 }, builder);
        });
      });
      continue;
    }

    if (localName === 'sectPr') continue;

    // Любая другая обёртка в пространстве `w:` (`w:sdt`/`w:sdtContent`,
    // `w:customXml`, `w:ins`, `w:moveTo`, будущее расширение) — прозрачна:
    // абзацы/таблицы внутри неё не должны молча теряться, и не создают
    // собственный сегмент structuralPath (те же счётчики, что у родителя).
    walkChildren(child.children, state, ctx, counters, builder);
  }
}

/**
 * Разбирает DOCX-буфер в `CanonicalDocument`: каноническую строку документа,
 * блоки с офсетами в ней, hash-идентичность источника и warnings по
 * неподдержанным структурам. `SourceBlockLocation` (контракт
 * `applicability/identity-assignment.ts`) получается через
 * `toSourceBlockLocation()` — не тот же тип, что `CanonicalBlock`
 * (`sectionPath` здесь массив, там строка с `'(root)'`-sentinel; `kind`/
 * `structuralPath` `assignIdentity` не нужны).
 */
export async function extractCanonicalDocument(buffer: Buffer): Promise<CanonicalDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXmlFile = zip.file('word/document.xml');
  if (documentXmlFile === null) {
    throw new Error(
      'extractCanonicalDocument: word/document.xml не найден в архиве — это не DOCX или архив повреждён'
    );
  }

  const xml = await documentXmlFile.async('string');
  const root = parseXmlDocumentElement(xml, 'extractCanonicalDocument');
  const body = firstChildByLocalName(root, 'body');
  if (body === null) {
    throw new Error('extractCanonicalDocument: <w:body> не найден в word/document.xml');
  }

  const builder: BlockBuilder = { parts: [], offset: 0, blocks: [], warnings: [], anchorCounter: 0 };
  const state: WalkState = { headingStack: [] };
  walkChildren(
    body.children,
    state,
    { structuralPrefix: 'body', insideTableCell: false },
    { p: 0, tbl: 0 },
    builder
  );

  const canonicalText = builder.parts.join('');

  return {
    parserVersion: CANONICAL_DOCX_PARSER_VERSION,
    sourceRevisionHash: sha256Hex(`${CANONICAL_DOCX_PARSER_VERSION}\u0000${canonicalText}`),
    canonicalText,
    canonicalTextHash: sha256Hex(canonicalText),
    blocks: builder.blocks,
    warnings: builder.warnings,
  };
}

/**
 * Проекция `CanonicalBlock` -> `SourceBlockLocation` (`applicability/
 * identity-assignment.ts`) для скармливания `assignIdentity`.
 * `sectionPath` (массив) склеивается в строку с прежним sentinel `'(root)'`
 * для пустого breadcrumb — `identity.ts` использует её только как
 * человекочитаемые метаданные, не для hash (Step 3, независимое ревью PR
 * #76: структурный дискриминатор `sourceBlockAnchor` — `structuralPath`,
 * который эта проекция теперь переносит БЕЗ изменений, как непрозрачную
 * строку внутри hash — форма не обязана совпадать с человекочитаемым
 * представлением, важна только детерминированность).
 */
export function toSourceBlockLocation(block: CanonicalBlock): SourceBlockLocation {
  return {
    anchor: block.anchor,
    text: block.text,
    sectionPath: block.sectionPath.length > 0 ? block.sectionPath.join(' / ') : '(root)',
    structuralPath: block.structuralPath,
    blockStart: block.blockStart,
    blockEnd: block.blockEnd,
  };
}
