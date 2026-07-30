/**
 * Проверка: содержит ли сам корпус операторских эталонов взаимоисключающие
 * утверждения. Если да — потолок точности задаётся не поиском, а корпусом,
 * и замер «против эталона» этот класс ошибок увидеть не может в принципе.
 *
 * Берём узел «нужен ли оригинал для нотариального заверения»: в замере
 * out-of-corpus два вопроса на эту тему получили оценку OK, но их эталоны
 * утверждают разное.
 */
import prisma from '../src/lib/db';

const PROBE = ['оригинал', 'подшива', 'сшива', 'ксерокопи'];

async function main() {
  const pairs = await prisma.qAPair.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { metadata: { path: ['authorityTag'], equals: 'VOICE_ANSWER_AUTHORITY' } },
        { metadata: { path: ['authorityTag'], equals: 'HISTORICAL_ANSWER_AUTHORITY' } },
        { metadata: { path: ['origin'], equals: 'voice-operator' } },
        { metadata: { path: ['origin'], equals: 'historical-operator' } },
      ],
    },
    select: { id: true, question: true, answer: true, audience: true },
  });

  const hits = pairs.filter((p) => {
    const t = `${p.question} ${p.answer}`.toLowerCase();
    return PROBE.some((w) => t.includes(w));
  });

  console.log(`Эталонных пар всего: ${pairs.length}`);
  console.log(`Затрагивают узел «оригинал / подшивка»: ${hits.length}\n`);

  for (const h of hits) {
    const t = h.answer.toLowerCase();
    // Два взаимоисключающих утверждения на одном узле.
    const requiresOriginal =
      /оригинал[а-яё]*\s+(?:обязателен|необходим|нужен|требуется)/.test(t) ||
      /без\s+оригинал[а-яё]*\s+(?:нельзя|невозможно|не\s+)/.test(t) ||
      /подшивается\s+именно\s+к\s+оригиналу/.test(t);
    const copyAllowed =
      /(?:обычн[а-яё]*\s+)?ксерокопи/.test(t) && /(?:можно|допустим|подойд|достаточно|по\s+выбору)/.test(t);

    const tag = requiresOriginal && copyAllowed
      ? 'СМЕШАННОЕ'
      : requiresOriginal
        ? 'ОРИГИНАЛ ОБЯЗАТЕЛЕН'
        : copyAllowed
          ? 'КОПИИ ДОСТАТОЧНО'
          : '—';

    if (tag === '—') continue;
    console.log(`[${tag}] ${h.id}`);
    console.log(`   В: ${h.question.slice(0, 110)}`);
    console.log(`   О: ${h.answer.slice(0, 220).replace(/\s+/g, ' ')}...\n`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
