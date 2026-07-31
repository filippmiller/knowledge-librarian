/**
 * Разведка: есть ли у бота приоритет по дате действия между ценовыми прайсами.
 *
 * Только чтение. Ничего не пишет в базу.
 *
 * Что печатает:
 *   A) инвентаризация ценовых документов: id, дата загрузки, аудитория, счётчики;
 *   B) какие поля вообще есть у Document/Rule/DocChunk — есть ли там дата
 *      действия / признак архива (проверка по information_schema, не по schema.prisma);
 *   C) воспроизведение отбора чанков (hybridSearch, audience=internal) на
 *      типичных ценовых вопросах СОТРУДНИКА — из каких документов поднимаются
 *      чанки и на каких местах;
 *   D) воспроизведение отбора правил (Step 5 движка, строки 1008-1043
 *      enhanced-answering-engine.ts) — из каких документов правила и на каких
 *      местах;
 *   E) выгрузка rawText прайсов в файлы для построчного сравнения цифр.
 *
 * Запуск:
 *   railway run npx tsx scripts/audit-price-document-recency.ts
 *   railway run npx tsx scripts/audit-price-document-recency.ts --dump=<dir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import prisma from '../src/lib/db';
import { hybridSearch, type HybridSearchResult } from '../src/lib/ai/vector-search';
import { extractSearchTerms, scoreText } from '../src/lib/ai/enhanced-answering-engine';
import { selectKeyTerms } from '../src/lib/knowledge/glossary';
import { admissibleAudiences } from '../src/lib/knowledge/audience';

const dumpArg = process.argv.find((a) => a.startsWith('--dump='));
const DUMP_DIR = dumpArg ? dumpArg.slice('--dump='.length) : null;

/** Вопросы сотрудника про цены. Формулировки бытовые, как в Telegram. */
const QUESTIONS = [
  // Услуги, по которым цифры 010125 и 010126 РАСХОДЯТСЯ (см. секцию E).
  'сколько стоит справка о несудимости без апостиля за 3 рабочих дня',
  'сколько стоит СОН без апостиля за 5 рабочих дней',
  'сколько стоит срочный апостиль ЗАГС Москва за 1-2 дня',
  'сколько стоит консульская легализация МЮ и МИД без подачи в посольство',
  'до скольки нужно заказать справку о несудимости чтобы день пошел в зачет',
  // Контрольные: цифры совпадают.
  'сколько стоит истребование документа из ЗАГСа другого региона',
];

function fmt(n: number): string {
  return n.toFixed(4);
}

/** Копия selectContextChunks (enhanced-answering-engine.ts:334-358). */
function selectContextChunks(chunks: HybridSearchResult[], maxChunks = 5): HybridSearchResult[] {
  if (chunks.length === 0) return [];
  const eligible = chunks.filter((c) => c.semanticScore >= 0.4 || c.keywordScore >= 0.65);
  if (eligible.length === 0) return [];
  const maxScore = eligible.map((c) => c.combinedScore)[0];
  const threshold = maxScore * 0.6;
  return eligible.filter((c) => c.combinedScore >= threshold).slice(0, maxChunks);
}

/** Копия rankByQuestion (enhanced-answering-engine.ts:394-418). */
function rankByQuestion<T>(
  items: T[],
  question: string,
  getText: (item: T) => string,
  getBoost: (item: T) => number = () => 0,
  getSummary: (item: T) => string = () => ''
): Array<{ item: T; score: number }> {
  const terms = extractSearchTerms(question);
  if (terms.length === 0) return items.map((item) => ({ item, score: 0 }));
  return items
    .map((item) => {
      const relevance = scoreText(getText(item), terms) + scoreText(getSummary(item), terms);
      return { item, score: relevance > 0 ? relevance + getBoost(item) : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
}

async function sectionA() {
  console.log('\n================ A. ЦЕНОВЫЕ ДОКУМЕНТЫ В БАЗЕ ================');
  const docs = await prisma.document.findMany({
    where: { OR: [{ title: { contains: 'райс', mode: 'insensitive' } }, { filename: { contains: 'райс', mode: 'insensitive' } }] },
    select: {
      id: true, title: true, filename: true, uploadedAt: true, audience: true,
      parseStatus: true, scenarioKey: true,
      _count: { select: { rules: true, chunks: true, qaPairs: true } },
    },
    orderBy: { uploadedAt: 'asc' },
  });
  for (const d of docs) {
    const byStatus = await prisma.rule.groupBy({
      by: ['status'],
      where: { documentId: d.id },
      _count: { _all: true },
    });
    console.log(`\n[${d.id}] ${d.title}`);
    console.log(`  файл:        ${d.filename}`);
    console.log(`  uploadedAt:  ${d.uploadedAt.toISOString()}`);
    console.log(`  audience:    ${d.audience}   parseStatus: ${d.parseStatus}   scenarioKey: ${d.scenarioKey ?? 'null'}`);
    console.log(`  rules: ${d._count.rules} (${byStatus.map((s) => `${s.status}=${s._count._all}`).join(', ') || '—'})  chunks: ${d._count.chunks}  qa: ${d._count.qaPairs}`);
  }
  return docs;
}

async function sectionB() {
  console.log('\n================ B. ПОЛЯ ТАБЛИЦ (information_schema) ================');
  for (const table of ['Document', 'Rule', 'DocChunk']) {
    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      table
    );
    console.log(`\n${table}: ${cols.map((c) => `${c.column_name}:${c.data_type}`).join(', ')}`);
    const dateLike = cols.filter((c) => /effective|valid|expire|archiv|obsolete|supersed|effect/i.test(c.column_name));
    console.log(`  поля про срок действия / архив: ${dateLike.length ? dateLike.map((c) => c.column_name).join(', ') : 'НЕТ'}`);
  }
}

async function sectionC(docTitles: Map<string, string>) {
  console.log('\n================ C. ОТБОР ЧАНКОВ (hybridSearch, audience=internal) ================');
  for (const q of QUESTIONS) {
    console.log(`\n--- вопрос: ${q}`);
    const results = await hybridSearch(q, [], 10, 0.7, [], 'internal');
    const ctx = selectContextChunks(results, 5);
    const ctxIds = new Set(ctx.map((c) => c.id));
    results.forEach((r, i) => {
      const title = docTitles.get(r.documentId) ?? r.documentId;
      const mark = ctxIds.has(r.id) ? '★' : ' ';
      console.log(
        `  ${mark}#${i + 1} sem=${fmt(r.semanticScore)} kw=${fmt(r.keywordScore)} rrf=${fmt(r.combinedScore)}  ${title}`
      );
    });
    console.log(`  → в контекст ушло чанков: ${ctx.length}; документы контекста: ${[...new Set(ctx.map((c) => docTitles.get(c.documentId) ?? c.documentId))].join(' | ') || '—'}`);
  }
}

async function sectionD(docTitles: Map<string, string>) {
  console.log('\n================ D. ОТБОР ПРАВИЛ (копия Step 5 движка, audience=internal) ================');
  const audienceWhere = { audience: { in: admissibleAudiences('internal') } };
  for (const q of QUESTIONS) {
    console.log(`\n--- вопрос: ${q}`);
    const keyTerms = selectKeyTerms(extractSearchTerms(q));
    const perTerm = await Promise.all(
      keyTerms.map((t) =>
        prisma.rule.findMany({
          where: { status: 'ACTIVE', ...audienceWhere, body: { contains: t, mode: 'insensitive' as const } },
          include: { document: { select: { title: true } } },
          take: 25,
          orderBy: { confidence: 'desc' },
        })
      )
    );
    const byConfidence = await prisma.rule.findMany({
      where: { status: 'ACTIVE', ...audienceWhere },
      include: { document: { select: { title: true } } },
      take: 100,
      orderBy: { confidence: 'desc' },
    });
    const seen = new Set<string>();
    const candidates = [...perTerm.flat(), ...byConfidence].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    const ranked = rankByQuestion(
      candidates,
      q,
      (r) => `${r.ruleCode} ${r.title} ${r.body} ${r.document?.title ?? ''}`,
      (r) => (r.confidence >= 1 ? 2 : 0),
      (r) => r.title
    ).slice(0, 10);
    ranked.forEach((entry, i) => {
      const r = entry.item;
      const title = r.document?.title ?? '(без документа)';
      console.log(`  #${i + 1} score=${entry.score} ${r.ruleCode} [${r.audience}] ← ${title}`);
      console.log(`       ${r.title}`);
      console.log(`       ${r.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    });
    const docsUsed = [...new Set(ranked.map((e) => e.item.document?.title ?? '(без документа)'))];
    console.log(`  → документы топ-10: ${docsUsed.join(' | ')}`);
  }
  void docTitles;
}

async function sectionE(docIds: Array<{ id: string; title: string }>) {
  if (!DUMP_DIR) {
    console.log('\n(секция E пропущена: не задан --dump=<dir>)');
    return;
  }
  mkdirSync(DUMP_DIR, { recursive: true });
  console.log('\n================ E. ВЫГРУЗКА rawText ================');
  for (const d of docIds) {
    const full = await prisma.document.findUnique({ where: { id: d.id }, select: { rawText: true } });
    const safe = d.title.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 60);
    const path = join(DUMP_DIR, `${safe}.txt`);
    writeFileSync(path, full?.rawText ?? '', 'utf8');
    console.log(`  ${path}  (${(full?.rawText ?? '').length} символов)`);

    const rules = await prisma.rule.findMany({
      where: { documentId: d.id },
      select: { ruleCode: true, title: true, body: true, status: true, audience: true },
      orderBy: { ruleCode: 'asc' },
    });
    const rulePath = join(DUMP_DIR, `${safe}.rules.txt`);
    writeFileSync(
      rulePath,
      rules.map((r) => `${r.ruleCode}\t${r.status}\t${r.audience}\t${r.title}\t${r.body.replace(/\s+/g, ' ')}`).join('\n'),
      'utf8'
    );
    console.log(`  ${rulePath}  (${rules.length} правил)`);
  }
}

async function main() {
  const docs = await sectionA();
  const titles = new Map(docs.map((d) => [d.id, d.title]));
  // Названия всех документов, чтобы атрибутировать чанки не только прайсов.
  const allDocs = await prisma.document.findMany({ select: { id: true, title: true } });
  for (const d of allDocs) titles.set(d.id, d.title);

  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const want = (s: string) => !only || only.includes(s);

  if (want('b')) await sectionB();
  if (want('c')) await sectionC(titles);
  if (want('d')) await sectionD(titles);
  if (want('e')) await sectionE(docs.map((d) => ({ id: d.id, title: d.title })));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
