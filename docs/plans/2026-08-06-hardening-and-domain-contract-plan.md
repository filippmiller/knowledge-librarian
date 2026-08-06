# План: укрепление фундамента + исполняемый доменный контракт до Prisma v2

> Ответ на внешний разбор (ChatGPT) сессии PR #53–59. Написан для двух читателей:
> (1) второй проверки этим же ChatGPT перед выполнением, (2) исполнения СЛЕДУЮЩЕЙ
> сессией — эта уже длинная, автор плана не будет его реализовывать сам.
>
> Формат ниже — не пересказ разбора. Каждый пункт независимо перепроверен по коду
> перед тем, как попасть в раздел «подтверждено» или «оспариваю» — см. команды
> проверки в скобках, их может повторить кто угодно.
>
> **Revision 2 (2026-08-06):** первая версия этого плана получила `REQUEST_CHANGES`
> от того же внешнего ChatGPT-ревью, плюс два независимых открытых замечания от
> Codex на самом PR (см. §3 — оба закрыты добавлением недостающих стадий и
> заменой `--fail-on` на явную gate-семантику). Ревью согласилось с направлением
> (порядок hardening → доменный контракт → пилот → схема правильный, provider-баги
> подтверждены, порядок pgvector/Prisma логичен), но указало, что план физически
> невыполним между PR B и пилотом (нет моста: structured output, QueryFrame,
> extraction, human review, persistence), что PR A слишком большой одним куском,
> что `facets: Record<string, FacetValue>` — будущий EAV, что `evaluateApplicability()`
> требует разбиения на 4 функции, что `grader.independent` — недостаточно одного
> boolean, что gate golden corpus не совпадает с реальным shape `run-eval-corpus.ts`,
> и что эту ветку нужно сначала обновить от текущего `master` (PR #60 уже смержен).
> Все эти пункты учтены ниже; изменения отмечены `[R2]`.

## Как это читать

- **§1** — что из разбора подтвердилось при чтении кода (буквально, не на слово).
- **§2** — что я оспариваю или уточняю, с обоснованием.
- **§3** — предлагаемая последовательность работ (`[R2]`: расширена мостом между
  доменным контрактом и пилотом, PR A разбит на A1–A4, PR B — на B1/B2).
- **§4** — архитектурные вопросы, которые план сознательно НЕ решает сейчас, а
  ставит на пилот 2.3 — чтобы не повторить ошибку "схема раньше пилота" ещё раз,
  на этот раз с фасетами вместо scenario-дерева.
- **§5** — что явно не делать в следующей сессии.
- **§6** — Beads-изменения (готовятся к выполнению ПОСЛЕ утверждения этого плана,
  не раньше).

---

## §1. Подтверждено чтением кода (не с чужих слов)

### 1.1 Provider fallback ломает закреплённую модель — P0

`createChatCompletion()` (`src/lib/ai/chat-provider.ts`) читает
`options.provider ?? getProvider()` для ПЕРВИЧНОЙ попытки, но при фоллбэке:

```ts
const fallbackProvider = provider === 'anthropic' ? 'openai' : 'anthropic';
...
const raw = fallbackProvider === 'openai'
  ? await callOpenAI(options, temperature)
  : await callAnthropic(options, temperature);
```

`options` (включая `options.model`) передаётся БЕЗ ИЗМЕНЕНИЙ. Если вызывающий код
закрепил `model: 'claude-sonnet-5'` через `GRADER_MODEL`, а Anthropic временно не
ответил, фоллбэк уйдёт в OpenAI с тем же `model: 'claude-sonnet-5'` — и упадёт там
тоже, потому что это не модель OpenAI.

**Это не гипотеза** — я поймал ровно это в собственном живом прогоне
`test-extraction-pack.ts` (кейс `Q01-M1`, `scratchpad/extraction-pack/*.json`,
поле `grades[].reasoning: "fetch failed"` → `model_not_found` от OpenAI на строке
`claude-sonnet-5`). Записалось как `GRADER_ERROR`, не уронило прогон — но
диагноз "временный сетевой сбой" я дал неверный, реальная причина — сломанный
контракт фоллбэка.

**Чек**: `grep -n "fallbackProvider" src/lib/ai/chat-provider.ts`

### 1.2 `streamChatCompletionTokens` игнорирует `options.provider` — P1

```ts
export async function* streamChatCompletionTokens(options, _chunkSize = 120) {
  const provider = getProvider();   // не options.provider ?? getProvider()
```

`options.model` в стриминге читается (значит `EXTRACTION_MODEL` без указания
провайдера работает), но `options.provider` — нет. Уточнение относительно
разбора: это НЕ ломает независимость grader'а (grader идёт через нестриминговый
`createChatCompletion`, где `provider` учитывается) — ломает будущую возможность
закрепить `EXTRACTION_PROVIDER` отдельно от `AI_PROVIDER`. Отдельный, менее
острый дефект, не тот же самый, что 1.1.

**Чек**: `grep -n "const provider = getProvider" src/lib/ai/chat-provider.ts`

### 1.3 Retry-путь извлечения не наследует `EXTRACTION_MODEL` — P0

```ts
async function retryBatchExtraction(messages: ChatMessage[]) {
  const retryContent = await createChatCompletion({
    messages: [...messages, {...}],
    temperature: 0,
    responseFormat: 'json_object',
    maxTokens: 16000,
    // нет model — используется дефолт провайдера, не EXTRACTION_MODEL
  });
```

Первичный вызов (`streamChatCompletionTokens`) использует `EXTRACTION_MODEL`,
ретрай при невалидном JSON — нет. Один документ может быть частично извлечён
закреплённой моделью, частично дефолтной, и итог выглядит как один однородный
прогон. Подтверждено буквально — `EXTRACTION_MODEL` встречается в файле ровно
один раз (в первичном вызове).

**Чек**: `grep -n "EXTRACTION_MODEL" src/lib/ai/knowledge-extractor-stream.ts`

### 1.4 `grader.independent` считается по сырым override, не по резолвленной модели — P0

```ts
const extractionModel = process.env.EXTRACTION_MODEL || null;
const graderModel = process.env.GRADER_MODEL || null;
const graderIsIndependent = graderProvider !== extractionProvider || graderModel !== extractionModel;
```

Если `ANTHROPIC_MODEL=X` (общий дефолт) и `GRADER_MODEL=X` заданы одинаково, но
`EXTRACTION_MODEL` не задан — сравнение `null !== 'X'` даёт `true`, хотя фактически
обе стороны используют одну и ту же модель X. Артефакту `grader.independent`
сейчас нельзя доверять без этой правки.

**Чек**: `grep -n "graderIsIndependent" scripts/test-extraction-pack.ts`

### 1.5 `servedByProvider`/`servedByModel` не возвращаются вызывающему коду — P1

Следствие 1.1 и 1.4: `createChatCompletion` возвращает `Promise<string>`, не
структуру с тем, что РЕАЛЬНО обслужило вызов. Без этого 1.1 нельзя ни поймать
надёжно, ни отладить постфактум.

### 1.6 Regex для temperature-retry узкий — P2

`/temperature.{0,40}deprecated/i` — сработал для реальной ошибки Anthropic
(`"temperature" is deprecated for this model`), но не сработает на другую
формулировку той же сути. Не выдумываю других формулировок (это домысел без
доступа к их реальным текстам ошибок) — фиксирую как известный риск, не
блокер: сегодняшний код работает для проверенных моделей.

### 1.7 Truth table: внутренние нестыковки — подтверждено, помельче

- §2-таблица не повторяет `audience` явно в колонке «обязательные поля» для
  `PROCEDURE_STEP`/`EXCEPTION_RULE`/`DELIVERY_RULE`/`PRICE_RULE`, хотя §3.2
  утверждает «audience обязателен при create для ВСЕХ kind, где применим».
  Не противоречие по существу (§3.2 главнее), но читается как нестыковка,
  если смотреть только на таблицу §2.
- `TERM_DEFINITION` в §2 требует `reviewedBy` буквально этим именем поля, а §5
  вводит модель `reviewStatus: UNCLASSIFIED|REVIEWED` — разные имена одного
  понятия в разных разделах одного документа. Моя ошибка, не смысловая, но
  реальная. **[R2]** См. §3 (PR A4) и §4.4 ниже — вводим строгий инвариант
  вместо простого переименования.
- **Моя собственная ошибка счёта**, не в самом документе: в тексте PR #59 и
  комментарии Beads я дважды написал «5 SCOPE dimensions», перечислив ровно
  четыре (`scenario/audience/geography/service`). В самой truth table (§ Термины)
  корректно написано «SCOPE-измерение: scenario, audience, geography, service»
  — четыре. Ошибка в моей коммуникации о документе, не в документе. Исправляю
  здесь письменно; PR-описание на GitHub можно поправить `gh pr edit 59`, если
  это важно для истории.

**Чек**: `grep -n "SCOPE-измерение" docs/plans/2026-08-05-applicability-truth-table.md`

### 1.8 Порядок миграций 2.4 vs 3.1 — буквальное противоречие в одном документе

`docs/plans/2026-08-05-aurora-knowledge-engine-v2.md`:

- Заголовок Задачи 3.1: *«(ПЕРЕД 2.4, не после — циклическая зависимость из v1
  плана исправлена)»*.
- Раздел «Исправленный критический путь»: `...pilot (2.3) → schema correction
  (2.4) → pgvector extension (3.1) → column/backfill/index (3.2)`.

Буквально одно противоречит другому. Разбор прав, что нужно решение. Задача 3.2
уже (без противоречия) зависит от ОБЕИХ — 3.1 и 2.4: `### Задача 3.2 (зависит
от 3.1 и 2.4)`. Отсюда мой вывод, отличный от чистого «варианта A» разбора: не
переставлять критический путь, а поправить ЗАГОЛОВОК 3.1 — у relational-части
2.4 (KnowledgeUnit, KnowledgeEvidence, AnswerVariant и т.д.) нет зависимости от
pgvector вообще; зависимость появляется только у 3.2 (сама vector-колонка),
которая и так помечена как зависящая от обеих. 3.1 можно выполнить когда
угодно до 3.2, независимо от 2.4 — «ПЕРЕД 2.4» в заголовке избыточно и вводит в
заблуждение, критический путь ниже уже верный.

**Чек**: `grep -n "ПЕРЕД 2.4\|Исправленный критический путь" docs/plans/2026-08-05-aurora-knowledge-engine-v2.md`

### 1.9 Golden corpus (`run-eval-corpus.ts`) — два реальных пробела

- Всегда `process.exit(0)` на успешном пути, даже если есть FAIL — нет режима
  gate, только baseline capture (`grep -n "process.exit" scripts/run-eval-corpus.ts`
  → строка 181 внутри успешного пути).
- 6 из 15 кейсов категории `known-good` не имеют явного
  `requiresClarificationOrHold` в `expect` — проверено скриптом по самому
  файлу `eval-corpus.json`. Такой кейс формально PASS, даже если поведение
  бота незаметно съехало в hold: проверяются только те поля, что явно заданы.

**[R2]** Codex независимо указал на связанный пробел на самом PR: копировать
`--fail-on=none|degraded|lost` из `test-extraction-pack.ts` в `run-eval-corpus.ts`
нельзя буквально — у extraction harness есть вердикты `DEGRADED`/`LOST`, у
golden corpus их нет, там только `PASS/FAIL` на кейс. См. §3, PR A3 — вместо
переноса чужой семантики вводим отдельную, подходящую именно этому раннеру.

---

## §2. Что я оспариваю или уточняю

### 2.1 «Golden corpus не полностью read-only» — не новая находка, а известный компромисс

`answerQuestionEnhanced()` действительно пишет fire-and-forget телеметрию
(`HallucinationLog` и подобное) при срабатывании consistency-gate. Это не
открытие этой сессии — тем же способом ("read-only" = "не создаёт
Document/Rule/QAPair", НЕ "нулевые записи вообще") уже работали оба сегодняшних
независимых аудита (`.claude/audits/2026-08-05-*.md`) и весь мой золотой корпус
(PR #56) — та же телеметрия пишется на КАЖДЫЙ обычный вопрос от реального
пользователя, прогон корпуса не создаёт новый класс записей, только больше строк
уже штатного типа. Не оспариваю ценность идеи `telemetryMode: 'disabled'` как
улучшения (добавляю в PR A3, см. §3) — оспариваю рамку «это скрытая проблема»:
это заранее принятое, документированное решение, не сюрприз.

**[R2]** Ревью раунда 2 согласилось с этим доводом ("не скрытый сюрприз"), но
справедливо добавило: это не отменяет необходимость настоящего no-write режима
для production regression runner'а — то, что прежние прогоны уже писали
телеметрию, объясняет историю, но не основание продолжать так делать. Принято
без возражений — `telemetryMode: 'disabled'` остаётся в PR A3, теперь явно как
обязательный пункт, не как опциональное улучшение.

### 2.2 «Legacy numeric evidence должен быть hold, а не участвовать в синтезе как раньше» — реальный компромисс, не очевидный факт

Разбор прав, что §4.2 truth table оставляет числа-в-прозе без governance-проверки
до backfill. Но предложенное решение («UNVERIFIED → hold, пока не пройдёт
backfill») имеет цену: `SCOPE_NULL_STRICT` dry-run в этой же сессии уже показал,
что похожая по духу строгая политика подняла hold-rate с ~27% до 86.7% на золотом
корпусе — то есть аналогичное ужесточение здесь тоже кандидат на резкий рост
удержаний, не бесплатное улучшение. Не отвергаю предложение — фиксирую как
РЕШЕНИЕ, которое нужно принять осознанно с числом в руках (dry-run на золотом
корпусе ДО включения), а не тихо принять как самоочевидно верное.

**[R2] Конкретный эксперимент** (ревью раунда 2 согласилось с доводом, но
потребовало не просто «когда-нибудь dry-run», а точный протокол измерения —
добавляется как задача в PR A4/отдельная задача Beads, см. §6):

Shadow-фиксация (не блокирует ответ, только логирует), reason
`unverified_numeric_evidence`, срабатывает только при ОДНОВРЕМЕННОМ выполнении:

1. финальный ответ содержит числовое утверждение (сумма, срок, количество дней);
2. это утверждение опирается ИСКЛЮЧИТЕЛЬНО на legacy `body` (прозу), не на
   typed `Tariff` или структурный `numericConstraint`;
3. нет второго независимого источника, согласующегося по значению.

Отчёт по прогону золотого корпуса + выборке реальных прод-вопросов за период:

```text
доля ответов с numeric claims
доля ответов, где numeric claim только на legacy prose
число случаев конфликтующих значений между источниками
сколько ответов стало бы hold при UNVERIFIED→hold
сколько из них при ручной проверке сейчас фактически правильны/неправильны
```

Только после этого отчёта выбирается policy (например: internal-аудитория —
разрешить + пометка unverified; client-аудитория — typed-источник авто-отправка,
legacy-only prose — human review). Hold применяется к конкретному
неподтверждённому утверждению, а не ко всему документу, где встретилась цифра
— так стратегия не деградирует в грубую блокировку каждого DocChunk/Rule с
любым числом внутри.

### 2.3 Оценка «Реальная готовность нового v2-движка: 2/10»

Согласен по существу (в runtime нет `ApplicabilityProfile`/`QueryFrame`/
`evaluateApplicability` — и не должно быть, эта работа целенаправленно не
начиналась: план (после ревью Grok+Codex, PR #54) прямо требует truth table
ДО pilot ДО схемы, не наоборот). Числовая оценка не то, с чем можно спорить
предметно — фиксирую согласие, не разбираю дальше.

---

## §3. Предлагаемая последовательность **[R2 — существенно переработано]**

Ревью раунда 1 согласилось с макро-порядком (hardening → доменный контракт →
пилот → схема), но правильно указало на физическую невыполнимость перехода от
PR B прямо к пилоту 2.3: пилоту нужны structured-output контракт, QueryFrame,
структурная экстракция с provenance, human-review формат и временное
persistence — этого не было ни одной задачей между ними. Ниже — полная цепочка
без пропусков, плюс разбиение PR A и PR B на управляемые куски (проверяемые и
откатываемые по отдельности, а не одним PR с шестью несвязанными зонами
изменений).

```
Обновить эту ветку от текущего master (PR #60 уже смержен — сделано в этой
редакции документа)
   ↓
[сделано] 0.0–0.3, 0.6/0.7 (partial), 2.1 (truth table) — PR #55–59
   ↓
A1 — Provider routing & fallback contract
   ↓
A2 — Extraction run consistency (единый ExtractionRunConfig, grader independence)
   ↓
A3 — Eval harness gate semantics (baseline vs gate, no-write mode)
   ↓
A4 — Документация (truth-table consistency, review-status invariant, 3.1 заголовок,
     numeric-evidence эксперимент как задача)
   ↓
B1 — Типизированный доменный контракт: FacetRegistry, ApplicabilityProfile,
     QueryFrame — pure TS/Zod, без Prisma/LLM/БД
   ↓
B2 — Evaluator'ы: eligibility / scope / trigger / multi-unit resolution,
     exhaustive table-driven тесты на каждую строку truth table
   ↓
2.2 — Concept/ConceptAlias, канонические Concept ID (уже в очереди Beads,
     translation-5ii — теперь зависит от B2, не только от 2.1)
   ↓
C — Provider structured-output adapter (типобезопасный JSON-контракт поверх
     Anthropic/OpenAI, с реальной резолвленной моделью в артефакте)
   ↓
D — QueryFrame builder (вопрос + история переписки + канал → typed QueryFrame,
     UNKNOWN для отсутствующих значений, negation, missingRequiredFacets)
   ↓
E — Структурная экстракция + provenance (kind/facets/triggerCondition/
     numericConstraint/parentRuleRef/sourceSpan вместо title+body)
   ↓
F — Human-review артефакт + временное immutable persistence для пилота
     (JSON/JSONL, не production Prisma v2)
   ↓
2.3 — Пилот на 3–5 РЕАЛЬНЫХ документах бюро (не только синтетика про зуд)
   ↓
2.4 — Финальная Prisma-схема v2 (только после B2, C–F и 2.3 дают реальные данные)
   ↓
pgvector (3.1/3.2) / retrieval / shadow / canary — без изменений порядка
```

### PR A1 — Provider routing & fallback contract [P0]

Разбито из исходного пункта 1–2, 5 старого PR A. Только provider-механика,
никакой правки extraction/grader/eval-корпуса в этом PR.

- **Явный fallback-контракт по умолчанию — fail-closed.** Если вызывающий код
  закрепил `options.model` явно, кросс-провайдерный фоллбэк для этого вызова
  ОТКЛЮЧЁН по умолчанию — молчаливая подмена модели хуже честной ошибки,
  особенно для extraction/grader/verifier/benchmark/QueryFrame-построения.
  Явный opt-in при необходимости фоллбэка:

  ```ts
  interface ChatCompletionOptions {
    // ...существующие поля
    providerModels?: { anthropic?: string; openai?: string };
    allowCrossProviderFallback?: boolean; // default: false
  }
  ```

  Если `allowCrossProviderFallback: true`, фоллбэк обязан взять модель из
  `providerModels[fallbackProvider]`, а не переиспользовать `options.model`.
  Обычный клиентский synthesis (не extraction/grader) может продолжать
  разрешать фоллбэк — это решение оставляется на месте вызова, не хардкодится
  в `chat-provider.ts`.

- **Вернуть, что РЕАЛЬНО обслужило вызов — не ломая существующие call sites.**
  Вместо немедленной замены сигнатуры `createChatCompletion(): Promise<string>`
  везде (риск для hardening-PR слишком большой ради одного PR), добавляется
  parallel "detailed" API, а существующая сигнатура становится тонкой обёрткой:

  ```ts
  interface CompletionAttempt {
    provider: Provider;
    model: string;
    startedAt: string;
    latencyMs: number;
    outcome: 'SUCCESS' | 'ERROR';
    statusCode?: number;
    errorCode?: string;
  }

  interface ChatCompletionResult {
    text: string;
    servedByProvider: Provider;
    servedByModel: string;
    fallbackUsed: boolean;
    attempts: CompletionAttempt[];
  }

  async function createChatCompletionDetailed(
    options: ChatCompletionOptions
  ): Promise<ChatCompletionResult>;

  async function createChatCompletion(
    options: ChatCompletionOptions
  ): Promise<string> {
    return (await createChatCompletionDetailed(options)).text;
  }
  ```

  Существующие call sites не трогаются в этом PR. Новый код (A2 extraction,
  grader, будущий C) переходит на `createChatCompletionDetailed`.

- **[P1]** `streamChatCompletionTokens`: `options.provider ?? getProvider()`,
  как уже сделано в `createChatCompletion`. Аналогичная detailed-обёртка для
  стриминга:

  ```ts
  const operation = createChatCompletionStreamDetailed(options);
  for await (const token of operation.tokens) { /* ... */ }
  const metadata = await operation.completion; // ChatCompletionResult без text
  ```

**Acceptance criteria:**
- закреплённая Anthropic-модель никогда не отправляется в OpenAI при фоллбэке;
- без `providerModels[fallbackProvider]` кросс-провайдерный фоллбэк не
  выполняется — вызов завершается ошибкой (fail-closed), не молчаливой
  подменой модели;
- при заданном `providerModels` фоллбэк использует правильный, валидный для
  целевого провайдера model ID;
- `streamChatCompletionTokens` уважает `options.provider`;
- `attempts[]` в `ChatCompletionResult` содержит каждую попытку (primary +
  fallback, если был);
- тесты: primary success, primary fail → fallback success (с `providerModels`),
  primary fail → fallback disabled (без `providerModels`, ожидаем ошибку),
  dual failure.

### PR A2 — Extraction run consistency [P0]

Разбито из исходного пункта 3–4 старого PR A.

- **[P0]** `retryBatchExtraction()` должен получать ту же модель, что и
  первичный вызов — единый `ExtractionRunConfig` (provider, model, prompt
  version), не два независимых места выбора модели.
- **[P0]** Пересчитать независимость grader'а по РЕЗОЛВЛЕННЫМ
  `servedByProvider`/`servedByModel` (из `ChatCompletionResult`, PR A1), не по
  сырым env-переменным. **[R2]** Одного boolean недостаточно — документ может
  делиться на несколько batch, часть из которых обслужена одной моделью,
  часть — другой после фоллбэка (даже с fail-closed policy: пользователь мог
  явно разрешить фоллбэк для этого прогона). Вместо `graderIsIndependent: boolean`:

  ```ts
  type GraderIndependence = 'FULL' | 'PARTIAL' | 'NONE' | 'UNKNOWN';
  // FULL    — ни один вызов grader'а не совпал по provider+model ни с одним
  //           extraction-вызовом (primary или retry, по всем batch)
  // PARTIAL — часть extraction-вызовов совпала с grader'ом, часть нет
  // NONE    — grader и extraction фактически выполнены одной моделью
  // UNKNOWN — не хватает attempt-метаданных для вывода (старые прогоны до A1)
  ```

  Артефакт прогона хранит каждый extraction batch, каждый retry, каждый grader
  call с их фактическим `servedByProvider`/`servedByModel`/prompt version/
  source hash — независимость вычисляется по этому списку, не по двум
  env-строкам.

**Acceptance criteria:**
- primary и JSON-retry в рамках одного документа используют один
  `ExtractionRunConfig`;
- артефакт прогона хранит фактически использованную модель для каждого batch
  (включая retry);
- mixed-model run (из-за разрешённого фоллбэка) явно помечается в артефакте;
- `GraderIndependence` вычисляется как FULL/PARTIAL/NONE/UNKNOWN по реальным
  attempt-данным, не по env presence;
- extraction benchmark не может пометить прогон как `FULL`-независимый без
  фактической телеметрии, подтверждающей это.

### PR A3 — Eval harness gate semantics [P1]

Разбито из исходного пункта 6–7, 11 старого PR A. **[R2]** Исходное
предложение «скопировать `--fail-on=none|degraded|lost` из
`test-extraction-pack.ts`» отклонено — Codex верно указал, что
`run-eval-corpus.ts` не имеет вердиктов `DEGRADED`/`LOST`, только per-case
`PASS/FAIL`. Вместо копирования чужой семантики — своя, подходящая этому
раннеру:

```ts
type ExpectedDisposition =
  | 'MUST_PASS'    // regression, если FAIL
  | 'MUST_HOLD'    // regression, если бот дал прямой ответ вместо hold
  | 'MAY_HOLD'     // hold допустим временно (например, кейс с нострификацией —
                    // уже документирован как temporarily-acceptable hold)
  | 'KNOWN_FAIL';  // ожидаемо падает сегодня, не блокирует gate

type CaseResult = 'PASS' | 'FAIL' | 'XFAIL' | 'XPASS';
// XFAIL — KNOWN_FAIL и фактически FAIL: ожидаемо, не блокирует
// XPASS — KNOWN_FAIL, но фактически PASS: неожиданное улучшение, требует
//         ручного решения — либо снять KNOWN_FAIL, либо это ложный сигнал
```

Режимы запуска:

```bash
--mode=baseline   # всегда пишет snapshot результатов, никогда не падает
--mode=gate       # exit 1 при: MUST_PASS→FAIL, MUST_HOLD→direct-answer,
                  # KNOWN_FAIL→PASS (XPASS, требует ручного review baseline)
                  # ошибка самого движка (исключение, не assertion) — всегда exit 1
```

- **[P1]** 6 `known-good` кейсов без явного `requiresClarificationOrHold`
  получают явную `ExpectedDisposition` (в основном `MUST_PASS`, кейс с
  нострификацией — `MAY_HOLD`, не подряд всем шести одна и та же метка).
- **[P1]** `telemetryMode: 'disabled'` — параметр на исполняемый вызов,
  глушащий fire-and-forget телеметрию (`HallucinationLog` и т.п.) именно на
  eval-прогонах. Не убирает существующее поведение для реальных
  пользовательских вопросов — только для `--mode=gate`/`--mode=baseline`.

**Acceptance criteria:**
- `--mode=baseline` всегда формирует snapshot-артефакт, никогда не завершает
  процесс с ненулевым кодом из-за содержимого кейсов;
- `--mode=gate` возвращает exit 1 именно при перечисленных regression-условиях
  и ни при каких других;
- PASS/FAIL/XFAIL/XPASS вычисляются по стабильным case ID, не по порядковому
  номеру в файле;
- ни один `known-good` кейс не остаётся без явной `ExpectedDisposition`;
- eval-прогон с `telemetryMode: 'disabled'` не создаёт строк в
  `HallucinationLog`/`HeldAnswer`/другой production-телеметрии.

### PR A4 — Документация [P1]

Разбито из исходного пункта 8–9 старого PR A плюс новый пункт про
review-статус.

- Убрать вводящий в заблуждение заголовок «(ПЕРЕД 2.4, не после)» у Задачи 3.1
  в `docs/plans/2026-08-05-aurora-knowledge-engine-v2.md` (см. §1.8 — сам
  критический путь ниже уже верный, правится только заголовок).
- Truth table §2: явно продублировать `audience` в колонке «обязательные поля»
  для всех kind, где оно применимо.
- **[R2] Строгий инвариант вместо простого переименования.** `reviewedBy` и
  `reviewStatus` — не два имени одного понятия, а разные поля с зависимостью:

  ```ts
  reviewStatus: 'UNCLASSIFIED' | 'REVIEWED';
  reviewedBy: string | null;
  reviewedAt: Date | null;
  // Инвариант: reviewStatus === 'REVIEWED' ⟺ reviewedBy и reviewedAt оба заданы
  ```

  Для факета в состоянии `GLOBAL` (см. B1 ниже) отдельно хранится, кто именно
  подтвердил глобальность ИМЕННО этого измерения — не переиспользовать
  document-level `reviewedBy` для per-facet review. Truth table §2 и §5
  приводятся к этому единому контракту в этом PR.
- Зафиксировать явно в §2 truth table: `PRICE_RULE` описывает ПОЛИТИКУ расчёта
  (коэффициенты, что входит в стоимость), не сами числа — не конкурирует с уже
  типизированным `Tariff` (услуга/направление/единица/срок/даты/audience).
  Правка одного предложения, не требует пилота (см. §4.3).
- Добавить в план задачу (см. §6) на конкретный numeric-evidence эксперимент
  из §2.2 выше — не абстрактное "когда-нибудь dry-run", а измерение с
  зафиксированным протоколом.

### PR B1 — Типизированный доменный контракт [P1, depends-on A1–A4]

**[R2] `facets: Record<string, FacetValue>` отклонён** — легко превращается в
новый EAV (`issuingCountry`/`issueCountry`/`issuerCountry`/`issuingContry` —
все валидны для TypeScript, hard filter перестаёт совпадать при малейшей
опечатке в ключе). Вместо этого — типизированный, но расширяемый registry:

```ts
// src/lib/knowledge/applicability/facets.ts
const FACET_REGISTRY = {
  scenario: scenarioFacet,
  service: conceptFacet,
  documentType: conceptFacet,
  issuingCountry: countryFacet,
  destinationCountry: countryFacet,
  documentForm: documentFormFacet,
  languageFrom: languageFacet,
  languageTo: languageFacet,
  deliveryCity: cityFacet,
  partner: partnerFacet,
} as const;

type FacetKey = keyof typeof FACET_REGISTRY;

type FacetState<T> =
  | { state: 'UNKNOWN' }
  | { state: 'GLOBAL'; reviewedBy: string; reviewedAt: string }
  | { state: 'SCOPED'; include: readonly T[]; exclude?: readonly T[] };
```

Обращение по ключу, отсутствующему в `FACET_REGISTRY`, — ошибка компиляции/
runtime-валидации (fail-closed), не молчаливое игнорирование. `UNKNOWN` и
`GLOBAL` — разные состояния, не взаимозаменяемые (нельзя случайно трактовать
неизвестное как разрешение применять знание глобально — это уже пройденный
урок текущего v1-бага). `audience`, `reviewStatus` и provenance — отдельные
обязательные поля верхнего уровня `ApplicabilityProfile`, не элементы facets.

Конкретный набор facet-ключей сверх перечисленных в примере выше и их
обязательность по `kind` — решает пилот (2.3), не эта задача (см. §4.1). B1
даёт расширяемый типовой каркас, не финальный список измерений.

```ts
export interface ApplicabilityProfile {
  facets: { [K in FacetKey]?: FacetState<FacetValueOf<K>> };
  audience: 'CLIENT' | 'INTERNAL' | 'BOTH';
  reviewStatus: 'UNCLASSIFIED' | 'REVIEWED';
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface QueryFrame {
  concepts: string[];              // канонические Concept ID (после 2.2)
  facets: { [K in FacetKey]?: FacetValueOf<K> | 'UNKNOWN' };
  negation: boolean;
  missingRequiredFacets: FacetKey[];
  ambiguities: string[];
}
```

**Acceptance criteria:**
- ни одного `Record<string, unknown>`/`Record<string, FacetValue>` для facet
  keys нигде в контракте;
- неизвестный facet-ключ — ошибка на этапе валидации, не тихий no-op;
- `UNKNOWN` не равен и не приводится неявно к `GLOBAL`;
- `Zod`-схемы для `ApplicabilityProfile`/`QueryFrame` существуют и покрыты
  unit-тестами на валидные/невалидные значения.

### PR B2 — Evaluator'ы [P1, depends-on B1]

**[R2]** Одной функции `evaluateApplicability(profile, query)` недостаточно —
truth table сама различает независимые проверки (eligibility кандидата,
scope-совпадение по фасетам, активация условия/триггера, разрешение конфликтов
между несколькими units). Разбивается на четыре:

```ts
// 1. Годен ли unit вообще для рассмотрения (независимо от конкретного вопроса)
function evaluateUnitEligibility(
  unit: KnowledgeUnitLike,
  requestContext: RequestContext
): EligibilityDecision;
// проверяет: status, reviewStatus, audience, validity, source revision

// 2. Совпадает ли scope unit'а с фасетами вопроса
function evaluateScope(
  profile: ApplicabilityProfile,
  query: QueryFrame
): ScopeDecision;
// возвращает: MATCH | CONFLICT | UNKNOWN по каждой фасете,
// missingFacets, conflictingFacets, reasons

// 3. Активно ли условие применения (triggerCondition) для этого запроса
function evaluateTrigger(
  triggerCondition: TriggerCondition,
  query: QueryFrame
): TriggerDecision;
// возвращает: ACTIVE | INACTIVE | UNKNOWN

// 4. Разрешение конфликтов между несколькими подходящими units
function resolveKnowledgeSet(
  candidates: EvaluatedCandidate[],
  query: QueryFrame
): ResolutionDecision;
// разрешает: parent/exception relations, specific-over-general, supersedes,
// numeric conflicts, unresolved conflicts
```

Финальное решение обязано объяснять себя, не просто возвращать булево:

```ts
{
  eligible: true,
  scopeVerdict: 'UNKNOWN',
  reasons: ['destination_country_missing'],
  missingFacets: ['destinationCountry'],
  requiresClarification: true,
}
```

**Acceptance criteria:**
- каждая строка truth table (§3.1–§3.4 в `2026-08-05-applicability-truth-table.md`)
  имеет отдельный table-driven тест, исполняющий именно `evaluateScope`;
- `evaluateTrigger` и `resolveKnowledgeSet` (multi-unit conflict) покрыты
  отдельными тестами, не разделяющими сценарии с `evaluateScope`;
- решения всех четырёх функций содержат машиночитаемые reason codes и (где
  применимо) `missingFacets`/`conflictingFacets` — не только verdict;
- `scenario` не хардкожен как единственная обязательная ось ни в одной из
  четырёх функций (расширяемость под §4.1 сохранена).

### PR C — Provider structured-output adapter [P1, depends-on A1, B1]

Единый способ получить от Anthropic/OpenAI валидированный по Zod-схеме объект,
поверх `createChatCompletionDetailed` (PR A1):

```ts
async function structured<T>(opts: {
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  providerModels?: { anthropic?: string; openai?: string };
}): Promise<{ data: T; servedByProvider: Provider; servedByModel: string }>;
```

Runtime-проверка через тот же Zod, что и в B1/B2 — извлечённые/построенные
объекты (QueryFrame из D, extraction из E) проходят один и тот же класс
валидации, что типы контракта.

**Acceptance criteria:**
- невалидный по схеме ответ модели не проходит как "успех" молча — явная
  ошибка с диагностикой, какое поле не совпало;
- `servedByProvider`/`servedByModel` в результате всегда соответствуют
  реально выполнившему вызов провайдеру (не заявленному в опциях).

### PR D — QueryFrame builder [P1, depends-on B1, C, 2.2]

Вход: вопрос пользователя + контекст переписки + канал/audience. Выход —
`QueryFrame` (тип из B1): канонические concept ID (после 2.2 — Concept/
ConceptAlias), атомарные facet-значения или `UNKNOWN`, `negation`,
`missingRequiredFacets`, `ambiguities`. Реализуется через `structured()` (PR C).

**Acceptance criteria:**
- построитель никогда не придумывает facet-значение, отсутствующее в вопросе
  — при неуверенности возвращает `UNKNOWN`, не догадку;
- негация распознаётся на наборе тестовых вопросов ("не апостиль, а
  консульская легализация");
- `missingRequiredFacets` вычисляется относительно `kind`-специфичных
  обязательных полей из truth table (B1/B2), не хардкожен per-вопрос.

### PR E — Структурная экстракция + provenance [P1, depends-on B1, C, 2.2]

Экстрактор выдаёт не `{ruleCode, title, body, confidence, sourceSpan}`
(текущая `ExtractedRuleStream`, подтверждено — структурного поля условия
применимости в схеме нет вообще, см. находку в комментарии к translation-2n9),
а:

```ts
interface ExtractedKnowledgeUnit {
  kind: KnowledgeUnitKind;
  facets: Partial<Record<FacetKey, FacetValue>>;
  triggerCondition: TriggerCondition | null;
  numericConstraint: NumericConstraint | null;
  parentRuleRef: string | null;
  sourceSpan: SourceSpan;
}
```

Использует `ExtractionRunConfig` (PR A2) и `structured()` (PR C). Известные
живые баги от синтетического прогона (translation-2n9, комментарий от
2026-08-05) — потеря родительского контекста при фрагментации правила и
молчаливый пропуск части правил при генерации QA-пар — фиксируются здесь как
regression-тесты на реальных примерах из того прогона, не абстрактно.

**Acceptance criteria:**
- ни одно извлечённое условие применимости не остаётся необработанной прозой
  там, где `triggerCondition`/`numericConstraint` применимы по `kind`;
- фрагментация длинного правила не теряет ссылку на `parentRuleRef`;
- `sourceSpan` присутствует для каждого извлечённого unit'а (проверяемость
  вручную на исходном документе).

### PR F — Human-review артефакт + временное persistence [P1, depends-on E]

НЕ production Prisma v2 (это всё ещё 2.4, после пилота). Минимально:

- JSON/JSONL артефакты на файловой системе (или временная таблица, если проще
  для скрипта ревью — решение по объёму, не по необходимости);
- content hash + source revision hash на каждый unit;
- явные review-решения (`accept`/`reject`/`edit`) с `reviewedBy`/`reviewedAt`
  по инварианту из A4;
- стабильные ID, переживающие повторный прогон экстракции по тому же
  документу (иначе 2.3 не сможет сравнивать итерации пилота).

**Acceptance criteria:**
- повторный прогон пилота по неизменному документу не создаёт дубликаты
  review-решений для одного и того же unit'а (стабильный ID проверяется
  тестом);
- review-артефакт читаем без специального тулинга (plain JSON/JSONL) — пилот
  ещё не обязан иметь UI.

---

## §4. Открытые архитектурные вопросы — сознательно НЕ решаются сейчас

### 4.1 `scenario` как единственная главная ось — главный вопрос разбора

Возражение по существу: для бюро переводов применимость реально зависит не
только от scenario, а от `documentType`, `issuingCountry`, `documentForm`
(оригинал/скан/копия), `languagePair`, `urgency`, `partner`,
`deliveryRoute` и т.д. — если всё это снова свернуть в один `scenarioKey`,
получится то же дерево, только длиннее (`apostille.education.russia.
original.germany.urgent...`).

**Не принимаю и не отвергаю сейчас.** Причина та же, по которой план (после
двух ревью) требует пилот ДО финальной схемы: один синтетический документ про
зуд НЕ может подтвердить или опровергнуть, нужны ли атомарные фасеты — он
намеренно не о домене бюро переводов. Ответ на этот вопрос — единственная
содержательная цель Задачи 2.3 (пилот на 3-5 РЕАЛЬНЫХ документах бюро,
включая документ про Орёл/FPM, документ с ценами, документ про доставку,
документ про оригинал/скан, документ про языковую пару — сам разбор предлагает
близкий список категорий, использую его как чек-лист подбора документов для
пилота).

**[R2]** Что PR B1 ДЕЛАЕТ (не просто "должен сделать"), чтобы не блокировать
этот вопрос: `FACET_REGISTRY` спроектирован как открытый для дополнения набор
(добавление новой фасеты — новая запись в registry + новый конкретный
`FacetValue`-тип, без переписывания `evaluateScope`/`evaluateTrigger`/
`resolveKnowledgeSet` с нуля). Конкретный набор фасет сверх примера в B1
решает пилот, не эта truth table.

### 4.2 `TERM_DEFINITION` контекстно-зависим

Согласен, что термин может значить разное в апостиле/нотариальном переводе/
консульской легализации — сегодняшняя truth table делает `TERM_DEFINITION`
безусловно document-scoped, что упрощение. Тот же ответ, что в 4.1: решается
пилотом (найдётся ли в реальных документах бюро термин с контекстно-разным
значением — вероятно да, но не гадаю без данных), не переписыванием truth
table сейчас.

### 4.3 `PRICE_RULE` не должен конкурировать с `Tariff`

Согласен по существу — `Tariff` уже типизирован (услуга, направление, единица,
срок, даты действия, audience). `PRICE_RULE` в v2 должен описывать ПОЛИТИКУ
расчёта (коэффициенты, что входит в стоимость), не сами числа. **[R2]**
Правится в PR A4 (чисто текстовая правка truth table), не откладывается до
2.4 — не требует пилота или кода.

### 4.4 review-статус — не переименование, инвариант

**[R2]** Добавлено по итогам ревью раунда 2. `reviewStatus` и `reviewedBy` —
разные понятия (см. PR A4): один описывает процессный статус unit'а в целом,
другой — кто и когда подтвердил конкретное решение (документ REVIEWED, ИЛИ
конкретная фасета GLOBAL). Truth table не должна больше использовать их как
взаимозаменяемые имена одного поля.

---

## §5. Явно НЕ делать в следующей сессии, пока PR A/B не закрыты

- Никакой финальной Prisma-схемы v2 (Задача 2.4).
- Никакого `pgvector`/vector-колонки (3.1/3.2) — не блокер PR A/B, но и не
  часть их объёма.
- Никакого backfill 1535 правил эвристической классификацией.
- Никакого массового переизвлечения корпуса.
- Не мержить `PR #52` (LlmCallLog full logging) как есть — уже отслежено
  как `translation-m0x`, без изменений в этом плане.
- Не начинать 2.3 (пилот) до готовности B2, C, D, E, F — пилоту физически
  нужны все пять, не только `evaluateApplicability` (**[R2]**: расширено —
  исходная версия называла только PR B, чего было объективно недостаточно
  для описанного end-to-end пилота).
- **[R2]** Не путать безопасный backfill (`Document.scenarioKey` уже известен
  → унаследовать в null-детей) с эвристической массовой классификацией 1535
  правил — это два разных по риску действия, см. §6, `translation-8kf`.
- **[R2]** Не мержить PR A одним куском — обязательно как минимум A1/A2/A3/A4
  отдельными PR (разный blast radius, разная срочность отката).
- **[R2]** Не вводить `facets: Record<string, unknown>` ни в каком виде —
  только типизированный `FACET_REGISTRY` (B1).

**Порядок ревью для каждого PR A1–F** (учитывая процессную находку разбора):
не мержить сразу по зелёному CI — дождаться хотя бы одного содержательного
ревью (Grok/Codex/CodeRabbit) на диффе, а не только автоматической сборки.
Предыдущий PR (#59) уже показал: содержательные находки пришли через 2 минуты
ПОСЛЕ merge. Дать боту(-ам) реальное время до merge, не просто дождаться CI.

---

## §6. Beads — изменения после утверждения плана

**[R2]** Часть пункта, отслеженного в исходной версии как "новая задача",
уже существует — не создавать дубликат. `translation-8kf` (создана в прошлой
сессии, синхронизирована в этой) уже покрывает:

- `Rule.create()`/`QAPair.create()` не наследуют `scenarioKey` — оба пути в
  `commit.ts`, не только `QAPair`, как ошибочно сузила исходная версия этого
  плана в пункте "Rule.create() не наследует scenarioKey" (было неполным —
  сам `translation-8kf` называет оба);
- безопасный backfill существующих `DocChunk`/`Rule`/`QAPair` ТОЛЬКО там, где
  `Document.scenarioKey` уже известен (не эвристическая классификация
  остальных 1535 — см. §5);
- `setDocumentScenario()`-стиль sync-функция (по аналогии с
  `setDocumentAudience()`) ИЛИ явно документированное решение её не делать;
- regression-тест на все известные write path.

Действие в этой сессии: **не создавать новую задачу**. `translation-8kf`
технически не зависит от B1 (сегодня `scenarioKey` — строковое поле, backfill
известного→известного не требует нового доменного контракта) и остаётся
исполнимой независимо, в любой момент, если появится время раньше PR A1–F.

Новые задачи к созданию (после утверждения этого плана):

- **P0** PR A1 — Provider routing & fallback contract, acceptance criteria из §3.
- **P0** PR A2 — Extraction run consistency, `depends-on` A1.
- **P1** PR A3 — Eval harness gate semantics, `depends-on` A2 (использует
  `ExtractionRunConfig`/`GraderIndependence` для консистентности артефактов,
  хотя технически может идти параллельно — оставляю зависимость как
  документирующую порядок ревью, не как жёсткий технический блокер).
- **P1** PR A4 — Документация (truth-table consistency, review-status
  инвариант, заголовок 3.1, `PRICE_RULE` vs `Tariff`, numeric-evidence
  эксперимент как отдельная задача с протоколом из §2.2).
- **P1** PR B1 — Типизированный контракт (FacetRegistry/ApplicabilityProfile/
  QueryFrame), `depends-on` A1–A4.
- **P1** PR B2 — Evaluator'ы (eligibility/scope/trigger/resolution) +
  exhaustive тесты, `depends-on` B1.
- `translation-5ii` (2.2 Concept/ConceptAlias): обновить `depends-on` →
  B2 (не только 2.1, как было в исходной версии плана).
- **P1** PR C — Provider structured-output adapter, `depends-on` A1, B1.
- **P1** PR D — QueryFrame builder, `depends-on` B1, C, 2.2.
- **P1** PR E — Структурная экстракция + provenance, `depends-on` B1, C, 2.2.
- **P1** PR F — Human-review артефакт + temp persistence, `depends-on` E.
- Пилот 2.3: обновить `depends-on` → F (не только предыдущая формулировка,
  зависевшая от одного PR B).
- **P2** numeric-evidence shadow-эксперимент (`unverified_numeric_evidence`,
  §2.2) — отдельная от PR A4 по исполнению (нужен прогон на реальных
  прод-вопросах за период, не только код), заводится вместе с A4,
  `depends-on` A4.

Не трогаю очередь `bd ready` в этой сессии за пределами вышеперечисленного —
создание перечисленных задач происходит ПОСЛЕ утверждения этой редакции
плана, не раньше.
