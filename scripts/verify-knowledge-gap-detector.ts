/**
 * Regression check for answerSignalsKnowledgeGap.
 *
 * A draft that admits it has no data must be routed to an operator, never
 * auto-sent. On 2026-07-30 production answered "В базе знаний не указана
 * стоимость апостиля именно на справку о несудимости из Алтайского края…"
 * with requiresHumanReview=false, because the pattern only matched the neuter
 * "не указано". Real answers agree with the noun's gender and number.
 *
 * Run: npx tsx scripts/verify-knowledge-gap-detector.ts
 */
import { answerSignalsKnowledgeGap } from '@/lib/ai/enhanced-answering-engine';

const cases: Array<{ answer: string; expected: boolean; name: string }> = [
  {
    name: 'реальный ответ с прода 30.07 — женский род',
    expected: true,
    answer:
      'В базе знаний не указана стоимость апостиля именно на справку о несудимости из Алтайского края. Для уточнения рекомендуем связаться с компанией напрямую.',
  },
  {
    name: 'средний род — исходный поддержанный случай',
    expected: true,
    answer: 'В базе знаний не указано, в какие сроки оформляется документ.',
  },
  {
    name: 'множественное число',
    expected: true,
    answer: 'В предоставленных источниках не указаны сроки оформления.',
  },
  {
    name: 'источники не упоминают регион',
    expected: true,
    answer: 'Документы из других регионов, включая Алтайский край, в источниках не упоминаются.',
  },
  {
    name: 'отфутболивание к менеджеру',
    expected: true,
    answer: 'Точную цену подскажет менеджер — рекомендуем обратиться к нам напрямую.',
  },
  {
    name: 'не удалось подтвердить',
    expected: true,
    answer: 'Не удалось подтвердить, работает ли отдел в субботу.',
  },
  {
    name: 'полноценный ответ с фактами — не пробел',
    expected: false,
    answer:
      'Государственная пошлина за проставление апостиля составляет 2500 рублей. Каждый документ оплачивается отдельно.',
  },
  {
    name: 'guardrail «мы этого не делаем» — это ответ, а не пробел',
    expected: false,
    answer:
      'Наше бюро ставит апостиль на оригиналы ЗАГС только для документов, выданных в Санкт-Петербурге и Ленинградской области. Если документ выдан в другом регионе, апостиль нужно ставить по месту выдачи.',
  },
  {
    name: 'адрес и график — не пробел',
    expected: false,
    answer:
      'Приём документов на апостиль ведётся с 9:30 до 12:00 и с 13:00 до 15:30 по адресу: Санкт-Петербург, ул. Большая Морская, д. 41.',
  },
];

let failed = 0;
for (const c of cases) {
  const actual = answerSignalsKnowledgeGap(c.answer);
  const ok = actual === c.expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ожидали=${c.expected} получили=${actual}`);
}

console.log(`\n${cases.length - failed}/${cases.length} прошло`);
if (failed > 0) process.exit(1);
