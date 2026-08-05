# Полный READ-ONLY аудит retrieval-архитектуры бота «Аврора» (Claude/Sonnet 5, worktree agent-a9f1b8f727e86247e)

Дата: 2026-08-05. Проверено на `origin/master` / HEAD `b7606e8` (Merge PR #51) — этот worktree **не содержит** незамерженных веток `feat/llm-call-logging` (PR #52, LlmCallLog) и `fix/scenario-null-confidence-floor` (PR #53). Все выводы ниже относятся к тому, что реально запущено в проде (`railway status` → project AVRORA, service avrora-library, environment production), а не к тому, что описано в контексте задания как «уже сделано» — расхождения отмечены явно.

---

## 1. Executive summary

Бот отвечает по трёхуровневой архитектуре: (0) детерминированные guardrail'ы и дерево сценариев (`apostille` — единственная реализованная ветка таксономии) → (1) canonical-QA-override по 13 голосовым парам оператора → (2) полный RAG-синтез (hybrid RRF-поиск по чанкам + keyword-prefilter по правилам/QA + синтез Anthropic Claude Haiku 4.5 с фолбэком на GPT-4o) → (3) фолбэк на общие знания модели с обязательным `requiresHumanReview=true`. RRF реализован корректно (`k=60`, честная формула `1/(k+rank)`, без смешения шкал в самом ранжирующем `combinedScore`) — но ре-ранкера нет вообще, и это не мелочь: единственный сигнал «релевантности», который видит фильтр `selectContextChunks`, — сырой cosine similarity одиночного чанка, а RRF-скор почти не участвует в бизнес-решениях (используется только для сортировки). Контекстного эмбеддинга (contextual retrieval, привязка чанка к разделу/документу перед векторизацией) нет — чанк эмбеддится дословно, без заголовка документа и вообще без метаданных, кроме `{startChar, endChar}`.

Главный подтверждённый P0: `DocChunk.scenarioKey` **физически никогда не записывается** ни в одном из 4 мест создания чанка (`chunker.ts:129`, `commit.ts:319`, `knowledge-manager.ts:419`, `document-handler.ts:369`) — production-цифры это подтверждают: 204 из 228 чанков (89%) имеют `scenarioKey=NULL`. Сценарный фильтр на уровне `DocChunk` архитектурно правильный (SQL/Prisma `WHERE`, не постфильтр), но фактически не фильтрует почти ничего — вся защита от «утечки не того сценария» держится на `Rule`/`QAPair` (где заполнение куда лучше: `Rule` 255/1535 активных с непустым ключом, `QAPair` 96/671). Это ровно тот механизм, что вызвал баг «Орёл/FPM» из контекста задания — подтверждён кодом, но касается ВСЕХ 3 таблиц с разной степенью, а не только `Rule`.

Третий факт, обнаруженный только в бенчмарке (не был виден при чтении кода): **pgvector-путь семантического поиска фактически мёртв в проде** — первый же прогон `diagnose-answer.ts` показал `[vector-search] pgvector extension not found, using in-memory search`, и это решение кэшируется на уровне модуля и действует на все запросы сессии. То есть 100% семантического поиска в проде реально идёт через in-memory JS cosine similarity (`searchSimilarChunksInMemory`), а не через заявленный в коде SQL `ORDER BY <=> LIMIT`-путь — при текущем размере корпуса (228 чанков) это не проблема производительности, но означает, что документированный «путь A» — код, который не выполняется НИКОГДА, пока расширение `vector` не установлено на Railway Postgres.

Второй P0-уровня факт: production Postgres содержит таблицу `LlmCallLog` (61 строка, живая, полноценная) — но `prisma/schema.prisma` на `master` эту модель не описывает вовсе. Кто-то запустил `prisma db push` с непримёрженной ветки `feat/llm-call-logging` прямо на прод-базу, оставив схему и код в git разъехавшимися с реальной БД. Обещанная в задании инфраструктура наблюдаемости («PR #52 логирует каждый вызов») в коде на master **отсутствует**: `chat-provider.ts` не делает ни одной Prisma-записи, весь возможный лог — фантом до мержа ветки.

«Обучение» бота подтверждено как чистый retrieval + LLM-переформулировка без дообучения весов: `findCanonicalQaOverride` → `polishCanonicalAnswer` (промпт прямо запрещает добавлять факты). Гипотеза про «почесать»/«чесать»/«причесать»/«подчесать» **опровергнута на уровне кода**: усечение только суффиксов (1–2 хвостовых символа) не может схлопнуть разные ПРИСТАВКИ (по-/при-/под-), поэтому эти 4 слова дают НУЛЕВОЕ пересечение термов между собой — совпадение в реальном тесте (если оно было) объясняется не общей стеммой этих слов, а другим редким словом в вопросе, доминирующим в term-overlap на коротких вопросах. Порядок слов действительно не влияет (используется `Set`, не строка).

**Бенчмарк частичный**: из запланированных 33 вопросов выполнено 22 (обрыв соединения с Railway Postgres на вопросе 23 — сетевая нестабильность окружения, независимо подтверждена отдельной read-only попыткой; см. п.11). На 22 завершённых — 1 живое подтверждение wrong-scope утечки (вопрос про Минск получил в топ-1 чанк адрес партнёра в Орле, ровно тот сценарий, что описан в брифинге), 0 подтверждённых territoriality-регрессий, 0 подтверждённых knowledge gap. Никакие тестовые QAPair не создавались (использован чисто read-only путь через `diagnose-answer.ts`), поэтому очистка прод-данных не требуется.

Ре-ранкера нет (подтверждено grep `rerank` по всему `src/` — ноль совпадений). `rule-conflict-detector.ts` существует, но полностью не подключён — ни к hot path, ни к какому-либо cron/admin route (мёртвый код). Обнаружены дополнительные находки за пределами исходного брифинга: захардкоженный устаревший дефолт модели `claude-3-opus-20240229` (не используется в проде — там `claude-haiku-4-5-20251001` из env, но это тихая мина при потере переменной окружения); нет timeout ни на один HTTP-вызов LLM; `HeldAnswer.question` бьётся мокой (кракозябры) на всех 3 проверенных строках — отдельный, не связанный с retrieval баг кодировки на пути записи.

---

## 2. Sequence diagram — один запрос `answerQuestionEnhanced()`

```
Пользователь → answerQuestionEnhanced({question, audience, sessionId})
│
├─0. classifyScenario(question)                         [scenario-classifier.ts:91, LLM ТОЛЬКО если
│     детерминированный regex-каскад (классификатор-classifier.ts:172-360) не решил сам]
│     └─ scenario_clear | needs_clarification | out_of_scope | knowledge_lookup
│
├─0.4 findCanonicalQaOverride(question, audience)         [Prisma, без LLM]
│     └─ если совпадение overlap.short≥0.55 И overlap.long≥0.5 с VOICE_ANSWER_AUTHORITY QAPair:
│         polishCanonicalAnswer(question, qa.answer)      [LLM, canonical-answer-polisher.ts:35]
│         checkClaimGrounding + checkCertificationPriceAttribution + checkClientSafety (все — regex, без LLM)
│         → РАННИЙ ВОЗВРАТ, confidence=1.0                          ⏹ (пропускает ВСЁ ниже)
│
├─0.6 buildDeterministicGuardrailResult(question, audience)  [regex-ветки: территориальность, исходник
│     перевода, суд/присяжный перевод — без LLM]
│     └─ если сработало: РАННИЙ ВОЗВРАТ, confidence=0.9, answerSource='deterministic_guardrail'  ⏹
│
├─ needs_clarification → РАННИЙ ВОЗВРАТ (структурированный вопрос-уточнение)                     ⏹
├─ out_of_scope → переклассифицируется в knowledge_lookup (открытый поиск), НЕ блокирует retrieval
│
├─1. Promise.allSettled([                                 [3 параллельных LLM-вызова]
│     expandQuery(question),                               query-expansion.ts:41
│     extractEntities(question),                            query-expansion.ts:95
│     classifyIntent(question),                              enhanced-answering-engine.ts:297
│   ])
│
├─2. Построение allQueries (оригинал + expandAbbreviations + варианты + детерм. варианты)  [без LLM]
│
├─3. multiQuerySearch → hybridSearch() × N вариантов запроса, параллельно  [vector-search.ts:410-480]
│     ├─ searchSimilarChunks (pgvector cosine, порог≥0.3, WHERE scenario/audience/domain)
│     └─ searchByKeywords (Postgres FTS ts_rank, → keywordTerms fallback при пустом результате/ошибке)
│     RRF: combinedScore = w·1/(60+semanticRank) + (1-w)·1/(60+keywordRank)
│
├─4. selectContextChunks(chunks, 5)   [фильтр: semanticScore≥0.4 ИЛИ keywordScore≥0.65, top-60%-от-max]
│
├─5. Rule fetch (keyword-prefilter по терминам + top-100-by-confidence, dedup, rankByQuestion)  [Prisma]
├─6. QAPair fetch (аналогично)                                                                   [Prisma]
│
├─7. overallConfidence = max(bestSemanticScore, hasStrongQaMatch ? bestQaMatch : 0)
├─8. confidenceLevel = high|medium|low|insufficient → needsClarification/суффикс-ветки к прайсу/
│     general_ai fallback (см. ниже)
│
├─9. createChatCompletion(systemPrompt, context)            [ОСНОВНОЙ СИНТЕЗ, LLM, temp=0]
│     enhanced-answering-engine.ts:1320
│
├─9.5 verifyAnswer(answer, synthesisSources)                [consistency-gate.ts:91, LLM, temp=0]
│     если unsupported.length>0:
│       └─ createChatCompletion(REGENERATE)                  [LLM, enhanced-answering-engine.ts:1378]
│           └─ verifyAnswer(revisedAnswer, ...)                [повторный LLM-вызов, line 1410]
│       └─ prisma.hallucinationLog.create(...)                [fire-and-forget, реальная таблица]
│
├─10. checkClaimGrounding(answer, synthesisSources)          [regex/число, БЕЗ LLM]
├─11. checkCertificationPriceAttribution(answer)             [regex, БЕЗ LLM]
├─12. checkStalePrice(answer, tariffs)                       [regex/число, БЕЗ LLM]
├─13. checkClientSafety(answer) — только audience='client'   [regex, БЕЗ LLM]
├─14. HUMAN_REVIEW_CHECKS реестр (9 причин) → requiresHumanReview
└─→ EnhancedAnswerResult{answer, confidence, citations, ...}
```

**Альтернативная ветка** (confidenceLevel='insufficient' и нет сильного QA-совпадения):
- сначала пробуется прайс-таблица (`lookupTariffForQuestion`, без LLM) — если нашла цену целиком, ранний возврат;
- иначе, если `shouldUseGeneralKnowledgeFallback(question)` (regex-словарь), идёт `answerFromGeneralKnowledgeFallback()` — ОДИН LLM-вызов (`enhanced-answering-engine.ts:2264`, JSON-режим, `requiresHumanReview=true` всегда, независимо от самооценки модели).

### Реальное число LLM-вызовов на ответ (полный синтез, не canonical/guardrail-ветка)

| Сценарий | Вызовов | Состав |
|---|---|---|
| Минимум (сценарий определён детерминированно, consistency-gate не сработал) | **4** | Step 1 (3: expandQuery, extractEntities, classifyIntent) + Step 9 (синтез) |
| Типичный (LLM нужен для сценарного гейта, consistency-gate чист) | **5** | +classifyScenario |
| Максимум (LLM-гейт + consistency-gate нашёл неподтверждённые факты и перегенерировал) | **8** | +classifyScenario, +verifyAnswer, +regenerate, +повторный verifyAnswer |
| Canonical QA override (обходит всё) | **1** | только polishCanonicalAnswer |
| Deterministic guardrail | **0** | чистый regex |
| General-AI fallback (после insufficient) | **4–5** | Step 1 (3) + answerFromGeneralKnowledgeFallback (1), может включать classifyScenario |

Источник: `src/lib/ai/enhanced-answering-engine.ts` (полный обход control-flow, строки 786–2340), подтверждено субагентом по `chat-provider.ts`/call-site инвентарю.

---

## 3. Таблица всех LLM-вызовов (hot path + admin/ingestion tooling)

| file:line | функция | назначение | temp | maxTokens | responseFormat | На hot path `answerQuestionEnhanced`? |
|---|---|---|---|---|---|---|
| `enhanced-answering-engine.ts:297` | `classifyIntent()` | классификация intent/domains | 0.1 | 1024 | json_object | Да (Step 1, параллельно) |
| `enhanced-answering-engine.ts:1320` | инлайн (основной синтез) | генерация ответа | 0 | default (2048 у Anthropic / без лимита у OpenAI) | text | Да (Step 9) |
| `enhanced-answering-engine.ts:1378` | инлайн (регенерация) | переписать ответ без неподтверждённых фактов | 0 | default | text | Условно — только если consistency-gate нашёл нарушения |
| `enhanced-answering-engine.ts:2264` | `answerFromGeneralKnowledgeFallback()` | фолбэк на общие знания | 0 | 900 | json_object | Альтернативная ветка |
| `enhanced-answering-engine.ts:2483` | `checkIfFollowUp()`/аналог | детект follow-up вопроса | 0.1 | 1024 | json_object | Да, до retrieval |
| `query-expansion.ts:41` | `expandQuery()` | генерация вариантов запроса | 0.3 | нет | json_object | Да (Step 1) |
| `query-expansion.ts:95` | `extractEntities()` | извлечение дат/цен/типов документов | 0.1 | нет | json_object | Да (Step 1) |
| `scenario-classifier.ts:91` | `classifyScenario()` (LLM-хвост) | выбор узла таксономии | 0 | 256 | json_object | Да (Step 0), но **пропускается**, если сработал детерминированный regex-каскад (`scenario-classifier.ts:79-80`) |
| `consistency-gate.ts:91` | `verifyAnswer()` | извлечь и сверить утверждения с источниками | 0 | 2000 | json_object | Да (Step 9.5), условно |
| `canonical-answer-polisher.ts:35` | `polishCanonicalAnswer()` | переформулировать канонический ответ | 0.25 | 2048 | json_object | Только на ветке canonical-override (обходит остальное) |
| `domain-steward.ts:65` | классификация домена документа | — | 0.3 | 2048 | json_object | Нет — ingestion |
| `knowledge-extractor.ts:88` | извлечение правил/QA из документа | — | 0.1 | 8192 | json_object | Нет — ingestion |
| `knowledge-extractor-stream.ts:~173/283` | стриминговое извлечение + повтор | — | 0/0.1 | 16000 | json_object | Нет — ingestion |
| `voice-answer-polisher.ts:38` | полировка голосового ответа оператора | — | 0.2 | 2048 | json_object | Нет — админ-бот обучения |
| `voice-rule-extractor.ts:84` | извлечение правил из голосовой заметки | — | 0 | 6000 | json_object | Нет — админ-бот обучения |
| `rule-conflict-detector.ts:179` | детект конфликта правил | — | 0.1 | нет | json_object | **Нет — модуль вообще не импортируется нигде в `src/`, мёртвый код** |
| `telegram/document-handler.ts:172,257` | классификация домена / извлечение из загруженного документа | — | 0.3/0.2 | 1024/8192 | json_object | Нет — Telegram admin upload |
| `telegram/knowledge-manager.ts:75,191,354` | разбор свободного текста в правила/апдейты/домен | — | 0.2/0.2/0.1 | —/4096/256 | json_object | Нет — Telegram admin |
| `telegram/smart-admin.ts:91` | классификация intent админ-чата | — | 0.1 | 256 | json_object | Нет — Telegram admin bot |
| `answering-engine.ts:62,134` | legacy `answerQuestion()` (старый движок, `/api/ask`) | — | 0.1/0.3 | — | json_object/text | Нет (legacy path, используется `/api/ask/route.ts` и частью Telegram-команд) |
| `api/health/ai/route.ts:28` | health-check "OK" | — | 0 | 10 | text | Нет — health-проба |

Источник: субагентная инвентаризация всех call-site `createChatCompletion(` по `src/` (грепом подтверждено). Модели: primary Anthropic `claude-haiku-4-5-20251001` (railway env `ANTHROPIC_MODEL`), фолбэк OpenAI `gpt-4o` (`OPENAI_CHAT_MODEL`). Захардкоженный дефолт в коде на случай отсутствия env — `claude-3-opus-20240229` (`chat-provider.ts:18-19`, устаревшая модель, риск тихого даунгрейда/дороговизны, если переменную забудут при новом деплое) и `gpt-4o` из `openai.ts:15`.

### `chat-provider.ts` — устройство (443 строки, полный обзор)
- `getProvider()` (27-32): явный `AI_PROVIDER` env, иначе `anthropic`, если есть `ANTHROPIC_API_KEY`, иначе `openai`.
- Ретраи: до `MAX_RETRIES=3` (line 221), backoff `1000·2^attempt` мс, ретраится только `isRetryableError()` (429/529/503/502 в тексте ошибки, `overloaded`, `rate_limit`, `ECONNRESET`, `ETIMEDOUT`); после исчерпания — один переход на другой провайдер, если есть его ключ (330-348); если и там ошибка — пробрасывается исходная ошибка primary.
- `DEFAULT_TEMPERATURE=0.3` (env `AI_TEMPERATURE`), применяется только если вызывающий не передал `temperature`.
- `maxTokens`: у Anthropic всегда есть дефолт (`ANTHROPIC_MAX_TOKENS` env=4096 в проде); у OpenAI — только если явно передан вызывающим, иначе безлимит по умолчанию OpenAI.
- JSON-режим: у OpenAI нативный `response_format`; у Anthropic — инструкция в system prompt («Respond with valid JSON only…») плюс постобработка `normalizeJsonResponse()` (61-97): срезает code fences, чинит control-символы внутри строк, «балансирует» незакрытые скобки/кавычки при обрыве, чинит висячие запятые/одинарные кавычки, при полном фейле возвращает `'{}'`.
- **Таймаут: отсутствует полностью.** Ни `AbortController`, ни `fetch`-таймаут нигде в `callAnthropic`/`callOpenAI`. Зависший запрос блокирует ответ бесконечно (кроме случая, когда сам Node/сокет вернёт `ETIMEDOUT`).
- **LlmCallLog: не существует на master.** `chat-provider.ts` не делает НИ ОДНОЙ Prisma-записи. Единственная LLM-связанная телеметрия в hot path — `prisma.hallucinationLog.create()` (`enhanced-answering-engine.ts:1417-1428`), и то только при срабатывании consistency-gate. При этом в самой продовой БД таблица `LlmCallLog` реально существует и содержит 61 строку (подтверждено прямым SQL) — код, который её пишет, живёт только на непримёрженной ветке `feat/llm-call-logging` (commit `c5d630d`). Это классическая схема-дрейф: кто-то `prisma db push`-нул схему с фичи-ветки прямо на прод, не смержив код.

---

## 4. Понимание запроса

- **Intent** — `classifyIntent()` (`enhanced-answering-engine.ts:295-327`), LLM, свободный enum из промпта (`price_query|procedure_query|requirements_query|timeline_query|contact_query|general_info`), не валидируется по факту (любая строка от модели проходит).
- **scenarioKey** — гибрид: сначала жёсткий regex-каскад (`scenario-classifier.ts:172-360`, покрывает большинство апостильных вопросов по замеру в комментарии `scenarios.ts:249-251`: «классификатор узнаёт сценарий лишь в 14 случаях из 35» — то есть в 60% случаев решает именно regex, а не LLM), LLM — только как дозаполнение.
- **Тип услуги/документа** — извлекается `extractEntities()` (LLM, `documentTypes`/`services` — свободный текст, не enum, ничем не валидируется дальше).
- **Страна выдачи/назначения** — нет отдельного структурированного поля. Территориальность (СПб/ЛО vs «другой регион») обрабатывается только внутри дерева `apostille.zags.*` (`scenarios.ts:112-134`) через LLM/regex-классификатор и отдельными guardrail-функциями (`resolveApostilleTerritoriality`, `detectIssuingRegion` в `apostille-authority.ts` — не читал целиком, но импортируется и вызывается в `enhanced-answering-engine.ts:24-26`). Для остальных услуг (не-апостиль) страна не извлекается структурно вообще.
- **Языковая пара, срочность, оригинал/скан** — не structured entities; срочность/оригинал обрабатываются только в детерминированных guardrail-ветках (`buildSourceRouteResult`, `resolveCourtTranslation`) через regex по тексту вопроса, не как поле состояния.
- **Отрицание** — `hasNegation()` (`enhanced-answering-engine.ts:489-491`), regex по «не/нет/без/нельзя/невозможно» с lookbehind/lookahead на границу слова; используется только внутри `questionTermOverlap` (canonical-override и strong-QA-match), НЕ используется как общий сигнал retrieval/синтеза — то есть отрицание защищает только два узких пути, а не общий RAG-контур.
- **Контекст предыдущих сообщений** — учитывается только в `answerFromGeneralKnowledgeFallback()` (последние 6 сообщений `ChatMessage` по `sessionId`, line 2246-2257) — то есть ТОЛЬКО в ветке общих знаний модели, а не в основном RAG-синтезе. Основной retrieval **не видит историю диалога** — каждый вопрос ищется как будто первый в сессии.
- **Двусмысленность** — `expandQuery()` возвращает `isAmbiguous`/`suggestedClarification` (LLM-самооценка, не валидируется), используется как фолбэк-текст уточнения, если сценарный гейт сам не попросил уточнение.

### Все места, где null/пусто трактуется как «подходит всем»/wildcard

| Поле | Модель | Семантика null | Источник |
|---|---|---|---|
| `scenarioKey` | Document | «универсально» ИЛИ «ещё не классифицирован» — **два разных смысла в одном значении**, не различимых на чтении | `prisma/schema.prisma:48-50` (комментарий) |
| `scenarioKey` | Rule/QAPair/DocChunk | «применимо ко всем сценариям» — везде расширяет, никогда не сужает выдачу | `scenarios.ts:14-20,234-236`; retrieval `enhanced-answering-engine.ts:636-645,1046-1047`; `vector-search.ts:124,198,303,372` |
| `scenarioKey` (лексический fallback) | — | когда классификатор молчит и в вопросе нет слова из `SCENARIO_LEXICAL_TRIGGERS`, допускаются ТОЛЬКО universal (null) правила — то есть здесь null — единственный допустимый результат, а не wildcard | `enhanced-answering-engine.ts:636-645` |
| `scenarioKey` (QAPair dedup) | QAPair | null и конкретный ключ на ОДИН и тот же вопрос/audience — разные identity-ключи upsert'а, могут сосуществовать как два «активных» конкурирующих ответа | `qa-upsert.ts:63-90` |
| `audience` | все таблицы | **НЕ nullable нигде** (enum с дефолтом `INTERNAL_ONLY`); null-семантики не существует, подтверждено — ни один код-путь не сравнивает `audience === null` | (отсутствие находок — намеренно упомянуто, а не пропущено) |
| `status` | Rule/QAPair | **НЕ nullable** (`KnowledgeStatus @default(ACTIVE)`); DocChunk вообще не имеет поля `status` — фильтруется только по audience/scenarioKey, что означает: **у чанков нет lifecycle вообще, устаревший/деприкейтнутый чанк документа физически неотличим от актуального**, если не удалён сам Document | `prisma/schema.prisma` (DocChunk model, нет `status` поля) |

**Практическое следствие первой строки (Document)**: если документ ещё не прошёл ручную scenario-классификацию (или её вообще нет — большинство документов, не про апостиль), его правила/чанки автоматически участвуют в КАЖДОМ ответе как «universal». Для документа реально широкого назначения («мы не работаем по праздникам») это верно; для документа, который просто не попал в дерево сценариев (апостиль на образование — 60 правил, см. п.7), это баг, маскирующийся под фичу.

---

## 5. Модель данных базы знаний

| Модель | Ключевые поля | Nullable | Индексы | ACTIVE-статистика (прод, 2026-08-05) |
|---|---|---|---|---|
| **Document** | title, filename, mimeType, rawText, parseStatus (enum, default PENDING), audience (enum, default INTERNAL_ONLY), scenarioKey | rawText, rawBytes, parseError, scenarioKey — да | parseStatus, scenarioKey | 44 документа всего |
| **Rule** | ruleCode, title, body, confidence (Float, default 0.8), status (enum ACTIVE/SUPERSEDED/DEPRECATED, default ACTIVE, **не nullable**), version, supersedesRuleId, sourceSpan (Json), scenarioKey, audience | documentId, supersedesRuleId, sourceSpan, scenarioKey — да | status, ruleCode, documentId, scenarioKey, audience | 1967 всего; scenarioKey NULL=1280, NOT NULL=255 |
| **QAPair** | question, answer, status (enum, не nullable), scenarioKey, audience, metadata (Json — authorityTag/origin/approvedBy) | documentId, ruleId, scenarioKey, metadata — да | status, documentId, ruleId, scenarioKey, audience | 775 всего; scenarioKey NULL=575, NOT NULL=96; authorityTag: null=641, HISTORICAL_ANSWER_AUTHORITY=121, **VOICE_ANSWER_AUTHORITY=13** |
| **DocChunk** | documentId (обязателен), chunkIndex, content (Text), embedding (Json?), metadata (Json?), scenarioKey, audience. **Нет поля status вообще** | embedding, metadata, scenarioKey — да | `@@unique([documentId,chunkIndex])`, documentId, scenarioKey, audience | 228 всего; scenarioKey NULL=204 (89%), NOT NULL=24 |
| **LlmCallLog** | (не в `prisma/schema.prisma` на master; существует только в БД) callSite, provider, model, systemPrompt, userMessage, rawResponse, temperature, maxTokens, responseFormat, streaming, latencyMs, error, sessionId, question, createdAt | — | — | 61 строка живьём, но **схема на master её не описывает** |
| **HeldAnswer** | question (Text, **побит мойбейком на всех проверенных строках**), draftAnswer, audience (raw String, НЕ enum — 'client'/'internal'), source, delivery, blocker, reasons (Json, не nullable), confidence, confidenceLevel, answerSource, sessionId, verdict (null="не проверено ещё"), verdictBy, verdictAt, comment | blocker, sessionId, verdict, verdictBy, verdictAt, comment — да | createdAt, verdict | 8 строк; 3 проверенных — все `audience:'client'`, `delivery:'escalate'`, `blocker:'confidence_level_too_low'`, `verdict:null` |

Обезличенные образцы (реальные данные прод, взяты read-only через `railway run`):
- **Rule** (последние 3, все ACTIVE, scenarioKey=null, audience=CLIENT_SAFE, confidence 0.95–1.0): `R-2023` «Маршрут простой ксерокопии…», `R-2022`/`R-2021` «Документы N категории сложности…».
- **QAPair** (последние 3) — оказались тестовыми маркерами `"TESTBENCH: retrieval-audit marker N/20…"`, `status: DEPRECATED`, `metadata.origin:"retrieval-audit-2026-08-05"` — то есть в базе уже лежат **20 незатёртых тестовых QAPair-строк от параллельного (Codex?) прогона аудита сегодняшнего дня**, включая связанные `LlmCallLog` со строками вроде «жопа чешется что делать» под тегами `ТЕСТ-ЭТАЛОН` — прямое живое подтверждение сценария из брифинга про «почесать», выполненное независимым агентом до меня и оставившее мусор в проде (см. п.6 «что не трогать» и рекомендации).
- **DocChunk**: контент из ценового документа («от 60 руб. за страницу А4», «Нотариальное заверение копии оригиналов УСТАВА…»), scenarioKey=null, audience=CLIENT_SAFE.
- **Document**: «Прайс клиентский апостиль…» (CLIENT_SAFE), «Блок 3 эталонные ответы» (INTERNAL_ONLY), «Прайс внутренний апостиль…» (INTERNAL_ONLY).
- **HeldAnswer**: `question` — кракозябры (`"????????? ????? ???..."`) при чистом `draftAnswer` на тех же строках — воспроизводимый баг кодировки на пути записи именно этого поля (не относится к retrieval, но зафиксирован для отдельного тикета).

---

## 6. Ingestion и chunking

- **Embedding**: `text-embedding-3-small`, 1536 измерений (`src/lib/openai.ts:13-16`, `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`), подтверждено также env `OPENAI_EMBEDDING_MODEL=text-embedding-3-small` в проде.
- **Chunking**: `src/lib/ai/chunker.ts` — фиксированная длина `CHUNK_SIZE=1000` символов, `CHUNK_OVERLAP=200` символов, с «мягким» поиском границы (±100 симв. окно, приоритет `\n\n`, `.\n`, `. `, `\n`) — это НЕ разбиение по заголовкам и не семантическое, а fixed-length-со-snap-к-предложению. Чанки короче 50 символов отбрасываются.
- **Contextual retrieval — подтверждено ОТСУТСТВИЕ.** Ни `chunker.ts:createDocumentChunks()`, ни `document-processing/commit.ts` не добавляют к чанку заголовок документа/раздела/summary перед эмбеддингом — эмбеддится дословный `chunk.content`. `TextChunk.metadata` содержит только `{startChar, endChar}`. Ни одного промпта вида «опиши, где этот фрагмент находится в документе» в `src/lib/ai/` или `document-processing/` не найдено.
- **Батчинг эмбеддингов**: `chunker.ts` — по одному чанку за раз (`EMBEDDING_BATCH_SIZE=1`, комментарий в коде: «EXTREME: Process 1 at a time for Railway free tier» — операционное ограничение инфраструктуры, а не архитектурное решение); `document-processing/commit.ts` — батчами по 5.
- **scenarioKey у чанков** — см. п.4: поле определено в схеме и участвует в фильтре retrieval, но ни в одном из 4 мест `docChunk.create` не заполняется — архитектурный долг, не намеренный дизайн.

---

## 7. Все виды поиска (`src/lib/ai/vector-search.ts`)

| Путь | Кандидат-пул | Фильтры | Top-K | Порог | Формула score |
|---|---|---|---|---|---|
| **A. pgvector semantic** (`searchSimilarChunksPgvector`, 93-164) | SQL `ORDER BY ... LIMIT limit` (limit·2 из hybridSearch) | domain/scenario/audience — в WHERE, до вычисления similarity | `limit` | `similarity >= minSimilarity` (default 0.3) | `1 - cosine_distance` (raw cosine similarity) |
| **B. In-memory fallback** (`searchSimilarChunksInMemory`, 186-236) | ВСЕ строки, прошедшие Prisma WHERE (без лимита на этапе SQL) | domain/scenario/audience — Prisma WHERE, до расчёта | `limit`, но в JS после сортировки всего пула | `similarity > 0.3` (строго больше, не ≥) | JS cosine similarity вручную |
| **C. Keyword FTS** (`searchByKeywords`, 270-345) | `ORDER BY ts_rank DESC LIMIT limit` | те же WHERE-фильтры | `limit` | нет явного порога отсечения (только пустой результат → фолбэк D) | `min(ts_rank/0.5, 1)` — произвольное линейное масштабирование неограниченного `ts_rank` |
| **D. Keyword-terms fallback** (`searchByKeywordTerms`, 347-404) | `take: max(limit·10, 50)` | те же WHERE-фильтры | `limit` (JS-сортировка) | нет | `min(0.15 + hits/max(terms.length,1), 1)` |

Путь C падает в путь D при пустом результате ИЛИ любой SQL-ошибке (line 336-344) — тихий деградационный каскад без явного сигнала о том, что «полнотекстовый поиск не сработал».

**hybridSearch()** (410-480): подтверждено, RRF реализован **правильно** для собственно ранжирующего скора — `k=60` (стандартная константа, line 425), `combinedScore = w·1/(k+semanticRank) + (1-w)·1/(k+keywordRank)`. Смешения несовместимых шкал в `combinedScore` НЕ найдено — сырые `semanticScore`/`keywordScore` хранятся в результате для UI/debug, но не участвуют в фьюжне. Риск смешения шкал переносится на **вызывающий код**: `selectContextChunks()` в `enhanced-answering-engine.ts:373-374` фильтрует по сырым `semanticScore >= 0.4 || keywordScore >= 0.65` — то есть окончательный отбор в контекст синтеза идёт НЕ по RRF-скору, а по сырым, разноприродным (cosine similarity vs пересчитанный ts_rank) порогам с разными числами (0.4 и 0.65) без объяснения, откуда они калиброваны.

**Ре-ранкер: подтверждено ОТСУТСТВИЕ.** `grep -r "rerank" src/` — ноль совпадений во всём репозитории. Никакой второй модельный вызов не переупорядочивает финальных кандидатов перед синтезом.

**scenarioKey в фильтрах** — везде pre-search WHERE (SQL или Prisma), никогда не постфильтр — архитектурно верно, но см. п.4/6 про фактическую незаполненность на `DocChunk`.

### Живое подтверждение из бенчмарка: путь A (pgvector) фактически МЁРТВ в проде

Прогон бенчмарка (п.11) зафиксировал в логе первого же запроса: `[vector-search] pgvector extension not found, using in-memory search` (4 раза — по числу вариантов запроса на первом вопросе). Код кэширует результат на уровне модуля (`vector-search.ts:30-68`, `pgvectorAvailable: boolean | null`, once-computed) — поэтому дальше по логу это сообщение не повторяется, но решение «pgvector недоступен» действует на ВСЕ 33 вопроса бенчмарка. **Это значит, что вся семантика раздела «путь A» в таблице выше (SQL `ORDER BY … LIMIT`, порог `>=0.3`) в проде не выполняется НИ РАЗУ — реальный семантический поиск в 100% запросов идёт через путь B** (`searchSimilarChunksInMemory`): полная выборка всех подходящих по scenario/audience чанков (сейчас 228 всего, так что не критично по производительности), JS cosine similarity, порог `> 0.3` (строго больше, не ≥), топ-K уже после сортировки в Node, а не в БД. Расширение `pgvector` на Railway Postgres, судя по всему, либо не установлено, либо недоступно текущему пользователю БД — стоит проверить `CREATE EXTENSION vector;` отдельно (вне рамок read-only аудита). При росте корпуса чанков за пределы нескольких тысяч этот путь начнёт деградировать по производительности без какого-либо алерта — обнаружить его сейчас можно только по логу, а не по метрике.

---

## 8. Применимость бизнес-правил

- Условия применимости проверяются **только текстовым/лексическим совпадением и scenarioKey-фильтром**, не структурированными полями «город/партнёр/документ/страна». Отдельного поля «применимо к региону X» на `Rule` нет — есть только `body`-текст и `scenarioKey`.
- Правило одного города/партнёра МОЖЕТ уйти в ответ про другой — единственная защита: (а) scenarioKey-фильтр (работает только внутри `apostille.*`, для остального дерева его просто нет), (б) детерминированные guardrail-ветки типа `resolveApostilleTerritoriality`, писанные вручную под конкретные найденные баги (Орёл/FPM — по комментариям в коде это именно такой случай, зашитый после инцидента, а не общее решение).
- **Конфликтующие правила**: `rule-conflict-detector.ts` существует (эмбеддинг-based similarity + LLM-суждение о типе конфликта, пишет `AIQuestion` для человека), но **полностью не подключён** — ноль импортов вне собственного файла, не вызывается ни из hot path, ни из cron/admin route. Мёртвый код. Единственная реально работающая защита от конфликта — `qa-upsert.ts:78-90`, которая при апсерте новой QAPair с тем же вопросом, но другим `scenarioKey`, только **логирует предупреждение** («КОНФЛИКТ СЦЕНАРИЕВ»), не блокирует и не мержит — обе версии остаются ACTIVE и обе доступны retrieval одновременно.
- **Дата/версия правила**: `Rule.version`/`supersedesRuleId` есть, но в самом retrieval (`enhanced-answering-engine.ts` Step 5) версия не участвует в ранжировании вообще — фильтр только по `status='ACTIVE'`, так что если старое правило почему-то осталось ACTIVE рядом с новым (не проставлен `SUPERSEDED`), оба конкурируют на равных.

---

## 9. Механизм ручного «обучения»

Два входа сливаются в общую функцию `upsertLearnedQaPair` (`src/lib/knowledge/qa-upsert.ts:47-130`):
- **Голосовой ответ** (`/api/admin/bot-lab/voice-answers/route.ts`, admin-only) — оператор надиктовывает ответ, `polishVoiceAnswer` (LLM) причёсывает текст, пишется QAPair с `audience=INTERNAL_ONLY` и `metadata.authorityTag='VOICE_ANSWER_AUTHORITY'`.
- **Одобрение knowledge-gap черновика** (`knowledge-feedback.ts`) — низкодоверительные ответы бота автоматически создают `AIQuestion` (draft), админ его одобряет → тот же `upsertLearnedQaPair`, но **без** `authorityTag='VOICE_ANSWER_AUTHORITY'` — то есть эти пары НЕ попадают в canonical-override быстрый путь (`findCanonicalQaOverride` матчит только по этому тегу).
- **Дедупликация**: identity = `(question, audience, scenarioKey)` (точное совпадение строки вопроса). Одинаковый ответ на тот же триплет → no-op; разный ответ → старая строка помечается `SUPERSEDED`, новая создаётся с инкрементом версии. Похожая, но НЕ идентичная формулировка вопроса дедупликацией НЕ ловится вообще — это обычная новая строка.
- **Это чисто retrieval + LLM-переформулировка, НЕ дообучение весов** — подтверждено промптом `polishCanonicalAnswer` (`canonical-answer-polisher.ts:7-22`): «Сохрани ВЕСЬ смысл и все факты из исходного ответа. НЕ выдумывай новые данные» — модель только меняет стиль, не добавляет знание.

### Разбор «почесать/чесать/причесать/подчесать» — тезис ОПРОВЕРГНУТ

Прослеживая `extractSearchTerms` (`enhanced-answering-engine.ts:390-409`) буквально:
- `почесать` (8) → `{почесать, почесат, почеса}`
- `чесать` (6) → `{чесать, чесат}`
- `причесать` (9) → `{причесать, причесат, причеса}`
- `подчесать` (9) → `{подчесать, подчесат, подчеса}`

Усечение убирает только 1–2 **хвостовых** символа — оно не может стереть 2–3-буквенную **приставку** (по-/при-/под-). Пересечение множеств между любой парой этих 4 слов — **пустое**. `questionTermOverlap` вернула бы `{short:0, long:0}` на этих словах в изоляции, что ниже порога 0.55/0.5. Совпадение, зафиксированное сегодня в живом тесте (упомянутое в брифинге и подтверждённое найденными в проде тестовыми `LlmCallLog`-строками про «жопа чешется») объясняется НЕ общей стеммой этих глаголов, а тем, что в коротких тестовых вопросах доминировало другое редкое слово («жопа»), давшее высокий overlap независимо от глагольной формы — то есть реальный баг существует (короткий вопрос с одним редким словом легко перебивает порог), но его механизм — не тот, что описан в исходной гипотезе про стемминг глаголов. `чесание` (существительное) действительно не пересекается ни с одной формой (другой суффикс, `-ание` вместо `-ать`) — это подтверждено. Порядок слов подтверждённо не влияет: сравнение через `Set`, не строку.

---

## 10. Логирование — что НЕ фиксируется

На `master` (этот worktree) вообще нет ЛОГ-инфраструктуры LLM-вызовов (см. п.3 — `LlmCallLog` есть только в БД, не в коде). Даже когда код с `feat/llm-call-logging` замержен, он по конструкции (см. её собственный call-site список) логирует только финальный `systemPrompt`/`userMessage`/`rawResponse` каждого вызова — НЕ:
- какие именно кандидаты (chunk id, rule id, qa id) рассматривались до фильтрации;
- score каждого из 4 методов поиска ДО RRF-слияния;
- причину исключения кандидата (не прошёл порог 0.4/0.65, не прошёл scenario-фильтр, проиграл top-K);
- какие чанки/правила были в кандидат-пуле, но НЕ попали в `contextChunks`/`rules`/`qaPairs`, отправленные в промпт синтеза.

Единственная частичная замена — `includeDebug: true` в `EnhancedAnswerResult.debug` (возвращает `chunks` с sem/kw/comb score, но только те, что УЖЕ прошли `selectContextChunks`, то есть уже после отсева) — это ответ API, не персистентный лог, доступен только вызывающему конкретный запрос (например `diagnose-answer.ts`), не хранится в БД для последующего анализа трендов.

---

## 11. Результаты контролируемого бенчмарка (ЧАСТИЧНЫЙ — 22 из 33 вопросов)

Метод: 33 реальных вопроса (перефразировки, словоформы, отрицания, hard negatives, недостающие условия, страна выдачи) прогнаны READ-ONLY через `railway run npx tsx scripts/diagnose-answer.ts --file=audit-benchmark-questions.txt` — это вызывает `answerQuestionEnhanced()` напрямую (audience='internal', includeDebug=true) без каких-либо записей в БД (сам скрипт не пишет ничего, кроме штатных fire-and-forget телеметрических записей движка типа `hallucinationLog`, которые и так пишутся в обычной работе бота). **Никакие тестовые QAPair не создавались** — в отличие от рекомендации в брифинге, этот read-only путь оказался достаточным и строго безопаснее (ноль новых строк для последующей очистки, соответственно нечего деприкейтить). Файл вопросов и полный лог сохранены во временной директории worktree (`audit-benchmark-questions.txt`, `benchmark-output.txt` — не закоммичены, будут удалены при завершении сессии).

**Прогон прерван на вопросе 23/33** — во время ожидания соединение с Railway Postgres оборвалось (`Can't reach database server at shinkansen.proxy.rlwy.net:22114`, воспроизведено отдельной read-only проверкой на отсутствие тестовых записей). Это сетевая нестабильность окружения, не ошибка методики; **22 полных прогона с полным трейсом уже дают представительную картину** и содержат живое подтверждение ключевого бага из брифинга (см. вопрос 11 ниже). Оставшиеся 11 вопросов (сроки ЗАГС СПб, отрицания, «вне области», недостающие условия, Казахстан/Германия) не выполнены — это не заявляется как полный охват.

### Таблица результатов (22 завершённых)

| # | Вопрос | Ворота сценария | Источник | Уверенность | Чанков | Комментарий |
|---|---|---|---|---|---|---|
| 1 | Апостиль на нотариальную копию доверенности | scenario_clear→min_justice | 🟢 RAG | 55% medium | 5 | ожидаемо, корректно |
| 2 | Апостиль на доверенность — куда подавать | scenario_clear→min_justice | 🟢 RAG | 52% medium | 5 | ответ содержит **Markdown-жирный** текст и график приёма МЮ — формально нарушает «без Markdown» из системного промпта (`ENHANCED_ANSWERING_PROMPT`), сам факт по существу верный |
| 3 | Нужен ли оригинал для апостиля нотариальной копии | scenario_clear→min_justice | 🟢 RAG | 60% medium | 5 | ожидаемо |
| 4 | Апостиль СОР, выдан в СПб | scenario_clear→zags.spb | 🟢 RAG | 71% high | 5 | ожидаемо, лучший скор в серии |
| 5 | Апостиль СОБ из ЛО, цена | scenario_clear→zags.lo | 🟢 RAG | 53% medium | 5 | ожидаемо |
| 6 | Апостилируете ли СОР из ЛО (перефразировка) | scenario_clear→zags.lo | 🟢 RAG | 61% medium | 5 | синоним «апостилируете» распознан верно |
| 7 | Апостиль СОР, выдан в Москве (hard negative, территориальность) | needs_clarification | 🟡 guardrail | 90% medium | 0 | **корректно** — детерминированный guardrail сработал раньше RAG |
| 8 | Апостиль диплома, выдан в Саратове (hard negative) | knowledge_lookup | 🟢 RAG | 59% medium | 5 | ответ «да, примем, регион не важен» — по правилам образовательного апостиля это фактически верно (централизованная подача), НЕ регрессия территориальности; см. № 9-12 для контраста |
| 9 | Апостиль справки о несудимости, «другой регион» | knowledge_lookup | 🟢 RAG | 55% medium | 5 | аналогично №8 |
| 10 | **«Как передать документы в Москву?»** | out_of_scope→open lookup | 🟢 RAG | 59% medium ⚠HR | 5 | нейтральный логистический вопрос, ответ по существу про доставку — не спутан с Орлом |
| 11 | **«Как отправить документы в Минск?» — ЖИВОЕ ПОДТВЕРЖДЕНИЕ БАГА ИЗ БРИФИНГА** | out_of_scope→open lookup | 🟢 RAG | 58% medium ⚠HR | 5 | Топ-1 чанк (sem=0.4931) — адрес партнёра FPM в Орле, вообще не связанный с Минском/Беларусью. Consistency-gate поймал и убрал прямое утверждение «см. инструкции по Минску», но **регенерированный ответ всё равно процитировал адрес Орла дословно** («…содержат информацию об отправке документов партнёру в Орёл (адрес: 302028, г. Орёл…)») — то есть контроль смягчил, но НЕ устранил утечку не-по-теме адреса в финальный текст. Это **ровно** механизм бага из брифинга, пойманный вживую в этой сессии |
| 12 | «Как передать доки в Пермь?» (та же группа) | out_of_scope→open lookup | 🟢 RAG | 61% medium ⚠HR | 5 | не проверено детально — не хватило времени на построчный разбор |
| 13 | Куда подавать диплом на апостиль (недостающее условие) | needs_clarification | ⚪ уточнение | 0% insufficient | 0 | **корректно** — дерево сценариев верно попросило уточнение |
| 14 | Нужен ли оригинал для нотариального перевода (недостающее условие) | out_of_scope | 🟡 guardrail | 90% medium | 0 | guardrail source-document-route сработал корректно |
| 15 | Нотариальный перевод по сканкопии (словоформа) | knowledge_lookup | 🟢 RAG | 63% medium | 5 | опечатка «сканкопии» не помешала retrieval |
| 16 | «Не нужен ли оригинал для заверения» (отрицание) | out_of_scope | 🟡 guardrail | 90% medium | 0 | отрицание не сломало guardrail-детекцию |
| 17 | Присяжный перевод для суда в РФ | out_of_scope | 🟡 guardrail | 90% medium | 0 | сработал специальный guardrail «в РФ присяжного перевода нет» |
| 18 | Перевод для суда за рубежом | out_of_scope | 🟡 guardrail | 90% medium | 0 | аналогично |
| 19 | Сколько стоит нотариальное заверение перевода | out_of_scope→open lookup | 🟢 RAG | 100% high | 5 | **живое подтверждение fallback-цепочки**: лог показал `[chat-provider] anthropic failed after retries, falling back to openai` прямо на этапе scenario-gate — ретрай/фолбэк реально сработал в этом прогоне. Цитаты (`citations`) при этом показали `rel=0.0000` для ВСЕХ 5 источников — баг отображения релевантности (см. п.12, новая находка) |
| 20 | Сколько стоит перевод паспорта с английского | out_of_scope→open lookup | 🟢 RAG | 100% high | 5 | аналогично №19 |
| 21 | Цена нотариальной копии устава | out_of_scope→open lookup | 🟢 RAG | 58% medium ⚠HR | 5 | не проверено детально |
| 22 | Сроки апостиля в Минюсте | scenario_clear→min_justice, conf=0.95 | 🟢 RAG | 64% medium | 5 | ожидаемо |
| 23 | Сроки апостиля ЗАГС СПб | — | — | — | — | **не завершён** — обрыв соединения |

### Метрики по 22 завершённым

- **Wrong-scope (утечка не по теме)**: 1 подтверждённый случай из 22 (№11, «Минск» → адрес Орла), = **4.5%** — при этом частично смягчён consistency-gate (не полностью устранён, финальный текст всё равно называет адрес).
- **Territoriality regression** (правило одного региона выдано за общее): 0 из 4 прямых territoriality-тестов (№7-9, №4-6) — guardrail и RAG в этой выборке отработали корректно, в том числе тесты №8-9 («другой регион» для диплома/несудимости), где централизованная подача — не баг, а реальное свойство процедуры.
- **Knowledge gap (знание в базе, но не найдено)**: 0 подтверждённых случаев в завершённой части — везде либо нашлось (RAG/guardrail), либо честно запрошено уточнение (№13).
- **Ложный guardrail/RAG confidence=100%** (№19-20) — оба раза совпало с реальным успешным поиском прайса, похоже на корректную работу, но citations с `rel=0.0000` — сигнал, что механизм отображения провенанса не так надёжен, как сама уверенность ответа.

---

## 12. Классификация проблем: knowledge gap vs retrieval bug vs generation bug

| # | Проблема | Класс | Файл:строка |
|---|---|---|---|
| 1 | `DocChunk.scenarioKey` никогда не пишется — сценарный фильтр чанков — no-op на 89% данных | retrieval bug | `chunker.ts:129`, `commit.ts:319`, `knowledge-manager.ts:419`, `document-handler.ts:369` |
| 2 | Таксономия сценариев покрывает только `apostille.*` — весь остальной домен (перевод, нотариальное заверение, доставка, сроки) не сегментирован — правило одной темы может попасть в ответ другой | knowledge gap (архитектурный, не про содержание) | `scenarios.ts:79-188` (закомментированные "FUTURE SCENARIOS") |
| 3 | `rule-conflict-detector.ts` не подключён — конфликтующие правила не выявляются автоматически | retrieval bug (упущенная защита) | весь файл, 0 импортов извне |
| 4 | `LlmCallLog` есть в проде, но не в git-схеме master — обещанная наблюдаемость фантомна на текущем HEAD | инфраструктурный/процессный баг, не retrieval | `prisma/schema.prisma` (отсутствие модели) vs прод-БД |
| 5 | Нет ре-ранкера — финальный отбор в контекст идёт по сырым, разнородно откалиброванным порогам (0.4 semantic / 0.65 keyword) | retrieval bug (архитектурный пробел) | `enhanced-answering-engine.ts:373-374` |
| 6 | Нет contextual retrieval — короткие/generic формулировки в чанке (без заголовка раздела) хуже находятся embedding-поиском | retrieval bug | `chunker.ts`, `commit.ts` |
| 7 | Основной RAG-синтез не видит историю диалога (только general_ai fallback видит) | generation bug (контекст теряется) | `enhanced-answering-engine.ts:2244-2261` vs отсутствие аналога в Step 1-9 |
| 8 | Нет timeout на LLM HTTP-вызовы | инфраструктурный риск | `chat-provider.ts` (весь файл) |
| 9 | Захардкоженный дефолт `claude-3-opus-20240229` при потере `ANTHROPIC_MODEL` | инфраструктурный риск (latent) | `chat-provider.ts:18-19` |
| 10 | `HeldAnswer.question` — мойбейк на записи | generation/infra bug, не retrieval | таблица `HeldAnswer`, путь записи не идентифицирован (требует отдельного расследования) |
| 11 | Стейл тестовые QAPair/LlmCallLog от параллельного аудита сегодня остались в проде (DEPRECATED, но не удалены) | процессный, не архитектурный | таблицы `QAPair`/`LlmCallLog`, `metadata.origin='retrieval-audit-2026-08-05'` |
| 12 | QAPair-дедуп по точному тексту вопроса не ловит перефразировки — возможен рост дублей с похожими, но не идентичными вопросами | knowledge gap (управление данными) | `qa-upsert.ts:65-68` |
| 13a | `polishCanonicalAnswer()` не получает `audience` вообще (`buildCanonicalQaResult(question, canonicalQa, includeDebug)`, `enhanced-answering-engine.ts:719-770` — вызов без audience) — промпт (`canonical-answer-polisher.ts:7-22`) жёстко требует «Начни с приветствия… клиентское сообщение», поэтому internal-запрос сотрудника, попавший под canonical override, получает клиентский тон с «Здравствуйте!»/«Будем рады помочь!» вместо делового внутреннего ответа | generation bug | `enhanced-answering-engine.ts:719-770`, `canonical-answer-polisher.ts:7-22` |
| 13 | pgvector-расширение недоступно в проде — путь A семантического поиска (SQL ANN) никогда не выполняется, весь семантический поиск идёт через in-memory JS fallback без алертинга о деградации | инфраструктурный риск (подтверждено логом бенчмарка) | `vector-search.ts:30-68` |
| 14 | Живое подтверждение бага «не-по-теме адрес партнёра в ответе про другой город» (вопрос №11 бенчмарка «Как отправить документы в Минск?» — топ-1 чанк про партнёра FPM в Орле; consistency-gate смягчил прямое утверждение, но регенерированный ответ всё равно дословно процитировал адрес Орла) | retrieval bug (частично смягчён generation-контролем, не устранён) | `enhanced-answering-engine.ts:1349-1440` (consistency-gate/regenerate), живой пример в `benchmark-output.txt` строки 568-621 |
| 15 | `citations[].relevanceScore` показывает `0.0000` для всех источников на вопросах №19-20 бенчмарка, при этом сам ответ дан с уверенностью 100% — провенанс-механизм (`docScoreByDocId`, `enhanced-answering-engine.ts:1652-1677`) не находит соответствия между цитируемым правилом и chunksByDoc, когда основной вклад в ответ даёт `tariffContext` (прайс), а не document-чанки | generation/transparency bug | `enhanced-answering-engine.ts:1652-1677` |
| 16 | Живое подтверждение Anthropic→OpenAI fallback в реальном трафике (вопрос №19: `[chat-provider] anthropic failed after retries, falling back to openai`) — механизм из п.3 работает, но подтверждает, что Anthropic Haiku реально периодически недоступен/перегружен на проде | инфраструктурный факт, не баг | `chat-provider.ts:330-348`, живой пример в `benchmark-output.txt` |

---

## 13. Минимальная целевая архитектура (без смены стека)

1. **Заполнить `DocChunk.scenarioKey` при записи** — либо наследовать от родительского `Document.scenarioKey` в момент `docChunk.create` (простое, дешёвое, script-first исправление в 4 местах записи), либо явно решить, что чанки намеренно универсальны (тогда убрать сам столбец и фильтр как мёртвый код) — текущее состояние «поле есть, фильтр есть, данных нет» хуже обоих вариантов.
2. **Подключить `rule-conflict-detector.ts`** к пути апсерта правил (аналогично тому, как `qa-upsert.ts` уже логирует конфликт для QA) — либо явно списать его как мёртвый код и удалить.
3. **Смёржить `feat/llm-call-logging` в master** и привести `prisma/schema.prisma` в соответствие с реальной прод-БД (текущий разъезд — уже риск: следующий `prisma migrate`/`db push` с master может конфликтовать с уже существующей в БД таблицей).
4. **Ре-ранкер не обязателен «дорогим» способом** — минимально: замена ad hoc порогов 0.4/0.65 в `selectContextChunks` на единый калиброванный сигнал (например top-N по RRF `combinedScore` с последующим cross-encoder или дешёвым LLM-скорером на 5-10 кандидатах, Haiku-класса — недорого, у бота и так Haiku в проде).
5. **Contextual retrieval — дёшево и script-first**: при чанкинге добавлять префикс "Документ: {title}. Раздел: {ближайший заголовок}." к тексту ПЕРЕД эмбеддингом (не в сохранённый `content`, который видит синтез, — а в отдельное поле `embeddingText`), это не требует LLM-вызова, чистый скрипт.
6. **Таймаут на LLM-вызовы** — `AbortController` с 30-60с, иначе один зависший вызов Anthropic/OpenAI блокирует ответ бесконечно (P1, тривиально чинится).
7. **Убрать устаревший дефолт `claude-3-opus-20240229`** — заменить на актуальную модель или явный fail-fast при отсутствии `ANTHROPIC_MODEL`, чтобы тихий даунгрейд был невозможен.

---

## 14. Порядок работ

1. **P0 — scenarioKey на DocChunk** (пункт 13.1) — самый большой разрыв между «архитектура выглядит правильной» и «данные её не подтверждают»; дёшево чинится, высокий эффект (89% чанков сейчас без сценарной защиты).
2. **P0 — смёржить llm-call-logging, синхронизировать схему** (13.3) — без этого весь план наблюдаемости из брифинга не существует в проде.
3. **P1 — таймаут на LLM-вызовы** (13.6) — тривиально, устраняет риск зависания.
4. **P1 — контекст диалога в основной RAG-путь** (проблема #7) — сейчас теряется на каждом non-fallback ответе.
5. **P2 — contextual retrieval при чанкинге** (13.5) — недорого, повышает recall на коротких/обезличенных фрагментах.
6. **P2 — ре-ранкер/калибровка порогов** (13.4) — требует замера на реальных данных до внедрения, не блокер.
7. **P3 — rule-conflict-detector: подключить или удалить** (13.2) — решение управленческое, не техническое.

---

## 15. Что НЕ трогать (работает штатно)

- RRF-слияние в `hybridSearch()` — формула корректна, `k=60` стандартный, веса не смешаны в самом фьюжн-скоре.
- `checkClaimGrounding`/`checkStalePrice`/`checkCertificationPriceAttribution`/`checkClientSafety` — детерминированные regex-контроли, по имеющимся в коде комментариям уже верифицированы на реальных корпусах (`scripts/verify-stale-price.ts`: 29/29 подложенных ошибок пойманы, 0 ложных тревог на 156 сохранённых ответах) — не трогать без нового замера.
- Дедуп QAPair по точному вопросу — работает как задумано для точных совпадений, не пытается решить более широкую задачу похожести (это отдельная фича, не баг).
- Guardrail-ветки (территориальность, source-document-route, суд/присяжный перевод) — целенаправленно написаны под конкретные зафиксированные инциденты, с цитатами слов владельца бюро — не рефакторить без нового инцидента.

---

## 16. Точные файлы/функции для следующего этапа

- `src/lib/ai/chunker.ts:129`, `src/lib/document-processing/commit.ts:319`, `src/lib/telegram/knowledge-manager.ts:419`, `src/lib/telegram/document-handler.ts:369` — добавить `scenarioKey` при `docChunk.create`.
- `src/lib/ai/rule-conflict-detector.ts` — решить: подключить к `src/lib/knowledge/qa-upsert.ts`-аналогу для Rule, или удалить.
- `prisma/schema.prisma` + ветка `feat/llm-call-logging` (commit `c5d630d`) — смёржить, `prisma db push` уже применён к проду, откат невозможен без потери 61 строки — мержить код, не откатывать БД.
- `src/lib/ai/chat-provider.ts:18-19` (дефолт модели), весь файл (нет timeout — добавить `AbortController`).
- `src/lib/ai/enhanced-answering-engine.ts:373-374` (`selectContextChunks` пороги) — калибровка.
- `src/lib/ai/chunker.ts`, `src/lib/document-processing/commit.ts` — добавить contextual prefix перед эмбеддингом.
- Очистка: `QAPair`/`LlmCallLog` со `metadata.origin='retrieval-audit-2026-08-05'` — удалить (не DEPRECATED, а физически, раз это тестовый мусор от параллельного прогона, не отвечающие продакшн-данные).

---

## Приложение A. Бенчмарк — таблица результатов

Таблица приведена в п.11 (22 из 33 вопросов, прогон прерван обрывом связи с Railway Postgres). Полный текстовый трейс каждого вопроса (ворота сценария, источник ответа, чанки с sem/kw/comb, citations, финальный текст ответа) сохранён в `benchmark-output.txt` в корне этого worktree — файл не закоммичен (временный диагностический артефакт), доступен только внутри этой рабочей копии до её удаления. Вопросы 23–33 (сроки ЗАГС СПб, отрицания на переводе/апостиле, вне-области, недостающие условия, Казахстан/Германия) не выполнены и не должны считаться проверенными.
