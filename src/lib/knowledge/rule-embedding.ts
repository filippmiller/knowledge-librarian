/**
 * Текст правила, по которому считается семантический вектор (translation-wmq).
 *
 * ЕДИНСТВЕННЫЙ источник этой склейки. Вектор считается в двух разных местах —
 * при коммите документа (`document-processing/commit.ts`) и при добивке старых
 * правил (`scripts/backfill-rule-embeddings.ts`), — и если склейки разойдутся,
 * векторы окажутся из разных пространств: одно и то же правило получит разную
 * близость к одному и тому же вопросу в зависимости от того, каким путём оно
 * попало в базу. Разъезд при этом молчаливый — ничего не падает, просто часть
 * корпуса начинает отвечать хуже.
 *
 * ЗАЧЕМ title И body ВМЕСТЕ. `title` — человеческая формулировка «о чём
 * правило», `body` — конкретика с числами и условиями. Вопросы клиентов бьют и
 * туда, и туда: «сколько стоит замена камеры» ближе к title, «а если я сам
 * цепь принесу» — к body. Брать что-то одно значит терять половину попаданий.
 */
export function ruleEmbeddingText(title: string, body: string): string {
  return `${title}\n${body}`.trim();
}

/**
 * Косинусная близость двух векторов. `null`, если вектора нет или длины не
 * совпали — второе означает смену модели эмбеддингов, и молча сравнивать такие
 * векторы нельзя: число получится, а смысла у него не будет.
 */
export function cosineSimilarity(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined
): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Достаёт вектор из Prisma-поля `Json?`, не доверяя его форме. */
export function parseStoredEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  return value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (value as number[])
    : null;
}
