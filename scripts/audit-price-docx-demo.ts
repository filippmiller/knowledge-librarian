/** Read-only: concrete side-by-side of the main price docx under both parsers.
 *  Run: railway run npx tsx scripts/audit-price-docx-demo.ts
 */
import { PrismaClient } from '@prisma/client';
import mammoth from 'mammoth';

const prisma = new PrismaClient();

async function main() {
  const doc = await prisma.document.findFirst({
    where: { title: { contains: 'Прайс на перевод и заверение-0' }, NOT: { rawBytes: null } },
    select: { id: true, title: true, rawBytes: true, rawText: true },
  });
  if (!doc) throw new Error('price doc not found');

  const buffer = Buffer.from(doc.rawBytes as Uint8Array);
  const raw = (await mammoth.extractRawText({ buffer })).value;
  const html = (await mammoth.convertToHtml({ buffer })).value;

  // Structured view: tables -> rows -> cells
  const tables = html.split('<table').slice(1);
  const structured = tables.map((t, ti) => {
    const rows = t.split('<tr').slice(1).map((r) => {
      const cells: string[] = [];
      const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(r)) !== null) cells.push(m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
      return cells;
    });
    return { table: ti + 1, rows: rows.length, maxCols: Math.max(...rows.map((r) => r.length), 0), sample: rows.slice(0, 4) };
  });

  console.log('DOC:', doc.title);
  console.log('extractRawText chars:', raw.length, ' non-empty lines:', raw.split('\n').filter((l) => l.trim()).length);
  console.log('convertToHtml: tables =', structured.length,
    ' total rows =', structured.reduce((s, t) => s + t.rows, 0));
  console.log('\n=== STRUCTURE VISIBLE ONLY IN HTML ===');
  console.log(JSON.stringify(structured, null, 1).slice(0, 6000));

  // find a language row and show what raw text looks like around it
  const needle = 'АНГЛИЙСКИЙ';
  const i = raw.toUpperCase().indexOf(needle);
  console.log('\n=== SAME REGION IN extractRawText (flat) ===');
  console.log(JSON.stringify(raw.slice(Math.max(0, i - 200), i + 400)));

  // how many rows would a naive line reader see as a coherent record?
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const numericOnlyLines = lines.filter((l) => /^[\d\s.,-]+$/.test(l)).length;
  console.log('\nlines that are bare numbers (orphaned price cells):', numericOnlyLines, 'of', lines.length);
}
main().catch((e) => { console.error('FAILED', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
