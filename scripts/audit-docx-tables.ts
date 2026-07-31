/** Read-only: compare mammoth.extractRawText vs convertToHtml on the corpus docx.
 *  Run: npx tsx scripts/audit-docx-tables.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';

const DIR = path.resolve(process.cwd(), 'documents');

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$'));
  const rows: Record<string, unknown>[] = [];

  for (const f of files) {
    const buffer = fs.readFileSync(path.join(DIR, f));
    const raw = (await mammoth.extractRawText({ buffer })).value;
    const html = (await mammoth.convertToHtml({ buffer })).value;

    const tables = (html.match(/<table/g) || []).length;
    const trs = (html.match(/<tr/g) || []).length;
    const tds = (html.match(/<t[dh][ >]/g) || []).length;

    // cells that live inside a table, as plain text
    const cellTexts: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
    let m: RegExpExecArray | null;
    while ((m = cellRe.exec(html)) !== null) {
      cellTexts.push(m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    }
    const nonEmptyCells = cellTexts.filter((c) => c.length > 0);
    const tableCharsHtml = nonEmptyCells.join(' ').length;

    rows.push({
      file: f,
      rawTextChars: raw.length,
      htmlChars: html.length,
      tables,
      rows: trs,
      cells: tds,
      nonEmptyCells: nonEmptyCells.length,
      tableTextChars: tableCharsHtml,
      rawTextLines: raw.split('\n').filter((l) => l.trim()).length,
    });
  }

  rows.sort((a, b) => Number(b.tables) - Number(a.tables));
  console.log(JSON.stringify(rows, null, 2));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
