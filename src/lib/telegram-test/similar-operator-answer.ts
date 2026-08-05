/**
 * Ближайший РЕАЛЬНЫЙ операторский ответ на похожий вопрос — для тестового бота
 * (см. src/app/api/telegram-test/route.ts).
 *
 * Источник — docs/email-bot/may2026-knowledge-base-final.json: 180 вопросов
 * клиентов с ответами, которые операторы реально давали (не синтез, живая
 * правда). Замер docs/bot-audit/accuracy-vs-operator.md уже показал: из 21
 * отправленного клиенту ответа бота только 1 совпал с оператором без
 * расхождений — 17 потеряли условие, которое оператор всегда называет.
 * Показывая сотруднику оператора рядом с ботом на каждом тестовом вопросе, мы
 * превращаем разовый замер в постоянную тренировку.
 *
 * Эмбеддинги корпуса считаются один раз за холодный старт процесса и живут в
 * памяти — 180 строк, пересчёт стоит копейки, а держать их в БД ради одного
 * тестового инструмента избыточно. Это НЕ путь ответа реальным клиентам;
 * туда, где нужна персистентность (canonical QAPair), правки уходят через
 * scripts/import-operator-answers.ts после ревью.
 */
import { generateEmbedding, generateEmbeddings } from '@/lib/openai';
import { readFileSync } from 'fs';
import { join } from 'path';

interface CorpusCase {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq?: number;
  confidence?: number;
}

interface EmbeddedCase extends CorpusCase {
  embedding: number[];
}

let cache: Promise<EmbeddedCase[]> | null = null;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function loadCorpus(): Promise<EmbeddedCase[]> {
  const path = join(process.cwd(), 'docs/email-bot/may2026-knowledge-base-final.json');
  const cases: CorpusCase[] = JSON.parse(readFileSync(path, 'utf8'));
  const embeddings = await generateEmbeddings(cases.map((c) => c.question));
  return cases.map((c, i) => ({ ...c, embedding: embeddings[i] }));
}

export interface SimilarOperatorAnswer {
  question: string;
  answer: string;
  category: string;
  similarity: number;
}

/**
 * Возвращает лучшее совпадение из корпуса, если сходство выше порога, иначе
 * null — «похожего прецедента у операторов нет» тоже полезная информация,
 * подсовывать слабое совпадение как будто оно релевантно — вредно.
 */
export async function findSimilarOperatorAnswer(
  question: string,
  threshold = 0.72
): Promise<SimilarOperatorAnswer | null> {
  cache ??= loadCorpus();
  const corpus = await cache;
  if (corpus.length === 0) return null;

  const qEmbedding = await generateEmbedding(question);
  let best: EmbeddedCase | null = null;
  let bestScore = -1;
  for (const c of corpus) {
    const score = cosineSimilarity(qEmbedding, c.embedding);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best || bestScore < threshold) return null;
  return { question: best.question, answer: best.answer, category: best.category, similarity: bestScore };
}
