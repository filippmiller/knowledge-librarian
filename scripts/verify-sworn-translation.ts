/**
 * Присяжный перевод и ответ про суд.
 * Запуск: npx tsx scripts/verify-sworn-translation.ts
 *
 * Повод — забракованный владельцем бюро живой ответ 31.07.2026: на вопрос про
 * пакет документов для суда бот предложил «присяжный перевод», которого в
 * России не существует. Ошибка пришла с ветки общих знаний: правил про
 * присяжный перевод в базе ноль.
 */
import {
  checkSwornTranslationClaim,
  resolveCourtTranslation,
} from '../src/lib/knowledge/sworn-translation';
import { buildDeterministicGuardrailResultForTests } from '../src/lib/ai/enhanced-answering-engine';
import { checkClientSafety } from '../src/lib/knowledge/audience';

let failed = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

/* --- утверждение про присяжный перевод --- */

const MUST_FLAG = [
  // Дословно из забракованного ответа.
  'Перевод, заверенный нотариусом, или присяжный перевод — в зависимости от того, какой суд принимает.',
  'Для суда подойдёт присяжный перевод.',
  'Мы делаем присяжные переводы.',
  'Присяжный перевод стоит дороже нотариального.',
];
for (const answer of MUST_FLAG) {
  const v = checkSwornTranslationClaim(answer);
  check(`ловится: «${answer.slice(0, 60)}…»`, !v.safe);
}

const MUST_PASS = [
  // Верное отрицание глушить нельзя.
  'В России института присяжного перевода не существует.',
  'Присяжного перевода в России нет — есть нотариальный перевод и заверение штампом бюро.',
  'Мы не делаем присяжный перевод.',
  // Отнесено к загранице — это верно.
  'За рубежом бывает присяжный перевод, в России такой услуги нет.',
  'В другой стране может потребоваться присяжный переводчик, зарегистрированный при консульстве.',
  'Присяжный перевод выполняет переводчик, зарегистрированный при консульстве соответствующей страны.',
  // Вообще не про то.
  'Нотариальное заверение перевода стоит 1100 рублей за документ.',
];
for (const answer of MUST_PASS) {
  const v = checkSwornTranslationClaim(answer);
  check(`проходит: «${answer.slice(0, 60)}…»`, v.safe, v.violations.map((x) => x.sentence).join(' | '));
}

/* --- ветка про суд --- */

check('суд в РФ опознаётся', resolveCourtTranslation('Какой пакет документов нужен для подачи перевода в суд?').kind === 'russian_court');
check('зарубежный суд опознаётся', resolveCourtTranslation('Нужен перевод для суда в Германии, что требуется?').kind === 'foreign_court');
check('не про суд — молчим', resolveCourtTranslation('Сколько стоит апостиль на диплом?').kind === 'unknown');
check(
  'РЕГРЕССИЯ: «судимость» не читается как суд',
  resolveCourtTranslation('Нужен апостиль на справку о несудимости').kind === 'unknown'
);

const ruCourt = buildDeterministicGuardrailResultForTests(
  'Какой пакет документов нужен для подачи перевода в суд?',
  'client'
);
check('суд в РФ: клиент получает ответ', ruCourt !== null);
check('суд в РФ: клиенту НЕ уходит заглушка', Boolean(ruCourt && !/уточню детали/iu.test(ruCourt.answer)));
check(
  'суд в РФ: названы оба допустимых варианта',
  Boolean(ruCourt && /нотариальн/iu.test(ruCourt.answer) && /штамп/iu.test(ruCourt.answer))
);
check(
  'суд в РФ: присяжный перевод клиенту НЕ предлагается',
  Boolean(ruCourt && checkSwornTranslationClaim(ruCourt.answer).safe),
  ruCourt?.answer.slice(0, 120)
);
const ruSafety = ruCourt ? checkClientSafety(ruCourt.answer) : null;
check('суд в РФ: клиентский текст проходит сигнализацию утечки', Boolean(ruSafety?.safe), ruSafety?.violations.join(', '));

const foreignCourt = buildDeterministicGuardrailResultForTests(
  'Нужен перевод для суда в Германии, что требуется?',
  'client'
);
check('зарубежный суд: клиент получает ответ', foreignCourt !== null);
check(
  'зарубежный суд: сказано, что такой перевод мы не делаем и цену не считаем',
  Boolean(foreignCourt && /не\s+(?:делаем|считаем|рассчитыва)/iu.test(foreignCourt.answer))
);
const foreignSafety = foreignCourt ? checkClientSafety(foreignCourt.answer) : null;
check('зарубежный суд: клиентский текст проходит сигнализацию утечки', Boolean(foreignSafety?.safe), foreignSafety?.violations.join(', '));

/* --- язык клиентских текстов --- */

// Владелец бюро: «Пусть не выдумывает слова! А берёт из ответов менеджеров в
// истории переписки». Проверено по корпусу из 180 реальных ответов менеджеров:
// «маршрут» не встречается ни разу. Слово попало в тексты от меня, не от них.
const INVENTED_WORDS = /маршрут|исходник|опци[яю]|конфигурац/iu;

const CLIENT_TEXTS: Array<[string, string]> = [
  ['суд в РФ', 'Какой пакет документов нужен для подачи перевода в суд?'],
  ['зарубежный суд', 'Нужен перевод для суда в Германии, что требуется?'],
  ['к чему подшивается', 'К чему подшивается нотариальный перевод — к оригиналу или к копии?'],
  ['строгая подача', 'Можно ли по скану сделать нотариальный перевод для консульства?'],
];
for (const [name, question] of CLIENT_TEXTS) {
  const r = buildDeterministicGuardrailResultForTests(question, 'client');
  const clean = Boolean(r && !INVENTED_WORDS.test(r.answer));
  check(`клиентский текст без придуманных слов: ${name}`, clean, r?.answer.match(INVENTED_WORDS)?.[0]);
}

console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
