/**
 * Проверка приписки цены на живом проде.
 *
 * Скрипт задаёт проду вопросы про цены заверения и сверяет ЕГО ответ с таблицей
 * прайса здесь, локально. Печатаются два вывода рядом: что насчитала проверка и
 * что решил прод (`requiresHumanReview`). Их расхождение означает, что
 * задеплоенный код проверку не выполняет, — именно этот класс дефекта трижды за
 * прошлую сессию не ловился зелёными тестами и обнаруживался только запросом к
 * проду.
 *
 * Запуск: npx tsx scripts/diagnose-price-attribution.ts
 */
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';

const URL = 'https://avrora-library-production.up.railway.app/api/ask';

const QUESTIONS = [
  'Чем вы можете заверить перевод — нотариусом, печатью вашего бюро или можно обойтись без заверения?',
  'Если мне нужен перевод срочно, это повлияет на цену? И как срочность влияет на стоимость заверения документов?',
  'Нужно заверить пять документов, как считается стоимость?',
  'Что дешевле — нотариальное заверение или заверение печатью бюро, и на сколько?',
  'Заверение перевода на несколько страниц — цена считается за страницу или за документ?',
  'Сколько стоит заверить копию документа у нотариуса и сколько сам перевод заверить?',
  'Подскажите, как у вас рассчитывается цена, если нужно заверить сразу несколько документов? И вообще, какие варианты заверения вы предлагаете?',
  'У меня договор на 12 страниц, нужно нотариальное заверение перевода. Сколько это будет стоить с учётом страниц?',
  'Нотариальное заверение считается постранично? У меня документ на 4 листа.',
  'Мне сказали, что заверение перевода стоит 260 рублей за страницу. Это так?',
  'Сколько стоит перевести и заверить свидетельство о рождении, и сколько будет нотариальная копия?',
  'Нужно заверить перевод справки и снять с неё нотариальную копию — посчитайте обе услуги.',
];

async function main() {
  let flagged = 0;
  let seamBroken = 0;

  for (const q of QUESTIONS) {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const j = (await res.json()) as Record<string, unknown>;
      const r = (j.result as Record<string, unknown>) ?? j;
      const answer = String(r.draftAnswer ?? r.answer ?? '');
      const v = checkCertificationPriceAttribution(answer);
      if (v.contradictions.length) flagged += 1;

      // Прод обязан пометить противоречие ручной проверкой. Нашли здесь, а прод
      // не пометил — значит стык между проверкой и движком не работает.
      const broken = v.contradictions.length > 0 && r.requiresHumanReview !== true;
      if (broken) seamBroken += 1;

      console.log('\n════════════════════════════════════════');
      console.log('ВОПРОС:', q);
      console.log(
        `delivery=${String(r.delivery)} review=${String(r.requiresHumanReview)} ` +
          `withheld=${String(r.answerWithheld)} conf=${Number(r.confidence ?? 0).toFixed(2)}`
      );
      console.log(
        `проверка приписки: связано пар ${v.checked}, противоречий ${v.contradictions.length}` +
          (broken ? '  ⛔ ПРОД НЕ ПОМЕТИЛ — СТЫК СЛОМАН' : '')
      );
      for (const c of v.contradictions) {
        console.log(`   ⚠ ${c.serviceLabel}: назвал ${c.claimed}, прайс ${c.expected}`);
        console.log(`     «${c.sentence}»`);
      }
      console.log('ОТВЕТ:', answer.replace(/\n+/g, ' ').slice(0, 600));
    } catch (e) {
      console.log('\nВОПРОС:', q, '\n  ОШИБКА СЕТИ:', String(e).slice(0, 160));
    }
    // Пауза обязательна: первый замер прошлой сессии потерял 8 ответов из 15 на
    // сетевых сбоях именно из-за её отсутствия.
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }

  console.log(
    `\nвопросов: ${QUESTIONS.length}; ответов с противоречием прайсу: ${flagged}; ` +
      `из них прод не пометил: ${seamBroken}`
  );
}

main();
