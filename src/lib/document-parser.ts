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
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
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
