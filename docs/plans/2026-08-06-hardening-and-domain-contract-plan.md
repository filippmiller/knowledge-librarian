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
> Codex на самом PR. Ревью согласилось с направлением (порядок hardening →
> доменный контракт → пилот → схема правильный, provider-баги подтверждены,
> порядок pgvector/Prisma логичен), но указало, что план физически невыполним
> между PR B и пилотом, что PR A слишком большой одним куском, что
> `facets: Record<string, FacetValue>` — будущий EAV, что `evaluateApplicability()`
> требует разбиения на 4 функции, что `grader.independent` — недостаточно одного
> boolean, что gate golden corpus не совпадает с реальным shape `run-eval-corpus.ts`,
> и что эту ветку нужно сначала обновить от текущего `master`. Все эти пункты были
> учтены (изменения отмечены `[R2]`).
>
> **Revision 3 (2026-08-06):** Revision 2 получила от того же ревью одобрение
> макро-архитектуры («backbone правильный»), но снова `REQUEST CHANGES` — на этот
> раз по контрактам, не по направлению. CodeRabbit независимо оставил 9 actionable
> comments на диффе Revision 2, все признаны валидными без исключений; ревью
> добавило ещё 8 существенных пунктов сверху. Изменения отмечены `[R3]`:
> исправлены все 9 comments CodeRabbit (типы `reviewedAt`, Zod-инвариант
> review-статуса, разделение table-driven тестов по владельцу, контракт
> `structured()`, вход QueryFrame builder, типизация `ExtractedKnowledgeUnit.facets`,
> единый формат persistence в PR F, MD040); плюс: fallback-политика заменена с
> boolean на трёхзначный `FallbackPolicy` с явным legacy-совместимым дефолтом,
> добавлены typed failure (`ChatCompletionError` с `attempts[]`) и
> timeout/`AbortSignal` в A1; `GraderIndependence` переименован в реальную
> provider/model-матрицу вместо переобещающего `FULL`; B1 различает
> `NOT_APPLICABLE` и `UNKNOWN` через `KNOWLEDGE_KIND_REGISTRY`, `audience`
> возвращён к текущей `CLIENT_SAFE | INTERNAL_ONLY` семантике; `negation: boolean`
> в QueryFrame заменён на per-facet `QueryFacetState` с evidence и `questionAspects`,
> `missingRequiredFacets` убран из LLM-выхода в пользу детерминированного
> вычисления в B2; `ExtractedKnowledgeUnit` получил обратно само утверждение
> (`statement`/`title`) и provenance по полям; PR F требует JSONL безусловно и
> детерминированные ID из pre-LLM source anchor, не из хэша LLM-контента; §6
> DAG перестроен по реальным техническим зависимостям вместо декоративной
> последовательности; §4.1 явно фиксирует инвариант «scenario не единственная
> ось» как принятое решение, а не открытый вопрос.
>
> **Revision 4 (2026-08-06) — возврат к продуктовой цели, ПОСЛЕДНЯЯ плановая
> ревизия.** Ревью Revision 3 признало собственные предыдущие раунды
> перекошенными: три ревизии подряд уходили всё глубже в контракты (fallback,
> streaming, `contentHash`, стабильные ID, тонкости Zod), и ни одна не
> потребовала измерить главное — попадает ли нужное правило в candidate pool
> ДО генерации ответа. Можно месяцами полировать типы и всё ещё не уметь
> сопоставить «как долго можно водить пальцами» с «продолжительность
> почёсывания — не более 15 секунд». Revision 4 не переписывает план: она
> добавляет §0 (North Star и Definition of Done), разделяет semantic recall и
> applicability precision как две независимые способности (§0.2), вводит
> PR G (evaluation-only semantic retrieval поверх reviewed JSONL) и PR H
> (end-to-end DOCX→answer runner) ДО финальной Prisma-схемы, и переставляет
> DAG так, чтобы массовое переизвлечение корпуса блокировалось доказательством
> продуктовой способности, а не наоборот. Контрактные замечания предыдущих
> ревизий сохранены как acceptance criteria своих PR и больше не расширяются —
> они разбираются в implementation-PR, а не в очередной ревизии плана.
> Изменения отмечены `[R4]`.

## Как это читать

- **§0** — **[R4]** North Star: что вообще считается решением задачи. Читать
  первым; всё остальное подчинено этому разделу.
- **§1** — что из разбора подтвердилось при чтении кода (буквально, не на слово).
- **§2** — что я оспариваю или уточняю, с обоснованием.
- **§3** — предлагаемая последовательность работ и её зависимости (`[R3]`:
  граф зависимостей исправлен на технический, не декоративный).
- **§4** — архитектурные вопросы; часть из них Revision 3 переводит из «открыто»
  в «инвариант принят, детали решает пилот» (см. 4.1).
- **§5** — что явно не делать в следующей сессии.
- **§6** — Beads-изменения (готовятся к выполнению ПОСЛЕ утверждения этого плана,
  не раньше — и не раньше содержательного ревью самой Revision 4).

---

## §0. North Star и Definition of Done **[R4]**

### 0.1 Что является целью

Целью НЕ является: `pgvector`, `QueryFrame`, `FACET_REGISTRY`, красивая
Prisma-схема, типизированный fallback или стабильные ID. Всё это — средства.

Целью является работающая цепочка:

```text
документ
→ смысловое извлечение правил
→ сохранение условий, исключений и чисел
→ понимание вопроса, заданного ДРУГИМИ словами
→ нахождение правильного знания
→ исключение похожих, но неприменимых правил
→ доказательный ответ только из найденного знания
```

Ни один отдельный этап (Prisma, pgvector, FacetRegistry, QueryFrame,
extraction, reranker) сам по себе не является завершением задачи. Задача
считается решённой только при полном прогоне `DOCX → structured extraction →
reviewed JSONL → semantic/hybrid retrieval → applicability/trigger/conflict →
evidence-backed answer` с прохождением всех ворот §0.3.

### 0.2 Три независимые способности — не путать между собой

Главная ошибка ревизий 1–3: контракты применимости (B1/B2) проектировались как
если бы они были главной способностью системы. Они — вторая из трёх, и она
бесполезна без первой.

**A. Semantic recall — найти нужное.** Здесь решается:

```text
«водить пальцами»            ↔ «почёсывание»
«ладони на вид не грязные»   ↔ «визуально чистые руки»
«близкий человек поможет»    ↔ «участие помощника»
«прихватило в автобусе»      ↔ «общественное место»
```

Средства: embeddings, contextual retrieval representation, lexical retrieval,
существующий RRF (`hybridSearch`, `src/lib/ai/vector-search.ts:432`, k=60),
semantic reranker, нормализованное представление запроса рядом с исходным
вопросом.

`Concept`/`ConceptAlias` (2.2) — **вспомогательная нормализация, а не замена
semantic retrieval**. Если успех зависит от того, внесён ли каждый синоним
заранее в alias registry, мы построили новый словарь ключевых слов, а не
понимание смысла. Неизвестная заранее перефразировка обязана находиться
семантической моделью, которой этой перефразировки никто не показывал.

**B. Applicability precision — не применить похожее, но неправильное.**
Semantic retrieval легко найдёт несколько похожих правил сразу (общее правило
доступа к коже; исключение для общественного места; исключение для
ограниченной подвижности; правило участия помощника). Здесь работают
`ApplicabilityProfile`, facets, `triggerCondition`, `parentRuleRef`,
разрешение конфликтов (B1/B2).

**Hard filtering не должен убивать recall** — критический инвариант:

```text
явный CONFLICT по фасете          → можно исключить кандидата ДО retrieval
UNKNOWN                            → НЕ равен GLOBAL (уже принято, см. §4.1)
UNKNOWN                            → и НЕ основание молча выбросить кандидата
неизвестное условие необходимо для выбора между правилами
                                   → clarification/hold, не угадывание и не
                                     пустой candidate pool
```

**C. Extraction fidelity — не потерять смысл при извлечении.** Найденный
фрагмент бесполезен, если экстрактор потерял число, разорвал ограничение на
несвязанные куски, забыл предусловие, превратил пример в правило или потерял
связь исключения с общим правилом. Покрывается PR E/F (structured extraction,
provenance, numeric constraints, human review).

### 0.3 Acceptance pack — уже в репозитории

```text
scripts/fixtures/semantic-rule-extraction-test-pack/
  uchebnaya_instrukciya_semanticheskoe_izvlechenie_pravil.docx   ← источник знания
  test_cases_semantic_rules.jsonl                                 ← test oracle
  kontrolnye_voprosy_i_klyuch.md                                  ← test oracle
```

Все три файла подтверждены в git (`git ls-files`), не локальные артефакты.
Пакет содержит 10 основных кейсов (`Q01`–`Q10`) и 6 negative-кейсов с полем
`expected_behavior`:

```text
Q01-M1  must_clarify    место не указано, ответ противоположен в уединении и на людях
Q04-N1  must_not_apply  пауза 30 сек не отменяет лимит в 3 цикла
Q05-N1  must_not_apply  исключение для автобуса не действует дома
Q05-M1  must_clarify    «что делать, если чешется» — нет ни места, ни симптомов
Q09-N1  must_not_apply  ранее данное согласие не бессрочно
Q10-N1  must_not_apply  послабление для не дотягивающихся не расширяется на обычный случай
```

**Правила изоляции oracle (нарушение = недействительный прогон):**

1. `DOCX` — единственный источник знания, загружается в систему.
2. `test_cases_semantic_rules.jsonl` и `kontrolnye_voprosy_i_klyuch.md` —
   **test oracle**: не загружать в базу знаний, не добавлять в extraction
   prompt, не передавать answering engine.
3. Grader/раннер может читать oracle. Сам движок — нет.
4. Правильный ответ, полученный general-AI fallback'ом без найденного
   knowledge unit, засчитывается как **FAIL**, не как успех. Поле
   `answerSource` уже существует
   (`src/lib/ai/enhanced-answering-engine.ts:134`:
   `'knowledge_base' | 'general_ai' | 'deterministic_guardrail'`), поэтому
   ворота измеримы напрямую, без новой телеметрии.

### 0.4 Ворота (gates)

**Extraction gate** — после загрузки ТОЛЬКО исходного DOCX:

- каждое из 10 смысловых правил покрыто извлечённым unit'ом или связанной
  группой units (точное число units не обязано равняться десяти, но покрытие
  каждого источника обязательно, а раздробленные части обязаны оставаться
  связанными через `parentRuleRef`);
- условия, запреты, исключения и числа сохранены;
- правило 5 связано с контекстом общественного места;
- правило 9 сохраняет согласие, перчатки и немедленную остановку;
- правило 10 сохраняет ограниченную подвижность и запрет твёрдых предметов;
- не добавлено ни одного требования, которого нет в документе.

**Retrieval gate** — ДО синтеза ответа (главная недостающая метрика ревизий 1–3):

- для каждого `Q01`–`Q10` ожидаемая группа правил присутствует в reranked
  top-5;
- поиск работает не только через буквальные слова и alias-таблицу;
- сохраняется полный trace: какие units были кандидатами, какие отфильтрованы
  и почему;
- **успех не может быть засчитан по красивому финальному ответу** — если
  ожидаемый unit не попал в pool, кейс FAIL независимо от текста ответа.

**Applicability gate** — все 6 negative-кейсов:

- `must_not_apply` действительно не применяет узкое исключение;
- `must_clarify` запрашивает недостающее условие, а не выбирает наугад;
- `UNKNOWN` не превращается молча в `GLOBAL`;
- неизвестная facet не уничтожает recall (сначала кандидаты, затем уточнение);
- явный конфликт исключает unit до синтеза.

**Answer gate:**

- `Q01`–`Q10` = 10/10;
- все 6 negative-кейсов = PASS;
- числовые ограничения совпадают точно (Q04: 15 сек / 30 сек / 3 цикла);
- ответ содержит обязательные условия;
- нет выдуманных требований;
- `answerSource === 'knowledge_base'`, не `'general_ai'`;
- citations/source anchors ведут к тем units, на которых построен ответ.

**Generalization gate** — только после полного прохождения учебного документа:

- 3–5 реальных документов бюро (это и есть пилот 2.3);
- вопросы формулируются отдельно от extraction prompt, другим человеком/
  сессией;
- часть вопросов использует заранее неизвестные перефразы;
- и только затем — финальная схема (2.4), pgvector (3.1/3.2), shadow/canary и
  массовое переизвлечение корпоративных документов.

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
  вместо простого переименования. **[R3]** Инвариант теперь также закреплён
  Zod-refinement в B1, не только текстом (см. PR B1, PR A4).
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
golden corpus их нет, там только `PASS/FAIL` на кейс. См. §3, PR A3.
**[R3]** CodeRabbit на диффе Revision 2 пошёл на шаг дальше: даже нового
`ExpectedDisposition`/`CaseResult` недостаточно без явного `ActualDisposition` —
без него `MUST_HOLD → direct-answer` и поведение `MAY_HOLD` невозможно вычислить
из голого `PASS/FAIL`. Полная матрица — в PR A3 ниже.

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
для production regression runner'а. Принято без возражений — `telemetryMode:
'disabled'` остаётся в PR A3, явно как обязательный пункт.

### 2.2 «Legacy numeric evidence должен быть hold, а не участвовать в синтезе как раньше» — реальный компромисс, не очевидный факт

Разбор прав, что §4.2 truth table оставляет числа-в-прозе без governance-проверки
до backfill. Но предложенное решение («UNVERIFIED → hold, пока не пройдёт
backfill») имеет цену: `SCOPE_NULL_STRICT` dry-run в этой же сессии уже показал,
что похожая по духу строгая политика подняла hold-rate с ~27% до 86.7% на золотом
корпусе — то есть аналогичное ужесточение здесь тоже кандидат на резкий рост
удержаний, не бесплатное улучшение. Не отвергаю предложение — фиксирую как
РЕШЕНИЕ, которое нужно принять осознанно с числом в руках (dry-run на золотом
корпусе ДО включения), а не тихо принять как самоочевидно верное.

**[R2] Конкретный эксперимент:**

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
неподтверждённому утверждению, а не ко всему документу, где встретилась цифра.

### 2.3 Оценка «Реальная готовность нового v2-движка: 2/10»

Согласен по существу (в runtime нет `ApplicabilityProfile`/`QueryFrame`/
`evaluateApplicability` — и не должно быть, эта работа целенаправленно не
начиналась). Числовая оценка не то, с чем можно спорить предметно — фиксирую
согласие, не разбираю дальше.

### 2.4 Dependabot (81 alerts) — не блокер этого PR **[R3]**

Ревью раунда 3 подтвердило верность решения не смешивать это с PR №61: 81 alert
нельзя чинить одним массовым апдейтом — нужно разделить runtime vs dev-only,
direct vs transitive, severity, reachability, patch/minor vs major. Заведено
отдельной задачей вне Beads-графа этого плана (не блокирует PR A1–F), если среди
алертов не найдётся подтверждённая critical reachable runtime-уязвимость —
severity и reachability пока не проверены, поэтому не игнорируется и не паникуется.

---

## §3. Предлагаемая последовательность и граф зависимостей **[R3 — граф исправлен на технический; R4 — добавлены PR G/H перед 2.3/2.4]**

Revision 2 предложила полностью линейную цепочку (A1→A2→A3→A4→B1→B2→...). Ревью
раунда 3 верно указало: это декоративный порядок ревью, а не реальные технические
зависимости — A3 и A4 физически не зависят от A1/A2, а пилот 2.3 зависит не
только от F, но и от B2 и D параллельно (F зависит от E, но D — отдельная ветка,
не сворачивающаяся в E/F). Ниже — реальный DAG; порядок ИСПОЛНЕНИЯ (какой PR
писать первым) может по-прежнему быть линейным по соображениям пропускной
способности одной сессии, но БЛОКИРОВКА в Beads должна отражать только то, что
технически необходимо.

```text
Обновить эту ветку от текущего master (сделано в Revision 2)

Без зависимостей, могут идти параллельно:
  A1 — Provider routing & fallback contract
  A3 — Eval harness gate semantics
  A4 — Документация (truth-table consistency, review-status invariant)

A1 → A2 — Extraction run consistency

A4 → B1 — Типизированный доменный контракт (FacetRegistry, KnowledgeKindRegistry,
           ApplicabilityProfile, QueryFrame)

B1 → B2 — Evaluator'ы (eligibility / scope / trigger / resolution)

B2 → 2.2 — Concept/ConceptAlias (translation-5ii)

A1 + B1 → C — Provider structured-output adapter

B1 + C + 2.2 → D — QueryFrame builder

A2 + B1 + C + 2.2 → E — Структурная экстракция + provenance

E → F — Human-review артефакт + JSONL persistence

F → G — [R4] Evaluation-only semantic retrieval поверх reviewed JSONL
         (embeddings + lexical + RRF + reranker, in-memory, БЕЗ pgvector)

B2 + D + G → H — [R4] End-to-end fixture runner (DOCX → answer, Q01–Q10 +
                  6 negative cases, полный retrieval trace)

H PASS → 2.3 — Пилот на 3–5 РЕАЛЬНЫХ документах бюро

2.3 PASS → 2.4 — Финальная Prisma-схема v2

2.4 → pgvector (3.1/3.2) / shadow / canary → массовое переизвлечение корпуса
```

**[R4] Ключевая перестановка.** До Revision 4 план вёл от пилота сразу к Prisma
v2, а semantic retrieval и pgvector стояли ПОСЛЕ схемы — то есть пилот
физически не мог доказать исходную продуктовую задачу (найти правило по
смыслу), потому что механизма семантического поиска поверх извлечённых units
на тот момент ещё не существовало. G и H встают ДО 2.3/2.4 и делают
доказательство возможным на десяти правилах, без production-хранилища.

Практическое следствие для исполнения (не для Beads-блокировки): A1/A3/A4 можно
писать в любом порядке или параллельно разными сессиями — они не мешают друг
другу файлово. B1 технически ждёт только A4 (нужен зафиксированный
review-инвариант и truth-table consistency перед тем, как типизировать контракт
на их основе) — по факту разумно также подождать A1–A3, чтобы не переписывать
signatures дважды, но это решение по эргономике, не зависимость.

### PR A1 — Provider routing & fallback contract [P0]

Только provider-механика, никакой правки extraction/grader/eval-корпуса в этом PR.

**[R3] Fallback-политика — трёхзначная, не boolean, с явным legacy-совместимым
дефолтом.** Revision 2 сделала `allowCrossProviderFallback` default `false` —
ревью верно указало, что это молча отключило бы фоллбэк у ВСЕХ существующих
call sites (classifier, synthesis, verifier), которые сегодня на него
рассчитывают, при заявлении «existing call sites не трогаются» — внутреннее
противоречие. Вместо boolean:

```ts
type FallbackPolicy =
  | 'NONE'               // фоллбэк запрещён — явно закреплённая модель важнее
                          // отказоустойчивости
  | 'SAME_PROVIDER_ONLY'  // фоллбэк допустим только на другую модель ТОГО ЖЕ
                          // провайдера (зарезервировано, не требуется в A1)
  | 'CROSS_PROVIDER';     // фоллбэк на другого провайдера разрешён —
                          // ТРЕБУЕТ providerModels[fallbackProvider]

interface ChatCompletionOptions {
  // ...существующие поля
  providerModels?: { anthropic?: string; openai?: string };
  fallbackPolicy?: FallbackPolicy;
}
```

Правило дефолта (без него это снова тихая регрессия):

```text
options.model задан явно (пиннинг)
  + providerModels[fallbackProvider] НЕ задан  → fallbackPolicy по умолчанию NONE
    (fail-closed: явное закрепление важнее отказоустойчивости)
  + providerModels[fallbackProvider] задан      → CROSS_PROVIDER разрешён с этой
    моделью

options.model НЕ задан явно (сегодняшний типичный call site)
  → fallbackPolicy по умолчанию временно остаётся CROSS_PROVIDER (без смены
    модели — берётся дефолт целевого провайдера), сохраняя ТЕКУЩЕЕ поведение
    бесшовно. Это временное состояние до отдельной последовательной миграции
    call sites на явный `fallbackPolicy` — не постоянное решение, отслеживается
    как follow-up задача (см. §6), не блокирует A1.
```

**Typed failure — ошибка тоже несёт телеметрию.** `ChatCompletionResult`
Revision 2 существовал только для успеха; при полном отказе (primary И fallback
оба упали) диагностика снова терялась бы. Решение — не новый discriminated-union
return type (это изменило бы `await`-эргономику каждого места вызова), а typed
error, сохраняющий сегодняшнее поведение «бросает исключение при полном отказе»:

```ts
interface CompletionAttempt {
  provider: Provider;
  model: string;
  startedAt: string;
  latencyMs: number;
  outcome: 'SUCCESS' | 'ERROR' | 'ABORTED';
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

class ChatCompletionError extends Error {
  attempts: CompletionAttempt[];
  constructor(message: string, attempts: CompletionAttempt[]) { ... }
}

async function createChatCompletionDetailed(
  options: ChatCompletionOptions
): Promise<ChatCompletionResult>;
// бросает ChatCompletionError (с полным attempts[]) при полном отказе —
// не молча возвращает пустой text

async function createChatCompletion(
  options: ChatCompletionOptions
): Promise<string> {
  return (await createChatCompletionDetailed(options)).text;
}
```

Существующие call sites не трогаются в этом PR — они уже сегодня получают
исключение при полном отказе, просто без `attempts[]` внутри. Новый код (A2
extraction, grader, будущий C) переходит на `createChatCompletionDetailed` и
может читать `error.attempts` в catch-блоке.

**Timeout и cancellation — подтверждено обоими сегодняшними аудитами как
отсутствующее, не включено в Revision 2, добавляется здесь:**

```ts
interface ChatCompletionOptions {
  // ...
  requestTimeoutMs?: number;   // таймаут одной попытки (primary ИЛИ fallback)
  totalDeadlineMs?: number;    // суммарный дедлайн на весь вызов, включая retry
  signal?: AbortSignal;
}
```

Правила:
- retry/backoff обязаны укладываться в `totalDeadlineMs` — превышение
  дедлайна прерывает попытку фоллбэка, не начинает её;
- прерванный стрим (потребитель прекратил итерацию раньше конца, или сработал
  `AbortSignal`) — `outcome: 'ABORTED'` в соответствующем `CompletionAttempt`,
  не `'ERROR'`;
- ранний выход потребителя из `for await` не должен блокировать финализацию
  completion-метаданных (`operation.completion` в стриминговом варианте ниже
  обязана разрешиться/отклониться, а не зависнуть).

**Streaming, аналогично:**

```ts
export async function* streamChatCompletionTokens(options, chunkSize) {
  const provider = options.provider ?? getProvider(); // было: только getProvider()
  // ...
}

const operation = createChatCompletionStreamDetailed(options);
for await (const token of operation.tokens) { /* ... */ }
const metadata = await operation.completion; // ChatCompletionResult без text
```

**Acceptance criteria:**
- закреплённая (`options.model` задан) модель никогда не отправляется другому
  провайдеру без `providerModels[fallbackProvider]` — в этом случае вызов
  завершается `ChatCompletionError`, не молчаливой подменой модели;
- вызовы без явно закреплённой модели сохраняют сегодняшнее поведение
  (кросс-провайдерный фоллбэк работает как раньше) — ни один существующий
  тест/сценарий не должен сломаться из-за этого PR;
- при заданном `providerModels` фоллбэк использует правильный, валидный для
  целевого провайдера model ID;
- `streamChatCompletionTokens` уважает `options.provider`;
- `attempts[]` содержит каждую попытку (primary + fallback, если был), включая
  `ABORTED` для прерванных попыток;
- `totalDeadlineMs` соблюдается — retry не начинается, если превысит дедлайн;
- ранний разрыв потребления стрима не подвешивает `operation.completion`;
- тесты: primary success; primary fail → fallback success (с `providerModels`);
  primary fail → fallback `NONE` (пиннинг без provider map, ожидаем
  `ChatCompletionError`); primary fail → legacy fallback (без пиннинга,
  сохранённое поведение); dual failure (оба провайдера упали, `attempts.length
  === 2`); timeout укладывающийся и превышающий `totalDeadlineMs`; ранняя
  отмена стрима.

### PR A2 — Extraction run consistency [P0, depends-on A1]

- **[P0]** `retryBatchExtraction()` должен получать ту же модель, что и
  первичный вызов — единый `ExtractionRunConfig` (provider, model, prompt
  version, `fallbackPolicy`), не два независимых места выбора модели.
- **[P0]** Пересчитать независимость grader'а по РЕЗОЛВЛЕННЫМ
  `servedByProvider`/`servedByModel` (из `ChatCompletionResult`, PR A1), не по
  сырым env-переменным.

  **[R3] `GraderIndependence` переименован — старая шкала переобещала.**
  Revision 2 ввела `FULL | PARTIAL | NONE | UNKNOWN`, но ревью верно указало:
  если extraction шёл на Claude Haiku, а grader — на Claude Sonnet,
  `provider+model` формально различаются и шкала назвала бы это `FULL`
  независимостью — при том, что это одно семейство моделей одного вендора с
  потенциально коррелированными ошибками. `FULL` — слово, которое здесь нельзя
  использовать честно. Вместо оценки независимости — фактическая матрица
  отношений:

  ```ts
  type ModelRelationship =
    | 'SAME_MODEL'                    // тот же provider И та же model строка
    | 'SAME_PROVIDER_DIFFERENT_MODEL' // тот же provider, другая model
    | 'DIFFERENT_PROVIDER'            // разные provider (Anthropic vs OpenAI)
    | 'MIXED'                         // batch/retry дали разные результаты
                                       // внутри одного прогона
    | 'UNKNOWN';                      // не хватает attempt-метаданных (прогоны
                                       // до PR A1)
  ```

  Понятие «независимый grader» как policy-вывод (например, «считать надёжным
  для авто-принятия») строится ПОВЕРХ этой матрицы отдельной функцией
  (`DIFFERENT_PROVIDER` → надёжно независим; `SAME_PROVIDER_DIFFERENT_MODEL` →
  частично; `SAME_MODEL`/`MIXED` → не независим) — но сырое поле артефакта
  хранит факт (`ModelRelationship`), не готовую интерпретацию.

  Артефакт прогона хранит каждый extraction batch, каждый retry, каждый grader
  call с их фактическим `servedByProvider`/`servedByModel`/prompt version/
  source hash — `ModelRelationship` вычисляется по этому списку, не по двум
  env-строкам.

**Acceptance criteria:**
- primary и JSON-retry в рамках одного документа используют один
  `ExtractionRunConfig`;
- артефакт прогона хранит фактически использованную модель для каждого batch
  (включая retry);
- mixed-model run (из-за разрешённого фоллбэка) явно помечается `MIXED` в
  артефакте;
- `ModelRelationship` вычисляется как SAME_MODEL/SAME_PROVIDER_DIFFERENT_MODEL/
  DIFFERENT_PROVIDER/MIXED/UNKNOWN по реальным attempt-данным, не по env presence;
- ни один текст отчёта/лога не использует слово «independent» без указания
  конкретного `ModelRelationship`, на котором основан вывод.

### PR A3 — Eval harness gate semantics [P1]

Своя gate-семантика для `run-eval-corpus.ts` (не копия
`--fail-on=none|degraded|lost` из `test-extraction-pack.ts` — там другие
вердикты, `DEGRADED`/`LOST`, которых у golden corpus нет).

**[R3] Добавлен `ActualDisposition` — CodeRabbit верно указал, что без него
`MUST_HOLD → direct-answer` и `MAY_HOLD` невозможно вычислить из голого
`PASS/FAIL`:**

```ts
type ActualDisposition = 'DIRECT_ANSWER' | 'HOLD' | 'ERROR';

type ExpectedDisposition =
  | 'MUST_PASS'    // ожидаем прямой корректный ответ
  | 'MUST_HOLD'    // ожидаем hold/clarification, не прямой ответ
  | 'MAY_HOLD'     // и прямой ответ (если корректный), и hold — оба приемлемы
                    // (например, кейс с нострификацией — temporarily-acceptable
                    // hold, уже задокументирован)
  | 'KNOWN_FAIL';  // ожидаемо падает сегодня, не блокирует gate

type CaseResult = 'PASS' | 'FAIL' | 'XFAIL' | 'XPASS';
```

Явная матрица `ExpectedDisposition × ActualDisposition → CaseResult`:

```text
MUST_PASS:
  DIRECT_ANSWER + assertions passed → PASS
  DIRECT_ANSWER + assertions failed → FAIL
  HOLD                               → FAIL
  ERROR                              → FAIL

MUST_HOLD:
  HOLD          → PASS
  DIRECT_ANSWER → FAIL
  ERROR         → FAIL

MAY_HOLD:
  HOLD                             → PASS
  DIRECT_ANSWER + assertions pass  → PASS
  DIRECT_ANSWER + assertions fail  → FAIL
  ERROR                            → FAIL

KNOWN_FAIL:
  фактический FAIL (по любой из вышеуказанных логик) → XFAIL, не блокирует gate
  фактический PASS                                    → XPASS, требует ручного
                                                          review (снять
                                                          KNOWN_FAIL или это
                                                          ложный сигнал)
  ERROR движка (исключение, не assertion)              → FAIL всегда, никогда
                                                          не XFAIL
```

Режимы запуска:

```bash
--mode=baseline   # всегда пишет snapshot результатов, никогда не падает
--mode=gate       # exit 1 при: MUST_PASS→FAIL, MUST_HOLD→FAIL, MAY_HOLD→FAIL,
                  #   KNOWN_FAIL→XPASS (требует ручного review baseline)
                  #   ошибка самого движка — всегда exit 1
```

- **[P1]** 6 `known-good` кейсов без явного `requiresClarificationOrHold`
  получают явную `ExpectedDisposition` (в основном `MUST_PASS`, кейс с
  нострификацией — `MAY_HOLD`, не подряд всем шести одна и та же метка).
- **[P1]** `telemetryMode: 'disabled'` — параметр на исполняемый вызов,
  глушащий fire-and-forget телеметрию (`HallucinationLog` и т.п.) именно на
  eval-прогонах.

**Acceptance criteria:**
- `--mode=baseline` всегда формирует snapshot-артефакт, никогда не завершает
  процесс с ненулевым кодом из-за содержимого кейсов;
- `ActualDisposition` вычисляется из реального ответа движка (наличие
  hold/clarification маркера vs прямой ответ vs исключение) ДО сравнения с
  `ExpectedDisposition`;
- `--mode=gate` возвращает exit 1 ровно по матрице выше и ни при каких других
  условиях;
- PASS/FAIL/XFAIL/XPASS вычисляются по стабильным case ID, не по порядковому
  номеру в файле;
- ни один `known-good` кейс не остаётся без явной `ExpectedDisposition`;
- eval-прогон с `telemetryMode: 'disabled'` не создаёт строк в
  `HallucinationLog`/`HeldAnswer`/другой production-телеметрии.

### PR A4 — Документация [P1]

- Убрать вводящий в заблуждение заголовок «(ПЕРЕД 2.4, не после)» у Задачи 3.1
  в `docs/plans/2026-08-05-aurora-knowledge-engine-v2.md` (см. §1.8).
- Truth table §2: явно продублировать `audience` в колонке «обязательные поля»
  для всех kind, где оно применимо.
- **Строгий инвариант вместо простого переименования, единый тип везде.**
  `reviewedBy` и `reviewStatus` — разные поля с зависимостью:

  ```ts
  reviewStatus: 'UNCLASSIFIED' | 'REVIEWED';
  reviewedBy: string | null;
  reviewedAt: string | null;  // [R3] ISO-8601 string везде на границе JSON/
                               // JSONL/Zod — CodeRabbit нашёл, что Revision 2
                               // смешала Date/string между этим блоком и B1;
                               // Date допустим ТОЛЬКО внутри runtime-кода после
                               // явного parse, никогда в самом контракте
  // Инвариант: reviewStatus === 'REVIEWED' ⟺ reviewedBy и reviewedAt оба заданы
  ```

  **[R3]** Этот инвариант документируется здесь как источник истины, но
  ЗАКРЕПЛЯЕТСЯ кодом (Zod `.superRefine()`) в PR B1, не только текстом —
  CodeRabbit верно указал, что текстового комментария недостаточно для
  runtime-контракта.
- Зафиксировать явно в §2 truth table: `PRICE_RULE` описывает ПОЛИТИКУ расчёта,
  не сами числа — не конкурирует с уже типизированным `Tariff`.
- Добавить в план задачу (см. §6) на конкретный numeric-evidence эксперимент
  из §2.2 выше.

### PR B1 — Типизированный доменный контракт [P1, depends-on A4]

**`facets: Record<string, FacetValue>` отклонён** — легко превращается в новый
EAV. Вместо этого — типизированный, но расширяемый registry:

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

**[R3] `NOT_APPLICABLE` и `UNKNOWN` — разные состояния, не одна и та же
"отсутствующая фасета".** Ревью указало главную оставшуюся двусмысленность:
`facets: { [K in FacetKey]?: FacetState<...> }` (опциональный ключ) кодирует
ОБА случая одним и тем же "поле отсутствует" — «фасета неприменима к этому
`kind`» и «фасета применима, но пока неизвестна». Это ровно тот класс ошибки,
который весь план пытается уничтожить у `scenarioKey=null`. Решение — второй
registry, привязывающий применимость фасет к `kind`:

```ts
// src/lib/knowledge/applicability/kinds.ts
const KNOWLEDGE_KIND_REGISTRY = {
  PROCEDURE_STEP: {
    applicableFacets: ['scenario', 'service'],
    requiredFacets: ['scenario'],
  },
  DELIVERY_RULE: {
    applicableFacets: ['scenario', 'deliveryCity'],
    requiredFacets: ['scenario', 'deliveryCity'],
  },
  // ...остальные kind из truth table, включая TERM_DEFINITION/PRICE_RULE/
  // EXCEPTION_RULE — конкретные applicable/required списки переносятся из
  // truth table §2/§3.2 (уже нормализованных в PR A4) в этом PR, не заново
  // придумываются
} as const;
```

TypeScript-тип `ApplicabilityProfile.facets` остаётся структурно permissive
(`Partial`-карта по всем `FacetKey` — полная per-`kind` условная типизация была
бы избыточным усложнением для документа плана), но РЕАЛЬНОЕ разделение
`NOT_APPLICABLE`/`UNKNOWN`/`GLOBAL`/`SCOPED` обеспечивается Zod
`.superRefine()`, сверяющим ключи `facets` с `KNOWLEDGE_KIND_REGISTRY[kind]`:

```text
для каждого facet в KNOWLEDGE_KIND_REGISTRY[kind].applicableFacets:
  ключ ДОЛЖЕН присутствовать в facets со значением UNKNOWN | GLOBAL | SCOPED
для каждого facet НЕ из applicableFacets:
  ключ НЕ ДОЛЖЕН присутствовать в facets вообще (не UNKNOWN — отсутствие)
для каждого facet в requiredFacets:
  если audience допускает клиентский auto-answer — UNKNOWN запрещён на этом
  этапе валидации create/publish (см. B2 evaluateUnitEligibility, которая
  дополнительно проверяет это в рантайме запроса)
```

Обращение по ключу, отсутствующему в `FACET_REGISTRY`, — ошибка компиляции/
runtime-валидации (fail-closed), не молчаливое игнорирование.

**[R3] `audience` возвращён к текущей семантике.** Revision 2 предложила
`'CLIENT' | 'INTERNAL' | 'BOTH'` без определения, чем это отличается от уже
существующих `CLIENT_SAFE`/`INTERNAL_ONLY` (видит ли `CLIENT` сотрудник? чем
`BOTH` отличается от `CLIENT_SAFE`? как мигрировать текущие значения?) — ревью
верно отклонило это как непроверенную смену модели без отдельного решения.
Контракт B1 сохраняет действующую систему:

```ts
export interface ApplicabilityProfile {
  kind: KnowledgeUnitKind;
  facets: { [K in FacetKey]?: FacetState<FacetValueOf<K>> }; // валидируется
                                                              // через superRefine
                                                              // выше
  audience: 'CLIENT_SAFE' | 'INTERNAL_ONLY';
  reviewStatus: 'UNCLASSIFIED' | 'REVIEWED';
  reviewedBy: string | null;
  reviewedAt: string | null;
}
```

Расширение до отдельного `BOTH`/аналога — возможное будущее решение, но требует
собственного анализа миграции существующих данных, не принимается попутно здесь.

**[R3] QueryFrame: `negation: boolean` заменён на per-facet include/exclude с
evidence, `missingRequiredFacets` убран из LLM-выхода.** Ревью указало два
отдельных дефекта старого `QueryFrame`:

1. Один глобальный `negation: boolean` не различает «мне нужен НЕ апостиль, а
   легализация» (отрицание конкретного значения фасеты) и «а оригинал не
   нужен?» (вопрос о требовании, не утверждение `originalRequired=false`).
2. `missingRequiredFacets` — не факт вопроса, а результат сравнения вопроса с
   требованиями конкретного `kind`. Вычислять его в LLM-построителе (PR D)
   означает дублировать и рассинхронизировать логику, которая уже должна жить
   в evaluator'е (PR B2, `evaluateScope`). Убирается из типа `QueryFrame`
   полностью — `evaluateScope` вычисляет `missingFacets` сравнением
   `QueryFrame.facets` с `KNOWLEDGE_KIND_REGISTRY[kind].requiredFacets`.

```ts
interface FacetEvidence {
  source: 'CURRENT_MESSAGE' | 'HISTORY' | 'DETERMINISTIC';
  messageId?: string;
  quote: string;
}

type QueryFacetState<T> =
  | { state: 'UNKNOWN' }
  | {
      state: 'KNOWN';
      include: readonly T[];
      exclude: readonly T[];
      evidence: readonly FacetEvidence[];
    };

type QuestionAspect =
  | 'ELIGIBILITY' | 'REQUIREMENT' | 'PRICE' | 'PROCEDURE' | 'DELIVERY';

export interface QueryFrame {
  concepts: string[];              // канонические Concept ID (после 2.2)
  facets: { [K in FacetKey]?: QueryFacetState<FacetValueOf<K>> };
  questionAspects: QuestionAspect[]; // композитный вопрос ("сколько стоит X и
                                      // нужен ли оригинал?") несёт несколько
  ambiguities: string[];             // включая конфликт текущего сообщения с
                                      // историей — см. PR D
}
```

Приоритет источников значения факета (реализуется в PR D, тип здесь только
даёт место для evidence): явное значение в текущем сообщении сильнее истории;
противоречие текущего сообщения с историей → запись в `ambiguities`, не
молчаливый override; значение только в истории — используется, но
`evidence[].source === 'HISTORY'` сохраняется для аудита.

**Acceptance criteria:**
- ни одного `Record<string, unknown>`/`Record<string, FacetValue>` для facet
  keys нигде в контракте;
- неизвестный facet-ключ — ошибка на этапе валидации, не тихий no-op;
- `UNKNOWN`, `NOT_APPLICABLE` (кодируется отсутствием ключа вне
  `applicableFacets`) и `GLOBAL` — три разных, не взаимозаменяемых состояния,
  подтверждённых тестами на `KNOWLEDGE_KIND_REGISTRY`;
- Zod-схема `ApplicabilityProfile` содержит `.superRefine()`, проверяющий:
  (а) presence/absence facets по `KNOWLEDGE_KIND_REGISTRY[kind]`, (б)
  `reviewStatus === 'REVIEWED' ⟺ reviewedBy != null && reviewedAt != null`;
  тесты покрывают ВСЕ комбинации `reviewStatus`×`reviewedBy`×`reviewedAt`
  (валидные и невалидные), не только счастливый путь;
- `QueryFrame` не содержит `missingRequiredFacets` и не содержит булевого
  `negation` — оба заменены типами выше;
- `Zod`-схемы для `ApplicabilityProfile`/`QueryFrame` покрыты unit-тестами на
  валидные/невалидные значения.

### PR B2 — Evaluator'ы [P1, depends-on B1]

Одной функции `evaluateApplicability(profile, query)` недостаточно — truth
table сама различает независимые проверки. Разбивается на четыре:

```ts
// 1. Годен ли unit вообще для рассмотрения (независимо от конкретного вопроса)
function evaluateUnitEligibility(
  unit: KnowledgeUnitLike,
  requestContext: RequestContext
): EligibilityDecision;
// проверяет: status, reviewStatus, audience, validity, source revision,
// а также requiredFacets из KNOWLEDGE_KIND_REGISTRY не UNKNOWN, если unit
// должен участвовать в клиентском auto-answer (см. B1)

// 2. Совпадает ли scope unit'а с фасетами вопроса
function evaluateScope(
  profile: ApplicabilityProfile,
  query: QueryFrame
): ScopeDecision;
// возвращает: MATCH | CONFLICT | UNKNOWN по каждой ПРИМЕНИМОЙ (см.
// KNOWLEDGE_KIND_REGISTRY[profile.kind]) фасете, missingFacets (вычислено
// здесь, не в QueryFrame — см. B1), conflictingFacets, reasons

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

Финальное решение обязано объяснять себя:

```ts
{
  eligible: true,
  scopeVerdict: 'UNKNOWN',
  reasons: ['destination_country_missing'],
  missingFacets: ['destinationCountry'],
  requiresClarification: true,
}
```

**[R3] Table-driven тесты распределены по владельцу решения, не все через
`evaluateScope`.** CodeRabbit верно указал на внутреннее противоречие Revision
2: требование «каждая строка truth table» через `evaluateScope`, при том что
сам документ уже выделяет отдельные eligibility/trigger/resolution проверки.
Явное сопоставление:

```text
truth table §3.1 (SCOPE dimension matrix)        → evaluateScope suite
truth table §3.2 (обязательные поля по kind)      → evaluateUnitEligibility suite
truth table §3.3 (triggerCondition activation)    → evaluateTrigger suite
truth table §3.4 (multi-unit conflict resolution) → resolveKnowledgeSet suite
```

**Acceptance criteria:**
- каждая строка truth table сопоставлена ровно одной из четырёх suite выше —
  ни одна не прогоняется повторно «на всякий случай» через `evaluateScope`;
- `evaluateScope` вычисляет `missingFacets` детерминированно, сравнивая
  `QueryFrame.facets` с `KNOWLEDGE_KIND_REGISTRY[profile.kind].requiredFacets`
  (не читает `QueryFrame.missingRequiredFacets` — такого поля больше нет, см. B1);
- `evaluateTrigger` и `resolveKnowledgeSet` покрыты отдельными тестами;
- решения всех четырёх функций содержат машиночитаемые reason codes и (где
  применимо) `missingFacets`/`conflictingFacets`;
- `scenario` не хардкожен как единственная обязательная ось ни в одной из
  четырёх функций (расширяемость под §4.1 сохранена).

### PR C — Provider structured-output adapter [P1, depends-on A1, B1]

**[R3] Контракт приведён в соответствие с A1/A2 — Revision 2 не принимала
`ExtractionRunConfig`/fallback-политику и не возвращала `attempts[]`, из-за
чего PR E не смог бы гарантировать consistency retry и вычисление
`ModelRelationship`:**

```ts
async function structured<T>(opts: {
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  runConfig: ExtractionRunConfig;      // provider, model, promptVersion (PR A2)
  fallbackPolicy?: FallbackPolicy;      // из PR A1, дефолт NONE для structured
                                         // вызовов (extraction/grader/QueryFrame
                                         // требуют предсказуемости больше, чем
                                         // отказоустойчивости)
}): Promise<{ data: T } & ChatCompletionResult>;  // ChatCompletionResult из A1,
                                                    // включая attempts[]
```

Runtime-проверка через тот же Zod, что и в B1/B2.

**Acceptance criteria:**
- невалидный по схеме ответ модели не проходит как "успех" молча — явная
  ошибка с диагностикой, какое поле не совпало;
- результат всегда включает полный `attempts[]`, не только финальный
  успешный вызов;
- `servedByProvider`/`servedByModel` в результате всегда соответствуют
  реально выполнившему вызов провайдеру.

### PR D — QueryFrame builder [P1, depends-on B1, C, 2.2]

Вход: вопрос пользователя + история переписки + канал/audience. Выход —
`QueryFrame` (тип из B1, после `[R3]`: per-facet `QueryFacetState` вместо
глобального `negation`, без `missingRequiredFacets`). Реализуется через
`structured()` (PR C).

**[R3] Обработка истории переписки — явный контракт, не подразумеваемый.**
CodeRabbit указал: если facet найден в истории, он не должен становиться
`UNKNOWN` только потому, что отсутствует в последнем сообщении. Правило:

```text
facet есть в текущем сообщении               → state: KNOWN, evidence: CURRENT_MESSAGE
facet есть только в истории                  → state: KNOWN, evidence: HISTORY
facet в текущем сообщении ПРОТИВОРЕЧИТ истории → ambiguities += конфликт,
                                                  state текущего сообщения
                                                  побеждает (сильнее), но конфликт
                                                  не замалчивается
facet нигде не упомянут                       → state: UNKNOWN
```

`missingRequiredFacets` НЕ вычисляется здесь (см. B1/B2) — builder не знает и
не должен знать про `KNOWLEDGE_KIND_REGISTRY`, это забота evaluator'а.

**Acceptance criteria:**
- построитель никогда не придумывает facet-значение, отсутствующее и в
  текущем сообщении, и в истории — при неуверенности возвращает `UNKNOWN`;
- отрицание конкретного значения фасеты ("не апостиль, а консульская
  легализация") даёт `exclude: ['apostille']`, не глобальный флаг;
- вопрос-требование ("а оригинал не нужен?") распознаётся как
  `questionAspects: ['REQUIREMENT']`, не как отрицание facet-значения;
  композитный вопрос ("сколько стоит и нужен ли оригинал") даёт больше одного
  `questionAspect`;
- факт из истории, отсутствующий в последнем сообщении, НЕ становится
  `UNKNOWN` (регрессионный тест на этот конкретный кейс, который CodeRabbit
  указал явно);
- конфликт текущего сообщения с историей попадает в `ambiguities`, не
  разрешается молча.

### PR E — Структурная экстракция + provenance [P1, depends-on B1, C, 2.2]

Экстрактор выдаёт не `{ruleCode, title, body, confidence, sourceSpan}`
(текущая `ExtractedRuleStream` — структурного поля условия применимости в
схеме нет вообще, см. находку в комментарии к translation-2n9), а:

```ts
interface ExtractedKnowledgeUnit {
  kind: KnowledgeUnitKind;

  statement: string;   // [R3] само утверждение/нормализованный claim — ревью
                        // указало, что предыдущая версия знала, К ЧЕМУ правило
                        // применимо, но не знала, ЧТО оно утверждает
  title?: string;

  facets: Partial<{ [K in FacetKey]: FacetValueOf<K> }>; // [R3] CodeRabbit:
                                                           // Partial<Record<
                                                           // FacetKey,FacetValue>>
                                                           // разрешал любое
                                                           // значение для
                                                           // любого ключа
                                                           // (issuingCountry
                                                           // мог получить
                                                           // не-страну);
                                                           // key-specific
                                                           // mapped type это
                                                           // исключает
  triggerCondition: TriggerCondition | null;
  numericConstraint: NumericConstraint | null;
  parentRuleRef: string | null;   // [R3] ссылается на стабильный source anchor
                                    // или уже назначенный deterministic unit ID
                                    // (см. PR F) — НЕ на эпемерную метку
                                    // конкретного прогона вроде "R-17"

  sourceSpan: SourceSpan;
  evidenceByField: Record<string, SourceSpan>;   // [R3] provenance по каждому
                                                   // структурному полю отдельно,
                                                   // не только по unit целиком
  uncertainties: ExtractionUncertainty[];         // [R3] см. смягчённый
                                                   // acceptance criterion ниже
}
```

Использует `ExtractionRunConfig` (PR A2) и `structured()` (PR C). Известные
живые баги от синтетического прогона (translation-2n9) — потеря родительского
контекста при фрагментации правила и молчаливый пропуск части правил при
генерации QA-пар — фиксируются здесь как regression-тесты на реальных примерах
из того прогона.

**Acceptance criteria:**
- **[R3, смягчено]** распознанное условие применимости структурируется в
  `triggerCondition`/`numericConstraint`; НЕраспознанное или неуверенное
  условие получает явную запись в `uncertainties` и блокируется от
  auto-activation (не участвует в `evaluateTrigger` как `ACTIVE`) — ничего не
  исчезает молча, но абсолютное «ни одно условие не остаётся прозой» было
  нереалистичным требованием к LLM-экстракции;
- `statement` присутствует и непусто для каждого извлечённого unit'а;
- `facets` не допускает несовместимое с `FacetKey` значение (типоуровневая
  проверка + Zod);
- фрагментация длинного правила не теряет ссылку на `parentRuleRef`, и эта
  ссылка разрешается в валидный source anchor или unit ID (PR F), не в
  эпемерную метку прогона;
- `sourceSpan` присутствует для unit'а целиком, `evidenceByField` — минимум
  для `statement`, `facets`, `triggerCondition`, `numericConstraint` по
  отдельности.

### PR F — Human-review артефакт + persistence [P1, depends-on E]

**[R3] Формат — JSONL безусловно, без альтернативы «может быть временная
таблица».** CodeRabbit указал на прямое противоречие в Revision 2 (текст
одновременно разрешал временную таблицу и требовал plain JSON/JSONL для
acceptance criterion). НЕ production Prisma v2 (это всё ещё 2.4, после пилота):

- JSONL-файлы на файловой системе — единственный контракт, без опционального
  «или таблица». Проще, auditable, diffable, не создаёт преждевременную
  полусхему.

**[R3] Детерминированные ID — из pre-LLM source anchor, не из хэша LLM-вывода.**
Ревью указало на ловушку: `unitId = hash(content)` делает unit "новым" при
малейшей перефразировке моделью того же самого правила между прогонами.
Порядок построения:

```text
1. Source anchor строится ДО и НЕЗАВИСИМО от LLM:
   sourceRevisionHash + sectionPath + startOffset + endOffset + kind +
   stable local discriminator (например, порядковый номер unit'а внутри
   секции по результатам детерминированного chunking, не LLM-нумерации)

2. unitId = hash(sourceRevisionHash + sourceAnchor + kind + discriminator)
   — стабилен между прогонами экстракции по неизменному документу, даже если
   LLM перефразировал statement

3. contentHash = отдельный fingerprint от statement/facets/triggerCondition —
   меняется при реальном дрейфе содержания, используется, чтобы ЗАМЕТИТЬ
   изменение, не чтобы идентифицировать unit
```

`parentRuleRef` (PR E) ссылается на `unitId`, построенный этим способом, или
на сырой source anchor, если родительский unit ещё не прошёл экстракцию.

Дополнительно:
- явные review-решения (`accept`/`reject`/`edit`) с `reviewedBy`/`reviewedAt`
  по инварианту из B1/A4;
- повторный прогон по неизменному документу не создаёт дубликат review-решения
  для того же `unitId`.

**Acceptance criteria:**
- persistence — JSONL, без исключений для этого пилота;
- `unitId` стабилен между двумя прогонами экстракции одного и того же
  document revision, даже если LLM изменил формулировку `statement`
  (регрессионный тест: два прогона, одинаковый anchor, разный текст → тот же
  `unitId`, разный `contentHash`);
- `contentHash` меняется, когда меняется содержание, и используется именно
  для обнаружения дрейфа, не для идентичности;
- повторный прогон не создаёт дубликаты review-решений для одного `unitId`;
- review-артефакт читаем без специального тулинга (plain JSONL).

### PR G — Evaluation-only semantic retrieval поверх reviewed JSONL **[R4]** [P0, depends-on F]

Первое место во всём плане, где проверяется ГЛАВНАЯ способность системы:
находить правило по смыслу при другой формулировке вопроса. Работает поверх
reviewed JSONL из PR F, **не требует production pgvector** — на десяти
правилах достаточно in-memory индекса и уже существующего в репозитории
cosine (`src/lib/ai/vector-search.ts:184`, а также `chunker.ts:17`).

Состав:

- **`retrievalText` на unit** — то, что реально индексируется. Не только
  `statement`: `title + statement + source context + структурные условия +
  facets`. Правило «не более 15 секунд подряд» должно быть находимо вопросом
  «как долго можно водить пальцами», а для этого в индексируемом тексте
  обязан присутствовать контекст, из которого видно, что речь о почёсывании.
- **embeddings по units** (не по сырым чанкам документа — это принципиально:
  ищем по извлечённому знанию, а не по исходной прозе);
- **lexical retrieval** — существующий `searchByKeywords`-подход;
- **RRF** — переиспользовать существующий (`hybridSearch`,
  `src/lib/ai/vector-search.ts:432`, k=60), не писать второй;
- **semantic reranker** — **[R4] проверено: в репозитории отсутствует**
  (`grep -rln "rerank" src/lib` пусто), это НОВЫЙ компонент, а не
  переиспользование существующего. Применяется к небольшому candidate pool
  (десятки units, не тысячи), поэтому cross-encoder/LLM-reranker здесь
  дёшев;
- **полный retrieval trace** на каждый запрос (см. артефакт в PR H).

**Acceptance criteria:**
- `recall@5` после reranking = 10/10 на `Q01`–`Q10` (ожидаемая группа правил
  в reranked top-5);
- измеряется и отдельно фиксируется `recall@K` ДО reranking (candidate
  generation) — чтобы было видно, что чинить, если ворота не прошли:
  генерацию кандидатов или ранжирование;
- `Q03` (не содержит слова «чесать»), `Q04` («водить пальцами»), `Q09`
  («близкий человек поможет добраться») находятся БЕЗ добавления их
  формулировок в `ConceptAlias` — это прямая проверка, что работает
  семантика, а не словарь;
- trace показывает lexical rank, vector rank, RRF rank и reranker rank
  отдельно для каждого кандидата;
- ничего не пишется в production-таблицы (evaluation-only, как
  `telemetryMode: 'disabled'` в A3).

### PR H — End-to-end fixture runner **[R4]** [P0, depends-on B2, D, G]

Полный путь `DOCX → answer` одной командой, единственное место, где ворота
§0.4 проверяются вместе, а не по отдельности.

```text
uchebnaya_instrukciya_...docx
  → PR E structured extraction
  → PR F reviewed JSONL units
  → PR D QueryFrame (вопрос другими словами)
  → PR G retrieval (embeddings + lexical + RRF + reranker)
  → PR B2 evaluateUnitEligibility / evaluateScope / evaluateTrigger /
           resolveKnowledgeSet
  → evidence-backed synthesis
  → сверка с oracle (Q01–Q10 + 6 negative cases)
```

**Артефакт прогона обязан содержать по каждому case ID:**

```text
extracted unit IDs / source anchors
QueryFrame (facets, questionAspects, ambiguities)
pre-filter candidates
exclusion reasons (почему кандидат выброшен и какой функцией B2)
lexical rank / vector rank / RRF rank / reranker rank
selected evidence
actual disposition (DIRECT_ANSWER | HOLD | ERROR — тип из A3)
final answer
answerSource
expected rule IDs (из oracle)
PASS/FAIL + причина
```

**Acceptance criteria:**
- изоляция oracle соблюдена и проверяема: `test_cases_semantic_rules.jsonl`
  и `kontrolnye_voprosy_i_klyuch.md` не попадают ни в базу знаний, ни в
  extraction prompt, ни во вход answering engine (тест на это — не только
  договорённость);
- `Q01`–`Q10` = 10/10, все 6 negative-кейсов PASS;
- ни один PASS не получен при `answerSource === 'general_ai'` — такой кейс
  автоматически FAIL, даже если текст ответа совпал с ожидаемым;
- числа Q04 (15 сек / 30 сек / 3 цикла) совпадают точно;
- `Q05` применяет исключение для автобуса, `Q05-N1` — не применяет его дома;
- `Q01-M1` и `Q05-M1` дают clarification/hold, а не выбор одного из двух
  взаимоисключающих правил наугад;
- прогон воспроизводим: повторный запуск на том же DOCX даёт те же `unitId`
  (стабильность из PR F) и сопоставимый retrieval trace.

---

## §4. Открытые архитектурные вопросы

### 4.1 `scenario` не единственная главная ось — **[R3] принято как инвариант, детали остаются за пилотом**

Возражение по существу: для бюро переводов применимость реально зависит не
только от scenario, а от `documentType`, `issuingCountry`, `documentForm`
(оригинал/скан/копия), `languagePair`, `urgency`, `partner`, `deliveryRoute` и
т.д.

**[R3]** Revision 2 сформулировала это как «не принимаю и не отвергаю сейчас».
Ревью раунда 3 указало, что для контракта B1 этого недостаточно — сам факт,
что `scenario` НЕ является единственной осью, уже логически следует из
необходимости `FACET_REGISTRY`/`KNOWLEDGE_KIND_REGISTRY` как расширяемых
структур (иначе зачем вообще регистр из десяти фасет вместо одного поля).
Формулировка уточняется: **инвариант «scenario не единственная ось» принят
окончательно и не пересматривается пилотом.** Что ОСТАЁТСЯ открытым и решается
именно пилотом (2.3) — это НЕ "нужны ли атомарные фасеты вообще", а:

- какой конкретно каталог facet-ключей нужен сверх примера в B1
  (`FACET_REGISTRY` уже сейчас содержит 10 ключей не просто для примера — это
  рабочая гипотеза, которую пилот подтверждает или расширяет);
- какие facet-ключи обязательны (`requiredFacets`) для каждого конкретного
  `kind` в `KNOWLEDGE_KIND_REGISTRY` — это таблица, которую пилот населяет
  данными, а не бинарное решение "нужна ли она".

`FACET_REGISTRY`/`KNOWLEDGE_KIND_REGISTRY` спроектированы как открытые для
дополнения (добавление новой фасеты — новая запись в registry + новый
конкретный `FacetValue`-тип, без переписывания `evaluateScope`/`evaluateTrigger`/
`resolveKnowledgeSet` с нуля) — именно поэтому принятие инварианта сейчас не
блокирует пилот, а направляет его.

### 4.2 `TERM_DEFINITION` контекстно-зависим

Согласен, что термин может значить разное в апостиле/нотариальном переводе/
консульской легализации — сегодняшняя truth table делает `TERM_DEFINITION`
безусловно document-scoped, что упрощение. Решается пилотом (найдётся ли в
реальных документах бюро термин с контекстно-разным значением), не
переписыванием truth table сейчас.

### 4.3 `PRICE_RULE` не должен конкурировать с `Tariff`

Согласен по существу — `Tariff` уже типизирован. `PRICE_RULE` в v2 должен
описывать ПОЛИТИКУ расчёта, не сами числа. Правится в PR A4.

### 4.4 review-статус — не переименование, инвариант

`reviewStatus` и `reviewedBy` — разные понятия: один описывает процессный
статус unit'а в целом, другой — кто и когда подтвердил конкретное решение.
**[R3]** С Revision 3 это больше не только текстовый инвариант — закреплено
Zod `.superRefine()` в PR B1 (см. там), с тестами на все комбинации.

---

## §5. Явно НЕ делать в следующей сессии

- Никакой финальной Prisma-схемы v2 (Задача 2.4).
- Никакого `pgvector`/vector-колонки (3.1/3.2). **[R4]** Отдельно: PR G
  намеренно НЕ использует pgvector — на десяти правилах in-memory cosine
  доказывает продуктовую способность, а pgvector решает производительность и
  масштаб, то есть нужен позже и по другой причине.
- Никакого backfill 1535 правил эвристической классификацией.
- **[R4]** Никакого массового переизвлечения корпоративных документов до
  прохождения PR H (учебный DOCX 10/10 + все negative) И пилота 2.3 на
  реальных документах. Это главный запрет ревизии: переизвлекать корпус
  экстрактором, который ещё не доказал сохранение условий и чисел, — значит
  тиражировать дефект по всей базе.
- Не мержить `PR #52` (LlmCallLog full logging) как есть — отслежено как
  `translation-m0x`.
- **[R4]** Не начинать 2.3 (пилот на реальных документах) до ЗЕЛЁНОГО PR H на
  учебном DOCX. Пилот проверяет обобщение на незнакомый домен; если система не
  прошла контролируемый пакет, где ответы известны, пилот измерит шум, а не
  обобщение.
- **[R4]** Не засчитывать кейс как пройденный по тексту финального ответа, если
  ожидаемый unit не попал в reranked top-5 (см. Retrieval gate, §0.4) — «модель
  угадала из общих знаний» не является работающей системой знаний.
- **[R4]** Не полагаться на `ConceptAlias` как на механизм семантического
  сопоставления: alias-таблица нормализует известное, а ворота G проверяют
  именно НЕизвестные заранее перефразы.
- Не путать безопасный backfill (`Document.scenarioKey` уже известен →
  унаследовать в null-детей) с эвристической массовой классификацией 1535
  правил — см. §6, `translation-8kf`.
- Не мержить PR A одним куском — обязательно как минимум A1/A2/A3/A4
  отдельными PR.
- Не вводить `facets: Record<string, unknown>` ни в каком виде.
- **[R3]** Не называть провайдер/модель-совпадение grader'а `FULL independence`
  — использовать фактическую `ModelRelationship`-матрицу (см. PR A2).
- **[R3]** Не вычислять `missingRequiredFacets` в LLM/QueryFrame builder — это
  детерминированная функция `evaluateScope` от `KNOWLEDGE_KIND_REGISTRY`.
- **[R3]** Не строить `unitId` из хэша LLM-сгенерированного текста — только из
  pre-LLM source anchor (см. PR F).
- **[R3]** Не мержить эту Revision 3, пока не закрыты все 9 comments CodeRabbit
  на диффе Revision 2 (закрыты этой редакцией — см. пометки `[R3]` выше) И не
  получено новое содержательное ревью именно на диффе Revision 3 — тот же
  двухступенчатый gate, который применяется к каждому PR A1–F ниже.

**Порядок ревью для каждого PR A1–F:** не мержить сразу по зелёному CI —
дождаться хотя бы одного содержательного ревью (Grok/Codex/CodeRabbit) на
диффе. Предыдущий PR (#59) уже показал: содержательные находки пришли через 2
минуты ПОСЛЕ merge.

---

## §6. Beads — изменения после утверждения плана

`translation-8kf` (уже существует, синхронизирована с этой сессией) покрывает
`Rule.create()`/`QAPair.create()` scenarioKey-наследование, безопасный backfill
и sync-функцию для v1 — не дублируется здесь, технически не зависит от B1,
остаётся исполнимой независимо в любой момент.

**[R3] Граф зависимостей ниже заменяет полностью линейную версию из Revision
2** — отражает реальные технические блокеры (см. §3), не порядок ревью:

- **P0** PR A1 — Provider routing & fallback contract. Без зависимостей.
- **P0** PR A2 — Extraction run consistency. `depends-on` A1.
- **P1** PR A3 — Eval harness gate semantics. Без зависимостей (может идти
  параллельно с A1/A2/A4).
- **P1** PR A4 — Документация. Без зависимостей (может идти параллельно с
  A1/A2/A3).
- **P1** PR B1 — Типизированный контракт (FacetRegistry, KnowledgeKindRegistry,
  ApplicabilityProfile, QueryFrame). `depends-on` A4.
- **P1** PR B2 — Evaluator'ы. `depends-on` B1.
- `translation-5ii` (2.2 Concept/ConceptAlias): `depends-on` B2.
- **P1** PR C — Provider structured-output adapter. `depends-on` A1, B1.
- **P1** PR D — QueryFrame builder. `depends-on` B1, C, 2.2.
- **P1** PR E — Структурная экстракция + provenance. `depends-on` A2, B1, C, 2.2.
- **P1** PR F — Human-review артефакт + JSONL persistence. `depends-on` E.
- **[R4] P0** PR G — Evaluation-only semantic retrieval поверх reviewed JSONL
  (retrievalText, embeddings по units, lexical, существующий RRF, НОВЫЙ
  reranker, in-memory без pgvector). `depends-on` F.
- **[R4] P0** PR H — End-to-end fixture runner (DOCX → answer, Q01–Q10 + 6
  negative cases, полный retrieval trace, изоляция oracle). `depends-on`
  B2, D, G.
- Пилот 2.3: `depends-on` H (**[R4]**: в Revision 3 было B2+D+F — теперь путь
  идёт через G и H, которые уже включают B2 и D транзитивно; пилот не
  начинается, пока учебный пакет не зелёный).
- 2.4 (финальная Prisma-схема): `depends-on` 2.3.
- **[R4]** Массовое переизвлечение корпоративных документов: `depends-on` 2.3
  (не 2.4) — заводится явной задачей, чтобы этот запрет был отслеживаемым, а
  не только текстом в §5.
- **P2** numeric-evidence shadow-эксперимент (`unverified_numeric_evidence`,
  §2.2). `depends-on` A4.
- **[R3] Новая P2 задача**: временная политика `fallbackPolicy` по умолчанию
  для вызовов без явно закреплённой модели (см. PR A1 — сейчас сохраняет
  legacy `CROSS_PROVIDER` поведение намеренно, но это не постоянное решение) —
  последовательная миграция всех call sites на явный `fallbackPolicy`.
  `depends-on` A1, не блокирует A1 сам.

Не трогаю очередь `bd ready` в этой сессии за пределами вышеперечисленного —
создание перечисленных задач происходит ПОСЛЕ утверждения этой редакции плана
(включая свежее содержательное ревью на диффе Revision 3), не раньше.
