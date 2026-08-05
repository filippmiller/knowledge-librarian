/**
 * Общая логика извлечения знаний из переписки, используемая
 * extract-knowledge.mjs и extract-knowledge-range.mjs: промпт, ретраи с
 * экспоненциальным бэкоффом на 429/500/503, чтение Retry-After.
 *
 * Первый прогон на 640 тредах при concurrency=6 без ретраев уложил 608 из 640
 * в rate limit (TPM у gpt-4o) в первую же минуту — почти полный отказ, а не
 * частичный пробел. Без ретраев скрипт молча теряет знания, отчитываясь
 * «готово».
 */
export const SYSTEM = `Ты — аналитик базы знаний агентства ПЕРЕВОДОВ и ЛЕГАЛИЗАЦИИ документов (Санкт-Петербург, «Аврора»). На вход — переписка оператора с клиентом по ОДНОЙ сделке (КЛИЕНТ/КОМПАНИЯ, по времени). Твоя задача — извлечь ТОЛЬКО переиспользуемые ЗНАНИЯ, которые помогут отвечать БУДУЩИМ клиентам.

ИЗВЛЕКАЙ (это знания):
- capability — что компания делает/не делает: нотариальная копия, апостиль, легализация для страны X, доверенность в офисе, выезд, заверение чужого перевода и т.п.
- requirement — что нужно для услуги: оригинал, скан полного разворота паспорта, подписанный бланк, личное присутствие, согласие на обработку и т.п.
- process — как устроена услуга: перевод между двумя иностранными языками идёт через русский; «копия с копии»; стадии апостиля; где ставится апостиль (ЗАГС/Минюст/МВД); что делать с документом из другого региона.
- policy — правила: предоплата (%), кто может забрать документы (по доверенности), рабочие часы, обмен закрывающими по ЭДО, способы оплаты.
- location — офисы, самовывоз, доставка как услуга.
- pricing_policy — КАК считается цена (по знакам готового перевода, заверение +за документ, срочность), но НЕ конкретные суммы.

НЕ ИЗВЛЕКАЙ (выбрось полностью):
- Статус конкретного заказа: «когда готово», «оплату произвёл», «документ получил», «на какой стадии».
- Разовые факты: конкретные суммы, даты готовности, имена людей, номера заказов, ссылки на оплату.
- Благодарности, согласования, приветствия, «принято/ок».
- Всё, что нельзя переиспользовать для ДРУГОГО клиента.

ПРАВИЛА ОБОБЩЕНИЯ:
1. Убери имена, номера заказов, конкретные суммы и даты.
2. Вопрос сформулируй как ОБЩИЙ (как будущий клиент спросит), а не про конкретный заказ.
3. Ответ — переиспользуемое ПРАВИЛО компании, своими словами, кратко и точно.
4. Если ответ зависел от конкретной цены/срока — поставь price_dependent=true и в ответе опиши политику, НЕ называй сумму.
5. confidence: насколько уверенно это общее правило компании (0..1). Если знание спорное/разовое — ниже.
6. Если в треде нет переиспользуемых знаний — верни {"items":[]}.
7. question и answer — ВСЕГДА по-русски, даже если переписка велась на другом языке (часть клиентов иностранные). Факт о компании не зависит от языка, на котором его один раз спросили.

Верни СТРОГО JSON:
{"items":[{"type":"capability|requirement|process|policy|location|pricing_policy","question":"...","answer":"...","price_dependent":bool,"confidence":0.0}]}`;

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export const MAX_RETRIES = 6;

/**
 * @param {string} transcript
 * @param {{key: string, model: string, label?: string}} opts
 */
export async function extract(transcript, { key, model, label = '' }) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: transcript }],
      }),
    });
    if (r.status === 429 || r.status === 500 || r.status === 503) {
      if (attempt === MAX_RETRIES) {
        const body = await r.text();
        throw new Error(`после ${MAX_RETRIES} попыток: ${r.status} ${body.slice(0, 200)}`);
      }
      const retryAfterHeader = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : 1000 * 2 ** attempt + Math.random() * 500;
      if (attempt >= 2) console.log(`  ⏳ ${label}: ${r.status}, попытка ${attempt + 1}/${MAX_RETRIES + 1}, жду ${Math.round(waitMs)}мс`);
      await sleep(waitMs);
      continue;
    }
    const j = await r.json();
    if (!j.choices) throw new Error(JSON.stringify(j).slice(0, 300));
    return JSON.parse(j.choices[0].message.content).items || [];
  }
  return [];
}
