import JSZip from 'jszip';

/**
 * Конструктор минимальных DOCX-буферов для тестов H slice 5b (canonical
 * blocks-with-offsets). Не `.test.ts` намеренно — vitest забирает только
 * `*.test.ts` (см. прецедент `applicability/__tests__/helpers.ts`).
 *
 * `word/document.xml` — единственная запись архива, которую читает
 * `extractCanonicalDocument`; остальные части настоящего .docx (Content
 * Types, rels, styles.xml) намеренно не создаются — тест ZIP им не пользуется.
 */

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export async function buildDocxBuffer(bodyXml: string): Promise<Buffer> {
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}</w:body></w:document>`;
  const zip = new JSZip();
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Готовый фрагмент `<w:p>` для standalone-разбора `extractParagraphText`. */
export function standaloneParagraphXml(inner: string): string {
  return `<w:p xmlns:w="${W_NS}" xmlns:r="${R_NS}">${inner}</w:p>`;
}
