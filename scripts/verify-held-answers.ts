/**
 * Петля обратной связи: запись удержания → вердикт человека → отчёт.
 *
 * Проверяется сквозной путь, а не отдельные функции: смысл петли в том, что
 * вердикт оператора доходит до статистики контроля. Если рвётся хоть одно
 * звено, отчёт молча покажет «нет данных», и решение об ослаблении контроля
 * снова будет приниматься вслепую.
 *
 * Тестовые строки помечаются и удаляются в конце — прогон не должен искажать
 * настоящую статистику.
 *
 * Запуск: railway run npx tsx scripts/verify-held-answers.ts
 */
import prisma from '../src/lib/db';
import { isHeldVerdict, setHeldVerdict, HELD_VERDICT_LABELS } from '../src/lib/ai/held-answers';
import type { ReasonDetail } from '../src/lib/ai/answer-reasons';

const MARK = '[ПРОВЕРКА ПЕТЛИ]';

let checks = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // Хвосты прошлых прогонов: проверка обязана быть повторяемой.
  await prisma.heldAnswer.deleteMany({ where: { question: { startsWith: MARK } } });

  const reasons: ReasonDetail[] = [
    { reason: 'price_attribution', detail: 'назвал 300 ₽/стр, прайс 1250 ₽/док' },
    { reason: 'ungrounded_numbers', detail: '4200 (сумма)' },
  ];

  const held = await prisma.heldAnswer.create({
    data: {
      question: `${MARK} Сколько стоит нотариальное заверение копии?`,
      draftAnswer: 'Заверение копии — 260 ₽ за страницу.',
      audience: 'client',
      source: 'API',
      delivery: 'escalate',
      blocker: 'human_review_required',
      reasons: reasons as unknown as object,
      confidence: 0.62,
      confidenceLevel: 'medium',
      answerSource: 'knowledge_base',
    },
    select: { id: true, verdict: true },
  });
  check('удержание записывается', Boolean(held.id));
  check('вердикт изначально пуст', held.verdict === null);

  check('строка вердикта распознаётся', isHeldVerdict('correct') && !isHeldVerdict('ok'));

  const saved = await setHeldVerdict(held.id, 'correct', '@проверка');
  check('вердикт записывается', saved);

  const after = await prisma.heldAnswer.findUnique({ where: { id: held.id } });
  check('вердикт сохранён', after?.verdict === 'correct', `получено ${after?.verdict}`);
  check('автор сохранён', after?.verdictBy === '@проверка');
  check('время проставлено', after?.verdictAt !== null);

  // Главное звено: причины дожили до отчёта в разбираемом виде. Если тут пусто,
  // статистика по контролям будет считаться по нулю, а выглядеть достоверно.
  const back = (after?.reasons as unknown as ReasonDetail[]) ?? [];
  check(
    'причины контролей дожили до отчёта',
    back.length === 2 && back[0].reason === 'price_attribution',
    `получено ${back.map((r) => r.reason).join(',') || 'пусто'}`
  );

  const wrong = await setHeldVerdict(held.id, 'wrong', '@другой оператор');
  const rejudged = await prisma.heldAnswer.findUnique({ where: { id: held.id } });
  check('вердикт можно пересмотреть', wrong && rejudged?.verdict === 'wrong');

  check('несуществующая запись не роняет вызов', !(await setHeldVerdict('нет-такой-id', 'correct', '@x')));

  check(
    'подписи вердиктов заданы для всех значений',
    Object.keys(HELD_VERDICT_LABELS).length === 3
  );

  await prisma.heldAnswer.deleteMany({ where: { question: { startsWith: MARK } } });
  const left = await prisma.heldAnswer.count({ where: { question: { startsWith: MARK } } });
  check('тестовые строки убраны за собой', left === 0);

  console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
