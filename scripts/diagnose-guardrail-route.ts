/**
 * Почему детерминированный ответ не доходит до клиента.
 *
 * Guardrail вызывается только на двух ветках сценарного гейта — уточнение и
 * out_of_scope. Если гейт уверенно выбрал сценарий, таблица территориальности
 * не спрашивается вовсе. Скрипт печатает обе величины рядом.
 *
 * Запуск: railway run npx tsx scripts/diagnose-guardrail-route.ts
 */
import { classifyScenario } from '../src/lib/knowledge/scenario-classifier';
import { buildInternalGuardrailResultForTests } from '../src/lib/ai/enhanced-answering-engine';
import prisma from '../src/lib/db';

const QUESTIONS = [
  'Можно ли поставить апостиль на справку о несудимости, выданную в Саратовской области?',
  'Можно ли апостилировать диплом, выданный в Саратове?',
  'Как апостилировать свидетельство о рождении, выданное в другом регионе?',
];

async function main() {
  for (const q of QUESTIONS) {
    const guardrail = buildInternalGuardrailResultForTests(q);
    let gate: string;
    try {
      const d = await classifyScenario(q);
      gate = d.kind + ('scenarioKey' in d ? ` → ${d.scenarioKey}` : '');
    } catch (e) {
      gate = `ошибка: ${String(e).slice(0, 60)}`;
    }
    const consulted = gate.startsWith('needs_clarification') || gate.startsWith('out_of_scope');
    console.log(`\n«${q.slice(0, 66)}…»`);
    console.log(`  таблица дала ответ: ${guardrail !== null}`);
    console.log(`  сценарный гейт:     ${gate}`);
    console.log(`  таблицу спросят:    ${consulted}`);
    if (guardrail && !consulted) {
      console.log('  ⚠ ОТВЕТ ЕСТЬ, НО ДО НЕГО НЕ ДОХОДЯТ');
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(String(e).slice(0, 300));
  await prisma.$disconnect();
  process.exit(1);
});
