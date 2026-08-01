/**
 * Полезен ли контроль: сколько удержаний он дал и сколько из них было зря.
 *
 * Отчёт, ради которого заводилась таблица `HeldAnswer`. Частота срабатывания
 * контроля не измеряет ничего: контроль, сработавший сто раз, может быть и
 * лучшей защитой системы, и худшим её тормозом — по частоте это неразличимо.
 * Различает только вердикт человека о черновике, который контроль забраковал.
 *
 * Что считается:
 * · сколько ответов удержано и по какой помехе политики;
 * · для каждого из восьми контролей — сколько удержаний он дал;
 * · из размеченных человеком: доля «черновик был верен» — это и есть цена
 *   контроля, выраженная в отнятых верных ответах.
 *
 * Контроль, у которого доля зря удержанных высока, не должен блокировать
 * клиентский контур — только внутренний или только журнал. Контроль без единой
 * верной находки за долгий срок — кандидат в теневой режим, а не вечный страж.
 *
 * Запуск: railway run npx tsx scripts/report-held-answers.ts
 *         DAYS=30 railway run npx tsx scripts/report-held-answers.ts
 */
import prisma from '../src/lib/db';
import { HUMAN_REVIEW_LABELS, type HumanReviewReason, type ReasonDetail } from '../src/lib/ai/answer-reasons';
import { AUTO_ANSWER_BLOCKER_LABELS, type AutoAnswerBlocker } from '../src/lib/ai/delivery-decision';

const DAYS = Number(process.env.DAYS ?? 90);
const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000);
  const rows = await prisma.heldAnswer.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n=== УДЕРЖАННЫЕ ОТВЕТЫ ЗА ${DAYS} ДНЕЙ ===\n`);
  if (rows.length === 0) {
    console.log('Записей нет. Либо ничего не удерживалось, либо учёт ещё не выкачен в прод.');
    await prisma.$disconnect();
    return;
  }

  const judged = rows.filter((r) => r.verdict !== null);
  console.log(`удержано: ${rows.length} · размечено человеком: ${judged.length} (${pct(judged.length, rows.length)})`);
  if (judged.length === 0) {
    console.log('\nБез вердиктов отчёт бессмыслен: нажмите кнопку под сообщением об эскалации.');
  }

  const byBlocker = new Map<string, number>();
  for (const r of rows) byBlocker.set(r.blocker ?? '—', (byBlocker.get(r.blocker ?? '—') ?? 0) + 1);
  console.log('\nЧТО МЕШАЛО ОТПРАВИТЬ');
  for (const [blocker, n] of [...byBlocker.entries()].sort((a, b) => b[1] - a[1])) {
    const label = AUTO_ANSWER_BLOCKER_LABELS[blocker as AutoAnswerBlocker] ?? blocker;
    console.log(`  ${String(n).padStart(4)} · ${label}`);
  }

  // По контролю: сколько удержаний и сколько из размеченных оказались зря.
  const stats = new Map<HumanReviewReason, { held: number; judged: number; wasCorrect: number }>();
  for (const r of rows) {
    const reasons = (r.reasons as unknown as ReasonDetail[]) ?? [];
    for (const item of reasons) {
      const s = stats.get(item.reason) ?? { held: 0, judged: 0, wasCorrect: 0 };
      s.held += 1;
      if (r.verdict) {
        s.judged += 1;
        if (r.verdict === 'correct') s.wasCorrect += 1;
      }
      stats.set(item.reason, s);
    }
  }

  console.log('\nПО КОНТРОЛЯМ');
  console.log('  удержал | размечено | зря удержал | контроль');
  for (const [reason, s] of [...stats.entries()].sort((a, b) => b[1].held - a[1].held)) {
    const waste = s.judged === 0 ? 'нет данных' : `${s.wasCorrect} (${pct(s.wasCorrect, s.judged)})`;
    console.log(
      `  ${String(s.held).padStart(7)} | ${String(s.judged).padStart(9)} | ${waste.padStart(11)} | ${HUMAN_REVIEW_LABELS[reason]}`
    );
  }

  const wasted = judged.filter((r) => r.verdict === 'correct');
  console.log(`\nИТОГ: из ${judged.length} размеченных удержаний зря — ${wasted.length} (${pct(wasted.length, judged.length)})`);
  if (wasted.length > 0) {
    console.log('\nЗРЯ УДЕРЖАННЫЕ — разобрать глазами:');
    for (const r of wasted.slice(0, 12)) {
      const reasons = (r.reasons as unknown as ReasonDetail[]) ?? [];
      console.log(`\n  «${r.question.slice(0, 90)}»`);
      console.log(`     контроли: ${reasons.map((x) => x.reason).join(', ') || '—'} · помеха: ${r.blocker ?? '—'}`);
      console.log(`     черновик: ${r.draftAnswer.slice(0, 140).replace(/\n/g, ' ')}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
