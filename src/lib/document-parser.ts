import mammoth from 'mammoth';

export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const lowerFilename = filename.toLowerCase();

  // PDF parsing
  if (mimeType === 'application/pdf' || lowerFilename.endsWith('.pdf')) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buffer: Buffer) => Promise<{ text: string }>;
    const data = await pdfParse(buffer);
    return data.text;
  }

  // Word documents
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerFilename.endsWith('.docx')
  ) {
    const result = await mammoth.convertToHtml({ buffer });
    const text = htmlToPlainText(result.value);

    if (text.trim().length > 0) {
      return text;
    }

    const rawResult = await mammoth.extractRawText({ buffer });
    return rawResult.value;
  }

  if (mimeType === 'application/msword' || lowerFilename.endsWith('.doc')) {
    // For .doc files, try mammoth (may not work for all .doc files)
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch {
      throw new Error('Unable to parse .doc file. Please convert to .docx');
    }
  }

  // Plain text
  if (
    mimeType === 'text/plain' ||
    lowerFilename.endsWith('.txt') ||
    lowerFilename.endsWith('.md')
  ) {
    return buffer.toString('utf-8');
  }

  // RTF - basic support
  if (mimeType === 'application/rtf' || lowerFilename.endsWith('.rtf')) {
    // Basic RTF stripping
    let text = buffer.toString('utf-8');
    text = text.replace(/\\[a-z]+(-?\d+)? ?/gi, '');
    text = text.replace(/[{}]/g, '');
    return text;
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

function htmlToPlainText(html: string): string {
  const withStructuralBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<ol\b[^>]*>|<ul\b[^>]*>/gi, '\n')
    .replace(/<\/ol>|<\/ul>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<tr\b[^>]*>/gi, '')
    .replace(/<\/td>/gi, '\n')
    .replace(/<td\b[^>]*>/gi, '')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<h[1-6]\b[^>]*>/gi, '');

  return decodeHtmlEntities(withStructuralBreaks.replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

export function detectMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();

  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
    md: 'text/plain',
    rtf: 'application/rtf',
  };

  return mimeTypes[ext || ''] || 'application/octet-stream';
}
