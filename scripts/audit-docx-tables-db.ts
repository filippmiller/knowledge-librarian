/** Read-only: pull rawBytes of production documents and compare mammoth parsers.
 *  Run: railway run npx tsx scripts/audit-docx-tables-db.ts
 */
import { PrismaClient } from '@prisma/client';
import mammoth from 'mammoth';

const prisma = new PrismaClient();

function cellsOf(html: string) {
  const out: string[] = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  }
  return out;
}

async function main() {
  const docs = await prisma.document.findMany({
    where: { NOT: { rawBytes: null } },
    select: { id: true, title: true, filename: true, mimeType: true, rawBytes: true, rawText: true },
  });

  const rows: Record<string, unknown>[] = [];
  let priceHtmlSample = '';
  let priceRawSample = '';
  let priceTitle = '';

  for (const d of docs) {
    if (!d.filename.toLowerCase().endsWith('.docx')) continue;
    const buffer = Buffer.from(d.rawBytes as Uint8Array);
    let raw = '', html = '';
    try {
      raw = (await mammoth.extractRawText({ buffer })).value;
      html = (await mammoth.convertToHtml({ buffer })).value;
    } catch (e) {
      rows.push({ title: d.title, error: String(e) });
      continue;
    }
    const tables = (html.match(/<table/g) || []).length;
    const trs = (html.match(/<tr/g) || []).length;
    const cells = cellsOf(html);
    const nonEmpty = cells.filter((c) => c.length > 0);

    // How much of the table text survives in the flat rawText?
    // Count non-empty cells whose text does NOT appear as an isolated token run in rawText lines.
    const rawFlat = raw.replace(/\s+/g, ' ');
    const missingCells = nonEmpty.filter((c) => c.length > 2 && !rawFlat.includes(c)).length;

    rows.push({
      title: d.title,
      storedRawTextChars: (d.rawText ?? '').length,
      extractRawTextChars: raw.length,
      extractRawTextLines: raw.split('\n').filter((l) => l.trim()).length,
      convertToHtmlChars: html.length,
      tables,
      tableRows: trs,
      nonEmptyCells: nonEmpty.length,
      tableTextChars: nonEmpty.join(' ').length,
      cellsTextMissingFromRawText: missingCells,
    });

    if (tables > 0 && !priceTitle) {
      priceTitle = d.title;
      priceHtmlSample = html.slice(0, 2500);
      priceRawSample = raw.slice(0, 1200);
    }
  }

  rows.sort((a, b) => Number(b.tables ?? 0) - Number(a.tables ?? 0));
  console.log('=== PER DOCUMENT ===');
  console.log(JSON.stringify(rows, null, 2));
  console.log('=== SAMPLE DOC WITH TABLES: ' + priceTitle + ' ===');
  console.log('--- extractRawText (first 1200) ---');
  console.log(priceRawSample);
  console.log('--- convertToHtml (first 2500) ---');
  console.log(priceHtmlSample);
}
main().catch((e) => { console.error('FAILED', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
