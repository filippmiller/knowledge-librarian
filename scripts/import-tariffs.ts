/**
 * Импорт тарифной сетки из подписанных прайс-листов, действующих с 01.01.2026.
 *
 * Зачем. До этой таблицы цены жили текстом в 400+ правилах базы знаний, и бот
 * дважды назвал клиенту цену чужой услуги (docs/bot-audit/06-price-table-and-source-routes.md).
 * Прайс — это таблица; текстом она перестаёт быть таблицей, и подмена цены
 * становится неотличимой от верного ответа.
 *
 * Откуда читаем. Из `Document.rawBytes` продовой базы, а не с диска: там лежат
 * ровно те два docx, которые прислал владелец (сверено по sha256), и импорт
 * воспроизводится на любой машине с `DATABASE_URL`, без файлов в репозитории.
 *
 * Чем читаем. `mammoth.convertToHtml` — она сохраняет разметку таблиц.
 * `extractRawText` расплющивает таблицу в поток слов; именно из-за неё прайс
 * попал в базу знаний кашей, в которой цена оторвана от услуги.
 *
 * Запуск:
 *   railway run npx tsx scripts/import-tariffs.ts           — сухой прогон
 *   railway run npx tsx scripts/import-tariffs.ts --apply   — записать в базу
 */
import { PrismaClient, Prisma, KnowledgeAudience } from '@prisma/client';
import mammoth from 'mammoth';
import type {
  TariffAmountKindKey,
  TariffSectionKey,
  TariffTurnaroundKey,
  TariffUnitKey,
  TranslationDirectionKey,
} from '@/lib/knowledge/tariffs';

const prisma = new PrismaClient();

export const TARIFF_EFFECTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');

/** Обе таблицы-источника размечены в базе как CLIENT_SAFE — это клиентские
 *  прайсы, подписанные генеральным директором (docs/bot-audit/02-price-documents.md §3). */
const IMPORT_AUDIENCE: KnowledgeAudience = 'CLIENT_SAFE';

const IMPORTER = 'scripts/import-tariffs.ts';

const SOURCE_TITLES = {
  translation: 'Прайс на перевод и заверение-010126',
  apostille: 'Прайс клиентский апостиль, истребование и КЛ СПб и МСК 010126',
} as const;

// ---------------------------------------------------------------------------
// Разбор docx в структуру блоков
// ---------------------------------------------------------------------------

interface Cell {
  text: string;
  colspan: number;
}
type Row = Cell[];
type Block = { kind: 'table'; rows: Row[] } | { kind: 'p'; text: string };

function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Плоский список блоков в порядке документа: абзацы и таблицы вперемешку.
 *  Порядок важен — сноски и оговорки стоят под своей таблицей, и привязать их
 *  можно только по соседству. */
function parseBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const blockRe = /<table>([\s\S]*?)<\/table>|<p>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    if (m[1] !== undefined) {
      const rows: Row[] = [];
      const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
      let r: RegExpExecArray | null;
      while ((r = rowRe.exec(m[1])) !== null) {
        const cells: Row = [];
        const cellRe = /<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/g;
        let c: RegExpExecArray | null;
        while ((c = cellRe.exec(r[1])) !== null) {
          const colspan = /colspan="(\d+)"/.exec(c[1] ?? '');
          cells.push({ text: decode(c[2]), colspan: colspan ? Number(colspan[1]) : 1 });
        }
        rows.push(cells);
      }
      blocks.push({ kind: 'table', rows });
    } else {
      const text = decode(m[2] ?? '');
      if (text) blocks.push({ kind: 'p', text });
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Разбор цены
// ---------------------------------------------------------------------------

export interface ParsedPrice {
  amount: number | null;
  amountKind: TariffAmountKindKey;
  percent: number | null;
  percentBase: string | null;
  baseFeeAmount: number | null;
  unit: TariffUnitKey;
}

function toNumber(raw: string): number | null {
  const digits = raw.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  return Number(digits);
}

/** Единица — часть цены, а не оформление. «260» без «за страницу» уже уходило
 *  клиенту как цена за документ. */
function unitOf(suffix: string): TariffUnitKey | null {
  const s = suffix.toLowerCase();
  if (/у\.?\s*с\.?|условн/.test(s)) return 'CONDITIONAL_PAGE';
  if (/отметк/.test(s)) return 'MARK';
  if (/виз/.test(s)) return 'VISA';
  if (/док/.test(s)) return 'DOCUMENT';
  if (/стр/.test(s)) return 'PAGE';
  return null;
}

export function parsePrice(rawText: string): ParsedPrice | null {
  const text = rawText.replace(/[ ]/g, ' ').replace(/\s+/g, ' ').trim();

  // «70% от стоимости 1 у.с.» и «+10% от стоимости» — не цены, а правила
  // расчёта. Сверять их с числом в ответе бота нельзя, поэтому вид числа
  // хранится отдельным признаком.
  const percent = /^(\+)?\s*(\d+(?:[.,]\d+)?)\s*%\s*от\s+(.+)$/i.exec(text);
  if (percent) {
    return {
      amount: null,
      amountKind: percent[1] ? 'PERCENT_SURCHARGE' : 'PERCENT_OF_BASE',
      percent: toNumber(percent[2]),
      percentBase: percent[3].trim(),
      baseFeeAmount: null,
      unit: 'PERCENT',
    };
  }

  // «1000 руб. тариф + 260 руб. / стр.» — разовый тариф нотариуса поверх
  // поштучной цены.
  const composite = /^([\d\s]+)\s*руб\.?\s*тариф\s*\+\s*([\d\s]+)\s*руб\.?\s*\/?\s*(.+)$/i.exec(text);
  if (composite) {
    const unit = unitOf(composite[3]);
    const base = toNumber(composite[1]);
    const amount = toNumber(composite[2]);
    if (unit === null || base === null || amount === null) return null;
    return { amount, amountKind: 'FIXED', percent: null, percentBase: null, baseFeeAmount: base, unit };
  }

  // «от 60 руб. за страницу А4» — нижняя граница.
  const from = /^от\s+([\d\s]+)\s*руб\.?\s*(?:\/|за)?\s*(.+)$/i.exec(text);
  if (from) {
    const unit = unitOf(from[2]);
    const amount = toNumber(from[1]);
    if (unit === null || amount === null) return null;
    return { amount, amountKind: 'FROM', percent: null, percentBase: null, baseFeeAmount: null, unit };
  }

  // «5000 руб./док», «260 руб. / стр.», «150 руб. / док. + НЗ».
  const fixed = /^([\d\s]+)\s*руб\.?\s*(?:\/|за)\s*(.+)$/i.exec(text);
  if (fixed) {
    const unit = unitOf(fixed[2].replace(/\+\s*НЗ\.?$/i, ''));
    const amount = toNumber(fixed[1]);
    if (unit === null || amount === null) return null;
    return { amount, amountKind: 'FIXED', percent: null, percentBase: null, baseFeeAmount: null, unit };
  }

  return null;
}

function looksLikePrice(text: string): boolean {
  return /руб|%/.test(text);
}

// ---------------------------------------------------------------------------
// Строка тарифа
// ---------------------------------------------------------------------------

export interface TariffRow {
  naturalKey: string;
  section: TariffSectionKey;
  sectionTitle: string | null;
  serviceName: string;
  authority: string | null;
  termText: string | null;
  conditions: string | null;
  price: ParsedPrice;
  priceText: string;
  footnote: string | null;
  language: string | null;
  complexityCategory: number | null;
  direction: TranslationDirectionKey | null;
  turnaround: TariffTurnaroundKey | null;
  includesNotary: boolean;
  sourceFile: string;
  documentId: string;
  sortOrder: number;
}

export interface Unparsed {
  source: string;
  where: string;
  text: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Прайс на перевод и заверение
// ---------------------------------------------------------------------------

const TURNAROUND_BY_LABEL: Record<string, TariffTurnaroundKey> = {
  'СТАНДАРТ': 'STANDARD',
  'ЧЕРЕЗ 1 ДЕНЬ': 'IN_1_DAY',
  'НА СЛЕД. ДЕНЬ': 'NEXT_DAY',
  'В ДЕНЬ ПРИЕМА': 'SAME_DAY',
  'ДВА ЧАСА': 'TWO_HOURS',
};

const TURNAROUND_KEY: Record<TariffTurnaroundKey, string> = {
  STANDARD: 'стандарт',
  IN_1_DAY: 'через-1-день',
  NEXT_DAY: 'на-след-день',
  SAME_DAY: 'в-день-приема',
  TWO_HOURS: 'два-часа',
};

/** Порядок услуг заверения в прайсе. Ключи те же, что в
 *  src/lib/knowledge/certification-price.ts — там та же таблица уже разобрана
 *  и отревьюена, и общий ключ позволяет сверить сетку с ней построчно
 *  (scripts/verify-tariffs.ts), а позже — свести две копии в одну. */
const CERTIFICATION_KEYS_IN_DOC_ORDER = [
  'bureau_stamp',
  'notarial_translation',
  'notarial_urgent',
  'notarial_bilingual',
  'notarial_urgent_bilingual',
  'notarial_copy',
  'notarial_copy_urgent',
  'notarial_charter_copy',
  'notarial_identity',
  'stamps_translation',
  'duplicate_copy',
  'marks',
  'visas',
  'editing',
  'proofreading',
  'typing_ru',
  'typing_eu',
  'typing_east',
  'table_layout',
  'unclear_text',
  'layout',
  'scan',
  'photocopy',
] as const;

function isMatrixHeader(rows: Row[]): number | null {
  const first = rows[0]?.[0]?.text ?? '';
  const m = /^КАТЕГОРИЯ\s*(\d)$/i.exec(first);
  return m ? Number(m[1]) : null;
}

function buildTranslationTariffs(
  blocks: Block[],
  sourceFile: string,
  documentId: string,
  unparsed: Unparsed[]
): TariffRow[] {
  const rows: TariffRow[] = [];
  let sortOrder = 0;

  // Оговорки под таблицами. «1 условная страница = 1800 знаков» стоит под
  // таблицами 1 и 2 категории и не повторена под 3-й, но единица цены во всех
  // трёх одна — иначе цена за у.с. уходит клиенту как цена за документ.
  const matrixWideNotes: string[] = [];
  const categoryNotes = new Map<number, string[]>();

  blocks.forEach((block, i) => {
    if (block.kind !== 'p') return;
    const prevTable = [...blocks.slice(0, i)].reverse().find((b) => b.kind === 'table');
    const category = prevTable && prevTable.kind === 'table' ? isMatrixHeader(prevTable.rows) : null;
    if (category === null) return;
    // `\w` в JS — только латиница, кириллицу им не поймать: с `условн\w*` эта
    // проверка молча не срабатывала, и 3 категория осталась без единицы цены.
    if (/условн[а-яё]*\s+страниц|минимальн[а-яё]*\s+объ[её]м/i.test(block.text)) {
      if (!matrixWideNotes.includes(block.text)) matrixWideNotes.push(block.text);
      return;
    }
    const list = categoryNotes.get(category) ?? [];
    list.push(block.text);
    categoryNotes.set(category, list);
  });

  for (const block of blocks) {
    if (block.kind !== 'table') continue;
    const category = isMatrixHeader(block.rows);
    if (category === null) continue;

    const header = block.rows[0];
    const columns = block.rows[1];
    if (!header || !columns) {
      unparsed.push({ source: sourceFile, where: `КАТЕГОРИЯ ${category}`, text: '', reason: 'нет шапки таблицы' });
      continue;
    }

    // Шапка: [КАТЕГОРИЯ N][СРОК ×5], каждый срок накрывает две колонки.
    const terms: { turnaround: TariffTurnaroundKey; label: string; throughput: string | null }[] = [];
    for (const cell of header.slice(1)) {
      const throughput = /\[(.+?)\]/.exec(cell.text);
      const label = cell.text.replace(/\[.*?\]/g, '').trim();
      const turnaround = TURNAROUND_BY_LABEL[label.toUpperCase()];
      if (!turnaround) {
        unparsed.push({ source: sourceFile, where: `КАТЕГОРИЯ ${category}`, text: cell.text, reason: 'неизвестный срок в шапке' });
        continue;
      }
      terms.push({ turnaround, label, throughput: throughput ? throughput[1].trim() : null });
    }

    const columnLabels = columns.map((c) => c.text);
    if (columnLabels.length !== terms.length * 2) {
      unparsed.push({
        source: sourceFile,
        where: `КАТЕГОРИЯ ${category}`,
        text: columnLabels.join(' | '),
        reason: `колонок ${columnLabels.length}, ожидалось ${terms.length * 2}`,
      });
      continue;
    }

    const footnote =
      [...(categoryNotes.get(category) ?? []), ...matrixWideNotes].join(' ').trim() || null;

    for (const row of block.rows.slice(2)) {
      const language = row[0]?.text ?? '';
      // Пустая строка-разделитель между дальним зарубежьем и СНГ.
      if (!language) continue;

      for (let c = 0; c < columnLabels.length; c++) {
        const term = terms[Math.floor(c / 2)];
        const columnLabel = columnLabels[c];
        const raw = row[c + 1]?.text ?? '';
        if (!raw) {
          unparsed.push({
            source: sourceFile,
            where: `КАТЕГОРИЯ ${category} / ${language} / ${term.label} / ${columnLabel}`,
            text: '',
            reason: 'пустая ячейка',
          });
          continue;
        }
        const amount = toNumber(raw);
        if (amount === null) {
          unparsed.push({
            source: sourceFile,
            where: `КАТЕГОРИЯ ${category} / ${language} / ${term.label} / ${columnLabel}`,
            text: raw,
            reason: 'ячейка не число',
          });
          continue;
        }

        // «вкл. НЗ» есть только в 1 категории и означает ту же цену вместе с
        // нотариальным заверением; «С» и «НА» — направление перевода.
        const includesNotary = /нз/i.test(columnLabel);
        const direction: TranslationDirectionKey = /^НА$/i.test(columnLabel) ? 'TO_FOREIGN' : 'FROM_FOREIGN';
        const directionText = direction === 'TO_FOREIGN' ? 'на иностранный язык' : 'с иностранного языка';

        rows.push({
          naturalKey: [
            'translation',
            `cat${category}`,
            language.toLowerCase(),
            TURNAROUND_KEY[term.turnaround],
            direction === 'TO_FOREIGN' ? 'на' : 'с',
            includesNotary ? 'нз1' : 'нз0',
          ].join('|'),
          section: 'TRANSLATION',
          sectionTitle: `КАТЕГОРИЯ ${category}`,
          serviceName:
            `Перевод, ${language}, ${category} категория сложности, ${directionText}, ${term.label}` +
            (includesNotary ? ', включая нотариальное заверение' : ''),
          authority: null,
          termText: term.label,
          conditions: term.throughput ? `Пропускная способность: ${term.throughput}` : null,
          price: {
            amount,
            amountKind: 'FIXED',
            percent: null,
            percentBase: null,
            baseFeeAmount: null,
            unit: 'CONDITIONAL_PAGE',
          },
          priceText: `${raw} руб. / 1 у.с.`,
          footnote,
          language,
          complexityCategory: category,
          direction,
          turnaround: term.turnaround,
          includesNotary,
          sourceFile,
          documentId,
          sortOrder: sortOrder++,
        });
      }
    }
  }

  return rows;
}

function buildCertificationTariffs(
  blocks: Block[],
  sourceFile: string,
  documentId: string,
  unparsed: Unparsed[]
): TariffRow[] {
  const table = blocks.find(
    (b) => b.kind === 'table' && /наименование услуги/i.test(b.rows[0]?.[0]?.text ?? '')
  );
  if (!table || table.kind !== 'table') {
    unparsed.push({ source: sourceFile, where: 'заверение', text: '', reason: 'таблица заверения не найдена' });
    return [];
  }

  // «Стоимость (НДС не облагается)» — оговорка живёт в шапке колонки и обязана
  // уехать вместе с ценой.
  const headerNote = /\((.+?)\)/.exec(table.rows[0]?.[1]?.text ?? '');
  const footnote = headerNote ? `${headerNote[1].trim()}.` : null;

  const dataRows = table.rows.slice(1).filter((r) => (r[0]?.text ?? '').length > 0);
  if (dataRows.length !== CERTIFICATION_KEYS_IN_DOC_ORDER.length) {
    unparsed.push({
      source: sourceFile,
      where: 'заверение',
      text: `строк ${dataRows.length}`,
      reason: `ожидалось ${CERTIFICATION_KEYS_IN_DOC_ORDER.length} — порядок ключей мог сдвинуться`,
    });
    return [];
  }

  const rows: TariffRow[] = [];
  dataRows.forEach((row, i) => {
    const serviceName = row[0]?.text ?? '';
    const priceText = row[1]?.text ?? '';
    const price = parsePrice(priceText);
    if (!price) {
      unparsed.push({ source: sourceFile, where: `заверение / ${serviceName}`, text: priceText, reason: 'цена не разобрана' });
      return;
    }
    rows.push({
      naturalKey: `certification|${CERTIFICATION_KEYS_IN_DOC_ORDER[i]}`,
      section: 'CERTIFICATION',
      sectionTitle: null,
      serviceName,
      authority: null,
      termText: null,
      conditions: null,
      price,
      priceText,
      footnote,
      language: null,
      complexityCategory: null,
      direction: null,
      turnaround: null,
      includesNotary: false,
      sourceFile,
      documentId,
      sortOrder: 1000 + i,
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Прайс апостиль / истребование / КЛ
// ---------------------------------------------------------------------------

const SECTION_BY_HEADER: { test: RegExp; section: TariffSectionKey }[] = [
  { test: /образовательные\s+документы/i, section: 'APOSTILLE_EDUCATION' },
  { test: /апостиль\s+в\s+москве/i, section: 'APOSTILLE_MOSCOW' },
  { test: /консульская\s+легализация/i, section: 'CONSULAR_LEGALIZATION' },
  { test: /^ТПП$/, section: 'CHAMBER_OF_COMMERCE' },
  { test: /срочное\s+истребование/i, section: 'VITAL_RECORDS_URGENT' },
  { test: /истребование\s+документа\s+ЗАГС/i, section: 'VITAL_RECORDS_SPB' },
  { test: /СОН\s+без\s+апостил/i, section: 'CRIMINAL_RECORD' },
  { test: /СОН\s+с\s+апостил/i, section: 'CRIMINAL_RECORD_APOSTILLE' },
  { test: /нострификация/i, section: 'NOSTRIFICATION' },
  { test: /^апостиль$/i, section: 'APOSTILLE_SPB' },
];

/** Пометка «Доставка включена в стоимость» напечатана в той же ячейке, что и
 *  заголовок раздела. Это оговорка к цене, а не часть названия услуги. */
const HEADER_INLINE_NOTE = /\s*Доставка включена в стоимость\.?\s*/i;

/** Разбивает «(...)» с учётом вложенности: «(45 рабочих дней)» и
 *  «(Доверенность ... (при наличии))» — два разных куска, а не один. */
function parenGroups(text: string): { groups: string[]; rest: string } {
  const groups: string[] = [];
  let rest = '';
  let depth = 0;
  let buffer = '';
  for (const ch of text) {
    if (ch === '(') {
      if (depth === 0) buffer = '';
      else buffer += ch;
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
      if (depth === 0) groups.push(buffer.trim());
      else buffer += ch;
    } else if (depth > 0) {
      buffer += ch;
    } else {
      rest += ch;
    }
  }
  return { groups, rest: rest.replace(/\s+/g, ' ').trim() };
}

const TIME_WORD = /дн(ей|я|ь)|недел|месяц|мес\.|р\.\s*д\.|рабоч|сроки/i;

/** Строка вида «3 рабочих дня» — в разделах СОН услуга названа одним сроком,
 *  и всё остальное берётся из заголовка раздела. */
function isBareTerm(text: string): boolean {
  return /^(?:до\s+)?\d+\s*(?:[–\-]\s*\d+\s*)?рабоч/i.test(text);
}

function buildApostilleTariffs(
  blocks: Block[],
  sourceFile: string,
  documentId: string,
  unparsed: Unparsed[]
): TariffRow[] {
  // Общая оговорка документа: сроки и тарифы зависят от инстанций. Она стоит
  // отдельной таблицей в конце и относится ко всем строкам.
  const globalNote =
    blocks.find(
      (b) => b.kind === 'table' && b.rows.length === 1 && /действующие\s+тарифы/i.test(b.rows[0]?.[0]?.text ?? '')
    ) ?? null;
  const globalFootnote =
    globalNote && globalNote.kind === 'table' ? (globalNote.rows[0]?.[0]?.text ?? null) : null;

  interface Draft extends Omit<TariffRow, 'footnote'> {
    sectionKey: TariffSectionKey;
  }
  const drafts: Draft[] = [];
  const sectionFootnotes = new Map<TariffSectionKey, string[]>();
  const seen = new Set<string>();
  let sortOrder = 2000;

  let section: TariffSectionKey | null = null;
  let sectionTitle: string | null = null;

  for (const block of blocks) {
    if (block.kind !== 'table') continue;
    // Шапка документа и общая оговорка — не данные.
    if (block.rows.length <= 2 && !block.rows.some((r) => r.some((c) => looksLikePrice(c.text)))) continue;

    for (const row of block.rows) {
      const cells = row.map((c) => c.text).filter((t) => t.length > 0);
      if (cells.length === 0) continue;
      const joined = cells.join(' ');

      // Шапка колонок.
      if (/^услуга$/i.test(cells[0]) || (cells.length === 2 && /^стоимость$/i.test(cells[1]))) continue;

      // Сноска раздела.
      if (joined.startsWith('*')) {
        if (section) {
          const list = sectionFootnotes.get(section) ?? [];
          list.push(joined.replace(/^\*\s*/, ''));
          sectionFootnotes.set(section, list);
        } else {
          unparsed.push({ source: sourceFile, where: 'сноска', text: joined, reason: 'сноска вне раздела' });
        }
        continue;
      }

      const priceCell = cells[cells.length - 1];
      const isDataRow = cells.length >= 2 && looksLikePrice(priceCell);

      if (!isDataRow) {
        // Заголовок раздела. Номер («1.», «2.») печатается отдельной ячейкой.
        const titleCells = cells.filter((t) => !/^\d+\.?$/.test(t));
        const rawTitle = titleCells[0] ?? '';
        const match = SECTION_BY_HEADER.find((s) => s.test.test(rawTitle));
        if (!match) {
          unparsed.push({ source: sourceFile, where: 'заголовок', text: joined, reason: 'раздел не опознан' });
          continue;
        }
        section = match.section;
        sectionTitle = rawTitle.replace(HEADER_INLINE_NOTE, ' ').replace(/\s+/g, ' ').trim();

        const notes: string[] = [];
        if (HEADER_INLINE_NOTE.test(rawTitle)) notes.push('Доставка включена в стоимость.');
        // Остальные ячейки заголовка — примечания к разделу («Если справка
        // заказана до 11:00…»).
        notes.push(...titleCells.slice(1));
        if (notes.length) {
          const list = sectionFootnotes.get(section) ?? [];
          for (const n of notes) if (!list.includes(n)) list.push(n);
          sectionFootnotes.set(section, list);
        }
        continue;
      }

      if (!section) {
        unparsed.push({ source: sourceFile, where: 'строка', text: joined, reason: 'строка вне раздела' });
        continue;
      }

      const nameCell = cells.slice(0, -1).filter((t) => !/^\d+\.?$/.test(t)).join(' ').trim();
      if (!nameCell) {
        unparsed.push({ source: sourceFile, where: section, text: joined, reason: 'нет названия услуги' });
        continue;
      }
      const price = parsePrice(priceCell);
      if (!price) {
        unparsed.push({ source: sourceFile, where: `${section} / ${nameCell}`, text: priceCell, reason: 'цена не разобрана' });
        continue;
      }

      const { groups, rest } = parenGroups(nameCell);
      const termGroups = groups.filter((g) => TIME_WORD.test(g));
      const conditionGroups = groups.filter((g) => !TIME_WORD.test(g));
      const bare = isBareTerm(nameCell);

      const termText = bare ? nameCell : (termGroups[0] ?? null);
      // Орган стоит до первой скобки. «Стандартный срок» и повтор заголовка
      // раздела органом не являются — это часть названия услуги.
      const prefix = nameCell.split('(')[0].trim();
      const authority =
        bare ||
        !prefix ||
        /^стандартный срок$/i.test(prefix) ||
        (sectionTitle !== null && prefix.toLowerCase() === sectionTitle.toLowerCase())
          ? null
          : prefix;
      const leftover = rest.replace(prefix, '').replace(/\s+/g, ' ').trim();
      const conditions = [...conditionGroups, leftover].filter(Boolean).join('; ') || null;

      const naturalKey = `${section.toLowerCase()}|${nameCell.toLowerCase().replace(/\s+/g, ' ')}`;
      if (seen.has(naturalKey)) {
        unparsed.push({ source: sourceFile, where: section, text: nameCell, reason: 'повтор ключа в документе' });
        continue;
      }
      seen.add(naturalKey);

      drafts.push({
        naturalKey,
        sectionKey: section,
        section,
        sectionTitle,
        serviceName: bare && sectionTitle ? `${sectionTitle} — ${nameCell}` : nameCell,
        authority,
        termText,
        conditions,
        price,
        priceText: priceCell,
        language: null,
        complexityCategory: null,
        direction: null,
        turnaround: null,
        includesNotary: false,
        sourceFile,
        documentId,
        sortOrder: sortOrder++,
      });
    }
  }

  // Сноски печатаются ПОД строками, к которым относятся, поэтому привязываются
  // вторым проходом.
  return drafts.map(({ sectionKey, ...draft }) => ({
    ...draft,
    footnote:
      [...(sectionFootnotes.get(sectionKey) ?? []), globalFootnote]
        .filter((x): x is string => Boolean(x))
        .join(' ')
        .trim() || null,
  }));
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

export interface BuildResult {
  rows: TariffRow[];
  unparsed: Unparsed[];
}

export async function buildTariffs(client: PrismaClient = prisma): Promise<BuildResult> {
  const unparsed: Unparsed[] = [];
  const rows: TariffRow[] = [];

  for (const [kind, title] of Object.entries(SOURCE_TITLES) as [keyof typeof SOURCE_TITLES, string][]) {
    const doc = await client.document.findFirst({
      where: { title },
      select: { id: true, filename: true, rawBytes: true },
    });
    if (!doc?.rawBytes) {
      unparsed.push({ source: title, where: 'документ', text: '', reason: 'документ или его rawBytes не найдены в базе' });
      continue;
    }
    const html = (await mammoth.convertToHtml({ buffer: Buffer.from(doc.rawBytes) })).value;
    const blocks = parseBlocks(html);

    if (kind === 'translation') {
      rows.push(...buildTranslationTariffs(blocks, doc.filename, doc.id, unparsed));
      rows.push(...buildCertificationTariffs(blocks, doc.filename, doc.id, unparsed));
    } else {
      rows.push(...buildApostilleTariffs(blocks, doc.filename, doc.id, unparsed));
    }
  }

  const keys = new Set<string>();
  for (const r of rows) {
    if (keys.has(r.naturalKey)) {
      unparsed.push({ source: r.sourceFile, where: r.section, text: r.naturalKey, reason: 'дубликат naturalKey' });
    }
    keys.add(r.naturalKey);
  }

  return { rows, unparsed };
}

function toCreateInput(r: TariffRow): Prisma.TariffUncheckedCreateInput {
  return {
    naturalKey: r.naturalKey,
    section: r.section,
    sectionTitle: r.sectionTitle,
    serviceName: r.serviceName,
    authority: r.authority,
    termText: r.termText,
    conditions: r.conditions,
    amount: r.price.amount,
    amountKind: r.price.amountKind,
    percent: r.price.percent,
    percentBase: r.price.percentBase,
    baseFeeAmount: r.price.baseFeeAmount,
    unit: r.price.unit,
    currency: 'RUB',
    priceText: r.priceText,
    effectiveFrom: TARIFF_EFFECTIVE_FROM,
    effectiveTo: null,
    audience: IMPORT_AUDIENCE,
    footnote: r.footnote,
    language: r.language,
    complexityCategory: r.complexityCategory,
    direction: r.direction,
    turnaround: r.turnaround,
    includesNotary: r.includesNotary,
    sourceFile: r.sourceFile,
    documentId: r.documentId,
    sortOrder: r.sortOrder,
    isActive: true,
    updatedBy: IMPORTER,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows, unparsed } = await buildTariffs();

  const existing = await prisma.tariff.findMany({ select: { naturalKey: true } });
  const existingKeys = new Set(existing.map((t) => t.naturalKey));
  const importedKeys = new Set(rows.map((r) => r.naturalKey));
  const stale = existing.filter((t) => !importedKeys.has(t.naturalKey));

  const bySection = new Map<string, { total: number; created: number; updated: number }>();
  for (const r of rows) {
    const s = bySection.get(r.section) ?? { total: 0, created: 0, updated: 0 };
    s.total++;
    if (existingKeys.has(r.naturalKey)) s.updated++;
    else s.created++;
    bySection.set(r.section, s);
  }

  console.log(apply ? '=== ИМПОРТ ТАРИФОВ (--apply) ===' : '=== СУХОЙ ПРОГОН (без --apply ничего не пишется) ===');
  console.log(`Действуют с: ${TARIFF_EFFECTIVE_FROM.toISOString().slice(0, 10)}   контур: ${IMPORT_AUDIENCE}`);
  console.log('');
  console.log('раздел'.padEnd(28) + 'всего'.padStart(7) + 'новых'.padStart(8) + 'обновлений'.padStart(12));
  for (const [sec, s] of [...bySection.entries()].sort()) {
    console.log(sec.padEnd(28) + String(s.total).padStart(7) + String(s.created).padStart(8) + String(s.updated).padStart(12));
  }
  console.log('-'.repeat(55));
  console.log('ИТОГО'.padEnd(28) + String(rows.length).padStart(7));
  console.log('');

  if (stale.length) {
    console.log(`Строк в базе, которых нет в документах: ${stale.length}${apply ? ' — будут помечены неактивными' : ''}`);
    for (const t of stale.slice(0, 20)) console.log(`  ${t.naturalKey}`);
    console.log('');
  }

  if (unparsed.length) {
    console.log(`НЕ РАЗОБРАНО: ${unparsed.length}`);
    for (const u of unparsed) console.log(`  [${u.source}] ${u.where} :: "${u.text}" — ${u.reason}`);
    console.log('');
  } else {
    console.log('Не разобранных строк нет.');
    console.log('');
  }

  if (!apply) {
    console.log('Запустите с --apply, чтобы записать.');
    return;
  }

  let written = 0;
  for (const r of rows) {
    const data = toCreateInput(r);
    const { naturalKey, ...update } = data;
    await prisma.tariff.upsert({ where: { naturalKey }, create: data, update });
    written++;
    if (written % 200 === 0) console.log(`  записано ${written}/${rows.length}`);
  }
  if (stale.length) {
    await prisma.tariff.updateMany({
      where: { naturalKey: { in: stale.map((t) => t.naturalKey) } },
      data: { isActive: false, updatedBy: `${IMPORTER} (нет в документе)` },
    });
  }
  console.log(`Записано строк: ${written}. Помечено неактивными: ${stale.length}.`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('FAILED', e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
