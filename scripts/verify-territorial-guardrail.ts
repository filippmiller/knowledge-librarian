/**
 * Детерминированный ответ по территориальности — сквозная проверка ветки.
 *
 * Проверяется не таблица (для неё есть verify-apostille-authority.ts), а то,
 * что движок её действительно применяет и не применяет там, где решать нельзя.
 *
 * Запуск: npx tsx scripts/verify-territorial-guardrail.ts
 */
import { buildInternalGuardrailResultForTests } from '../src/lib/ai/enhanced-answering-engine';

interface Case {
  name: string;
  question: string;
  /** Должен ли сработать детерминированный ответ. */
  expectGuardrail: boolean;
  /** Фрагменты, обязательные в ответе. */
  mustInclude?: string[];
  mustNotInclude?: string[];
}

const CASES: Case[] = [
  {
    name: 'СОН из Саратова → отказ по территориальности (раньше сюда не доходил никто)',
    question: 'Можно ли поставить апостиль на справку о несудимости, выданную в Саратовской области?',
    expectGuardrail: true,
    mustInclude: ['Министерство внутренних дел', 'по месту выдачи', 'НОТАРИАЛЬНУЮ КОПИЮ'],
  },
  {
    name: 'диплом из Саратова → БЕРЁМ, территориальности нет',
    question: 'Можно ли апостилировать диплом, выданный в Саратове?',
    expectGuardrail: true,
    mustInclude: ['Да, можем', 'территориального признака у него нет'],
    mustNotInclude: ['не можем', 'по месту выдачи'],
  },
  {
    name: 'аттестат из Перми → БЕРЁМ',
    question: 'Как апостилировать аттестат, выданный в Перми?',
    expectGuardrail: true,
    mustInclude: ['Да, можем'],
  },
  {
    name: 'нотариальная доверенность из Казани → отказ по территориальности',
    question: 'Можно ли апостилировать нотариальную доверенность, оформленную в Казани?',
    expectGuardrail: true,
    mustInclude: ['Министерство юстиции', 'по месту выдачи'],
  },
  {
    name: 'свидетельство ЗАГС из другого региона → прежняя специализированная ветка',
    question: 'Как апостилировать свидетельство о рождении, выданное в другом регионе?',
    expectGuardrail: true,
    mustInclude: ['по месту выдачи'],
  },
  {
    name: 'СОН из СПб → детерминированного отказа НЕТ, идём обычным путём',
    question: 'Можно ли поставить апостиль на справку о несудимости, полученную в Санкт-Петербурге?',
    expectGuardrail: false,
  },
  {
    name: 'названы оба региона → решения НЕТ, вопрос идёт обычным путём',
    question: 'Справка о несудимости из Саратова — можно ли апостилировать в СПб?',
    expectGuardrail: false,
  },
  {
    name: 'регион не назван → решения НЕТ',
    question: 'Сколько стоит апостиль на справку о несудимости?',
    expectGuardrail: false,
  },
  {
    name: 'диплом без региона → решения НЕТ, это вопрос про цену и срок',
    question: 'Можно ли апостилировать диплом в спб',
    expectGuardrail: false,
  },
  {
    name: 'вопрос не про апостиль → решения НЕТ',
    question: 'Сколько стоит перевод паспорта с английского, документ из Саратова?',
    expectGuardrail: false,
  },
];

let failed = 0;
for (const c of CASES) {
  const result = buildInternalGuardrailResultForTests(c.question);
  const fired = result !== null;
  let ok = fired === c.expectGuardrail;
  const problems: string[] = [];

  if (ok && fired && c.mustInclude) {
    for (const frag of c.mustInclude) {
      if (!result!.answer.includes(frag)) {
        ok = false;
        problems.push(`нет фрагмента «${frag}»`);
      }
    }
  }
  if (ok && fired && c.mustNotInclude) {
    for (const frag of c.mustNotInclude) {
      if (result!.answer.includes(frag)) {
        ok = false;
        problems.push(`есть запрещённый фрагмент «${frag}»`);
      }
    }
  }

  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      сработал=${fired} ожидали=${c.expectGuardrail}${problems.length ? ' | ' + problems.join('; ') : ''}`);
  if (!ok && fired) console.log(`      ответ: ${result!.answer.replace(/\s+/g, ' ').slice(0, 180)}`);
}

console.log(`\n${CASES.length - failed}/${CASES.length} прошло`);
if (failed > 0) process.exit(1);
