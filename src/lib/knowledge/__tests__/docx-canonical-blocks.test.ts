import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCX_PARSER_VERSION,
  extractCanonicalDocument,
  extractParagraphText,
  extractParagraphTextWithWarnings,
  toSourceBlockLocation,
} from '../docx-canonical-blocks';
import { buildDocxBuffer, standaloneParagraphXml } from './docx-fixture-helpers';
import { computeSourceBlockAnchor } from '../applicability/identity';

/**
 * Canonical DOCX v2 (продолжение сессии Aurora v2, Beads translation-yz9).
 * Заменяет `parseDocument()` (`document-parser.ts`) для целей извлечения —
 * та функция нормализует пробелы и уничтожает соответствие офсетов, здесь
 * это КРИТИЧЕСКИЙ инвариант (`resolveEvidenceOffsets`,
 * `applicability/identity.ts`, требует находить цитату буквальным `indexOf`).
 *
 * Синтетические фикстуры (не настоящий acceptance pack — тот доступен только
 * `src/lib/eval/__tests__/`, см. правила изоляции oracle §0.3).
 */

describe('extractParagraphText — сборка текста абзаца из run-ов', () => {
  it('склеивает несколько run-ов подряд без вставки разделителя (split runs)', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Термины. </w:t></w:r>' +
        '<w:r><w:t>Глагол «чесать» обозначает действие.</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe(
      'Термины. Глагол «чесать» обозначает действие.'
    );
  });

  it('w:tab -> символ табуляции', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>До</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>После</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('До\tПосле');
  });

  it('w:br без типа (или textWrapping) -> перевод строки', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>Строка 1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Строка 2</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('Строка 1\nСтрока 2');
  });

  it('w:cr -> перевод строки, как и w:br', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>A</w:t></w:r><w:r><w:cr/></w:r><w:r><w:t>B</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('A\nB');
  });

  it('w:noBreakHyphen -> U+2011 (неразрывный дефис)', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>кто</w:t></w:r><w:r><w:noBreakHyphen/></w:r><w:r><w:t>то</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('кто‑то');
  });

  it('w:softHyphen -> U+00AD (мягкий перенос)', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>сло</w:t></w:r><w:r><w:softHyphen/></w:r><w:r><w:t>во</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('сло­во');
  });

  it('NBSP внутри w:t проходит буквально, без нормализации', () => {
    const xml = standaloneParagraphXml('<w:r><w:t>10 секунд</w:t></w:r>');
    expect(extractParagraphText(xml)).toBe('10 секунд');
  });

  it('xml:space="preserve" — ведущие/хвостовые пробелы run-а не обрезаются', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t xml:space="preserve">Раз. </w:t></w:r><w:r><w:t xml:space="preserve"> Два</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('Раз.  Два');
  });

  it('w:pPr/w:rPr не протекают в текст', () => {
    const xml = standaloneParagraphXml(
      '<w:pPr><w:spacing w:after="20"/><w:jc w:val="center"/></w:pPr>' +
        '<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Заголовок</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('Заголовок');
  });

  it('w:hyperlink — текст вложенных run-ов извлекается', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>См. </w:t></w:r>' +
        '<w:hyperlink r:id="rId1"><w:r><w:t>ссылку</w:t></w:r></w:hyperlink>'
    );
    expect(extractParagraphText(xml)).toBe('См. ссылку');
  });
});

describe('extractParagraphTextWithWarnings — неподдержанные структуры не исчезают молча', () => {
  it('w:sym -> OBJECT REPLACEMENT CHARACTER + SYMBOL_NOT_DECODED warning (не создаёт ложное слово)', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>не</w:t></w:r>' +
        '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>' +
        '<w:r><w:t>допускается</w:t></w:r>'
    );
    const { text, warnings } = extractParagraphTextWithWarnings(xml);
    expect(text).not.toBe('недопускается');
    expect(text).toBe('не￼допускается');
    expect(warnings).toEqual([expect.objectContaining({ code: 'SYMBOL_NOT_DECODED' })]);
  });

  it('нераспознанное иностранное поддерево (OMML-формула) -> плейсхолдер + FOREIGN_CONTENT_PLACEHOLDER warning', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>до</w:t></w:r>' +
        '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
        '<m:r><m:t>x+1</m:t></m:r>' +
        '</m:oMath>' +
        '<w:r><w:t>дней</w:t></w:r>'
    );
    const { text, warnings } = extractParagraphTextWithWarnings(xml);
    expect(text).not.toBe('додней');
    expect(text).toBe('до￼дней');
    expect(warnings).toEqual([expect.objectContaining({ code: 'FOREIGN_CONTENT_PLACEHOLDER' })]);
  });

  it('mc:AlternateContent ВНУТРИ абзаца — только mc:Fallback + ALTERNATE_CONTENT_CHOICE_DISCARDED warning', () => {
    const xml = standaloneParagraphXml(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="w14"><w:r><w:t>CHOICE_TEXT</w:t></w:r></mc:Choice>' +
        '<mc:Fallback><w:r><w:t>FALLBACK_TEXT</w:t></w:r></mc:Fallback>' +
        '</mc:AlternateContent>'
    );
    const { text, warnings } = extractParagraphTextWithWarnings(xml);
    expect(text).toBe('FALLBACK_TEXT');
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'ALTERNATE_CONTENT_CHOICE_DISCARDED' }),
    ]);
  });

  it('w:moveFrom не дублирует перемещённый текст + TRACKED_MOVE_SOURCE_DISCARDED warning', () => {
    const xml = standaloneParagraphXml(
      '<w:moveFrom><w:r><w:t>MOVED</w:t></w:r></w:moveFrom>' +
        '<w:moveTo><w:r><w:t>MOVED</w:t></w:r></w:moveTo>'
    );
    const { text, warnings } = extractParagraphTextWithWarnings(xml);
    expect(text).toBe('MOVED');
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'TRACKED_MOVE_SOURCE_DISCARDED' }),
    ]);
  });

  it('обычный текст без экзотики — пустой список warnings', () => {
    const xml = standaloneParagraphXml('<w:r><w:t>Обычный текст.</w:t></w:r>');
    expect(extractParagraphTextWithWarnings(xml).warnings).toEqual([]);
  });
});

describe('extractCanonicalDocument — контракт CanonicalDocument', () => {
  it('parserVersion присутствует и совпадает с экспортированной константой', async () => {
    const buffer = await buildDocxBuffer('<w:p><w:r><w:t>X.</w:t></w:r></w:p>');
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.parserVersion).toBe(CANONICAL_DOCX_PARSER_VERSION);
  });

  it('каждый непустой абзац -> один блок; block.text === canonicalText.slice(blockStart, blockEnd)', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Первый абзац.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Второй абзац.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);

    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].text).toBe('Первый абзац.');
    expect(doc.blocks[1].text).toBe('Второй абзац.');
    for (const block of doc.blocks) {
      expect(doc.canonicalText.slice(block.blockStart, block.blockEnd)).toBe(block.text);
    }
  });

  it('инвариант офсетов: 0 <= blockStart <= blockEnd <= canonicalText.length для каждого блока', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>А.</w:t></w:r></w:p>' + '<w:p><w:r><w:t>Б.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    for (const block of doc.blocks) {
      expect(block.blockStart).toBeGreaterThanOrEqual(0);
      expect(block.blockEnd).toBeGreaterThanOrEqual(block.blockStart);
      expect(block.blockEnd).toBeLessThanOrEqual(doc.canonicalText.length);
    }
  });

  it('блоки идут в порядке документа и не перекрываются', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Первый.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Второй.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Третий.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    for (let i = 1; i < doc.blocks.length; i++) {
      expect(doc.blocks[i].blockStart).toBeGreaterThanOrEqual(doc.blocks[i - 1].blockEnd);
    }
  });

  it('пустой абзац (без текста) не создаёт блок', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Текст.</w:t></w:r></w:p>' + '<w:p><w:pPr/></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks).toHaveLength(1);
  });

  it('анкеры уникальны, и полный документ воспроизводится между двумя прогонами одного буфера', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>А.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Б.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>В.</w:t></w:r></w:p>'
    );
    const run1 = await extractCanonicalDocument(buffer);
    const run2 = await extractCanonicalDocument(buffer);

    const anchors = run1.blocks.map((b) => b.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(run2).toEqual(run1);
  });

  it('повторяющиеся ОДИНАКОВЫЕ абзацы получают РАЗНЫЕ anchor/structuralPath — не считается ошибкой', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Повтор.</w:t></w:r></w:p>' + '<w:p><w:r><w:t>Повтор.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].text).toBe(doc.blocks[1].text);
    expect(doc.blocks[0].anchor).not.toBe(doc.blocks[1].anchor);
    expect(doc.blocks[0].structuralPath).not.toBe(doc.blocks[1].structuralPath);
  });

  it('canonicalTextHash — sha256 canonicalText, стабилен для того же текста и меняется при правке', async () => {
    const bufferA = await buildDocxBuffer('<w:p><w:r><w:t>А.</w:t></w:r></w:p>');
    const bufferB = await buildDocxBuffer('<w:p><w:r><w:t>Б.</w:t></w:r></w:p>');

    const docA1 = await extractCanonicalDocument(bufferA);
    const docA2 = await extractCanonicalDocument(bufferA);
    const docB = await extractCanonicalDocument(bufferB);

    expect(docA2.canonicalTextHash).toBe(docA1.canonicalTextHash);
    expect(docB.canonicalTextHash).not.toBe(docA1.canonicalTextHash);
    expect(docA1.canonicalTextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sourceRevisionHash стабилен для того же текста и меняется при правке содержимого', async () => {
    const bufferA = await buildDocxBuffer('<w:p><w:r><w:t>А.</w:t></w:r></w:p>');
    const bufferB = await buildDocxBuffer('<w:p><w:r><w:t>Б.</w:t></w:r></w:p>');

    const docA1 = await extractCanonicalDocument(bufferA);
    const docA2 = await extractCanonicalDocument(bufferA);
    const docB = await extractCanonicalDocument(bufferB);

    expect(docA2.sourceRevisionHash).toBe(docA1.sourceRevisionHash);
    expect(docB.sourceRevisionHash).not.toBe(docA1.sourceRevisionHash);
  });

  it('sourceRevisionHash НЕ зависит от сырых байт ZIP-архива — только от canonicalText/parserVersion (главный инвариант этой сессии: пересохранение документа без изменения видимого содержания не должно менять revision)', async () => {
    // Тот же видимый текст, но два РАЗНЫХ по байтам DOCX-архива: разные
    // произвольные "служебные" XML-атрибуты (эмулируют то, что реально
    // меняется при пересохранении в Word — rsid/timestamps и т.п.), которые
    // не влияют на canonicalText вообще.
    const bufferWithRsid1 = await buildDocxBuffer(
      '<w:p w:rsidR="00AA1111"><w:r><w:t>Тот же текст.</w:t></w:r></w:p>'
    );
    const bufferWithRsid2 = await buildDocxBuffer(
      '<w:p w:rsidR="00BB2222"><w:r><w:t>Тот же текст.</w:t></w:r></w:p>'
    );

    expect(bufferWithRsid1.equals(bufferWithRsid2)).toBe(false);

    const doc1 = await extractCanonicalDocument(bufferWithRsid1);
    const doc2 = await extractCanonicalDocument(bufferWithRsid2);

    expect(doc1.canonicalText).toBe(doc2.canonicalText);
    expect(doc1.sourceRevisionHash).toBe(doc2.sourceRevisionHash);
  });

  it('повторяющаяся фраза в РАЗНЫХ блоках — каждый блок содержит её ровно один раз (без утечки между блоками)', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Помощник обязан надеть чистые перчатки.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Хранить чистые перчатки отдельно.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks).toHaveLength(2);
    for (const block of doc.blocks) {
      const first = block.text.indexOf('чистые перчатки');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(block.text.indexOf('чистые перчатки', first + 1)).toBe(-1);
    }
  });

  it('таблица: каждая ячейка -> отдельный блок, kind=TABLE_CELL, structuralPath различает строку/столбец, sectionPath пуст (нет заголовков)', async () => {
    const buffer = await buildDocxBuffer(
      '<w:tbl><w:tr>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 1,1</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 1,2</w:t></w:r></w:p></w:tc>' +
        '</w:tr><w:tr>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 2,1</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 2,2</w:t></w:r></w:p></w:tc>' +
        '</w:tr></w:tbl>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks).toHaveLength(4);
    expect(doc.blocks.map((b) => b.text)).toEqual([
      'Ячейка 1,1',
      'Ячейка 1,2',
      'Ячейка 2,1',
      'Ячейка 2,2',
    ]);
    expect(doc.blocks.every((b) => b.kind === 'TABLE_CELL')).toBe(true);
    expect(doc.blocks.every((b) => b.sectionPath.length === 0)).toBe(true);
    const paths = doc.blocks.map((b) => b.structuralPath);
    expect(new Set(paths).size).toBe(4);
    expect(paths[0]).toContain('tr[0]');
    expect(paths[0]).toContain('tc[0]');
    expect(paths[1]).toContain('tc[1]');
    expect(paths[2]).toContain('tr[1]');
  });

  it('w:vMerge/w:gridSpan на ячейке -> MERGED_TABLE_CELL warning, ячейка всё равно не теряется', async () => {
    const buffer = await buildDocxBuffer(
      '<w:tbl><w:tr>' +
        '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>Merged</w:t></w:r></w:p></w:tc>' +
        '</w:tr></w:tbl>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Merged']);
    expect(doc.warnings).toEqual([expect.objectContaining({ code: 'MERGED_TABLE_CELL' })]);
  });

  it('заголовки (w:pStyle HeadingN): kind=HEADING, sectionPath — breadcrumb-МАССИВ для последующих PARAGRAPH-блоков', async () => {
    const heading = (level: number, text: string) =>
      `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

    const buffer = await buildDocxBuffer(
      heading(1, 'Раздел A') +
        para('Под A.') +
        heading(2, 'Раздел A.1') +
        para('Под A.1.') +
        heading(1, 'Раздел C') +
        para('Под C.')
    );
    const doc = await extractCanonicalDocument(buffer);

    const byText = new Map(doc.blocks.map((b) => [b.text, b]));
    expect(byText.get('Раздел A')?.kind).toBe('HEADING');
    expect(byText.get('Раздел A')?.sectionPath).toEqual([]);
    expect(byText.get('Под A.')?.kind).toBe('PARAGRAPH');
    expect(byText.get('Под A.')?.sectionPath).toEqual(['Раздел A']);
    expect(byText.get('Раздел A.1')?.sectionPath).toEqual(['Раздел A']);
    expect(byText.get('Под A.1.')?.sectionPath).toEqual(['Раздел A', 'Раздел A.1']);
    // Новый Heading1 обязан вытолкнуть Heading2 из стека, а не накапливаться.
    expect(byText.get('Раздел C')?.sectionPath).toEqual([]);
    expect(byText.get('Под C.')?.sectionPath).toEqual(['Раздел C']);
  });

  it('пустой (whitespace-only) заголовок не ломает sectionPath потомков в непустой массив-с-пустой-строкой', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Потомок под пустым заголовком</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    const child = doc.blocks.find((b) => b.text === 'Потомок под пустым заголовком');
    expect(child?.sectionPath).toEqual([]);
  });

  it('элемент списка (w:numPr): kind=LIST_ITEM, буквальный текст без синтезированного маркера нумерации', async () => {
    const listItem = (text: string) =>
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' +
      `<w:r><w:t>${text}</w:t></w:r></w:p>`;
    const buffer = await buildDocxBuffer(listItem('Первый пункт') + listItem('Второй пункт'));

    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Первый пункт', 'Второй пункт']);
    expect(doc.blocks.every((b) => b.kind === 'LIST_ITEM')).toBe(true);
  });

  it('kind=TABLE_CELL побеждает даже если абзац внутри ячейки сам является заголовком/списком', async () => {
    const buffer = await buildDocxBuffer(
      '<w:tbl><w:tr><w:tc>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Заголовок в ячейке</w:t></w:r></w:p>' +
        '</w:tc></w:tr></w:tbl>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks[0].kind).toBe('TABLE_CELL');
  });

  it('обычный абзац без списка/заголовка/таблицы -> kind=PARAGRAPH', async () => {
    const buffer = await buildDocxBuffer('<w:p><w:r><w:t>Обычный абзац.</w:t></w:r></w:p>');
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks[0].kind).toBe('PARAGRAPH');
  });

  it('бросает понятную ошибку, если в архиве нет word/document.xml', async () => {
    const JSZipCtor = (await import('jszip')).default;
    const zip = new JSZipCtor();
    zip.file('not-a-docx.txt', 'hello');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(extractCanonicalDocument(buffer)).rejects.toThrow(/document\.xml/);
  });

  it('бросает понятную (доменную) ошибку на «мусорном» XML, а не сырой ParseError', async () => {
    const JSZipCtor = (await import('jszip')).default;
    const zip = new JSZipCtor();
    zip.file('word/document.xml', '%%%NOTXML%%%');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(extractCanonicalDocument(buffer)).rejects.toThrow(/extractCanonicalDocument/);
  });

  it('валидный корень + мусор ПОСЛЕ закрывающего тега — доменная ошибка, не тихий partial-разбор', async () => {
    const documentXml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>A</w:t></w:r></w:p></w:body>' +
      '</w:document>JUNK_AFTER_ROOT';
    const JSZipCtor = (await import('jszip')).default;
    const zip = new JSZipCtor();
    zip.file('word/document.xml', documentXml);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(extractCanonicalDocument(buffer)).rejects.toThrow(/extractCanonicalDocument/);
  });

  it('ISO Strict OOXML namespace распознаётся так же, как Transitional', async () => {
    const strictNs = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
    const documentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<s:document xmlns:s="${strictNs}"><s:body>` +
      '<s:p><s:r><s:t>Правило</s:t></s:r></s:p>' +
      '</s:body></s:document>';
    const JSZipCtor = (await import('jszip')).default;
    const zip = new JSZipCtor();
    zip.file('word/document.xml', documentXml);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Правило']);
  });
});

describe('извлечение обёрток верхнего уровня — регрессии независимого ревью', () => {
  it('content control (w:sdt/w:sdtContent) на уровне body — абзац внутри НЕ теряется, structuralPath продолжает родительскую последовательность', async () => {
    const buffer = await buildDocxBuffer(
      '<w:sdt><w:sdtContent><w:p><w:r><w:t>Текст внутри content control</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
        '<w:p><w:r><w:t>Снаружи</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual([
      'Текст внутри content control',
      'Снаружи',
    ]);
    // Обёртка прозрачна для structuralPath — оба абзаца в одной последовательности p[N].
    expect(doc.blocks[0].structuralPath).toBe('body/p[0]');
    expect(doc.blocks[1].structuralPath).toBe('body/p[1]');
  });

  it('content control внутри ячейки таблицы — абзац тоже не теряется', async () => {
    const buffer = await buildDocxBuffer(
      '<w:tbl><w:tr><w:tc><w:sdt><w:sdtContent>' +
        '<w:p><w:r><w:t>Cell SDT</w:t></w:r></w:p>' +
        '</w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Cell SDT']);
  });

  it('w:customXml на уровне body — абзац внутри не теряется', async () => {
    const buffer = await buildDocxBuffer(
      '<w:customXml w:element="section"><w:p><w:r><w:t>Inside customXml</w:t></w:r></w:p></w:customXml>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Inside customXml']);
  });

  it('mc:AlternateContent на уровне body — mc:Fallback не теряется, mc:Choice не задваивает', async () => {
    const buffer = await buildDocxBuffer(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="wps"><w:p><w:r><w:t>Choice text</w:t></w:r></w:p></mc:Choice>' +
        '<mc:Fallback><w:p><w:r><w:t>Fallback text</w:t></w:r></w:p></mc:Fallback>' +
        '</mc:AlternateContent>' +
        '<w:p><w:r><w:t>After</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocument(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Fallback text', 'After']);
  });
});

describe('toSourceBlockLocation — проекция CanonicalBlock -> SourceBlockLocation (для assignIdentity)', () => {
  it('склеивает непустой sectionPath через " / "', async () => {
    const heading = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Раздел A</w:t></w:r></w:p>';
    const para = '<w:p><w:r><w:t>Под A.</w:t></w:r></w:p>';
    const buffer = await buildDocxBuffer(heading + para);
    const doc = await extractCanonicalDocument(buffer);
    const child = doc.blocks.find((b) => b.text === 'Под A.')!;

    const location = toSourceBlockLocation(child);
    expect(location.sectionPath).toBe('Раздел A');
    expect(location.anchor).toBe(child.anchor);
    expect(location.text).toBe(child.text);
    expect(location.blockStart).toBe(child.blockStart);
    expect(location.blockEnd).toBe(child.blockEnd);
  });

  it('пустой sectionPath -> sentinel "(root)"', async () => {
    const buffer = await buildDocxBuffer('<w:p><w:r><w:t>Без заголовков.</w:t></w:r></w:p>');
    const doc = await extractCanonicalDocument(buffer);
    expect(toSourceBlockLocation(doc.blocks[0]).sectionPath).toBe('(root)');
  });

  it('переносит structuralPath из CanonicalBlock — независимое ревью PR #76, Step 3: без этого поля sourceBlockAnchor не может различать структурную перестройку документа', async () => {
    const buffer = await buildDocxBuffer('<w:p><w:r><w:t>Текст.</w:t></w:r></w:p>');
    const doc = await extractCanonicalDocument(buffer);
    const location = toSourceBlockLocation(doc.blocks[0]);
    expect(location.structuralPath).toBe(doc.blocks[0].structuralPath);
    expect(location.structuralPath).toBe('body/p[0]');
  });
});

describe('structuralPath — независимое ревью PR #76, Step 3: коллизия sourceBlockAnchor при перестройке документа', () => {
  it('тот же видимый текст, тот же (пустой) sectionPath, те же offsets в canonicalText, но РАЗНАЯ структурная позиция (голый параграф vs ячейка таблицы) — CanonicalBlock обязан различаться structuralPath, иначе sourceBlockAnchor, посчитанный без него, схлопнёт две РАЗНЫЕ перестройки документа в одно и то же место', async () => {
    const bareParagraph = await buildDocxBuffer('<w:p><w:r><w:t>Текст.</w:t></w:r></w:p>');
    const insideTableCell = await buildDocxBuffer(
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Текст.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    );

    const docA = await extractCanonicalDocument(bareParagraph);
    const docB = await extractCanonicalDocument(insideTableCell);

    // Одинаковый видимый текст -> одинаковый canonicalText -> одинаковый
    // sourceRevisionHash (по дизайну — hash НЕ зависит от сырых ZIP-байт или
    // структуры, только от canonicalText, см. docx-canonical-blocks.ts).
    expect(docA.sourceRevisionHash).toBe(docB.sourceRevisionHash);
    // Одинаковый sectionPath (нет заголовков ни там, ни там) и одинаковые
    // offsets (единственный блок в обоих документах, тот же текст).
    expect(docA.blocks[0].sectionPath).toEqual(docB.blocks[0].sectionPath);
    expect(docA.blocks[0].blockStart).toBe(docB.blocks[0].blockStart);
    expect(docA.blocks[0].blockEnd).toBe(docB.blocks[0].blockEnd);
    // Но структурная позиция — РАЗНАЯ: голый параграф тела документа vs
    // параграф внутри ячейки таблицы. Раньше sourceBlockAnchor не видел эту
    // разницу вообще (computeSourceBlockAnchor не принимал structuralPath).
    expect(docA.blocks[0].structuralPath).not.toBe(docB.blocks[0].structuralPath);
    expect(docA.blocks[0].kind).toBe('PARAGRAPH');
    expect(docB.blocks[0].kind).toBe('TABLE_CELL');

    const locationA = toSourceBlockLocation(docA.blocks[0]);
    const locationB = toSourceBlockLocation(docB.blocks[0]);
    const anchorA = computeSourceBlockAnchor(
      docA.sourceRevisionHash,
      locationA.structuralPath,
      locationA.blockStart,
      locationA.blockEnd
    );
    const anchorB = computeSourceBlockAnchor(
      docB.sourceRevisionHash,
      locationB.structuralPath,
      locationB.blockStart,
      locationB.blockEnd
    );
    expect(anchorA).not.toBe(anchorB);
  });

  it('тот же DOCX, повторно распарсенный, — тот же structuralPath и тот же sourceBlockAnchor (не регрессия детерминизма)', async () => {
    const buffer = await buildDocxBuffer('<w:p><w:r><w:t>Текст.</w:t></w:r></w:p>');
    const doc1 = await extractCanonicalDocument(buffer);
    const doc2 = await extractCanonicalDocument(buffer);

    expect(doc1.blocks[0].structuralPath).toBe(doc2.blocks[0].structuralPath);

    const loc1 = toSourceBlockLocation(doc1.blocks[0]);
    const loc2 = toSourceBlockLocation(doc2.blocks[0]);
    const anchor1 = computeSourceBlockAnchor(
      doc1.sourceRevisionHash,
      loc1.structuralPath,
      loc1.blockStart,
      loc1.blockEnd
    );
    const anchor2 = computeSourceBlockAnchor(
      doc2.sourceRevisionHash,
      loc2.structuralPath,
      loc2.blockStart,
      loc2.blockEnd
    );
    expect(anchor1).toBe(anchor2);
  });
});
