/**
 * Разметка корпуса живых обращений (may2026-knowledge-base-final.json) по трём осям:
 * механизм ответа, цена ошибки, возможность автономного ответа.
 *
 * Разметка делается батчами через Anthropic Messages API.
 * Запуск: railway run npx tsx scripts/label-traffic-map.ts
 */
import * as fs from 'fs';
import * as path from 'path';

type Item = {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
  confidence: number;
};

type Labels = {
  i: number;
  mechanism: string;
  error_cost: string;
  autonomy: string;
  needs_external_data?: string;
};

const MECHANISMS = [
  'stable_fact',
  'conditional_rule',
  'calculation',
  'dynamic_data',
  'order_state',
  'consultation',
  'unknown_to_us',
];
const COSTS = ['money', 'lost_order', 'reputation', 'low'];
const AUTONOMY = ['auto_safe', 'auto_risky', 'human_only'];

const MODEL = process.env.LABEL_MODEL || 'claude-sonnet-5';
const BATCH = Number(process.env.LABEL_BATCH || 12);

const SYSTEM_V2 = `Ты аналитик бюро переводов «Аврора» (Санкт-Петербург). Тебе дают реальные вопросы клиентов и реальные ответы операторов. Размечай каждый вопрос по трём осям, СТРОГО по процедуре ниже. Отвечай валидным JSON-массивом, без пояснений и без markdown-обёртки.

ОСЬ 1 — mechanism. Иди по списку СВЕРХУ ВНИЗ и бери ПЕРВЫЙ подошедший пункт. Не выбирай «самый похожий» — выбирай первый сработавший.
1. order_state — вопрос про конкретный заказ конкретного клиента (готово ли, где мой перевод, когда заберу, дошла ли оплата).
2. dynamic_data — для ответа нужны сведения, которые устаревают сами, без правки базы знаний: график работы офиса, часы приёма, праздники и выходные, текущая загрузка нотариуса, «сколько ждать сегодня», актуальные адреса офисов, наличие свободного времени. АДРЕСА И ЧАСЫ РАБОТЫ ОФИСОВ — ВСЕГДА dynamic_data.
3. unknown_to_us — правильный ответ определяет третья сторона (посольство, консульство, вуз, принимающая инстанция, иностранный госорган), и ответ оператора по сути сводится к «уточняйте у них». Если «уточните у принимающей стороны» — лишь приписка к содержательному ответу, это НЕ unknown_to_us.
4. calculation — чтобы ответить, надо получить ЧИСЛО из тарифов: сумма, ставка × объём, итоговая цена, размер надбавки, итоговый срок в днях по объёму. ВАЖНО: объяснение МЕТОДА счёта без вычисления числа (что такое условная страница, 1800 знаков, из чего складывается цена) — это НЕ calculation, это stable_fact.
5. conditional_rule — в ответе есть развилка: разные исходы в зависимости от типа/происхождения/состояния документа, страны, органа, языка, статуса клиента (физлицо/юрлицо), выбора клиента. Маркеры: «если … то», «для российских — одно, для иностранных — другое», «зависит от того, …». Правило вида «считается как два заверения» — тоже conditional_rule (правило подсчёта, а не вычисление).
6. consultation — ответить нельзя без встречных уточнений, набор вариантов открыт («какие документы нужны именно мне»).
7. stable_fact — единый безусловный ответ, одинаковый для всех, кто задаёт этот вопрос: определения, перечни услуг, сроки хранения, «да, делаем / нет, не делаем», методика счёта, стандартный срок.

ОСЬ 2 — error_cost. Бери САМЫЙ ВЫСОКИЙ подошедший пункт (money > lost_order > reputation > low).
1. money — в верном ответе фигурирует цена, тариф, скидка, порядок или размер оплаты, ЛИБО срок исполнения; ошибка = не та сумма или невыполнимый срок. Сюда же — если из ответа следует, что клиенту придётся заплатить ещё раз.
2. lost_order — ответ по сути «делаем ли мы это»: отказ, согласие, переадресация к третьим лицам («идите к нотариусу»), адрес и как добраться. Ошибка отпугивает клиента или отправляет его мимо бюро.
3. reputation — ошибка путает процедуру, порядок шагов или требования к документам: клиент теряет время и доверие, но не деньги напрямую.
4. low — всё остальное (формат файла, оформление, мелкие организационные детали).

ОСЬ 3 — autonomy. Строго по правилам, сверху вниз:
1. human_only — если mechanism = order_state, consultation или unknown_to_us; ЛИБО если нужный факт устаревает сам и его в базе знаний нет (праздники, календарь, текущая загрузка, «сегодняшние» сроки госорганов).
2. auto_risky — если mechanism = conditional_rule или calculation; ЛИБО если в верном ответе есть цена/тариф/скидка или срок исполнения; ЛИБО если mechanism = dynamic_data, но нужный факт в базе хранится и лишь может устареть (адреса офисов, часы работы).
3. auto_safe — всё остальное.

ОСЬ 4 — needs_external_data: строка, один из вариантов: "crm" (состояние заказа), "schedule" (график/календарь/праздники/текущая загрузка), "third_party" (требования посольства/вуза/иностранного госоргана), "price_engine" (нужен расчёт по тарифам), "none".

Формат ответа: массив объектов [{"i": <номер>, "mechanism": "...", "error_cost": "...", "autonomy": "...", "needs_external_data": "..."}, ...]. Ровно столько элементов, сколько вопросов на входе, в том же порядке.`;

const SYSTEM_V1 = `Ты аналитик бюро переводов «Аврора» (Санкт-Петербург). Тебе дают реальные вопросы клиентов и реальные ответы операторов. Твоя задача — разметить каждый вопрос по трём осям. Отвечай СТРОГО валидным JSON-массивом, без пояснений и без markdown-обёртки.

ОСЬ 1 — mechanism (механизм, которым получается ответ):
- stable_fact — устойчивый факт или определение, которое не меняется и не зависит от условий («что такое условная страница», «какие услуги вы оказываете», «сколько хранится готовый заказ»).
- conditional_rule — правило с условием/развилкой: ответ зависит от типа документа, страны, органа, региона, статуса клиента («если документ выдан в другом регионе, то…», «на копию иностранного документа апостиль нельзя, на российского — можно»).
- calculation — чтобы ответить, надо посчитать: цена по объёму / языку / срочности / числу заверений, итоговая сумма или итоговый срок.
- dynamic_data — зависит от текущих данных вне базы знаний: расписание работы, календарь праздников, текущая загрузка нотариуса, актуальные адреса и часы офисов, сроки госорганов на сегодня.
- order_state — про конкретный заказ конкретного клиента: где мой перевод, готово ли, когда заберу, куда пришли деньги.
- consultation — однозначного ответа нет, нужен диалог и уточнения: какой набор документов нужен именно вам, как лучше поступить в вашей ситуации.
- unknown_to_us — у самой компании нет установленного ответа: вопрос про требования третьей стороны (посольство, вуз, конкретный чиновник), ответ вида «уточняйте у них».

Если подходят несколько — выбирай тот, БЕЗ которого ответ невозможен. Порядок приоритета при сомнении: order_state > dynamic_data > calculation > conditional_rule > unknown_to_us > consultation > stable_fact.

ОСЬ 2 — error_cost (во что обходится неверный ответ):
- money — прямые деньги: названа не та цена, обещан невозможный срок, клиент заплатил за ненужную процедуру или недоплатил.
- lost_order — верный по факту риск потерять заказ: бот отпугнул клиента, отказал в услуге, которая есть, или отправил клиента мимо бюро (к конкуренту, «идите к нотариусу», неверный адрес).
- reputation — неверно, но не денежно: перепутана процедура или порядок шагов, клиент теряет время и доверие.
- low — ошибка почти безвредна.

ОСЬ 3 — autonomy (может ли бот отвечать сам):
- auto_safe — может отвечать сам, ошибка маловероятна и дёшева.
- auto_risky — технически может, но ошибка дорога (деньги/срок/потерянный заказ) — нужен контроль человека или очень точный источник.
- human_only — обязан идти к человеку: нужны данные, которых у базы знаний нет в принципе (CRM, состояние заказа, текущее расписание/календарь, требования третьей стороны, индивидуальная консультация).

ОСЬ 4 — needs_external_data: строка. Если для точного ответа нужны данные, которых нет в базе знаний, назови источник одним из: "crm" (состояние заказа), "schedule" (график/календарь/праздники/загрузка), "third_party" (требования посольства/вуза/госоргана), "price_engine" (расчёт по тарифам), "none".

Формат ответа: массив объектов [{"i": <номер>, "mechanism": "...", "error_cost": "...", "autonomy": "...", "needs_external_data": "..."}, ...]. Ровно столько элементов, сколько вопросов на входе, в том же порядке.`;

const SYSTEM = process.env.LABEL_PROMPT === 'v1' ? SYSTEM_V1 : SYSTEM_V2;
const OUT_FILE = process.env.LABEL_OUT || 'scratchpad/labels-model-v2.json';

async function callApi(payload: unknown, attempt = 1): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return callApi(payload, attempt + 1);
    }
    throw new Error(`API ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return json.content.filter((c) => c.type === 'text').map((c) => c.text || '').join('');
}

function parseJsonArray(raw: string): Labels[] {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error(`no JSON array in: ${raw.slice(0, 300)}`);
  return JSON.parse(t.slice(start, end + 1)) as Labels[];
}

async function main() {
  const corpusPath = path.join(process.cwd(), 'docs/email-bot/may2026-knowledge-base-final.json');
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as Item[];
  const outPath = path.join(process.cwd(), OUT_FILE);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const done: Record<number, Labels> = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
    : {};

  const failures: string[] = [];
  const todo = corpus.map((_, i) => i).filter((i) => !(i in done));
  console.log(`corpus=${corpus.length} already=${Object.keys(done).length} todo=${todo.length} model=${MODEL}`);

  for (let b = 0; b < todo.length; b += BATCH) {
    const chunk = todo.slice(b, b + BATCH);
    const payloadItems = chunk.map((i) => ({
      i,
      category: corpus[i].category,
      price_dependent: corpus[i].price_dependent,
      question: corpus[i].question,
      operator_answer: corpus[i].answer,
    }));
    const userMsg = `Размети следующие ${chunk.length} вопросов:\n\n${JSON.stringify(payloadItems, null, 1)}`;
    try {
      const raw = await callApi({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      });
      const parsed = parseJsonArray(raw);
      for (const p of parsed) {
        if (!chunk.includes(p.i)) {
          failures.push(`batch@${b}: unexpected index ${p.i}`);
          continue;
        }
        if (!MECHANISMS.includes(p.mechanism) || !COSTS.includes(p.error_cost) || !AUTONOMY.includes(p.autonomy)) {
          failures.push(`i=${p.i}: invalid label ${p.mechanism}/${p.error_cost}/${p.autonomy}`);
          continue;
        }
        done[p.i] = p;
      }
      const missing = chunk.filter((i) => !(i in done));
      if (missing.length) failures.push(`batch@${b}: missing ${missing.join(',')}`);
      console.log(`batch ${b}..${b + chunk.length - 1}: ok=${parsed.length} total=${Object.keys(done).length}`);
    } catch (e) {
      failures.push(`batch@${b} (${chunk.join(',')}): ${(e as Error).message}`);
      console.log(`batch ${b}: FAILED ${(e as Error).message}`);
    }
    fs.writeFileSync(outPath, JSON.stringify(done, null, 1));
  }

  fs.writeFileSync(
    path.join(process.cwd(), 'scratchpad/labels-failures.json'),
    JSON.stringify({ model: MODEL, labeled: Object.keys(done).length, total: corpus.length, failures }, null, 1),
  );
  console.log(`DONE labeled=${Object.keys(done).length}/${corpus.length} failures=${failures.length}`);
  if (failures.length) console.log(failures.join('\n'));
}

void main();
