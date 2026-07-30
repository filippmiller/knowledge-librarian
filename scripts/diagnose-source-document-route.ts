/**
 * Противоречие про исходник для нотариального заверения — замер на проде.
 *
 * Владелец назвал три маршрута: простая ксерокопия, нотариальная копия,
 * оригинал; выбор определяется дальнейшим путём документа, а не предпочтением
 * клиента (docs/bot-audit/03-price-rules-from-owner.md §5). Правила базы R-417 и
 * R-333 называют только два, а эталонные пары противоречат друг другу. Аудит
 * зафиксировал, что на два похожих вопроса бот отвечает «по вашему выбору» и
 * «подшивается именно к оригиналу» — это противоречие фактам, то есть ошибка по
 * определению владельца.
 *
 * Скрипт задаёт одну и ту же суть в разных формулировках и печатает, какой
 * маршрут назван в каждом ответе. Расхождение между формулировками и есть
 * измеряемая величина.
 *
 * Запуск: npx tsx scripts/diagnose-source-document-route.ts
 */

const ENDPOINT = 'https://avrora-library-production.up.railway.app/api/ask';

const QUESTIONS = [
  'К чему подшивается нотариальный перевод — к оригиналу, к копии или к нотариальной копии?',
  'Нужен ли оригинал документа для нотариального заверения перевода?',
  'Можно ли сделать нотариальный перевод по скану, без оригинала?',
  'Я в другом городе, оригинал прислать не могу. Сможете сделать нотариальный перевод?',
  'Обязательно ли привозить оригинал, если нужен нотариально заверенный перевод?',
  'Что вы подшиваете к переводу, если я принесу только ксерокопию?',
];

/** Какие маршруты названы в ответе. Считается по упоминанию, а не по смыслу. */
function routesMentioned(answer: string): string[] {
  const routes: Array<[string, RegExp]> = [
    ['ксерокопия/скан', /ксерокопи|обычн[а-яё]*\s+копи|прост[а-яё]*\s+копи|скан[а-яё]*|распечатк/iu],
    ['нотариальная копия', /нотариальн[а-яё]*\s+копи/iu],
    ['оригинал', /оригинал/iu],
  ];
  return routes.filter(([, re]) => re.test(answer)).map(([name]) => name);
}

/** Отказ «без оригинала нельзя» — по владельцу это неверный ответ. */
const DENIES_WITHOUT_ORIGINAL =
  /(?:нужен|нужны|необходим|обязателен|требуется|только)\s+(?:именно\s+)?оригинал|без\s+оригинала\s+(?:нельзя|не\s+)/iu;

/** «На ваш выбор» — по владельцу ответ неполон: маршрут задаёт путь документа. */
const OFFERS_CHOICE = /на\s+ваш[а-яё]*\s+выбор|по\s+ваш[а-яё]*\s+(?:выбору|усмотрени)|любой\s+из\s+вариантов/iu;

/** Спрашивает ли бот то, от чего маршрут реально зависит. */
const ASKS_DESTINATION =
  /(?:для\s+как[а-яё]*\s+(?:стран|организац|инстанц|учреждени))|куда\s+(?:вы\s+)?(?:подаёте|подаете|будете\s+подавать|нужно\s+подать)|принимающ[а-яё]*\s+сторон/iu;

async function main() {
  const seen: string[][] = [];

  for (const q of QUESTIONS) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const j = (await res.json()) as Record<string, unknown>;
      const r = (j.result as Record<string, unknown>) ?? j;
      const answer = String(r.draftAnswer ?? r.answer ?? '');
      const routes = routesMentioned(answer);
      seen.push(routes);

      console.log('\n════════════════════════════════════════');
      console.log('ВОПРОС:', q);
      console.log(
        `delivery=${String(r.delivery)} review=${String(r.requiresHumanReview)} ` +
          `withheld=${String(r.answerWithheld)} source=${String(r.answerSource)}`
      );
      console.log(`маршруты названы: ${routes.length ? routes.join(', ') : '—'}`);
      console.log(
        `отказ без оригинала: ${DENIES_WITHOUT_ORIGINAL.test(answer)} | ` +
          `«на ваш выбор»: ${OFFERS_CHOICE.test(answer)} | ` +
          `спрашивает назначение: ${ASKS_DESTINATION.test(answer)}`
      );
      console.log('ОТВЕТ:', answer.replace(/\n+/g, ' ').slice(0, 600));
    } catch (e) {
      console.log('\nВОПРОС:', q, '\n  ОШИБКА СЕТИ:', String(e).slice(0, 160));
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }

  const signatures = new Set(seen.map((r) => r.slice().sort().join('+')));
  console.log(
    `\nответов: ${seen.length}; различных наборов маршрутов: ${signatures.size} ` +
      `(${[...signatures].join(' | ')})`
  );
  console.log(
    'Один и тот же набор во всех ответах означает, что противоречие снято. ' +
      'Разные наборы — что ответ зависит от формулировки.'
  );
}

main();
