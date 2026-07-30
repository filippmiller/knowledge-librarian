/**
 * Guarantee an active AISettings row exists.
 *
 * The Telegram delivery policy reads auto-answer config from this row. A
 * missing row means the bot escalates every question to an operator — that is
 * exactly what happened between 2026-07-17 and 2026-07-30, so the row is now
 * created explicitly rather than left to whoever first opens /admin/ai-settings.
 *
 * Run: railway run npx tsx scripts/ensure-ai-settings.ts [--enable]
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_MIN_CONFIDENCE } from '../src/lib/telegram/constants';

const prisma = new PrismaClient();
const enable = process.argv.includes('--enable');

async function main(): Promise<void> {
  const existing = await prisma.aISettings.findFirst({ where: { isActive: true } });

  if (existing) {
    const updated = await prisma.aISettings.update({
      where: { id: existing.id },
      data: enable ? { autoAnswerEnabled: true } : {},
    });
    console.log('Существующая строка настроек:', {
      id: updated.id,
      autoAnswerEnabled: updated.autoAnswerEnabled,
      autoAnswerMinConfidence: updated.autoAnswerMinConfidence,
    });
    return;
  }

  const created = await prisma.aISettings.create({
    data: {
      provider: 'openai',
      isActive: true,
      autoAnswerEnabled: enable,
      autoAnswerMinConfidence: DEFAULT_MIN_CONFIDENCE,
    },
  });
  console.log('Создана строка настроек:', {
    id: created.id,
    autoAnswerEnabled: created.autoAnswerEnabled,
    autoAnswerMinConfidence: created.autoAnswerMinConfidence,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
