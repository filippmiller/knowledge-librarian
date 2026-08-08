import { describe, expect, it } from 'vitest';
import {
  extractCanonicalDocxBlocks,
  extractParagraphText,
} from '../docx-canonical-blocks';
import { buildDocxBuffer, standaloneParagraphXml } from './docx-fixture-helpers';

/**
 * H slice 5b (план §3 PR H, Beads translation-yz9): canonical DOCX -> blocks
 * с офсетами. Заменяет `parseDocument()` (`document-parser.ts`) для целей
 * извлечения — та функция нормализует пробелы и уничтожает соответствие
 * офсетов, здесь это КРИТИЧЕСКИЙ инвариант (`resolveEvidenceOffsets`,
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
    const xml = standaloneParagraphXml('<w:r><w:t>10 секунд</w:t></w:r>');
    expect(extractParagraphText(xml)).toBe('10 секунд');
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

describe('extractCanonicalDocxBlocks — сборка блоков документа', () => {
  it('каждый непустой абзац -> один блок; block.text === canonicalText.slice(blockStart, blockEnd)', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Первый абзац.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Второй абзац.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);

    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].text).toBe('Первый абзац.');
    expect(doc.blocks[1].text).toBe('Второй абзац.');
    for (const block of doc.blocks) {
      expect(doc.canonicalText.slice(block.blockStart, block.blockEnd)).toBe(block.text);
    }
  });

  it('пустой абзац (без текста) не создаёт блок', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Текст.</w:t></w:r></w:p>' + '<w:p><w:pPr/></w:p>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks).toHaveLength(1);
  });

  it('анкеры уникальны и стабильны между двумя прогонами одного и того же буфера', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>А.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Б.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>В.</w:t></w:r></w:p>'
    );
    const run1 = await extractCanonicalDocxBlocks(buffer);
    const run2 = await extractCanonicalDocxBlocks(buffer);

    const anchors = run1.blocks.map((b) => b.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(run2).toEqual(run1);
  });

  it('sourceRevisionHash стабилен для того же буфера и меняется при правке содержимого', async () => {
    const bufferA = await buildDocxBuffer('<w:p><w:r><w:t>А.</w:t></w:r></w:p>');
    const bufferB = await buildDocxBuffer('<w:p><w:r><w:t>Б.</w:t></w:r></w:p>');

    const docA1 = await extractCanonicalDocxBlocks(bufferA);
    const docA2 = await extractCanonicalDocxBlocks(bufferA);
    const docB = await extractCanonicalDocxBlocks(bufferB);

    expect(docA2.sourceRevisionHash).toBe(docA1.sourceRevisionHash);
    expect(docB.sourceRevisionHash).not.toBe(docA1.sourceRevisionHash);
  });

  it('повторяющаяся фраза в РАЗНЫХ блоках — каждый блок содержит её ровно один раз (без утечки между блоками)', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:r><w:t>Помощник обязан надеть чистые перчатки.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Хранить чистые перчатки отдельно.</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks).toHaveLength(2);
    for (const block of doc.blocks) {
      const first = block.text.indexOf('чистые перчатки');
      expect(first).toBeGreaterThanOrEqual(0);
      expect(block.text.indexOf('чистые перчатки', first + 1)).toBe(-1);
    }
  });

  it('таблица: каждая ячейка -> отдельный блок с sectionPath, различающим строку/столбец', async () => {
    const buffer = await buildDocxBuffer(
      '<w:tbl><w:tr>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 1,1</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 1,2</w:t></w:r></w:p></w:tc>' +
        '</w:tr><w:tr>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 2,1</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>Ячейка 2,2</w:t></w:r></w:p></w:tc>' +
        '</w:tr></w:tbl>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks).toHaveLength(4);
    expect(doc.blocks.map((b) => b.text)).toEqual([
      'Ячейка 1,1',
      'Ячейка 1,2',
      'Ячейка 2,1',
      'Ячейка 2,2',
    ]);
    expect(doc.blocks.map((b) => b.sectionPath)).toEqual([
      'table[1]/row[1]/cell[1]',
      'table[1]/row[1]/cell[2]',
      'table[1]/row[2]/cell[1]',
      'table[1]/row[2]/cell[2]',
    ]);
  });

  it('заголовки (w:pStyle HeadingN) формируют sectionPath как breadcrumb для последующих абзацев', async () => {
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
    const doc = await extractCanonicalDocxBlocks(buffer);

    const byText = new Map(doc.blocks.map((b) => [b.text, b.sectionPath]));
    expect(byText.get('Раздел A')).toBe('(root)');
    expect(byText.get('Под A.')).toBe('Раздел A');
    expect(byText.get('Раздел A.1')).toBe('Раздел A');
    expect(byText.get('Под A.1.')).toBe('Раздел A / Раздел A.1');
    // Новый Heading1 обязан вытолкнуть Heading2 из стека, а не накапливаться.
    expect(byText.get('Раздел C')).toBe('(root)');
    expect(byText.get('Под C.')).toBe('Раздел C');
  });

  it('элемент списка (w:numPr) — обычный блок с буквальным текстом, без синтезированного маркера нумерации', async () => {
    const listItem = (text: string) =>
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' +
      `<w:r><w:t>${text}</w:t></w:r></w:p>`;
    const buffer = await buildDocxBuffer(listItem('Первый пункт') + listItem('Второй пункт'));

    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Первый пункт', 'Второй пункт']);
  });

  it('бросает понятную ошибку, если в архиве нет word/document.xml', async () => {
    const JSZipCtor = (await import('jszip')).default;
    const zip = new JSZipCtor();
    zip.file('not-a-docx.txt', 'hello');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(extractCanonicalDocxBlocks(buffer)).rejects.toThrow(/document\.xml/);
  });

  it('бросает понятную (доменную) ошибку на «мусорном» XML, а не сырой ParseError', async () => {
    const JSZipCtor = (await import('jszip')).default;
    const zip = new JSZipCtor();
    zip.file('word/document.xml', '%%%NOTXML%%%');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(extractCanonicalDocxBlocks(buffer)).rejects.toThrow(
      /extractCanonicalDocxBlocks/
    );
  });
});

describe('извлечение обёрток верхнего уровня — находки независимого ревью (Grok)', () => {
  it('content control (w:sdt/w:sdtContent) на уровне body — абзац внутри НЕ теряется', async () => {
    const buffer = await buildDocxBuffer(
      '<w:sdt><w:sdtContent><w:p><w:r><w:t>Текст внутри content control</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
        '<w:p><w:r><w:t>Снаружи</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual([
      'Текст внутри content control',
      'Снаружи',
    ]);
  });

  it('content control внутри ячейки таблицы — абзац тоже не теряется', async () => {
    const buffer = await buildDocxBuffer(
      '<w:tbl><w:tr><w:tc><w:sdt><w:sdtContent>' +
        '<w:p><w:r><w:t>Cell SDT</w:t></w:r></w:p>' +
        '</w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Cell SDT']);
  });

  it('w:customXml на уровне body — абзац внутри не теряется', async () => {
    const buffer = await buildDocxBuffer(
      '<w:customXml w:element="section"><w:p><w:r><w:t>Inside customXml</w:t></w:r></w:p></w:customXml>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
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
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Fallback text', 'After']);
  });

  it('w:moveFrom не дублирует перемещённый текст (Final view — виден только w:moveTo)', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:moveFrom><w:r><w:t>MOVED</w:t></w:r></w:moveFrom>' +
        '<w:moveTo><w:r><w:t>MOVED</w:t></w:r></w:moveTo></w:p>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks[0]?.text).toBe('MOVED');
  });

  it('пустой (whitespace-only) заголовок не ломает sectionPath потомков в пустую строку', async () => {
    const buffer = await buildDocxBuffer(
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Потомок под пустым заголовком</w:t></w:r></w:p>'
    );
    const doc = await extractCanonicalDocxBlocks(buffer);
    const child = doc.blocks.find((b) => b.text === 'Потомок под пустым заголовком');
    expect(child?.sectionPath).toBe('(root)');
  });

  it('w:cr -> перевод строки, как и w:br', async () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>A</w:t></w:r><w:r><w:cr/></w:r><w:r><w:t>B</w:t></w:r>'
    );
    expect(extractParagraphText(xml)).toBe('A\nB');
  });
});

describe('находки независимого ревью (Codex)', () => {
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

    const doc = await extractCanonicalDocxBlocks(buffer);
    expect(doc.blocks.map((b) => b.text)).toEqual(['Правило']);
  });

  it('mc:AlternateContent ВНУТРИ абзаца — только mc:Fallback, Choice не задваивает текст', () => {
    const xml = standaloneParagraphXml(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="w14"><w:r><w:t>SAME</w:t></w:r></mc:Choice>' +
        '<mc:Fallback><w:r><w:t>SAME</w:t></w:r></mc:Fallback>' +
        '</mc:AlternateContent>'
    );
    expect(extractParagraphText(xml)).toBe('SAME');
  });

  it('mc:AlternateContent — именно mc:Fallback побеждает, не mc:Choice (различимый текст)', () => {
    const xml = standaloneParagraphXml(
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<mc:Choice Requires="w14"><w:r><w:t>CHOICE_TEXT</w:t></w:r></mc:Choice>' +
        '<mc:Fallback><w:r><w:t>FALLBACK_TEXT</w:t></w:r></mc:Fallback>' +
        '</mc:AlternateContent>'
    );
    expect(extractParagraphText(xml)).toBe('FALLBACK_TEXT');
  });

  it('w:sym -> OBJECT REPLACEMENT CHARACTER, не пустая строка (не создаёт ложное слово)', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>не</w:t></w:r>' +
        '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>' +
        '<w:r><w:t>допускается</w:t></w:r>'
    );
    const text = extractParagraphText(xml);
    expect(text).not.toBe('недопускается');
    expect(text).toBe('не￼допускается');
  });

  it('нераспознанное иностранное поддерево (OMML-формула) — плейсхолдер, не тихая склейка слов', () => {
    const xml = standaloneParagraphXml(
      '<w:r><w:t>до</w:t></w:r>' +
        '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
        '<m:r><m:t>x+1</m:t></m:r>' +
        '</m:oMath>' +
        '<w:r><w:t>дней</w:t></w:r>'
    );
    const text = extractParagraphText(xml);
    expect(text).not.toBe('додней');
    expect(text).toBe('до￼дней');
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

    await expect(extractCanonicalDocxBlocks(buffer)).rejects.toThrow(
      /extractCanonicalDocxBlocks/
    );
  });
});
