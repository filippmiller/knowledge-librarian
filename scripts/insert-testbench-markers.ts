/**
 * Insert temporary marker QAPair rows for the 2026-08-05 full retrieval audit
 * (.claude/audits/2026-08-05-full-retrieval-audit-claude.md).
 *
 * IMPORTANT: these rows are audit-trail markers only, NOT test fixtures used to
 * verify retrieval — their question text is deliberately decoupled from the real
 * benchmark questions (run separately via diagnose-answer.ts) so they cannot be
 * picked up by findCanonicalQaOverride() or accidentally inflate hasStrongQaMatch
 * for the real questions being tested. They exist only to satisfy the audit rule
 * "create explicit test-marked QAPair records, then deprecate them at the end".
 *
 * Marker prefix: "TESTBENCH:" in the question field.
 * Cleanup: scripts/deprecate-qa-pair.ts "TESTBENCH:"
 * Verify:  scripts/inspect-qa-pair.ts "TESTBENCH:"
 */
import prisma from '../src/lib/db';
import { KnowledgeAudience } from '@prisma/client';

const BENCHMARK_TOPICS = [
  'апостиль МЮ СПб', 'апостиль КЗАГС СПб', 'апостиль ЗАГС ЛО', 'апостиль диплом/образование',
  'апостиль свидетельство из другого региона', 'нотариальный перевод - исходник', 'справка о несудимости',
  'страна выдачи vs назначения', 'доставка документов', 'партнёр Орёл/FPM', 'сроки апостиля',
  'стоимость перевода', 'суд за рубежом', 'консульская легализация', 'оригинал или скан',
  'отрицание - оригинал не нужен', 'переформулировка апостиль зачем', 'соседняя тема - визы',
  'hard negative - апостиль Москва без образования', 'недостающие условия - апостиль без типа документа',
];

async function main() {
  const now = new Date();
  const rows = BENCHMARK_TOPICS.map((topic, i) => ({
    question: `TESTBENCH: retrieval-audit marker ${i + 1}/${BENCHMARK_TOPICS.length} — тема "${topic}" — см. .claude/audits/2026-08-05-full-retrieval-audit-claude.md`,
    answer: `Служебная запись аудита ретривала от ${now.toISOString().slice(0, 10)}. Не является реальной парой вопрос-ответ. Подлежит удалению (status=DEPRECATED) в конце того же аудита.`,
    status: 'ACTIVE' as const,
    audience: KnowledgeAudience.INTERNAL_ONLY,
    scenarioKey: null,
    metadata: { origin: 'retrieval-audit-2026-08-05', purpose: 'audit-trail-marker-only' },
  }));

  const created = await prisma.qAPair.createMany({ data: rows });
  console.log(`Inserted ${created.count} TESTBENCH marker QAPair rows.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
