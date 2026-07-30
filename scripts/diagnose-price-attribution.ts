// Косвенные вопросы про цену заверения — там, где раньше возникала ошибка «260 вместо 1100».
// Прогон против прода, клиентский контур (аноним).
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';

const URL = 'https://avrora-library-production.up.railway.app/api/ask';
const QUESTIONS = [
  'Чем вы можете заверить перевод — нотариусом, печатью вашего бюро или можно обойтись без заверения?',
  'Если мне нужен перевод срочно, это повлияет на цену? И как срочность влияет на стоимость заверения документов?',
  'Нужно заверить пять документов, как считается стоимость?',
  'Сколько будет стоить заверение диплома и приложения к нему?',
  'Что дешевле — нотариальное заверение или заверение печатью бюро, и на сколько?',
  'Мне нужен перевод паспорта с заверением, назовите итоговую цену.',
  'Заверение перевода на несколько страниц — цена считается за страницу или за документ?',
  'Сколько стоит заверить копию документа у нотариуса и сколько сам перевод заверить?',
];

async function main() {
for (const q of QUESTIONS) {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    const j = await res.json();
    const r = j.result || j;
    const draft = r.draftAnswer || r.answer || '';
    const v = checkCertificationPriceAttribution(draft);
    console.log('\n════════════════════════════════════════');
    console.log('ВОПРОС:', q);
    console.log(`delivery=${r.delivery} review=${r.requiresHumanReview} withheld=${r.answerWithheld} conf=${(r.confidence ?? 0).toFixed(2)}`);
    console.log(`проверка приписки: связано пар ${v.checked}, противоречий ${v.contradictions.length}`);
    for (const c of v.contradictions) console.log(`   ⚠ ${c.serviceLabel}: назвал ${c.claimed}, прайс ${c.expected}\n     «${c.sentence}»`);
    console.log('ОТВЕТ:', draft.replace(/\n+/g, ' ').slice(0, 700));
  } catch (e) {
    console.log('\nВОПРОС:', q, '\n  ОШИБКА:', String(e).slice(0, 200));
  }
  await new Promise((r) => setTimeout(r, 4000));
}
}
main();
