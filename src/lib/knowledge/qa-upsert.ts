import { KnowledgeAudience, type Prisma } from '@prisma/client';

/**
 * Единая точка записи выученной пары вопрос-ответ.
 *
 * Раньше два места писали пары самостоятельно, и оба содержали один и тот же
 * дефект: пара искалась только по тексту вопроса и статусу, а создавалась без
 * поля `audience`, из-за чего срабатывал дефолт схемы `INTERNAL_ONLY`.
 *
 * Последствия были такие:
 *
 * - разобранный КЛИЕНТСКИЙ вопрос сохранялся как внутренний и клиентскому
 *   контуру больше не показывался — самообучение не работало ровно там, где
 *   приносит деньги;
 * - утверждение внутреннего черновика переводило одноимённую КЛИЕНТСКУЮ пару в
 *   `SUPERSEDED`, то есть контур обучения молча СОКРАЩАЛ клиентское покрытие;
 * - пара из одного сценария гасила пару с тем же вопросом из другого.
 *
 * Поэтому дедуп и подмена версии обязаны идти по тройке
 * `(вопрос, аудитория, сценарий)` — это и есть тождество пары. Дефолт
 * `INTERNAL_ONLY` остаётся безопасным для РАЗМЕТКИ документов, но для записи
 * выученного он неверен: аудиторию всегда объявляет вызывающий.
 */
export interface QaUpsertInput {
  question: string;
  answer: string;
  audience: KnowledgeAudience;
  scenarioKey: string | null;
  metadata: Prisma.InputJsonValue;
}

export interface QaUpsertResult {
  qaPairId: string;
  /** Пара, которую заменили. `null`, если создали первую версию. */
  supersededId: string | null;
  /** Существующая пара совпала дословно — ничего не меняли. */
  reused: boolean;
  version: number;
  previous?: { question: string; answer: string; version: number };
}

/**
 * Найти предыдущую версию пары, погасить её и записать новую.
 * Вызывать только внутри транзакции: между поиском и подменой не должно быть
 * окна, в котором пара видна дважды.
 */
export async function upsertLearnedQaPair(
  tx: Prisma.TransactionClient,
  input: QaUpsertInput
): Promise<QaUpsertResult> {
  const { question, answer, audience, scenarioKey, metadata } = input;

  const existing = await tx.qAPair.findFirst({
    where: { question, status: 'ACTIVE', audience, scenarioKey },
    orderBy: { updatedAt: 'desc' },
  });

  if (existing && existing.answer.trim() === answer.trim()) {
    return {
      qaPairId: existing.id,
      supersededId: null,
      reused: true,
      version: existing.version,
    };
  }

  if (existing) {
    await tx.qAPair.update({
      where: { id: existing.id },
      data: { status: 'SUPERSEDED' },
    });
  }

  const created = await tx.qAPair.create({
    data: {
      question,
      answer,
      status: 'ACTIVE',
      audience,
      scenarioKey,
      version: existing ? existing.version + 1 : 1,
      supersedesQaId: existing?.id,
      metadata,
    },
  });

  return {
    qaPairId: created.id,
    supersededId: existing?.id ?? null,
    reused: false,
    version: created.version,
    previous: existing
      ? { question: existing.question, answer: existing.answer, version: existing.version }
      : undefined,
  };
}
