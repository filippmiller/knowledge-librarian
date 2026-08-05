Сначала прочитаю полный план и сверяю его с кодовой базой и аудитами — без этого critique будет формальным.Сверяю ключевые места в коде с утверждениями плана: схема, retrieval, canonical override, миграции.# Критика плана Aurora Knowledge Engine v2

Вердикт: **не готов к Beads/подагентам**. Есть P0-дыры в порядке миграций, в модели применимости (болезнь v1 переживёт схему v2) и в том, что «bite-sized TDD» опирается на несуществующий test-runner. Ниже — только дефекты.

---

## P0 — блокирует старт

### 0.3 → должна быть 0.0, не 0.3
**Что не так:** baseline миграций стоит третьей, хотя 0.2 уже делает `migrate dev` + `railway run migrate deploy`.  
**Почему:** в `prisma/` **нет** `migrations/`. Сегодня прод живёт на `db push`. Любой `migrate deploy` без baseline либо упадёт на «таблица уже есть», либо (хуже) попытается создать мир заново против живой БД. Сам план в «Порядке ревью» это признаёт — и всё равно оставляет неправильный порядок.  
**Как исправить:**
1. Сначала `db pull` с прода как source of truth.  
2. Baseline `create-only` + `migrate resolve --applied` **на проде** (и на dev).  
3. Только потом любые schema-изменения (0.2, 2.x).  
4. В плане: **жёсткий serial gate**, не «подагент на задачу».

### 0.3 Step 3 — baseline из `schema.prisma`, а не из прода
**Что не так:** «создать миграцию из ТЕКУЩЕГО состояния схемы» — локальный `schema.prisma` **без** `LlmCallLog` (пока PR #52 не в master) и **без** колонки `embeddingVector` (её в schema нет, код уже пишет в неё raw SQL).  
**Почему:** baseline, снятый с git-схемы, **зафиксирует ложь**. Дальше `migrate deploy` будет «чинить» прод под неполную схему или постоянно врать в status.  
**Как:** baseline = diff `db pull` (prod) → schema → migration; merge PR #52 — часть выравнивания, не «первый шаг, который сам всё починит».

### 0.2 Step 5 — чинит не ту ветку null-wildcard
**Что не так:** логика завязана на `openLookup && scenarioKey === null && !isExplicitlyGlobal`.  
При **известном** сценарии фильтр остаётся:

```ts
OR: [{ scenarioKey: null }, { scenarioKey: { in: ancestors } }]
```

(`enhanced-answering-engine.ts` ~1059–1060, `vector-search.ts` ~137, ~213).  
**Почему:** это и есть корень «Орёл в ответе про Минск/Москву»: null = wildcard **когда сценарий известен**. План лечит open lookup / human-review, а не wildcard.  
**Как:** семантика null:
- `null + !isExplicitlyGlobal` → **никогда** не wildcard (ни open, ни closed);
- wildcard только `isExplicitlyGlobal=true` **или** (позже) `scopeStatus=GLOBAL`;
- отдельно: keyword-pool vs confidence-pool — не смешивать с wildcard.

### 0.2 — внутреннее противоречие спецификации
**Что не так:** контекст: «не участвует в открытом поиске **вообще** (только keyword)». Step 5: «попал в topN → `requiresHumanReview`».  
**Почему:** два разных продукта: (A) hard exclude, (B) soft hold. Исполнитель сделает что-то среднее, регрессии v1 непредсказуемы.  
**Как:** одна политика, явно:
1. confidence-top pool: null+!global **исключить**;
2. keyword pool: **допустить** + force hold;
3. vector/RRF: null+!global **исключить** (иначе Орёл снова в top-1 по cosine).

### Этапы 0–3 не закрывают болезнь извлечения
**Что не так:** инвариант 4 обещает re-extract из 44 docs на «Этапе 3», но Этап 3 = pgvector + QueryFrame. **Нет** задачи: extraction contract → `ApplicabilityProfile` обязателен → fail-closed если scope неясен. `DocChunk.scenarioKey` **нигде не пишется** при create (аудит + `chunker.ts`) — 0.2 вешает флаг на таблицу, write-path не трогает.  
**Почему:** v1 умирает на **записи** знания (условия применимости теряются). v2-схема на чтении без write-контракта = та же болезнь в новых таблицах.  
**Как:** до/вместе со схемой 2.1:
- extraction pipeline v2 (или жёсткий gate на legacy extractor);
- «нельзя ACTIVE/SCOPED без непустого профиля»;
- backfill/re-extract как отдельный этап **до** hard-filter retrieval, не «потом в 4–8».

### ApplicabilityProfile: пустые массивы = новый `null`
**Что не так:**
```prisma
serviceCodes String[] @default([])
// ... все facet-поля default []
```
Нет инварианта: `[]` = «не задано / unclassified» vs «любое значение».  
**Почему:** hard-filter «до ranking» при `[]` = match-all повторит scenarioKey=null один в один. SCOPED «с профилем» формально есть, семантически — пустышка.  
**Как:**
- запретить SCOPED, если **все** facet-массивы пусты;
- в фильтре: пустой facet **не** значит wildcard; wildcard только явный `scopeStatus=GLOBAL` / sentinel;
- лучше tri-state: `unset | any | values[]` (json/enum), не «массив по умолчанию пуст».

### Нет unit-test инфраструктуры, на которой строится весь TDD
**Что не так:** план: `npx vitest run ...`. В `package.json` — Playwright e2e, **нет** vitest/jest, нет `src/lib/ai/__tests__/`, `findCanonicalQaOverride` **не экспортирован** (`ForTests` выдуман; есть только `questionTermOverlapForTests`).  
**Почему:** «Step 1 red → green» невыполним; подагент либо застрянет на tooling, либо «починит без теста».  
**Как:** отдельная задача 0.0b: vitest + конфиг + паттерн export-for-tests / pure helpers. Не смешивать с prod-фиксом.

### 0.1/0.2 идут в прод без shadow и без feature-flag
**Что не так:** `ANSWER_ENGINE_VERSION` — только для полного v2. Этап 0 меняет live path клиентов сразу.  
**Почему:** инвариант 1 («v1 без перерыва») ≠ «v1 без изменения поведения». 0.1 убьёт почти все client canonical hits (exact после normalize). 0.2 при 1546/1967 Rule с null взорвёт hold-rate.  
**Как:** флаги `CANONICAL_CLIENT_EXACT_ONLY`, `SCOPE_NULL_STRICT`; shadow-метрики hold-rate / canonical-hit / wrong-scope **до** default-on.

---

## P1 — серьёзные логические/регрессионные дыры

### Архитектурный тезис vs Этап 0
**Что не так:** «`answerQuestionEnhanced` не трогается до отказа от v1» — и тут же 0.1/0.2 правят его в проде.  
**Почему:** агенты будут либо бояться трогать hot path, либо трогать без дисциплины «только safety patch».  
**Как:** явно: v1 **патчится** safety-слоем; v2 **рядом**; decommission — отдельно.

### 0.2 зависит от «как уже в PR #53» — PR #53 ещё OPEN
**Что не так:** план ссылается на уже сделанный keyword-only open lookup.  
**Почему:** на master поведение может отличаться; 0.2 поверх незамерженного #53 = конфликт/дубль.  
**Как:** зафиксировать base: merge #53 → измерить → затем 0.2; или включить #53 в 0.2 одним PR.

### 0.1 — неверная оценка эффекта + слабые тесты
**Что не так:**
1. Exact normalize: «Минск» ≠ «Минск, пожалуйста» — ок против FP, но client-canonical станет мёртвым (операторские формулировки ≠ клиентские).  
2. Тесты не бьют в заявленный баг (префиксы/редкий общий терм) — только «пожалуйста».  
3. Claude-аудит **опроверг** «причесать/почесать» через stem; план всё ещё на этой истории.  
**Как:** сначала замер hit-rate VOICE canonical на client traffic; порог exact **или** exact+alias table; тест на rare-token FP и на «не/без» (уже чинили в cache).

### 0.2 без capacity plan
**Что не так:** hold на любой null+!global в topN при ~80% null rules.  
**Почему:** бот «безопаснее», но перестаёт отвечать; эскалации забьют операторов; бизнес откатит патч.  
**Как:** dry-run на 100–150 реальных вопросов: % auto → hold; лимит; поэтапный strict только для DocChunk/vector (где Орёл), не сразу для всех Rule.

### 3.1 неполная и опасная по порядку
**Что не так:** «CREATE EXTENSION» — недостаточно. В schema **нет** `embeddingVector`; embeddings в `embedding Json`; есть `migrateEmbeddingsToPgvector` / HNSW, но **не в плане**. Step 4 «убрать in-memory fallback» до успешной миграции векторов = semantic search = 0.  
**Как:** extension → ALTER column → backfill 228 rows → index → health green → только потом fail-loud в prod. In-memory оставить как explicit `degraded` с алертом, не silent.

### 3.2 QueryFrame без controlled vocabulary
**Что не так:** `serviceCodes: z.array(z.string())` — свободные строки. `Concept`/`ConceptAlias` отложены в 2.3-N.  
**Почему:** hard-filter `QueryFrame.serviceCodes ∩ profile.serviceCodes` даст 0 при «апостиль» vs `apostille` vs `apostille.zags`. Болезнь сменит форму: не утечка, а пустые ответы.  
**Как:** словарь **до** массового extract и **до** QueryFrame в hot path; LLM мапит в enum/codes, Zod отвергает unknown.

### 2.1 — инварианты только в `create-unit.ts`
**Что не так:** SCOPED без profile / GLOBAL без authority — только app-layer create. Нет update/import/raw SQL/admin. Status default `DRAFT`, но путь ACTIVE не специфицирован.  
**Почему:** ровно как сейчас: кто-то `db push`/скрипт/telegram — и UNCLASSIFIED/SCOPED-пустышки в поиске.  
**Как:** единый write API; запрет прямого prisma из routes; transition ACTIVE только через review; ideally DB constraint/trigger.

### Параллельные подагенты на один файл
**Что не так:** 0.1 и 0.2 оба правят `enhanced-answering-engine.ts`; 0.2 и 2.x — schema.  
**Почему:** merge hell, потерянные фильтры.  
**Как:** DAG: `0.3 → 0.2 → 0.1` (или 0.1∥0.4∥0.5 после baseline); schema-задачи строго serial.

### 0.5 fail-fast на «старте процесса»
**Что не так:** смешаны «при старте» и «в callAnthropic». Нет `ANTHROPIC_MODEL` в CI/build/playwright → падение импорта.  
**Как:** fail только если provider=anthropic и нет model **в момент вызова**; health-check отдельно; не ломать `next build`.

### 1.2 — факт-ошибка предпосылки
**Что не так:** «удалить тестовые QAPair аудита». Claude-аудит: test QA **не создавал**. Codex: 20 TESTBENCH → DEPRECATED.  
**Почему:** зря трогают прод; ложное чувство «почистили».  
**Как:** inventory SQL по маркерам → delete только confirmed; не как обязательный этап «сегодняшнего аудита».

### 1.1 — scope размыт
**Что не так:** `recordHeldAnswer` пишет `params.question` as-is. Кракозябры, скорее, **выше** (Telegram/source), не в create.  
**Почему:** «починить held-answers.ts» не найдёт бага; потратите цикл.  
**Как:** сравнить raw webhook payload vs DB; проверить все writers; не гадать про ZWJ/Tailwind (другой класс).

---

## P2 — оценки, полнота, инварианты

### Нет оценок трудоёмкости вообще
План просит ловить нереализм оценок, но **часов/дней нет**. Неявно «задача = один подагент = сессия» — для 0.3 (prod baseline) и 0.2 (5 call-site + migration + capacity) это **неделя риска**, не «bite».  
**Минимум:** 0.3 = 0.5–1d + rollback rehearsal; 0.2 = 1–2d + eval corpus; extract+profile 44 docs = **человеко-недели**, не «этап 2–3 покажет» без design extraction.

### Инвариант 5 недостаточен
«UNCLASSIFIED не в auto-ответе клиенту» — хорошо, но **не** закрывает:
1. empty facets = wildcard;  
2. extract без scope → DRAFT/UNCLASSIFIED, а не ACTIVE;  
3. internal fuzzy canonical → если internal ответ уходит клиенту/в обучение;  
4. SUPERSEDED/validTo в retrieval;  
5. EvidenceChunk без audience (утечка internal в client path v2).

### Нет freeze legacy write path
Пока v2 недели: voice/telegram/admin пишут Rule/QAPair с `scenarioKey=null`. Куча unclassified растёт.  
**Нужно:** новые записи legacy → `requiresReview` / запрет ACTIVE без scenario или explicit global.

### Shadow (этап 7) слишком поздно
Метрики wrong-scope нужны **с этапа 0**, иначе 0.1/0.2 — слепые.

### Этапы 4–8 «потом» — но от них зависит success criteria 0–3
Нет exit criteria: «0–3 done when…». pgvector on + schema empty KnowledgeUnit = зелёный этап и **ноль** пользы клиенту.

### LlmCallLog (PR #52) без privacy review
Полные system/user/raw в проде. Merge «чтобы схема сошлась» тащит PII/retention.  
**Нужно:** redaction/TTL до merge-as-baseline.

### RRF «не трогаем» — ок, но v1 weeks
`selectContextChunks` режет по semanticScore, не по RRF (аудит). Орёл-класс багов живёт недели на cosine. 0.2 должен резать null из **vector path**, не только Rule human-review.

---

## Сводка: обязательные правки плана до Beads

| # | Действие |
|---|----------|
| 1 | Переставить: **0.3 baseline (prod pull) → tooling/tests → 0.1/0.4/0.5 → 0.2** |
| 2 | Переписать 0.2: null **никогда** не wildcard без explicit global; vector path включить |
| 3 | Добавить этап **Extraction/Applicability write-contract** до retrieval v2 |
| 4 | Инвариант: **пустой facet ≠ any**; SCOPED+all-empty запрещён |
| 5 | Ввести vitest (или переписать тесты на реальный runner) |
| 6 | Feature flags + shadow metrics для любых правок v1 hot path |
| 7 | 3.1: column + backfill + index + health; fallback off только после green |
| 8 | Controlled vocabulary до QueryFrame/hard-filter |
| 9 | Serial DAG, не «1 задача = 1 независимый подагент» на schema/engine |
| 10 | Оценки + exit criteria + rollback на 0.2/0.3 |

---

## Что в плане в целом верно (чтобы не казалось «всё плохо»)

Параллельный v2, запрет `db push`, UNCLASSIFIED out of auto-answer, RRF оставить, pgvector как develop-fork, не 1:1 migrate 1967 rules — **направление правильное**. Ломается **операционализация**: порядок миграций, семантика null/empty, write-side extraction, тестовый контур, и prod-регрессии v1 без флагов.

**Рекомендация:** не заводить Beads по текущему тексту. Сначала rev plan на пункты 1–4 и 6; потом второй проход критики на extraction+vocabulary. Иначе v2 повторит v1 под новыми именами таблиц.
