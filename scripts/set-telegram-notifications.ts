/**
 * Включить или выключить рассылки бота конкретному сотруднику.
 *
 * Уведомления отделены от роли намеренно: «не беспокоить» не должно отнимать
 * права управлять базой знаний. Поэтому отключение делается этим флагом, а не
 * понижением роли.
 *
 * Что отключается флагом: эскалация «вопрос передан оператору», эскалация ИИ
 * при пробеле в знаниях, отчёты `/report`, рассылка `/helpme`.
 *
 * Запуск:
 *   railway run npx tsx scripts/set-telegram-notifications.ts            # показать
 *   railway run npx tsx scripts/set-telegram-notifications.ts 234742362 off
 *   railway run npx tsx scripts/set-telegram-notifications.ts 234742362 on
 */
import prisma from '../src/lib/db';

async function show(): Promise<void> {
  const users = await prisma.telegramUser.findMany({
    orderBy: [{ role: 'asc' }, { firstName: 'asc' }],
    select: {
      telegramId: true,
      username: true,
      firstName: true,
      role: true,
      isActive: true,
      notificationsEnabled: true,
    },
  });
  console.log('\ntelegramId    имя            роль          активен  уведомления');
  for (const u of users) {
    console.log(
      `${u.telegramId.padEnd(13)} ${(u.firstName ?? '—').padEnd(14)} ${u.role.padEnd(13)} ${
        u.isActive ? 'да     ' : 'нет    '
      } ${u.notificationsEnabled ? 'ВКЛЮЧЕНЫ' : 'выключены'}`
    );
  }

  const env = process.env.TELEGRAM_SUPER_ADMIN;
  if (env) {
    // Эскалация ИИ добавляет этот идентификатор к списку получателей мимо базы,
    // поэтому выключение флага его не заглушит.
    console.log(`\nВНИМАНИЕ: TELEGRAM_SUPER_ADMIN=${env} получает эскалации ИИ в обход базы.`);
  }
}

async function main() {
  const [telegramId, state] = process.argv.slice(2);
  if (!telegramId) {
    await show();
    await prisma.$disconnect();
    return;
  }
  if (state !== 'on' && state !== 'off') {
    console.error('Второй аргумент должен быть on или off');
    process.exit(1);
  }

  const user = await prisma.telegramUser.findUnique({ where: { telegramId } });
  if (!user) {
    console.error(`Сотрудника с telegramId=${telegramId} в базе нет`);
    process.exit(1);
  }

  await prisma.telegramUser.update({
    where: { telegramId },
    data: { notificationsEnabled: state === 'on' },
  });
  console.log(
    `${user.firstName ?? user.username ?? telegramId}: уведомления ${state === 'on' ? 'ВКЛЮЧЕНЫ' : 'ВЫКЛЮЧЕНЫ'}`
  );
  await show();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
