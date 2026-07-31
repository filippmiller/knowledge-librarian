/** Разовая проверка порога автоответа. Только чтение. */
import prisma from '../src/lib/db';

async function main() {
  const s = await prisma.aISettings.findFirst({
    where: { isActive: true },
    select: { autoAnswerEnabled: true, autoAnswerMinConfidence: true, provider: true, model: true },
  });
  console.log('AISettings(isActive):', JSON.stringify(s));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
