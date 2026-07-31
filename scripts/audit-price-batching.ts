import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const BATCH = 4500, OVER = 600;
(async () => {
  const d = await p.document.findFirst({ where: { title: { contains: "Прайс на перевод и заверение-0" } }, select: { title: true, rawText: true } });
  const t = d!.rawText!;
  const batches: {i:number,start:number,end:number}[] = [];
  let off = 0, i = 0;
  while (off < t.length) {
    const end = Math.min(off + BATCH, t.length);
    batches.push({ i: ++i, start: off, end });
    off = end - OVER;
    if (off >= t.length - OVER) break;
  }
  const headerRe = /КАТЕГОРИЯ\s*\d|СТАНДАРТ|ЧЕРЕЗ 1 ДЕНЬ|вкл\. НЗ/g;
  const headers: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(t)) !== null) headers.push(m.index);
  const report = batches.map(b => {
    const seg = t.slice(b.start, b.end);
    const nums = (seg.match(/^\s*\d{3,4}\s*$/gm) || []).length;
    const hdrs = headers.filter(h => h >= b.start && h < b.end).length;
    return { batch: b.i, range: b.start + "-" + b.end, headerTokensInBatch: hdrs, bareNumberLines: nums, firstHeaderOffsetInBatch: headers.find(h => h >= b.start && h < b.end) ?? null };
  });
  console.log(JSON.stringify({ doc: d!.title, len: t.length, batches: batches.length, headerTokenOffsets: headers.slice(0, 40), report }, null, 2));
})().finally(() => p.$disconnect());
