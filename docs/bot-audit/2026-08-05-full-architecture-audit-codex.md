# Полный read-only аудит архитектуры бота «Аврора»

Дата среза: 5 августа 2026 г.
Репозиторий: `C:\dev\translation`; checkout: `efe693a34d261b3be5e9ce2a740852c7d35c915e`, ветка `feat/telegram-client-training-bot`.
Стек: Next.js 16, Prisma 5, PostgreSQL/Railway, OpenAI/Anthropic.
Режим: код и конфигурация только читались. Единственная запись в БД — предусмотренная заданием очистка 20 строк QAPair с точным TESTBENCH-маркером: `ACTIVE → DEPRECATED`; после очистки активных TESTBENCH-строк — 0. Код, PR, deploy и остальные production-записи не менялись.

## 1. Executive summary

1. Основная RAG-цепочка разумно разделяет scenario gate, multi-query hybrid retrieval, синтез и два post-generation контроля; RRF математически корректен, а numeric grounding проверяет контекст, увиденный моделью (`src/lib/ai/enhanced-answering-engine.ts:938-1009,1275-1287,1382-1473`; `src/lib/ai/vector-search.ts:430-501`; `src/lib/ai/claim-grounding.ts:188-209`).
2. Главный дефект — отсутствие формальной модели применимости знания. Таксономия `scenarioKey` покрывает только апостиль МЮ/ЗАГС, а `null` означает и «действует для всего», и «тема не классифицирована». В production-срезе `null` имели 1 546/1 967 Rule, 631/775 QAPair и 204/228 DocChunk; образовательный апостиль дал 60 активных правил и 7 чанков с `null`.
3. Поэтому узкое правило для города, партнёра или документа ранжируется по словам вместо обязательного отсечения по условиям. Живой тест: три формулировки передачи документов в Москву получили top-1 про партнёра в Орле (`.claude/audits/2026-08-05-moscow-oryol-bad-answer.md`).
4. Точечный confidence floor для `scenarioKey=null` уменьшает этот риск (`enhanced-answering-engine.ts:364-400,1095-1112,1156-1168`), но не устраняет перегрузку `null`, не вводит hard filters и не разрешает конфликты применимости.
5. «Обучение» оператора — запись QAPair и лексический override, а не дообучение модели (`enhanced-answering-engine.ts:403-522,683-729`; `src/lib/knowledge/qa-upsert.ts:47-129`). Общая редкая лексема даёт false positive, морфологически родственное слово может не совпасть.
6. Production не имеет extension `vector` и колонки `embeddingVector`; 228 embeddings — JSON-массивы размерности 1536. Текущий semantic path поэтому считает cosine в Node (`vector-search.ts:182-280,530-589`).
7. Провайдер по умолчанию — Anthropic при наличии ключа, модель `claude-3-opus-20240229`; OpenAI default — `gpt-4o`. Есть 4 попытки primary и 1 fallback, но нет timeout/AbortSignal; успешный fallback скрывает ошибку primary (`chat-provider.ts:18-31,221-346`).
8. `LlmCallLog` хранит финальные system/user/raw payload, но не retrieval trace, attempt и provider transition. По нему нельзя восстановить причину победы конкретного Rule/DocChunk.
9. В tracked Markdown найдены строки, похожие на API credentials (`SESSION_2026-01-20_streaming-processing-memory-optimization.md:24,91`; `SESSION_NOTES.md:1018,1021,1068`). Значения не воспроизводятся: P0 — ротация и очистка истории.
10. Минимальная целевая архитектура сохраняет стек: typed applicability facets, разделение `GLOBAL`/`UNCLASSIFIED`, pgvector, hard filtering до ranking, отдельный canonical matcher, reranker top-N и retrieval telemetry.

## 2. Полная цепочка одного запроса

### 2.1 Вход API

`POST /api/ask` принимает question/session/debug/context. Неаутентифицированный вызов получает `audience='client'`; внутренний режим доступен аутентифицированному пользователю. Route сохраняет сообщение, использует exact cache на 30 минут (до 200 элементов), вызывает context wrapper либо `answerQuestionEnhanced`, затем маршрутизирует direct/held/outbound (`src/app/api/ask/route.ts:22-265`).

### 2.2 Sequence diagram

```text
Client -> POST /api/ask -> auth/session/cache
  -> answerQuestionWithContext? -> [optional follow-up LLM]
  -> answerQuestionEnhanced(question, audience, sessionId)
     -> classifyScenario -> deterministic regex OR classifier LLM
     -> findCanonicalQaOverride (DB + term overlap)
        alt hit: canonical-polisher LLM -> deterministic guards -> answer
        else:
          -> territorial/clarification guards
          -> parallel: expandQuery LLM | extractEntities LLM | classifyIntent LLM
          -> query variants
          -> per variant, parallel:
               embedding API -> semantic search
               PostgreSQL FTS -> keyword search/fallback
             -> RRF -> cross-variant max merge -> top 10
          -> selectContextChunks -> max 5
          -> Rule pools -> lexical rank -> top 10
          -> QAPair pools -> lexical rank -> top 5
          -> Tariff lookup -> exact synthesis context
          alt safe general fallback: general-knowledge LLM
          else: synthesis LLM -> consistency LLM
                alt unsupported: one regeneration LLM -> consistency LLM again
                -> numeric/price/staleness/client guards
     <- answer + confidence + citations + review reasons/debug
  -> persist assistant/HeldAnswer/outbound decision -> JSON
```

### 2.3 Шаги, вход/выход, ошибки

| Шаг | Функция | Вход → выход | Ошибка/fallback |
|---|---|---|---|
| Scenario | `classifyScenario`, `scenario-classifier.ts:74-170` | question → clear/clarification/lookup/out-of-scope | regex first; LLM/JSON/unknown key → out-of-scope, затем open lookup (`enhanced...:913-921`) |
| Canonical | `findCanonicalQaOverride`, `enhanced...:683-729` | question+audience → QAPair/null | DB error → null; scenario не участвует |
| Guards | `enhanced...:873-893` | question/audience/scenario → answer/continue | deterministic, no LLM |
| Understanding | `expandQuery`, `extractEntities`, `classifyIntent` | question → variants/entities/intent | `Promise.allSettled`; сбой → empty/default (`enhanced...:938-959`) |
| Variants | `enhanced...:960-972` | LLM+abbreviation+deterministic → deduped strings | число/длина LLM variants не валидируются |
| Chunks | `multiQuerySearch`, `enhanced...:332-359,974-990` | variants+scope+audience → top 10 | один rejected query роняет `Promise.all`; error наружу |
| Context | `selectContextChunks`, `enhanced...:364-400` | top 10 → max 5 | absolute floor + 60% лучшего RRF |
| Rules | `enhanced...:1043-1130` | per-term ×25 + confidence100 → top10 | DB error наружу |
| QA | `enhanced...:1132-1186` | per-term ×25 + recent100 → top5 | DB error наружу |
| Confidence | `enhanced...:1188-1263` | max semantic/QA overlap → level | intent confidence намеренно исключён |
| Synthesis | `enhanced...:1265-1380` | exact context+tariffs+question → text | API error наружу; empty → фиксированная ошибка |
| Consistency | `verifyAnswer`, `consistency-gate.ts:66-153` | answer+exact sources → claim verdict | fail-closed; одна regeneration и recheck |
| Grounding | `checkClaimGrounding`, `claim-grounding.ts:156-209` | answer+sources → unsupported numeric claims | deterministic; не проверяет scope/актуальность |
| Delivery | review registry, `enhanced...:1571-1640` | result → direct/held | падение проверки само становится hold reason |

## 3. Все LLM-вызовы на answer path

### 3.1 Провайдер, retry, timeout

`getProvider()` берёт `AI_PROVIDER`; иначе выбирает Anthropic при `ANTHROPIC_API_KEY`, иначе OpenAI (`chat-provider.ts:18-31`). Defaults: Anthropic `claude-3-opus-20240229`, OpenAI `OPENAI_CHAT_MODEL`/`gpt-4o`; temperature .3; Anthropic max output 2048, OpenAI получает limit только при явном `maxTokens` (`chat-provider.ts:18-24,240-295`; `src/lib/openai.ts:4-15`).

Primary запускается `attempt=0..3` с backoff 1/2/4 с для retryable 429/529/503/502, затем ровно одна попытка другого провайдера (`chat-provider.ts:221-346`). Явного timeout нет. `options.model` переиспользуется на fallback. При двойном сбое выбрасывается primary error, fallback-error остаётся console-only. Production-срез: 61 успешная `LlmCallLog`, все OpenAI/`gpt-4o`, 8 callSite; это не показывает, был ли перед успехом неудачный Anthropic primary.

### 3.2 Callsites и prompts

| # | Callsite | Полный prompt / точка сборки | Output | temp/max | Fallback поведения |
|---:|---|---|---|---|---|
| 1 | scenario classifier | `CLASSIFIER_PROMPT`, `taxonomySummary()+question`, `scenario-classifier.ts:31-98` | `{scenarioKey,outOfScope,reasoning}` | 0/256 | failure → out-of-scope |
| 2 | query expansion | `QUERY_EXPANSION_PROMPT`, question, `query-expansion.ts:17-48` | `{isAmbiguous,variants,suggestedClarification}` | .3/default | empty/default |
| 3 | entity extraction | `ENTITY_EXTRACTION_PROMPT`, question, `query-expansion.ts:79-102` | `{dates,prices,documentTypes,services}` | .1/default | empty arrays |
| 4 | intent | `INTENT_CLASSIFIER_PROMPT`, question, `enhanced...:245-305` | `{intent,domains,confidence,reasoning}` | .1/1024 | general_info/[]/.5 |
| 5 | canonical polish | `POLISH_PROMPT`, question+exact QA, `canonical-answer-polisher.ts:1-46` | `{polishedAnswer}` | .25/2048 | raw QA answer |
| 6 | synthesis | полные constants `ENHANCED_ANSWERING_PROMPT`/`CLIENT_ANSWERING_PROMPT` at `enhanced...:132-244`; user assembly `1340-1375` | free text | 0/default | error propagates |
| 7 | consistency | полный `VERIFIER_SYSTEM_PROMPT`; numbered sources+answer, `consistency-gate.ts:36-99` | claims array | 0/2000 | fail-closed/hold |
| 8 | regeneration | same synthesis system; context+old answer+unsupported, `enhanced...:1411-1435` | free text | 0/default | keep old answer |
| 9 | consistency recheck | same as #7, `enhanced...:1440-1444` | claims array | 0/2000 | hold |
| 10 | general fallback | `GENERAL_KNOWLEDGE_FALLBACK_PROMPT`; optional history+question+reason, `enhanced...:2244-2308` | `{canAnswer,answer,confidence,requiresHumanReview,reasoning}` | 0/900 | guarded no-data |
| 11 | follow-up | inline prompt+conversation, `enhanced...:2489-2543` | `{isFollowUp,expandedQuestion}` | .1/500 | original question |

JSON означает `response_format=json_object` + `JSON.parse`/ручную проверку; strict provider JSON Schema/Zod нет. Таблица указывает единственные нормативные полные prompt constants и места interpolation.

### 3.3 Число вызовов

- 0: deterministic guard/tariff/clarification при regex scenario.
- 1–2: canonical hit (optional scenario LLM + polish).
- Типично 5–6: optional scenario + 3 understanding + synthesis + verifier.
- Прямой максимум 8: scenario + 3 understanding + synthesis + verifier + regeneration + re-verifier; с history wrapper — 9.
- Физический максимум provider requests: 8×5=40 или 9×5=45. Embedding calls отдельно: обычно 3–5; hard maximum отсутствует из-за невалидированного массива variants (`query-expansion.ts:53-62`; `enhanced...:966-971`).

## 4. Понимание запроса и значения wildcard

### 4.1 Структурированное понимание

| Понятие | Код и тип | Использование |
|---|---|---|
| Intent | `classifyIntent`, `enhanced-answering-engine.ts:295-326`: свободный `string`, `domains:string[]`, confidence | domains оставлены для debug, но retrieval ими не фильтруется (`1043-1052`) |
| Scenario | regex+LLM, union в `scenario-classifier.ts:25-29,74-170`; DB `String?` | единственный тематический hard filter; taxonomy только apostille |
| Service/document type | четыре свободных массива entity LLM, `query-expansion.ts:72-117` | добавляются в `relevanceText`, не являются фильтром |
| Страны/города | typed полей нет | частичные regex treaty/destination/regions (`scenario-classifier.ts:193-206,342-356`), иначе текстовый поиск |
| Language pair, original/scan, urgency | typed query-frame нет | слова/regex/Tariff lookup; Rule/Chunk не фильтруются по ним |
| Отрицание | общего parser/field нет | отдельные regex; canonical overlap игнорирует знак отрицания |
| Ambiguity | non-leaf scenario; `isAmbiguous:boolean` | scenario прерывает retrieval; expansion flag лишь metadata/clarification |
| History | `answerQuestionWithContext`, `enhanced...:2489-2508` | optional session, последние 6 сообщений; основной engine history не получает; general fallback читает её отдельно (`2276-2303`) |

Typed frame `service/documentType/issuingCountry/region/city/destinationCountry/languagePair/originality/urgency/negatedConstraints` отсутствует. Почти все условия, кроме audience и узкой apostille taxonomy, остаются текстом.

### 4.2 Null/undefined/empty как «подходит всем»

| Значение | Где | Фактический смысл |
|---|---|---|
| Rule/QA/Chunk `scenarioKey=null` при известном scenario | `scenarios.ts:231-237`; `vector-search.ts:118-139,209-216,305-320,388-397`; `enhanced...:1059-1061` | wildcard: допускается с ancestors |
| То же при open lookup | empty ancestors снимают chunk scenario filter; Rule/QA null допускаются только через term pool после точечного floor (`enhanced...:1054-1112,1156-1168`) | одновременно global и unclassified |
| classifier key null/undefined | `scenario-classifier.ts:119-124` | out-of-scope, не global |
| taxonomy `parentKey=null` | `scenarios.ts:79-181` | root, не применимость |
| voice category null | `voice-answers/route.ts:62-85` | case/category отсутствует; category может не быть taxonomy key |
| `domains=[]` | engine передаёт `[]` в hybrid (`enhanced...:979-985`) | domain filter отсутствует |
| audience | `src/lib/knowledge/audience.ts:1-45` | non-null enum; client=CLIENT_SAFE, internal=оба значения; wildcard null нет |
| Rule/QAPair status | retrieval queries | только ACTIVE; DocChunk status отсутствует |
| Document.parseStatus | vector retrieval | вообще не проверяется |
| Tariff.effectiveTo null | schema/lookup | бессрочно; корректная temporal semantics |
| empty scenario string | taxonomy запрещает (`scenarios.ts:26-29`) | production-срез: 0; DB constraint нет |

Таким образом, `scenarioKey=null` имеет минимум пять смыслов: действительно global (документация taxonomy `scenarios.ts:14-20`), unclassified ingestion, classifier out-of-scope, отсутствие voice category и query wildcard. Это корень дефекта scope.

## 5. Карта базы знаний и production-срез

### 5.1 Таблицы answer path

| Модель | Поля/индексы | Scope/version/validity | Срез 05.08.2026 |
|---|---|---|---|
| Document | title/file/content/parseStatus/error/audience/scenario; index status/scenario (`schema.prisma:31-65`) | audience enum, scenario nullable, revisions отдельно | 44, все COMPLETED; 36 internal/8 client; null 39 |
| Rule | code/title/body/confidence/sourceSpan/doc?/status/version/supersedes?/scenario?/audience; indexes (`175-212`) | status/version, effective dates нет | 1 967: ACTIVE 1 535, SUPERSEDED 238, DEPRECATED 194; null 1 546 |
| QAPair | question/answer/status/version/supersedes?/doc?/rule?/metadata?/scenario?/audience (`216-248`) | authority в JSON | до cleanup 775: 691/70/14; после 671/70/34; null 631 |
| DocChunk | doc/index/content/embedding JSON?/metadata?/scenario?/audience; unique doc+index (`261-282`) | status/version/validity нет | 228; null 204; 178 internal/50 client; 228×1536 embeddings |
| HeldAnswer | question/answer/audience/confidence/reasons/verdict/times (`1045-1074`) | human-review queue | 8 |
| HallucinationLog | session?/question/scenario?/initial/revised/unsupported (`604-617`) | telemetry | 252 |
| Tariff | typed service/language/complexity/direction/turnaround/amounts/effective dates/active/audience (`946-1031`) | полноценная validity | 1 622; все active/effective; effectiveTo null |
| LlmCallLog | callSite/provider/model/prompts/raw/error/latency/question/session | model есть в commit `c5d630d`, но не в schema текущего checkout | production table 61 |

Связанные: DocumentRevision/ProcessingAttempt, Domain+four join tables, DomainSuggestion, KnowledgeChange, AIQuestion, StagedExtraction, ChatSession/Message, AISettings, AnswerFeedback, Librarian tables, favorites/comments/notifications. Полный перечень — `prisma/schema.prisma:31-1074`; напрямую в answer path участвуют таблицы карты, ChatMessage и audience/tariff данные.

### 5.2 Обезличенные реальные примеры

| Таблица | A | B | C |
|---|---|---|---|
| Document | `<doc-edu>` образовательный апостиль, internal, scenario null | `<doc-zags>` СПб ЗАГС, scenario spb | `<doc-client>` памятка, client, null |
| Rule | `<rule-oryol>` партнёр/адрес Орёл, ACTIVE, null | `<rule-minjust>` ACTIVE/min_justice | `<rule-global>` общий порядок, ACTIVE/null |
| QAPair | `<qa-voice>` VOICE/internal/null | `<qa-doc>` linked doc+rule | `<qa-orphan>` без doc/rule/metadata |
| DocChunk | `<chunk-oryol>` null, 1536-d | `<chunk-zags>` spb/client | `<chunk-minjust>` min_justice/internal |
| HeldAnswer | `<held-1>` client/pending | `<held-2>` internal/low | `<held-3>` client/grounding hold |
| HallucinationLog | `<hall-1>` schedule/regenerated | `<hall-2>` unsupported number | `<hall-3>` verifier failure |
| LlmCallLog | `<llm-1>` scenario/openai/gpt-4o | `<llm-2>` expansion/openai/gpt-4o | `<llm-3>` synthesis/openai/gpt-4o |
| Tariff | `<tariff-1>` service/turnaround | `<tariff-2>` language/direction | `<tariff-3>` certification |

IDs/content хэшированы/обобщены; status/scope сохранены. Integrity: Rule `version>1=0`, `supersedes not null=0`; QAPair то же. QAPair: 200 без document, 170 без rule, 621 без metadata после cleanup. Rule: 119 без document, sourceSpan null=0. Version columns не образуют фактическую temporal chain.

### 5.3 SQL и ограничения снимка

```sql
SELECT status,count(*) FROM "Rule" GROUP BY status;
SELECT "scenarioKey",count(*) FROM "DocChunk" GROUP BY 1 ORDER BY 2 DESC;
SELECT count(*),min(jsonb_array_length(embedding)),max(jsonb_array_length(embedding))
FROM "DocChunk" WHERE embedding IS NOT NULL;
SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector');
SELECT column_name FROM information_schema.columns
WHERE table_name='DocChunk' AND column_name='embeddingVector';
```

Полный read-only набор — `scripts/audit-schema-state.ts`; для примеров использовался `left(md5(...),12)`. Повтор `railway run npx tsx scripts/audit-schema-state.ts` 05.08.2026 не дошёл до DB: Railway GraphQL TCP 10061 refused. Числа — ранее успешно полученный в этой audit-сессии production-срез, не результат неуспешного повтора.

Scenario distribution: Document null/minjustice/lo/spb = 39/3/1/1; Rule null/apostille/min/lo/spb = 1546/28/161/90/142; QA null/apostille/min/lo/spb/`capability` = 631/19/44/31/45/5; Chunk null/min/lo/spb = 204/10/7/7. `capability` доказывает отсутствие taxonomy constraint: voice пишет произвольную category (`voice-answers/route.ts:75`). Документ образования: 60 ACTIVE Rule и 7 Chunk с null.

## 6. Ingestion, chunking, embeddings

`commitDocumentKnowledge` записывает verified Rule/QA/Chunk (`src/lib/document-processing/commit.ts:65-364`); replace физически удаляет старые rows (`31-59`). Новые строки создаются без scenarioKey (`208-217,264-271,319-327`), в конце каскадируется только audience (`341-350`). Следовательно, ingestion null = «не присвоено», не «доказано global». `scripts/backfill-scenarios.ts` распознаёт лишь MinJustice/LO/ZAGS по имени/заголовку; unmatched остаются null. Translation root всё ещё закомментирован (`scenarios.ts:181`).

Parser: PDF=`pdf-parse` raw; DOCX/DOC=Mammoth+normalize; TXT/MD raw UTF-8; RTF — basic regex stripping (`src/lib/document-parser.ts:3-67`). Chunk target 1000 chars, overlap 200; boundary в ±100 по paragraph/sentence/newline; ≤50 chars discarded (`src/lib/ai/chunker.ts:4-95`). Это character chunking, не heading/token-aware.

Embedding input — ровно `chunk.content`; title, section, scenario, audience/applicability и соседние чанки не добавляются (`chunker.ts:120-135`; `commit.ts:306-325`). Metadata — offsets. **Contextual retrieval отсутствует.** Model — `OPENAI_EMBEDDING_MODEL` или `text-embedding-3-small` (`src/lib/openai.ts:12-33`), production dimension 1536; model/version per chunk не хранится. Batch sizes: 1 в old helper, 5 в staged commit.

## 7. Карта retrieval-путей

### 7.1 Четыре chunk search path

| Путь | SQL/код, pool, filter | Score/threshold/top-K | Fallback/проблемы |
|---|---|---|---|
| Native semantic pgvector | `1-(embeddingVector <=> query::vector)`, DocChunk; domain optional; scenario null+ancestors; audience; `vector-search.ts:105-177` | cosine `>=0.3`, ORDER distance, per hybrid call `limit*2=20` | при DB error ставит availability false и идёт in-memory |
| In-memory semantic | Prisma загружает **все** matching chunks с JSON embedding; same domain/scenario/audience; cosine loop, `201-253` | строго `>0.3`, sort desc, top20 | production фактически здесь; O(N×1536) CPU+memory per variant |
| PostgreSQL keyword FTS | `to_tsvector('russian',content) @@ plainto_tsquery('russian',$query)`, same filters, `287-365` | `ts_rank`; diagnostic score `min(rank/0.5,1)`; top20 | `normalizedQuery` строится, но SQL использует raw query; expression GIN index отсутствует |
| Keyword terms fallback | OR `contains` по tokens >2; Prisma `take=max(limit*10,50)` = 200 при answer path; `367-426` | `.15 + hits/termCount`, cap1; top20 | pool до scoring без `orderBy`, поэтому при >200 matching rows recall/tie зависит от DB order |

Для domain raw SQL строит `slugList = domainSlugs.map(s => '\''+s+'\'')` без escape (`vector-search.ts:118-126,305-313`), в отличие от scenario keys. Enhanced path всегда передаёт `[]`, поэтому exploitable main path сейчас нет, но exported API содержит dormant SQL-injection hazard.

### 7.2 RRF и multi-query

`hybridSearch` параллельно получает semantic top20 и keyword top20, затем:

```text
semanticRRF = 1/(60+semanticRank)
keywordRRF  = 1/(60+keywordRank)
combined    = 0.7*semanticRRF + 0.3*keywordRRF
```

Основание: `vector-search.ts:432-501`. RRF реализован корректно: raw cosine и normalized FTS score **не складываются**, значит несовместимые шкалы не сравниваются при fusion. Raw scores сохраняются для eligibility/debug. Tie-break после `sort(b.combined-a.combined)` не задан; стабильность наследует insertion/order источников.

`multiQuerySearch` запускает hybrid для каждой variant, дедуплицирует по chunk id и оставляет **max combinedScore из одной variant**, не агрегат поддержки нескольких variants (`enhanced...:332-359`). После top10 `selectContextChunks` требует semantic≥.4 или keyword≥.65; в open lookup для null chunk — semantic≥.62 или keyword≥.85; затем combined≥60% лучшего, max5 (`364-400`). Порог RRF относительный, абсолютная релевантность обеспечивается raw floors.

### 7.3 Rule и QAPair retrieval

Rule pool: по каждому significant term `contains` body, take25 by confidence; плюс top100 ACTIVE by confidence. В open lookup null исключён из бесплатного confidence pool, но доступен через term match. Candidate ranking: `scoreText(full)+scoreText(title)`; term длиной≥6 даёт 3, короткий 1, domain-critical token ещё +2; voice/confidence boosts применяются только при lexical relevance; top10 (`enhanced...:403-460,1078-1125`).

QA pool аналогичен: per-term question/answer take25 + recent100; open lookup исключает null из free recent pool; title boost фактически означает повторный score question; top5 (`1139-1181`). Это не vector retrieval Rule/QA и не BM25: substring heuristic.

**Reranker отсутствует.** Вызов cross-encoder/LLM, оценивающий top-N пар query-document, в answer path отсутствует; после RRF идёт только deterministic floor. `rule-conflict-detector.ts` — не reranker и не вызывается.

## 8. Применимость и конфликты бизнес-правил

До ranking проверяются только ACTIVE status, audience и scenario chain/lexical root. City, issuing/destination country, partner, service, document type, original/scan, language, urgency и validity Rule не представлены typed constraints и не проверяются. Поэтому правило для Орла/партнёра/документа может уйти в вопрос о Москве/Минске: живое подтверждение — Oryol audit; механизм — term/vector relevance плюс null wildcard.

`Rule.version`, `supersedesRuleId` и `QAPair.version/supersedesQaId` не участвуют в retrieval, кроме статуса ACTIVE. У Rule нет `validFrom/validTo`; дата документа/ревизии не сравнивается. Tariff — исключение: `isActive/effectiveFrom/effectiveTo` проверяются в специализированном path.

`src/lib/ai/rule-conflict-detector.ts` существует: для нового правила строит embedding, сравнивает со всеми правилами, затем может вызвать LLM до пяти раз (`:92-229`). По `rg` на symbol найдено только определение/exports — ingestion/commit его не вызывает. При ошибке detector возвращает no conflict (fail-open). Следовательно, противоречащие ACTIVE Rule/QA могут одновременно попасть в context; consistency gate лишь проверяет, что утверждение присутствует хотя бы в одном источнике, а не что источники согласованы.

Classification найденных дефектов здесь: неправильный scope существующей истины — **retrieval bug**; отсутствующее условие применимости в записи — **knowledge-model gap**; выбор одной стороны противоречия синтезом — вторичный **generation risk**, но не первопричина.

## 9. Механизм ручного «обучения»

### 9.1 Запись

`POST /api/admin/bot-lab/voice-answers` требует ADMIN, очищает/ограничивает question 2000 и transcript/answer 8000, при необходимости вызывает voice polisher, затем transaction (`voice-answers/route.ts:13-65`). `upsertLearnedQaPair` идентифицирует пару по `(exact question,audience,scenarioKey)`, берёт transaction advisory lock по hash, exact duplicate reuse, иначе ACTIVE predecessor → SUPERSEDED и создаёт version+1 (`qa-upsert.ts:47-129`). KnowledgeChange записывается APPROVED. Пара всегда INTERNAL_ONLY, `scenarioKey=sourceCase.category??null`, metadata содержит `origin=voice-operator` и `VOICE_ANSWER_AUTHORITY` (`voice route:65-126`).

Плюсы: auth, transaction, lock, explicit audience, version и audit trail. Риски: category не валидируется через `SCENARIOS`; null становится wildcard; конфликт с тем же question в другом scenario только выводится в console (`qa-upsert.ts:70-90`).

### 9.2 Поиск canonical override

`findCanonicalQaOverride` загружает все ACTIVE VOICE candidates допустимой audience без scenario filter, считает `questionTermOverlap`, требует `short>=.55 && long>=.5`, сортирует long, short, id (`enhanced...:683-725`). Hit минует retrieval/synthesis, но вызывает canonical polisher; отдаёт confidence=1 и no-review, если numeric/price/client-safety guards не сработали (`732-871`). Общий consistency verifier, stale/scope/conflict checks эта ветка не выполняет.

`extractSearchTerms` (`403-421`) делает: lowercase; ё→е; punctuation→space; split; отбрасывает слова <3; для длины≥6 добавляет форму без последнего символа, ≥8 — без двух; Set. Это не лемматизация: prefix не снимается, часть речи/синонимы не известны. `questionTermOverlap` сначала сравнивает наличие отрицания, затем exact set intersection и делит shared на меньший/больший размер (`502-520`). Порядок слов вообще не учитывается.

Для тестового canonical «почесать» измерено функцией `questionTermOverlapForTests`:

| Variant | short/long | Match | Причина |
|---|---:|---|---|
| exact | 1.000/1.000 | да | одинаковые sets |
| `чесать` | .714/.625 | да | обрезки и общие слова |
| `причесать` | .625/.625 | да, false positive | suffix truncation не различает приставочный смысл; редкая общая лексема повышает обе доли |
| `подчесать` | .625/.625 | да, false positive | то же |
| `чесание` | .250/.250 | нет, false negative | существительное даёт другой набор строк |
| изменённые лексемы при похожем смысле | 0 или ниже threshold | нет | нет morphology/synonyms |
| только переставить те же слова | 1.000/1.000 | да | это Set, порядок отсутствует |
| изменить полярность (`не/без`) | 0/0 | нет | текущий explicit `hasNegation` guard (`487-510`) |

Поэтому утверждение живого теста «другой порядок слов не нашёл» требует уточнения: **чистая перестановка тех же токенов обязана совпасть**; не найденная живая формулировка одновременно изменила лексемы/формы. Это подтверждается кодом и direct unit function, а не мнением.

Модель от этого не меняется: нет fine-tune job, training dataset upload или weight update. Сохраняется retrieval row; при совпадении другой LLM только стилистически переписывает answer. Это retrieval по памяти.

## 10. Логирование и наблюдаемость

Logging commit `c5d630d` добавляет Prisma `LlmCallLog` и instrumentation `createChatCompletion`; в нём найдено 27 уникальных callSite по репозиторию, а не 24. Запись fire-and-forget, payload обрезается до 20 000 символов. Production snapshot: 61 row, 8 фактически использованных callSite, all OpenAI/gpt-4o, `sessionId null=61`, `question null=18`, rawResponse non-null=61, errors=0; max system/user/raw lengths 3630/9268/1254.

Логируется итог каждой успешной/зафиксированной model call: callSite/provider/model/systemPrompt/userMessage/rawResponse/error/latency/question/session. **Не логируется**:

- request/run correlation между параллельными calls; attempt number и primary→fallback transition;
- query variants после нормализации и embedding latency;
- все candidate ids; separate semantic/keyword raw scores/ranks;
- metadata filters, candidate pool sizes и причины exclusion;
- per-variant RRF и победившая variant;
- chunks до/после `selectContextChunks` и точный final ordering;
- Rule/QA candidates до top-K и component lexical/authority scores;
- причина, почему knowledge row не найден.

`includeDebug` возвращает только уже выбранные context chunks и final Rule/QA ids (`enhanced...:1741-1761`), не trace. HallucinationLog покрывает post-generation claims, но не retrieval. Значит подтверждается исходная гипотеза: LlmCallLog объясняет ответ модели, но не путь данных до prompt.

Отдельный privacy-риск: полные user/system prompts и raw responses могут содержать документы/PII; schema/код не задают retention, redaction, encryption-at-field или access audit. `sessionId` практически не заполняется, поэтому расследование одного ответа также затруднено.

## 11. Контролируемый retrieval-бенчмарк

### 11.1 Метод и ограничения

Для production не создавалось знание, способное повлиять на ответы. 20 служебных QAPair из `scripts/insert-testbench-markers.ts` имели вопросы вида `TESTBENCH: retrieval-audit marker...`, специально не совпадали с тестовыми вопросами; в конце `scripts/deprecate-qa-pair.ts "TESTBENCH:"` перевёл все 20 в DEPRECATED, `inspect-qa-pair` подтвердил ACTIVE=0. Это единственная production mutation.

Свежий массовый rerun не состоялся из-за Railway TCP 10061. Поэтому ниже честно объединены три сохранённых **live** набора с указанным provenance, а не выданы за один новый прогон текущего HEAD: A — 15 unseen paraphrases (`docs/bot-audit/out-of-corpus-rephrased.md`, commit snapshot `ff2bdd...`); B — 3 live scope probes 05.08 (`.claude/audits/2026-08-05-moscow-oryol-bad-answer.md`); C — 12 domain rows из 30/30 live client run (`docs/bot-audit/live-30-sample-run-client.md`). Панель C содержит исходные corpus-вопросы и canonical hits, поэтому не включается в recall-rate перефразировок.

### 11.2 Результаты: 30 точных формулировок

| # | Вопрос | Ожидалось | Реально найдено | Вердикт/причина |
|---:|---|---|---|---|
| 1 | Подскажите, по какой схеме вы считаете цену за письменный перевод и что имеется в виду под условной страницей? | правило расчёта/условная страница | KB, 53% | OK |
| 2 | Требуется ли вносить деньги авансом перед тем, как вы начнёте мой заказ, или можно расплачиваться поэтапно? | QA предоплата | insufficient 0% | **known-but-not-found** |
| 3 | Куда нужно прикрепить нотариальный перевод — к самому оригиналу документа, к его копии или к нотариально заверенной копии? | нотариальный перевод/исходник | KB 69% | OK |
| 4 | Обязательно ли приносить оригинальный документ, чтобы вы его заверили и сшили с переводом? | original requirement | KB 68% | OK |
| 5 | Надо ли перед переводом договориться о том, как писать фамилию, имя и отчество, адреса и специальные слова? | QA согласования | KB 56% | OK |
| 6 | Когда у вас можно платить и с какого момента вы начинаете делать заказ? | рабочие часы/оплата | insufficient 0% | **known-but-not-found** |
| 7 | Чем вы можете заверить перевод — нотариусом, печатью вашего бюро или можно обойтись без заверения? | 3 варианта | KB 59% | WEAK: вариант без заверения не раскрыт |
| 8 | Если мне нужен перевод срочно, это повлияет на цену? И как срочность влияет на стоимость заверения документов? | tariff/urgency | KB 68% | OK |
| 9 | На какой срок вы держите у себя уже готовые переводы с печатью? И что случится, если я их не заберу вовремя? | storage rule | KB | OK |
| 10 | Где в Питере вы располагаетесь? Какие адреса ваших офисов? | office QA | insufficient 0% | **known-but-not-found** |
| 11 | Как лучше всего отправить документ — скан или фотография? И какие требования к качеству изображения, чтобы потом можно было заверить перевод? | scan-quality rule | KB 54% | OK |
| 12 | Какие правила нужно соблюдать при переводе фамилий, имён и названий? Как правильно их оформить? | names QA | KB 51% | OK |
| 13 | Подскажите, как у вас рассчитывается цена, если нужно заверить сразу несколько документов? И вообще, какие варианты заверения вы предлагаете? | certification/package pricing | KB 54% | WEAK + wrong-scope: пропуск package rule, добавлен education apostille/12 000/45 дней |
| 14 | А вы доставляете переведённые документы курьером в другие города? | delivery QA | KB 52%, storage context | WRONG: доставка есть, retrieval её не нашёл |
| 15 | Есть ли возможность заказать перевод онлайн и обсуждать всё через почту, без личного визита? | remote order QA | KB 54% | OK |
| 16 | как передать доки в москву | запрос уточнения/общая логистика, не education | R-388 Орёл/FPM, sem .572 | **wrong-scope** |
| 17 | как передать документы в москву | то же | R-388, sem .576 | **wrong-scope** |
| 18 | как отправить документы в москву | то же | R-388, sem .529 | **wrong-scope** |
| 19 | Какие услуги оказывает агентство? | capability QA | canonical/KB 100% | content OK; exact/corpus, не recall |
| 20 | Можно ли получить дубликат свидетельства / истребовать документ, если у меня нет оригинала или я за границей? | duplicate/region conditions | KB 67% | WEAK: ответ дал узкие цены/регионы при недостающих условиях; citations off-topic |
| 21 | Чем отличается присяжный перевод от нотариально заверенного и можно ли присяжный сделать удалённо? | Russia vs foreign process | KB 100% | OK; policy prompt также содержит guardrail |
| 22 | Помогаете ли вы с нострификацией (признанием) иностранного образовательного документа в РФ? | education service QA | KB 100% | OK/canonical |
| 23 | Какой стандартный срок выполнения перевода и можно ли его ускорить? | timeframe QA/tariff | KB 100% | OK/canonical |
| 24 | Как выполняется перевод между двумя иностранными языками (например, финский → английский, испанский → английский)? | language-pair procedure | KB 51% | found, medium; free-text language pair |
| 25 | Покажете ли вы перевод до заверения, чтобы я проверил (термины, серии, номера)? | review-before-certification QA | KB 100% | OK/canonical |
| 26 | Нужно перевести только нотариальные надписи и апостиль (или печать/штамп) на документе — это возможно? | partial translation/apostille text | KB 100% | OK/canonical |
| 27 | Как происходит консульская легализация документов (например, для Иордании)? | legalization procedure | KB 55% | found medium |
| 28 | Как срочность влияет на стоимость перевода и заверения? | tariff urgency | KB 65% | found; tariff-supported |
| 29 | Нужна ли предоплата для запуска заказа в работу и можно ли оплатить частями? | exact QA | insufficient 0% | **known-but-not-found даже на corpus wording** |
| 30 | Можно ли получить готовый документ доставкой/курьером в другой город? | delivery QA | KB 55% | ответ по сути correct, но cited Rules не подтверждали delivery — provenance gap |

### 11.3 Метрики и диагноз

Для строгой unseen панели A: exact correct 9/15=60%; WEAK 2/15=13.3%; WRONG 1/15=6.7%; не отвечено 3/15=20%; canonical recall 0/15. Строгий wrong-scope — 2/15=13.3% (#13,#14). Строгий **знание было в базе, но не найдено** — 4/15=26.7% (#2,#6,#10,#14); если считать частичные пропуски #7/#13, broad retrieval miss = 6/15=40%.

Панель B: wrong-scope 3/3. На A+B: 5/18=27.8% вопросов имели wrong-scope evidence/result. Это не population estimate, а targeted risk probe.

Панель C подтверждает knowledge coverage, но показывает два важных дефекта: exact предоплата всё равно lost (#29), а корректный delivery answer имеет несоответствующие citations (#30). Его нельзя смешивать с unseen accuracy, потому что многие строки нашли canonical exact QA.

Canonical morphology benchmark из раздела 9 дополняет 30 live rows: `причесать/подчесать` — hard-negative false positives; `чесание` — false negative; pure reorder — hit; inverted negation — deterministic reject. Так покрыты словоформы, порядок и отрицания без загрязнения production corpus.

## 12. Findings по критичности и классификация

| Sev | Finding | Доказательство | Класс |
|---|---|---|---|
| **P0** | Credential-like strings находятся в tracked Markdown; потенциальная компрометация действующих ключей | `SESSION_2026-01-20_streaming-processing-memory-optimization.md:24,91`; `SESSION_NOTES.md:1018,1021,1068`; значение не раскрывается | security/config exposure |
| **P1** | `scenarioKey=null` перегружен: global + unclassified; 78.6% Rule и 89.5% Chunk null | taxonomy `scenarios.ts:14-20,231-237`; commit без key `commit.ts:208-327`; production counts; live Oryol 3/3 | knowledge-model gap → retrieval bug |
| **P1** | Нет typed applicability/hard filters для города, стран, услуги, документа, формата и языка | schema Rule/QA/Chunk `175-282`; retrieval filters `vector-search.ts:105-426`; engine Rule/QA `1043-1181` | architecture/knowledge gap |
| **P1** | Canonical override игнорирует scenario и присваивает confidence 1 | `enhanced...:683-725,748-770`; voice category free string `voice route:62-85` | retrieval/scope bug |
| **P1** | Production не использует pgvector: JSON scan/cosine in Node | production SQL extension/column checks; `vector-search.ts:201-280` | availability/scalability |
| **P1** | Default Anthropic model устарел; explicit network timeout отсутствует; fallback не наблюдаем | `chat-provider.ts:18-31,221-346` | operational reliability |
| **P1** | Conflict detector не подключён; contradictions проходят как равноценные sources | `rule-conflict-detector.ts:92-229`; отсутствие caller по `rg`; consistency checks support, not conflict (`consistency-gate.ts:54-64`) | knowledge governance |
| **P1** | Retrieval telemetry отсутствует; невозможно доказать причины inclusion/exclusion | logging commit `c5d630d`; debug `enhanced...:1741-1761`; раздел 10 | observability |
| **P1** | Полные prompts/responses с PII логируются без retention/redaction и correlation | LlmCallLog fields/production stats, logging commit `c5d630d` | privacy/operations |
| **P1** | Schema drift: production LlmCallLog и logging branch не соответствуют текущему checkout | `git show c5d630d`; отсутствие model в current `schema.prisma` | deploy/reproducibility |
| **P2** | Chunk retrieval не join-ит Document и не проверяет parseStatus | `vector-search.ts:148-163,219-229,332-345` | retrieval hygiene |
| **P2** | Version/supersedes поля фактически не используются для corpus validity | schema `175-248`; production version/supersedes counts | knowledge governance |
| **P2** | FTS normalization dead code; нет GIN; term fallback pool nondeterministic | `vector-search.ts:294-302,323-365,400-425`; schema indexes `261-282` | retrieval quality/performance |
| **P2** | Domain slugs interpolируются raw SQL без escaping | `vector-search.ts:118-126,305-313`; enhanced passes [] | dormant security hazard |
| **P2** | LLM query variants не имеют array/length/count bounds | `query-expansion.ts:53-62`; `enhanced...:966-971` | cost/latency reliability |
| **P2** | Embeddings не содержат title/section/scope и не хранят model version per chunk | `chunker.ts:120-135`; `commit.ts:306-325`; schema `261-282` | retrieval recall |
| **P2** | RRF ties и Rule/QA lexical ties не имеют полного deterministic tie-break | `vector-search.ts:498-501`; `enhanced...:453-460` | reproducibility |

P0 означает немедленное действие владельца вне этого read-only задания: rotate/revoke affected credentials, затем purge Git history/notes и включить secret scanning. Не следует сначала «просто удалить строки» и считать ключи безопасными.

### 12.1 Knowledge gap vs retrieval bug vs generation bug

- **Knowledge gap:** знания нет в записи либо потеряно условие применимости: typed scope отсутствует, education taxonomy отсутствует, QAPair без metadata/document. Добавлять текст ответа без scope недостаточно.
- **Retrieval bug:** правильное знание есть, но не попало в context (#2/#6/#10/#14/#29), либо попало чужое (#13, #16–18). Это доминирующий наблюдаемый класс.
- **Generation bug:** модель искажает/добавляет факт при корректном context. В исследованных failures это не доказанная первопричина; consistency и numeric grounding специально ловят такой класс. #30 показывает provenance mismatch: ответ правильный, но citations не доказывают его; это retrieval/provenance, не обязательно hallucination.
- **Mixed:** если source сам конфликтен или scope утрачен, модель выбирает одну правдоподобную сторону. Формально текст генерирует LLM, но исправлять prompt первым — маскировать дефект данных/retrieval.

## 13. Минимальная целевая архитектура без смены стека

```text
Document -> Section -> KnowledgeUnit (Rule | QA | Chunk)
                         |
                         +-- applicability_profile:
                             classificationStatus = GLOBAL | SCOPED | UNCLASSIFIED
                             scenarioKey, serviceType, documentType
                             issuingCountry/region/city, destinationCountry
                             languageFrom/languageTo, originalRequired, scanAllowed
                             partner/office, audience, validFrom/validTo

Question -> strict QueryFrame (same facets + negation + missingFields)
         -> scenario/dialog clarification
         -> SQL hard applicability filter
         -> pgvector top-N + FTS/BM25-like top-N
         -> RRF (оставить)
         -> reranker top 30 -> top 8
         -> conflict/validity gate
         -> synthesis -> consistency/numeric guards
         -> RetrievalRun/Candidate/Selection telemetry
```

Конкретные изменения:

1. Добавить `ScopeStatus {GLOBAL,SCOPED,UNCLASSIFIED}`. Default ingestion — UNCLASSIFIED; GLOBAL разрешать только явным operator action. `scenarioKey=null` больше не кодирует оба состояния.
2. Вынести `ApplicabilityProfile` или typed nullable facets с inclusion/exclusion semantics; Rule/QA/Chunk наследуют profile секции/документа, но могут уточнить его. `UNCLASSIFIED` не выдавать клиенту автоматически.
3. Парсить один строгий QueryFrame (provider JSON schema + runtime Zod), а не три независимых свободных LLM результата. Явно хранить negation и `unknown`.
4. Добавить `DocumentSection(title,path,applicability)` и embed `document title + section path + applicability summary + chunk`. Raw content сохранять отдельно для цитаты.
5. Реально мигрировать `embeddingVector vector(1536)`, `embeddingModel`, `embeddingVersion`; HNSW cosine index. Добавить generated `tsvector('russian',content)` + GIN. JSON оставить временным rollback source.
6. Сначала SQL hard filter applicability/audience/status/document COMPLETED/validity, затем semantic+FTS candidate pools, текущий RRF, затем cross-encoder/LLM reranker с query frame. Raw scores не смешивать.
7. Canonical: exact normalized hash отдельно; fuzzy path — Russian lemma/embedding candidate search + negation + scope equivalence + margin to runner-up. Confidence 1 только у exact scoped operator-approved pair; иначе обычный synthesis/review.
8. Conflict detector запускать при commit/upsert и периодически offline; unresolved HIGH conflict исключать из auto-answer или удерживать ответ.
9. Добавить `RetrievalRun` и `RetrievalCandidate`: run/session/question hash, query variants, candidate type/id, sem/kw ranks and raw scores, RRF, filters passed/failed, exclusionReason, selectedOrder, promptIncluded. Retention/redaction policy обязательна.
10. Версионировать provider/model/prompt/embedding/retrieval config и связывать всё одним `runId`; timeout и circuit breaker задавать явно.

## 14. Порядок работ

1. **Сразу, отдельно от deploy:** ротация credential-like secrets и incident review (P0). Это единственное, что важнее retrieval correctness.
2. **Зафиксировать baseline:** retrieval telemetry/runId + 30–50 immutable regression questions. Без этого миграция scope не измерима.
3. **Развести GLOBAL/UNCLASSIFIED и добавить applicability.** Первыми разметить education apostille/Орёл, delivery, offices, original/scan, countries. Практику Орёл/FPM сохранить, но scoped/internal/conditional.
4. **Закрыть canonical bypass:** scenario/category validation, scoped match, ambiguity margin, morphology/negation tests.
5. **Мигрировать pgvector+FTS indexes** и фильтровать Document COMPLETED; сверить recall/latency до отключения JSON fallback.
6. **Подключить conflict detection/validity gate**, затем reranker. Reranker до scope migration лишь точнее ранжирует плохо размеченные данные.
7. **Укрепить provider layer:** supported model defaults, timeout, attempt/fallback telemetry, model-specific override.
8. **После каждого этапа** прогонять unseen paraphrases, hard negatives, missing-condition и client/internal leakage; release gate — wrong-scope=0 на curated critical set.

## 15. Что не трогать без доказанного регресса

- Формулу RRF `k=60`, weights .7/.3: она корректно избегает смешивания raw scales (`vector-search.ts:447-488`).
- Audience filter до retrieval и INTERNAL_ONLY default для ingestion (`audience.ts`; `commit.ts:346-350`).
- Exact synthesisSources для consistency/numeric grounding (`enhanced...:1275-1287,1394-1403`; `claim-grounding.ts:188-209`).
- Fail-closed verifier и повторную проверку regenerated answer (`consistency-gate.ts:100-153`; `enhanced...:1440-1471`).
- Typed Tariff validity/attribution/staleness guards.
- Advisory lock и versioned upsert identity `(question,audience,scenario)` (`qa-upsert.ts:47-129`).
- Deterministic territorial/price/client safety guardrails.
- Само знание про Орёл/FPM: владелец подтвердил актуальность. Нужно исправить применимость и disclosure, не удалять факт.

## 16. Точные точки следующего этапа

| Задача | Файлы/функции |
|---|---|
| Scope model/migration | `prisma/schema.prisma` Rule/QAPair/DocChunk/Document; новая migration; `src/lib/knowledge/scenarios.ts`; `scripts/backfill-scenarios.ts` |
| Query frame | `src/lib/knowledge/scenario-classifier.ts::classifyScenario`; `src/lib/ai/query-expansion.ts`; `enhanced-answering-engine.ts:938-972` |
| Hard applicability | `src/lib/ai/vector-search.ts::searchSimilarChunks*`, `searchByKeywords`, `searchByKeywordTerms`; Rule/QA queries `enhanced...:1043-1186` |
| Canonical | `extractSearchTerms`, `questionTermOverlap`, `findCanonicalQaOverride`, `buildCanonicalQaResult` at `enhanced...:403-871`; `voice-answers/route.ts`; `qa-upsert.ts` |
| Contextual chunks | `src/lib/document-parser.ts`; `src/lib/ai/chunker.ts`; `src/lib/document-processing/commit.ts` |
| pgvector/FTS | `src/lib/ai/vector-search.ts:105-280,530-589`; Prisma migration; backfill embeddings |
| Conflict/validity | `src/lib/ai/rule-conflict-detector.ts`; `commitDocumentKnowledge`; `upsertLearnedQaPair` |
| Retrieval telemetry | `chat-provider.ts` logging wrapper; `multiQuerySearch`; `selectContextChunks`; Rule/QA rankers; new RetrievalRun/Candidate models |
| Provider reliability | `src/lib/ai/chat-provider.ts:18-346`; callsite model overrides |
| Regression suite | `scripts/diagnose-answer.ts`; TESTBENCH scripts; saved 15/30 audit fixtures; canonical overlap tests |

## 17. Итоговая оценка

Бот уже имеет хорошие post-generation safeguards и рабочий hybrid retrieval, но его архитектурная граница доверия стоит слишком поздно: применимость факта определяется после candidate generation текстовой похожестью и prompt-инструкцией. Следующий этап должен начинаться не с замены модели и не с удаления узких знаний, а с явного scope каждого knowledge unit и наблюдаемого hard filtering до ranking. После этого pgvector/reranker улучшат качество; до этого они лишь быстрее и увереннее найдут иногда неприменимый факт.
