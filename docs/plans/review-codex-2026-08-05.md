1. **До 0.1 → отсутствует исполняемый тестовый контур.**  
   Что не так: план повсеместно требует `npx vitest`, но Vitest отсутствует в [package.json](</C:/dev/translation/package.json:60>), нет `test`/`typecheck`-скриптов. CI слушает `main`, тогда как рабочая ветка и история используют `master`, а `pnpm lint || echo ...` маскирует любое падение в [ci.yml](</C:/dev/translation/.github/workflows/ci.yml:5>).  
   Почему: тесты могут проходить только локально у конкретного агента; `npx` способен подтянуть непинованную версию; сломанный код будет смержен зелёным CI.  
   Как исправить: добавить задачу 0.0 — pin Vitest, конфигурация aliases/Prisma mocks, `test`, `typecheck`, `build`, `prisma validate`; исправить ветку CI и убрать `|| echo`. Все последующие задачи должны зависеть от 0.0.

2. **0.3 должна быть первой задачей, а не третьей.**  
   Что не так: миграций сейчас физически нет, но 0.2 уже требует `migrate dev` и `migrate deploy`.  
   Почему: первая инкрементальная миграция до baseline либо столкнётся с drift/reset, либо создаст некорректную историю, не описывающую существующую БД.  
   Как исправить: порядок `0.0 → 0.3 → остальные schema changes`. До завершения baseline запретить любые изменения схемы.

3. **0.3 → процедура baseline неполна и опасна.**  
   Что не так: `db pull --print` и визуальное наличие `LlmCallLog` не доказывают эквивалентность всей схемы; не указано, к какой БД применяется `migrate resolve`; нет dry-run с чистой БД, backup/restore и проверки всех существующих окружений.  
   Почему: можно пометить несовпадающую миграцию как применённую и получить ложное состояние “up to date”.  
   Как исправить: снять полный schema inventory, сгенерировать baseline через `prisma migrate diff --from-empty`, вручную проверить SQL и out-of-band objects, развернуть с нуля во временной БД, затем отдельно `resolve --applied` в каждом существующем окружении. Перед продом — проверенный backup/restore и rollback note.

4. **0.3 → нельзя слепо мержить PR #52.**  
   Что не так: PR несёт не только модель, но и логирование полных prompt/user content/raw response. Сосланный аудит уже классифицировал отсутствие retention/redaction/access policy как P1 privacy-риск.  
   Почему: исправление schema drift одновременно включает новый сбор PII и содержимого документов.  
   Как исправить: отделить schema-reconciliation от runtime-логгера. Сначала описать существующую таблицу и baseline; instrumentation мержить только после redaction, retention TTL, ограничений доступа, correlation ID и удаления либо шифрования чувствительных payloads.

5. **До 0.1 → проигнорирован P0 из одного из исходных аудитов.**  
   Что не так: аудит сообщает о credential-like строках в tracked Markdown, но Этап 0 этого вообще не содержит.  
   Почему: строить v2 поверх потенциально скомпрометированных production credentials нельзя считать production-safe планом.  
   Как исправить: отдельная P0-задача владельцу — revoke/rotate, проверить историю, выполнить secret scan, после чего включить secret scanning в CI. Не раскрывать найденные значения в задачах или логах.

6. **0.2 → временная защита повторяет исходный дефект.**  
   Что не так: неразмеченный узел всё ещё допускается в keyword topN и prompt, а защита включается после ranking через `requiresHumanReview`.  
   Почему: это снова post-filter вместо hard-filter. Неверный факт уже влияет на synthesis, внутренний ответ и отладочные данные; delivery лишь удерживает результат клиента.  
   Как исправить: `null + !isExplicitlyGlobal` должен быть исключён до semantic search, keyword search, RRF и формирования prompt. Для оператора нужен отдельный quarantine/debug retrieval, который физически не смешивается с answer candidates.

7. **0.2 → backfill `false` для всех null сломает v1 recall.**  
   Что не так: по аудиту null имеют около 79% Rule и 90% DocChunk; ручная разметка global объявлена неблокирующей.  
   Почему: немедленное enforcement либо выкинет большую часть реальных знаний, либо резко увеличит удержание ответов и нагрузку на сотрудников — нарушение инварианта непрерывной работы v1.  
   Как исправить: сначала inventory и явный allowlist критичных global/client-safe знаний, затем shadow-замер recall/hold rate на реальном корпусе, затем поэтапное enforcement по аудитории/каналу. Обязательны kill switch и rollback migration/application flag.

8. **0.2 → булево поле размножает источник истины.**  
   Что не так: флаг добавляется независимо в Rule/QAPair/DocChunk, хотя они происходят из Document и уже расходятся по `scenarioKey`. Не описано каскадирование и запрет несовместимых комбинаций.  
   Почему: правило может быть global, а его chunk — unclassified или наоборот.  
   Как исправить: в legacy-мосте использовать явный `ScopeStatus`, назначаемый на source/document revision, а дочерние значения получать транзакционно. Добавить consistency audit и запрет активации рассогласованного набора.

9. **0.1 → exact match не исправляет scope canonical override.**  
   Что не так: точный текст вопроса не доказывает применимость ответа. Каноническая пара могла быть записана из разговора с потерянным городом, услугой или типом документа. Она по-прежнему получает confidence 1.0 и bypass сценария в [enhanced-answering-engine.ts](</C:/dev/translation/src/lib/ai/enhanced-answering-engine.ts:683>).  
   Почему: устраняется false positive «причесать/почесать», но сохраняется главный класс wrong-scope ошибок.  
   Как исправить: до классификации canonical corpus безопаснее полностью отключить client override. Альтернатива — exact match плюс explicit global либо подтверждённое совпадение scope, validity, отсутствие конфликтующих дублей и прохождение всех обычных gates. Confidence 1.0 без доказанной применимости запретить.

10. **0.1 → предложенная production-проверка фактически не проверяет задачу.**  
    Что не так: `diagnose-answer.ts` жёстко использует `audience: 'internal'` в [строке 69](</C:/dev/translation/scripts/diagnose-answer.ts:69>), а задача меняет client-поведение. Кроме того, вызов не вполне read-only: движок может создать HallucinationLog, а после PR #52 — LlmCallLog.  
    Почему: Expected result может быть зелёным при неработающем client fix и одновременно мутировать prod.  
    Как исправить: добавить явный `--audience client --sandbox`, отключающий все writes/side effects; отдельно выполнить API-level delivery test.

## Ошибки модели v2

11. **2.1 → главный инвариант оставлен только в application code.**  
    Что не так: любой script, Prisma client или будущий агент может создать/активировать `SCOPED` без профиля либо `GLOBAL` с `authorityLevel=1`. Число `>0` не доказывает human review.  
    Почему: именно так архитектура снова потеряет условия применимости.  
    Как исправить: создавать units только DRAFT; отдельный транзакционный publish transition должен проверять профиль, reviewer identity, timestamps, evidence и конфликты. Для критических условий — DB trigger/constraint procedure и ограничение прямых write paths, а не один helper `create-unit.ts`.

12. **2.1 → семантика ApplicabilityProfile не определена.**  
    Что не так: не сказано, являются ли профили OR, поля внутри профиля AND, значения массива OR; что значит пустой массив; что происходит при неизвестном поле запроса.  
    Почему: разные реализаторы напишут разные hard filters, а `unknown` легко превратится в wildcard.  
    Как исправить: до схемы зафиксировать truth table с результатами `MATCH | CONFLICT | UNKNOWN`. Для каждого unit определить обязательные query dimensions; `UNKNOWN` по обязательному полю должен вести к clarification/abstain, не к допуску кандидата.

13. **2.1/3.2 → QueryFrame не способен проверить ApplicabilityProfile.**  
    Что не так: профиль содержит issuingRegion/city, deliveryCity, languages и partnerIds, но QueryFrame этих полей не имеет.  
    Почему: заявленный hard-filter технически невозможно выполнить.  
    Как исправить: спроектировать единую типизированную dimension schema, из которой генерируются и QueryFrame, и applicability predicates. Добавить city/region/language/partner/channel/document form и версии справочников.

14. **3.2 → `missingRequiredFields` вычисляет не тот субъект.**  
    Что не так: модель должна назвать недостающие поля, не видя требований конкретных кандидатов.  
    Почему: обязательность поля зависит от knowledge unit: для одного правила нужен destination country, для другого issuing city.  
    Как исправить: LLM извлекает только значения и неопределённости. `missingRequiredFields` вычисляет детерминированный applicability evaluator после загрузки профилей кандидатов.

15. **2.3/3.2 → Concept/справочники ошибочно объявлены неблокирующими.**  
    Что не так: QueryFrame и профиль используют произвольные `String[]`; LLM может вернуть разные коды или обычные слова.  
    Почему: hard filter получит систематические false negatives либо потребует permissive fallback.  
    Как исправить: `Concept`, service/document/country/language registries и alias resolution должны предшествовать QueryFrame и извлечению знаний. Коды валидируются по справочнику; неизвестный код не проходит молча.

16. **2.1 → `additionalConstraints Json` является новым контейнером потерянных условий.**  
    Что не так: нет схемы, версии, evaluator и правила fail-closed.  
    Почему: сложное условие снова будет «где-то в JSON», но retrieval его не проверит — точное повторение болезни v1.  
    Как исправить: типизированные predicates/DSL с ограниченным набором операторов, Zod/JSON Schema version и единым evaluator. Неизвестный predicate делает unit неавтоматизируемым.

17. **2.1 → предложенная Prisma-модель не обеспечивает заявленные связи.**  
    Что не так: `sourceRevisionId`, `sourceSectionId`, `supersedesId`, `DocumentSectionV2.documentId` и `parentSectionId` — простые строки без FK/relations. `contentHash` назван дедупом, но не имеет `@unique`.  
    Почему: появятся orphan records, циклы supersede и ссылки на несуществующие источники.  
    Как исправить: добавить реальные relations, indexes, delete policies и проверяемую temporal chain. Дедуп определять не только по тексту, а по content + applicability + audience + source revision.

18. **2.2 → показанная схема не пройдёт `prisma validate`.**  
    Что не так: у relation `EvidenceChunk.section` отсутствует обратное поле `DocumentSectionV2.chunks`.  
    Почему: миграцию нельзя даже сгенерировать.  
    Как исправить: добавить обе стороны relations и включить `prisma validate`/generate в acceptance criteria каждой schema-задачи.

19. **2.1/2.2 → нет связи между knowledge claims и evidence.**  
    Что не так: `KnowledgeUnitKind` содержит `EVIDENCE_CHUNK`, одновременно существует отдельный `EvidenceChunk`, но между ними нет relation.  
    Почему: нельзя доказать, какой фрагмент поддерживает или опровергает конкретное правило, и невозможно построить надёжные citations/conflict governance.  
    Как исправить: удалить дублирующий kind либо ввести `KnowledgeEvidence(unitId, chunkId, relation=SUPPORTS|CONTRADICTS, sourceSpan)`.

20. **2.2 → sections/chunks привязаны к изменяемому Document, а не к immutable revision.**  
    Что не так: при повторной загрузке документа старые chunks и ACTIVE units могут пережить изменение источника.  
    Почему: retrieval будет цитировать устаревшую редакцию.  
    Как исправить: сначала ввести immutable `SourceRevision/ExtractionRun`; sections, chunks и units должны ссылаться на конкретную revision. Новая revision активируется только после extraction, reconciliation и approval.

21. **2.2 → доказательство недостаточно для проверяемой цитаты.**  
    Что не так: есть только `rawContent`, но нет page/table/cell/offset/source hash.  
    Почему: «дословный текст» нельзя однозначно найти в исходном DOCX/PDF, особенно при повторениях и таблицах.  
    Как исправить: сохранять locator и revision hash: page, paragraph/table/cell, char offsets и extraction method.

22. **2.1 → `audience` конфликтует с `answerClient/answerInternal`.**  
    Что не так: один unit одновременно имеет единичную аудиторию и две версии ответа, все поля optional без kind-specific checks.  
    Почему: непонятно, какая комбинация допустима; ошибочный selector может выдать internal-текст клиенту.  
    Как исправить: отделить факт от presentation: `KnowledgeUnit` плюс `AnswerVariant(audience, text, status, reviewed...)`, с unique `(unitId,audience)` и отдельным approval.

## Ошибки порядка Этапов 2–3

23. **2.2/3.1 → циклическая зависимость.**  
    Что не так: 2.2 требует миграцию с `Unsupported("vector(1536)")`, но расширение создаётся лишь в 3.1.  
    Почему: PostgreSQL не создаст колонку типа `vector` до установки extension.  
    Как исправить: либо `3.1 extension-only → 2.2 schema`, либо сначала создать EvidenceChunk без vector, а затем отдельной expand-миграцией добавить колонку и индекс.

24. **3.1 → удаление fallback нарушает инвариант работы v1.**  
    Что не так: `vector-search.ts` используется v1 и сейчас намеренно падает обратно на in-memory в [строках 268–279](</C:/dev/translation/src/lib/ai/vector-search.ts:268>).  
    Почему: transient pgvector failure после изменения остановит ответы живого v1.  
    Как исправить: strict pgvector сделать только для v2. V1 fallback сохранять до cutover; v2 failure в shadow не должен влиять на v1. Общий health должен различать `service ready` и `v2 degraded`.

25. **3.1 → “включить extension” недостаточно.**  
    Что не так: отсутствуют миграция индекса HNSW/IVFFlat, backfill, dimension/model validation, `ANALYZE`, query-plan и latency checks.  
    Почему: pgvector может формально работать, но делать scan, содержать частично пустые vectors или смешанные embedding versions.  
    Как исправить: отдельные задачи: extension/column, идемпотентный resumable backfill, index creation, completeness audit, EXPLAIN/latency gate и rollback.

26. **3.2 → список изменяемых файлов нереалистичен.**  
    Что не так: текущий `chat-provider.ts` поддерживает только `text|json_object`, Anthropic parser выбрасывает tool-use blocks, OpenAI structured schema требует новый request type.  
    Почему: это не «новый query-frame.ts», а переработка provider contract, parsers, fallback и logging.  
    Как исправить: сначала provider-capability adapter с типизированным `structured<T>()`, отдельными OpenAI/Anthropic реализациями и contract tests; затем QueryFrame.

27. **3.2 → strict schema гарантирует форму, но не смысл.**  
    Что не так: валидный enum не означает правильный город, услугу, отрицание или отсутствие ambiguity. `documentFormAvailable` ещё и имеет два unknown-состояния: `null` и `UNKNOWN`.  
    Почему: syntactically valid QueryFrame может пропустить wrong-scope knowledge.  
    Как исправить: нормализация по справочникам, confidence/provenance на каждое поле, deterministic regex signals, contradiction checks и fail-closed clarification. Оставить одно представление unknown.

## Надёжность v1 и эксплуатация

28. **0.4 → timeout budget может достигать нескольких минут.**  
    Что не так: `MAX_RETRIES=3` означает четыре primary attempts; при 45 секундах это около 180 секунд до fallback плюс delays и fallback. `ETIMEDOUT` уже есть в retryable list, поэтому часть шага просто дублирует код.  
    Почему: HTTP request/Railway proxy завершится раньше, а зависшие вызовы продолжат потреблять соединения и деньги.  
    Как исправить: единый end-to-end deadline, например 25–40 секунд; per-attempt budget из остатка, максимум один retry/fallback. Для stream — отдельные TTFB, idle и total timeouts.

29. **0.4 → предложенный тест с “fetch, который никогда не резолвится” некорректен.**  
    Что не так: такой mock не реагирует на AbortSignal, поэтому abort сам по себе promise не отклонит. Также в плане нет test-only timeout option, хотя тест на него полагается.  
    Почему: тест будет висеть даже при правильном коде.  
    Как исправить: mock должен подписаться на `signal.abort`; добавить injectable timeout/clock; проверить primary timeout, retry budget, fallback и stream idle abort.

30. **0.5 → это не fail-fast при старте.**  
    Что не так: проверка в `callAnthropic()` происходит только при первом вызове. Общий `options.model` также может передать Anthropic model в OpenAI fallback.  
    Почему: ошибка проявится на клиентском запросе, а fallback может получить несовместимое имя модели.  
    Как исправить: валидировать provider-specific runtime config при инициализации сервиса/readiness; разделить `openaiModel` и `anthropicModel`; покрыть матрицу primary/fallback тестами.

31. **1.1 → диагностика mojibake строится на недоказанной гипотезе.**  
    Что не так: чистый `draftAnswer` не доказывает порчу именно при Prisma write. Она могла возникнуть раньше только в `question`, либо при чтении audit-клиентом.  
    Почему: можно “починить” невиновный код и оставить реальную причину.  
    Как исправить: для тех же session/timestamp сравнить UTF-8 bytes `HeldAnswer.question`, соответствующий USER `ChatMessage.content`, request/log boundary и `client_encoding`. После исправления нужен план восстановления старых строк или явная маркировка irrecoverable. Живую проверку проводить только sandbox-идентификатором.

32. **1.2 → критерии удаления не соответствуют данным.**  
    Что не так: QAPair имеет metadata, но показанная `LlmCallLog` — нет; поиск `metadata.origin/evalCaseId` для неё невозможен. Не задан точный manifest IDs и транзакция.  
    Почему: prefix-delete способен удалить реальные eval-наблюдения или не удалить ничего.  
    Как исправить: dry-run отчёт по каждой таблице, immutable список IDs, export в Ops Vault с redaction, транзакционное удаление с exact ID/count assertions и повторяемый post-check.

## Пропущенные зависимости и нереалистичная трудоёмкость

33. **Этапы 2–3 → отсутствует само повторное извлечение 44 документов.**  
    Что не так: ни одна задача не создаёт extraction pipeline, applicability extraction, human review UI или reconciliation с 1967 Rule/775 QAPair. При этом план утверждает, что Этапы 2–3 покажут скорость разметки.  
    Почему: они не разметят ни одного документа, поэтому заявленная развилка Этапа 4 никогда не получит данные.  
    Как исправить: после schema draft провести pilot на 3–5 разных документах, измерить units/page, долю UNCLASSIFIED, reviewer minutes/unit, disagreement rate и coverage legacy checklist. Только после pilot фиксировать схему и оценку 44 документов.

34. **2.3 → EvalCase нельзя откладывать.**  
    Что не так: regression corpus появляется после первых изменений.  
    Почему: не будет baseline, и нельзя доказать, что 0.1/0.2 не ухудшили v1.  
    Как исправить: EvalCase/golden fixtures — Этап 0. Включить реальные wrong-scope случаи, hard negatives, negation, missing-condition, client/internal leakage и известные корректные v1 ответы.

35. **Architecture/Этап 7 → feature flag пока фиктивен.**  
    Что не так: `ANSWER_ENGINE_VERSION` и `answerQuestionV2` существуют только в документе. В коде API, Telegram, mini-app, callbacks и conversation flow напрямую вызывают `answerQuestionEnhanced`.  
    Почему: переключение одного route оставит остальные каналы на v1; shadow/canary будут несопоставимыми.  
    Как исправить: заранее ввести общий side-effect-free `answerQuestion` facade и единый result contract. Все call sites переводятся на него при режиме `v1`; только после parity добавляются `shadow` и `v2`.

36. **Этап 7 → shadow может повредить v1 ресурсами.**  
    Что не так: нет sampling, concurrency/cost limits, очереди, DB pool budget и изоляции ошибок.  
    Почему: удвоенные embeddings/LLM/DB queries повысят latency и connection pressure живого продукта.  
    Как исправить: asynchronous sampled shadow после отдачи v1, отдельный concurrency limiter, жёсткий timeout, cost ceiling, no side effects, correlation ID и автоматическое отключение при ухудшении v1 p95/error rate.

37. **Этапы 4–8 → нет release gates.**  
    Что не так: отсутствуют численные критерии shadow/canary, rollback и длительность наблюдения.  
    Почему: “полный отказ от v1” невозможно объективно разрешить или запретить.  
    Как исправить: заранее определить как минимум: zero wrong-scope на critical set, client leakage=0, максимальный abstention delta, recall/precision, p95 latency, cost/question, error rate, минимальный объём размеченного shadow traffic, stable bucketing и автоматический rollback.

38. **Весь план → оценки трудоёмкости отсутствуют, а “недели” ничем не подтверждены.**  
    Что не так: нет page/section counts, сложности таблиц, reviewer capacity, скорости taxonomy design и provider work. Крупные задачи названы bite-sized, хотя 0.3, 1.1, 3.2 и re-extraction являются отдельными проектами.  
    Почему: невозможно проверить сроки и critical path; человеческая разметка почти наверняка станет bottleneck.  
    Как исправить: после pilot оценивать диапазонами и throughput, отдельно engineering и human review. До pilot допустима только оценка discovery, не всего v2.

39. **“Одна Beads-задача — отдельный подагент” → неверная модель исполнения.**  
    Что не так: задачи массово изменяют одни и те же файлы: Prisma schema/migrations, `enhanced-answering-engine.ts`, `chat-provider.ts`.  
    Почему: параллельные сессии создадут конфликтующие migrations, разный provider contract и потерю контекста production-инвариантов.  
    Как исправить: один владелец на migration chain и один на provider boundary; параллелить только независимые read-only исследования, fixtures и pilot annotation. Зависимые изменения выполнять последовательно.

Минимальный исправленный critical path:

`security incident → test/CI foundation → schema inventory+baseline → immutable source revision model → controlled vocab + applicability truth table → 3–5 document pilot → schema correction → EvalCase baseline → безопасные v1 mitigations под flag → pgvector expand/backfill/index → provider structured contract → QueryFrame → hard-filter retrieval → shadow isolation → measured canary`.

До исправления пунктов 1–16 заводить весь набор Beads преждевременно: агенты начнут реализовывать схему, которая технически не валидируется и семантически всё ещё допускает потерю условий применимости.
tokens used
153,601
Вердикт: план в текущем виде не готов к заведению Beads и реализации. Главная идея верна, но инвариант «UNCLASSIFIED не участвует в ответе» фактически не обеспечен, порядок миграций сломан, а безопасное сосуществование v1/v2 пока существует только в декларации.

## Блокирующие ошибки

1. **До 0.1 → отсутствует исполняемый тестовый контур.**  
   Что не так: план повсеместно требует `npx vitest`, но Vitest отсутствует в [package.json](</C:/dev/translation/package.json:60>), нет `test`/`typecheck`-скриптов. CI слушает `main`, тогда как рабочая ветка и история используют `master`, а `pnpm lint || echo ...` маскирует любое падение в [ci.yml](</C:/dev/translation/.github/workflows/ci.yml:5>).  
   Почему: тесты могут проходить только локально у конкретного агента; `npx` способен подтянуть непинованную версию; сломанный код будет смержен зелёным CI.  
   Как исправить: добавить задачу 0.0 — pin Vitest, конфигурация aliases/Prisma mocks, `test`, `typecheck`, `build`, `prisma validate`; исправить ветку CI и убрать `|| echo`. Все последующие задачи должны зависеть от 0.0.

2. **0.3 должна быть первой задачей, а не третьей.**  
   Что не так: миграций сейчас физически нет, но 0.2 уже требует `migrate dev` и `migrate deploy`.  
   Почему: первая инкрементальная миграция до baseline либо столкнётся с drift/reset, либо создаст некорректную историю, не описывающую существующую БД.  
   Как исправить: порядок `0.0 → 0.3 → остальные schema changes`. До завершения baseline запретить любые изменения схемы.

3. **0.3 → процедура baseline неполна и опасна.**  
   Что не так: `db pull --print` и визуальное наличие `LlmCallLog` не доказывают эквивалентность всей схемы; не указано, к какой БД применяется `migrate resolve`; нет dry-run с чистой БД, backup/restore и проверки всех существующих окружений.  
   Почему: можно пометить несовпадающую миграцию как применённую и получить ложное состояние “up to date”.  
   Как исправить: снять полный schema inventory, сгенерировать baseline через `prisma migrate diff --from-empty`, вручную проверить SQL и out-of-band objects, развернуть с нуля во временной БД, затем отдельно `resolve --applied` в каждом существующем окружении. Перед продом — проверенный backup/restore и rollback note.

4. **0.3 → нельзя слепо мержить PR #52.**  
   Что не так: PR несёт не только модель, но и логирование полных prompt/user content/raw response. Сосланный аудит уже классифицировал отсутствие retention/redaction/access policy как P1 privacy-риск.  
   Почему: исправление schema drift одновременно включает новый сбор PII и содержимого документов.  
   Как исправить: отделить schema-reconciliation от runtime-логгера. Сначала описать существующую таблицу и baseline; instrumentation мержить только после redaction, retention TTL, ограничений доступа, correlation ID и удаления либо шифрования чувствительных payloads.

5. **До 0.1 → проигнорирован P0 из одного из исходных аудитов.**  
   Что не так: аудит сообщает о credential-like строках в tracked Markdown, но Этап 0 этого вообще не содержит.  
   Почему: строить v2 поверх потенциально скомпрометированных production credentials нельзя считать production-safe планом.  
   Как исправить: отдельная P0-задача владельцу — revoke/rotate, проверить историю, выполнить secret scan, после чего включить secret scanning в CI. Не раскрывать найденные значения в задачах или логах.

6. **0.2 → временная защита повторяет исходный дефект.**  
   Что не так: неразмеченный узел всё ещё допускается в keyword topN и prompt, а защита включается после ranking через `requiresHumanReview`.  
   Почему: это снова post-filter вместо hard-filter. Неверный факт уже влияет на synthesis, внутренний ответ и отладочные данные; delivery лишь удерживает результат клиента.  
   Как исправить: `null + !isExplicitlyGlobal` должен быть исключён до semantic search, keyword search, RRF и формирования prompt. Для оператора нужен отдельный quarantine/debug retrieval, который физически не смешивается с answer candidates.

7. **0.2 → backfill `false` для всех null сломает v1 recall.**  
   Что не так: по аудиту null имеют около 79% Rule и 90% DocChunk; ручная разметка global объявлена неблокирующей.  
   Почему: немедленное enforcement либо выкинет большую часть реальных знаний, либо резко увеличит удержание ответов и нагрузку на сотрудников — нарушение инварианта непрерывной работы v1.  
   Как исправить: сначала inventory и явный allowlist критичных global/client-safe знаний, затем shadow-замер recall/hold rate на реальном корпусе, затем поэтапное enforcement по аудитории/каналу. Обязательны kill switch и rollback migration/application flag.

8. **0.2 → булево поле размножает источник истины.**  
   Что не так: флаг добавляется независимо в Rule/QAPair/DocChunk, хотя они происходят из Document и уже расходятся по `scenarioKey`. Не описано каскадирование и запрет несовместимых комбинаций.  
   Почему: правило может быть global, а его chunk — unclassified или наоборот.  
   Как исправить: в legacy-мосте использовать явный `ScopeStatus`, назначаемый на source/document revision, а дочерние значения получать транзакционно. Добавить consistency audit и запрет активации рассогласованного набора.

9. **0.1 → exact match не исправляет scope canonical override.**  
   Что не так: точный текст вопроса не доказывает применимость ответа. Каноническая пара могла быть записана из разговора с потерянным городом, услугой или типом документа. Она по-прежнему получает confidence 1.0 и bypass сценария в [enhanced-answering-engine.ts](</C:/dev/translation/src/lib/ai/enhanced-answering-engine.ts:683>).  
   Почему: устраняется false positive «причесать/почесать», но сохраняется главный класс wrong-scope ошибок.  
   Как исправить: до классификации canonical corpus безопаснее полностью отключить client override. Альтернатива — exact match плюс explicit global либо подтверждённое совпадение scope, validity, отсутствие конфликтующих дублей и прохождение всех обычных gates. Confidence 1.0 без доказанной применимости запретить.

10. **0.1 → предложенная production-проверка фактически не проверяет задачу.**  
    Что не так: `diagnose-answer.ts` жёстко использует `audience: 'internal'` в [строке 69](</C:/dev/translation/scripts/diagnose-answer.ts:69>), а задача меняет client-поведение. Кроме того, вызов не вполне read-only: движок может создать HallucinationLog, а после PR #52 — LlmCallLog.  
    Почему: Expected result может быть зелёным при неработающем client fix и одновременно мутировать prod.  
    Как исправить: добавить явный `--audience client --sandbox`, отключающий все writes/side effects; отдельно выполнить API-level delivery test.

## Ошибки модели v2

11. **2.1 → главный инвариант оставлен только в application code.**  
    Что не так: любой script, Prisma client или будущий агент может создать/активировать `SCOPED` без профиля либо `GLOBAL` с `authorityLevel=1`. Число `>0` не доказывает human review.  
    Почему: именно так архитектура снова потеряет условия применимости.  
    Как исправить: создавать units только DRAFT; отдельный транзакционный publish transition должен проверять профиль, reviewer identity, timestamps, evidence и конфликты. Для критических условий — DB trigger/constraint procedure и ограничение прямых write paths, а не один helper `create-unit.ts`.

12. **2.1 → семантика ApplicabilityProfile не определена.**  
    Что не так: не сказано, являются ли профили OR, поля внутри профиля AND, значения массива OR; что значит пустой массив; что происходит при неизвестном поле запроса.  
    Почему: разные реализаторы напишут разные hard filters, а `unknown` легко превратится в wildcard.  
    Как исправить: до схемы зафиксировать truth table с результатами `MATCH | CONFLICT | UNKNOWN`. Для каждого unit определить обязательные query dimensions; `UNKNOWN` по обязательному полю должен вести к clarification/abstain, не к допуску кандидата.

13. **2.1/3.2 → QueryFrame не способен проверить ApplicabilityProfile.**  
    Что не так: профиль содержит issuingRegion/city, deliveryCity, languages и partnerIds, но QueryFrame этих полей не имеет.  
    Почему: заявленный hard-filter технически невозможно выполнить.  
    Как исправить: спроектировать единую типизированную dimension schema, из которой генерируются и QueryFrame, и applicability predicates. Добавить city/region/language/partner/channel/document form и версии справочников.

14. **3.2 → `missingRequiredFields` вычисляет не тот субъект.**  
    Что не так: модель должна назвать недостающие поля, не видя требований конкретных кандидатов.  
    Почему: обязательность поля зависит от knowledge unit: для одного правила нужен destination country, для другого issuing city.  
    Как исправить: LLM извлекает только значения и неопределённости. `missingRequiredFields` вычисляет детерминированный applicability evaluator после загрузки профилей кандидатов.

15. **2.3/3.2 → Concept/справочники ошибочно объявлены неблокирующими.**  
    Что не так: QueryFrame и профиль используют произвольные `String[]`; LLM может вернуть разные коды или обычные слова.  
    Почему: hard filter получит систематические false negatives либо потребует permissive fallback.  
    Как исправить: `Concept`, service/document/country/language registries и alias resolution должны предшествовать QueryFrame и извлечению знаний. Коды валидируются по справочнику; неизвестный код не проходит молча.

16. **2.1 → `additionalConstraints Json` является новым контейнером потерянных условий.**  
    Что не так: нет схемы, версии, evaluator и правила fail-closed.  
    Почему: сложное условие снова будет «где-то в JSON», но retrieval его не проверит — точное повторение болезни v1.  
    Как исправить: типизированные predicates/DSL с ограниченным набором операторов, Zod/JSON Schema version и единым evaluator. Неизвестный predicate делает unit неавтоматизируемым.

17. **2.1 → предложенная Prisma-модель не обеспечивает заявленные связи.**  
    Что не так: `sourceRevisionId`, `sourceSectionId`, `supersedesId`, `DocumentSectionV2.documentId` и `parentSectionId` — простые строки без FK/relations. `contentHash` назван дедупом, но не имеет `@unique`.  
    Почему: появятся orphan records, циклы supersede и ссылки на несуществующие источники.  
    Как исправить: добавить реальные relations, indexes, delete policies и проверяемую temporal chain. Дедуп определять не только по тексту, а по content + applicability + audience + source revision.

18. **2.2 → показанная схема не пройдёт `prisma validate`.**  
    Что не так: у relation `EvidenceChunk.section` отсутствует обратное поле `DocumentSectionV2.chunks`.  
    Почему: миграцию нельзя даже сгенерировать.  
    Как исправить: добавить обе стороны relations и включить `prisma validate`/generate в acceptance criteria каждой schema-задачи.

19. **2.1/2.2 → нет связи между knowledge claims и evidence.**  
    Что не так: `KnowledgeUnitKind` содержит `EVIDENCE_CHUNK`, одновременно существует отдельный `EvidenceChunk`, но между ними нет relation.  
    Почему: нельзя доказать, какой фрагмент поддерживает или опровергает конкретное правило, и невозможно построить надёжные citations/conflict governance.  
    Как исправить: удалить дублирующий kind либо ввести `KnowledgeEvidence(unitId, chunkId, relation=SUPPORTS|CONTRADICTS, sourceSpan)`.

20. **2.2 → sections/chunks привязаны к изменяемому Document, а не к immutable revision.**  
    Что не так: при повторной загрузке документа старые chunks и ACTIVE units могут пережить изменение источника.  
    Почему: retrieval будет цитировать устаревшую редакцию.  
    Как исправить: сначала ввести immutable `SourceRevision/ExtractionRun`; sections, chunks и units должны ссылаться на конкретную revision. Новая revision активируется только после extraction, reconciliation и approval.

21. **2.2 → доказательство недостаточно для проверяемой цитаты.**  
    Что не так: есть только `rawContent`, но нет page/table/cell/offset/source hash.  
    Почему: «дословный текст» нельзя однозначно найти в исходном DOCX/PDF, особенно при повторениях и таблицах.  
    Как исправить: сохранять locator и revision hash: page, paragraph/table/cell, char offsets и extraction method.

22. **2.1 → `audience` конфликтует с `answerClient/answerInternal`.**  
    Что не так: один unit одновременно имеет единичную аудиторию и две версии ответа, все поля optional без kind-specific checks.  
    Почему: непонятно, какая комбинация допустима; ошибочный selector может выдать internal-текст клиенту.  
    Как исправить: отделить факт от presentation: `KnowledgeUnit` плюс `AnswerVariant(audience, text, status, reviewed...)`, с unique `(unitId,audience)` и отдельным approval.

## Ошибки порядка Этапов 2–3

23. **2.2/3.1 → циклическая зависимость.**  
    Что не так: 2.2 требует миграцию с `Unsupported("vector(1536)")`, но расширение создаётся лишь в 3.1.  
    Почему: PostgreSQL не создаст колонку типа `vector` до установки extension.  
    Как исправить: либо `3.1 extension-only → 2.2 schema`, либо сначала создать EvidenceChunk без vector, а затем отдельной expand-миграцией добавить колонку и индекс.

24. **3.1 → удаление fallback нарушает инвариант работы v1.**  
    Что не так: `vector-search.ts` используется v1 и сейчас намеренно падает обратно на in-memory в [строках 268–279](</C:/dev/translation/src/lib/ai/vector-search.ts:268>).  
    Почему: transient pgvector failure после изменения остановит ответы живого v1.  
    Как исправить: strict pgvector сделать только для v2. V1 fallback сохранять до cutover; v2 failure в shadow не должен влиять на v1. Общий health должен различать `service ready` и `v2 degraded`.

25. **3.1 → “включить extension” недостаточно.**  
    Что не так: отсутствуют миграция индекса HNSW/IVFFlat, backfill, dimension/model validation, `ANALYZE`, query-plan и latency checks.  
    Почему: pgvector может формально работать, но делать scan, содержать частично пустые vectors или смешанные embedding versions.  
    Как исправить: отдельные задачи: extension/column, идемпотентный resumable backfill, index creation, completeness audit, EXPLAIN/latency gate и rollback.

26. **3.2 → список изменяемых файлов нереалистичен.**  
    Что не так: текущий `chat-provider.ts` поддерживает только `text|json_object`, Anthropic parser выбрасывает tool-use blocks, OpenAI structured schema требует новый request type.  
    Почему: это не «новый query-frame.ts», а переработка provider contract, parsers, fallback и logging.  
    Как исправить: сначала provider-capability adapter с типизированным `structured<T>()`, отдельными OpenAI/Anthropic реализациями и contract tests; затем QueryFrame.

27. **3.2 → strict schema гарантирует форму, но не смысл.**  
    Что не так: валидный enum не означает правильный город, услугу, отрицание или отсутствие ambiguity. `documentFormAvailable` ещё и имеет два unknown-состояния: `null` и `UNKNOWN`.  
    Почему: syntactically valid QueryFrame может пропустить wrong-scope knowledge.  
    Как исправить: нормализация по справочникам, confidence/provenance на каждое поле, deterministic regex signals, contradiction checks и fail-closed clarification. Оставить одно представление unknown.

## Надёжность v1 и эксплуатация

28. **0.4 → timeout budget может достигать нескольких минут.**  
    Что не так: `MAX_RETRIES=3` означает четыре primary attempts; при 45 секундах это около 180 секунд до fallback плюс delays и fallback. `ETIMEDOUT` уже есть в retryable list, поэтому часть шага просто дублирует код.  
    Почему: HTTP request/Railway proxy завершится раньше, а зависшие вызовы продолжат потреблять соединения и деньги.  
    Как исправить: единый end-to-end deadline, например 25–40 секунд; per-attempt budget из остатка, максимум один retry/fallback. Для stream — отдельные TTFB, idle и total timeouts.

29. **0.4 → предложенный тест с “fetch, который никогда не резолвится” некорректен.**  
    Что не так: такой mock не реагирует на AbortSignal, поэтому abort сам по себе promise не отклонит. Также в плане нет test-only timeout option, хотя тест на него полагается.  
    Почему: тест будет висеть даже при правильном коде.  
    Как исправить: mock должен подписаться на `signal.abort`; добавить injectable timeout/clock; проверить primary timeout, retry budget, fallback и stream idle abort.

30. **0.5 → это не fail-fast при старте.**  
    Что не так: проверка в `callAnthropic()` происходит только при первом вызове. Общий `options.model` также может передать Anthropic model в OpenAI fallback.  
    Почему: ошибка проявится на клиентском запросе, а fallback может получить несовместимое имя модели.  
    Как исправить: валидировать provider-specific runtime config при инициализации сервиса/readiness; разделить `openaiModel` и `anthropicModel`; покрыть матрицу primary/fallback тестами.

31. **1.1 → диагностика mojibake строится на недоказанной гипотезе.**  
    Что не так: чистый `draftAnswer` не доказывает порчу именно при Prisma write. Она могла возникнуть раньше только в `question`, либо при чтении audit-клиентом.  
    Почему: можно “починить” невиновный код и оставить реальную причину.  
    Как исправить: для тех же session/timestamp сравнить UTF-8 bytes `HeldAnswer.question`, соответствующий USER `ChatMessage.content`, request/log boundary и `client_encoding`. После исправления нужен план восстановления старых строк или явная маркировка irrecoverable. Живую проверку проводить только sandbox-идентификатором.

32. **1.2 → критерии удаления не соответствуют данным.**  
    Что не так: QAPair имеет metadata, но показанная `LlmCallLog` — нет; поиск `metadata.origin/evalCaseId` для неё невозможен. Не задан точный manifest IDs и транзакция.  
    Почему: prefix-delete способен удалить реальные eval-наблюдения или не удалить ничего.  
    Как исправить: dry-run отчёт по каждой таблице, immutable список IDs, export в Ops Vault с redaction, транзакционное удаление с exact ID/count assertions и повторяемый post-check.

## Пропущенные зависимости и нереалистичная трудоёмкость

33. **Этапы 2–3 → отсутствует само повторное извлечение 44 документов.**  
    Что не так: ни одна задача не создаёт extraction pipeline, applicability extraction, human review UI или reconciliation с 1967 Rule/775 QAPair. При этом план утверждает, что Этапы 2–3 покажут скорость разметки.  
    Почему: они не разметят ни одного документа, поэтому заявленная развилка Этапа 4 никогда не получит данные.  
    Как исправить: после schema draft провести pilot на 3–5 разных документах, измерить units/page, долю UNCLASSIFIED, reviewer minutes/unit, disagreement rate и coverage legacy checklist. Только после pilot фиксировать схему и оценку 44 документов.

34. **2.3 → EvalCase нельзя откладывать.**  
    Что не так: regression corpus появляется после первых изменений.  
    Почему: не будет baseline, и нельзя доказать, что 0.1/0.2 не ухудшили v1.  
    Как исправить: EvalCase/golden fixtures — Этап 0. Включить реальные wrong-scope случаи, hard negatives, negation, missing-condition, client/internal leakage и известные корректные v1 ответы.

35. **Architecture/Этап 7 → feature flag пока фиктивен.**  
    Что не так: `ANSWER_ENGINE_VERSION` и `answerQuestionV2` существуют только в документе. В коде API, Telegram, mini-app, callbacks и conversation flow напрямую вызывают `answerQuestionEnhanced`.  
    Почему: переключение одного route оставит остальные каналы на v1; shadow/canary будут несопоставимыми.  
    Как исправить: заранее ввести общий side-effect-free `answerQuestion` facade и единый result contract. Все call sites переводятся на него при режиме `v1`; только после parity добавляются `shadow` и `v2`.

36. **Этап 7 → shadow может повредить v1 ресурсами.**  
    Что не так: нет sampling, concurrency/cost limits, очереди, DB pool budget и изоляции ошибок.  
    Почему: удвоенные embeddings/LLM/DB queries повысят latency и connection pressure живого продукта.  
    Как исправить: asynchronous sampled shadow после отдачи v1, отдельный concurrency limiter, жёсткий timeout, cost ceiling, no side effects, correlation ID и автоматическое отключение при ухудшении v1 p95/error rate.

37. **Этапы 4–8 → нет release gates.**  
    Что не так: отсутствуют численные критерии shadow/canary, rollback и длительность наблюдения.  
    Почему: “полный отказ от v1” невозможно объективно разрешить или запретить.  
    Как исправить: заранее определить как минимум: zero wrong-scope на critical set, client leakage=0, максимальный abstention delta, recall/precision, p95 latency, cost/question, error rate, минимальный объём размеченного shadow traffic, stable bucketing и автоматический rollback.

38. **Весь план → оценки трудоёмкости отсутствуют, а “недели” ничем не подтверждены.**  
    Что не так: нет page/section counts, сложности таблиц, reviewer capacity, скорости taxonomy design и provider work. Крупные задачи названы bite-sized, хотя 0.3, 1.1, 3.2 и re-extraction являются отдельными проектами.  
    Почему: невозможно проверить сроки и critical path; человеческая разметка почти наверняка станет bottleneck.  
    Как исправить: после pilot оценивать диапазонами и throughput, отдельно engineering и human review. До pilot допустима только оценка discovery, не всего v2.

39. **“Одна Beads-задача — отдельный подагент” → неверная модель исполнения.**  
    Что не так: задачи массово изменяют одни и те же файлы: Prisma schema/migrations, `enhanced-answering-engine.ts`, `chat-provider.ts`.  
    Почему: параллельные сессии создадут конфликтующие migrations, разный provider contract и потерю контекста production-инвариантов.  
    Как исправить: один владелец на migration chain и один на provider boundary; параллелить только независимые read-only исследования, fixtures и pilot annotation. Зависимые изменения выполнять последовательно.

Минимальный исправленный critical path:

`security incident → test/CI foundation → schema inventory+baseline → immutable source revision model → controlled vocab + applicability truth table → 3–5 document pilot → schema correction → EvalCase baseline → безопасные v1 mitigations под flag → pgvector expand/backfill/index → provider structured contract → QueryFrame → hard-filter retrieval → shadow isolation → measured canary`.

До исправления пунктов 1–16 заводить весь набор Beads преждевременно: агенты начнут реализовывать схему, которая технически не валидируется и семантически всё ещё допускает потерю условий применимости.
