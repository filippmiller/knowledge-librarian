/**
 * Кандидат на пилотный документ: у кого из документов больше всего правил, чьи
 * цитаты НЕ находятся в тексте документа вовсе (`locateQuote` → null). Это
 * прямой, дешёвый (без LLM) сигнал, что извлечение могло быть нечестным —
 * лучше начинать ревизию с документа, где уже есть основания подозревать
 * проблему, чем с случайного.
 *
 * Запуск: railway run npx tsx scripts/probe-pilot-document.ts
 */
import prisma from '../src/lib/db';
import { locateQuote } from '../src/lib/knowledge/quote-locator';

function str(span: Record<string, unknown> | null, key: string): string | null {
  const v = span?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

async function main() {
  const rules = await prisma.rule.findMany({
    where: { status: 'ACTIVE', documentId: { not: null } },
    select: {
      ruleCode: true,
      sourceSpan: true,
      documentId: true,
      document: { select: { title: true, filename: true, rawText: true } },
    },
  });

  interface DocStat {
    title: string;
    filename: string;
    total: number;
    exact: number;
    normalized: number;
    partial: number;
    notFound: number;
    hasRawText: boolean;
  }
  const byDoc = new Map<string, DocStat>();

  for (const r of rules) {
    if (!r.documentId || !r.document) continue;
    const span = (r.sourceSpan ?? null) as Record<string, unknown> | null;
    const quote = str(span, 'quote');
    if (!quote) continue;

    const stat = byDoc.get(r.documentId) ?? {
      title: r.document.title,
      filename: r.document.filename,
      total: 0,
      exact: 0,
      normalized: 0,
      partial: 0,
      notFound: 0,
      hasRawText: !!r.document.rawText,
    };
    stat.total++;

    if (!r.document.rawText) {
      // Текста нет вовсе — не считаем как "не найдено по содержанию", это другая причина.
    } else {
      const m = locateQuote(r.document.rawText, quote);
      if (!m) stat.notFound++;
      else if (m.kind === 'exact') stat.exact++;
      else if (m.kind === 'normalized') stat.normalized++;
      else stat.partial++;
    }
    byDoc.set(r.documentId, stat);
  }

  const ranked = [...byDoc.values()]
    .filter((d) => d.total >= 5 && d.hasRawText)
    .map((d) => ({ ...d, notFoundShare: d.notFound / d.total }))
    .sort((a, b) => b.notFoundShare - a.notFoundShare || b.total - a.total);

  console.log(`документов с ≥5 правилами и текстом: ${ranked.length}\n`);
  console.log('топ-10 по доле ненайденных цитат:\n');
  for (const d of ranked.slice(0, 10)) {
    console.log(
      `${d.filename} — правил: ${d.total}, дословно: ${d.exact}, нормализовано: ${d.normalized}, ` +
        `частично: ${d.partial}, НЕ НАЙДЕНО: ${d.notFound} (${Math.round(d.notFoundShare * 100)}%)`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
