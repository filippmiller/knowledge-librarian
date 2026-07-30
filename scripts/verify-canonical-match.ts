/**
 * Проверка порога канонического совпадения.
 *
 * findCanonicalQaOverride подменяет ответ целиком и назначает уверенность 1.0,
 * минуя сценарный гейт. Порог по КОРОТКОЙ стороне пропускал короткий общий
 * вопрос на длинный специфичный эталон: «сколько стоит апостиль» против
 * «Сколько стоит апостиль на справку о несудимости из другого региона» давало
 * 1.0. При пяти эталонах это было терпимо, после импорта 117 операторских
 * ответов — нет.
 *
 * Здесь проверяется сама метрика: короткая сторона (признак близости, влияет на
 * уверенность) и длинная (право подменить ответ).
 *
 * Запуск: npx tsx scripts/verify-canonical-match.ts
 */
import { questionTermOverlapForTests as overlap } from '@/lib/ai/enhanced-answering-engine';

const SHORT_GATE = 0.55;
const LONG_GATE = 0.5;

const cases: Array<{
  name: string;
  question: string;
  candidate: string;
  shouldOverride: boolean;
}> = [
  {
    name: 'тот же вопрос другими словами — подмена уместна',
    question: 'Какие услуги оказывает агентство?',
    candidate: 'Какие услуги оказывает агентство',
    shouldOverride: true,
  },
  {
    name: 'короткий общий против длинного специфичного — подмена НЕ уместна',
    question: 'сколько стоит апостиль',
    candidate: 'Сколько стоит апостиль на справку о несудимости из другого региона',
    shouldOverride: false,
  },
  {
    name: 'общий вопрос про перевод против узкого про нострификацию',
    question: 'сколько стоит перевод',
    candidate: 'Помогаете ли вы с нострификацией иностранного образования и сколько стоит перевод диплома',
    shouldOverride: false,
  },
  {
    name: 'совсем другой вопрос',
    question: 'Какие у вас офисы в Санкт-Петербурге?',
    candidate: 'Сколько стоит апостиль на справку о несудимости',
    shouldOverride: false,
  },
  {
    name: 'переформулировка с тем же смыслом и объёмом',
    question: 'Нужен ли оригинал документа для заверения перевода?',
    candidate: 'Нужен ли оригинал документа для заверения и сшития перевода',
    shouldOverride: true,
  },
];

let failed = 0;
for (const c of cases) {
  const o = overlap(c.question, c.candidate);
  const overrides = o.short >= SHORT_GATE && o.long >= LONG_GATE;
  const ok = overrides === c.shouldOverride;
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      short=${o.short.toFixed(2)} long=${o.long.toFixed(2)} → подмена=${overrides}, ожидали=${c.shouldOverride}`
  );
}

console.log(`\n${cases.length - failed}/${cases.length} прошло`);
if (failed > 0) process.exit(1);
