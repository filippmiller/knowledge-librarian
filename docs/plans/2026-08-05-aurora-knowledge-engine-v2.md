# Aurora Knowledge Engine v2 — Implementation Plan (v2 черновика, после ревью)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Каждая задача — отдельный Beads-issue, исполняется отдельным подагентом в отдельной сессии, если явно не помечена как SERIAL-ONLY (см. ниже).
>
> **История документа:** первая версия (`git log -- docs/plans/2026-08-05-aurora-knowledge-engine-v2.md`, если сохранена в git-истории) прошла adversarial-ревью у двух независимых моделей (Grok 4.5, Codex/gpt-5.6-sol, оба `--effort high`). Ревью нашло **39 конкретных дефектов**, включая блокирующие: неправильный порядок миграций, циклическую зависимость между расширением pgvector и колонкой типа vector, невалидные Prisma-связи (упал бы `prisma validate`), отсутствие тестовой инфраструктуры, на которой держится весь план, дыру null-wildcard, оставшуюся во ВТОРОЙ ветке кода (не только в open lookup, который я чинил в PR #53), и опасность мержить PR #52 как есть (тащит PII-логирование без retention). Этот документ — исправленная версия, отражающая критику. Полные тексты ревью: `docs/plans/review-grok-2026-08-05.md`, `docs/plans/review-codex-2026-08-05.md`.

**Goal:** тот же, что в v1 черновика — заменить ядро retrieval/understanding/answering на архитектуру с проверкой применимости ДО поиска, сохранив продукт и данные.

**Что изменилось после ревью (коротко):**
- Порядок: **тесты → security → baseline → EvalCase-корпус → facade → pilot-извлечение → схема → provider-контракт → QueryFrame → hard filter → shadow → canary.** Раньше схема шла раньше пилота — оба ревьюера независимо указали, что это гарантирует переписывание схемы после первого реального документа.
- Никаких оценок в «неделях» без пилота — только диапазон после пилота на 3-5 документах (Codex, находка 38).
- PR #52 (логирование) разделён на две задачи: синхронизация схемы (безопасно) и включение сбора PII (требует retention/redaction ПЕРЕД включением).
- Null-wildcard фикс теперь покрывает обе ветки кода (open lookup И known-scenario), не одну.
- Добавлена задача 0.0 (security) — независимо от того, что я лично проверил находку про credential-like строки и она оказалась ложной тревогой (старый уже отозванный ключ), Codex прав, что это должно быть формальной, проверяемой задачей с чек-листом, а не устным заверением в чате — следующий агент не обязан мне верить на слово.

---

## Инварианты (без изменений с v1, подтверждены ревью)

1. v1 отвечает клиентам без перерыва весь период разработки v2.
2. Практика Орёл/FPM не удаляется, правится её scope.
3. Никакого `prisma db push` на прод — только `migrate deploy`.
4. 1967 Rule / 775 QAPair не переносятся 1:1 — используются как checklist.
5. `reviewStatus=UNCLASSIFIED` никогда не в автоответе клиенту. *(Формулировка уточнена в PR A4: раньше здесь стояло `scopeStatus=UNCLASSIFIED` — одно поле для двух разных вопросов. Truth table §5 развела их: `reviewStatus` — статус ревью unit'а целиком, `scopeStatus[dimension]` — подтверждённая универсальность конкретной оси. Гейт клиентского автоответа проверяет именно `reviewStatus`.)*
6. **(новый, из ревью)** Пустой массив в `ApplicabilityProfile` (`serviceCodes: []` и т.п.) означает «неизвестно», НЕ «любое значение». Wildcard — только явный `scopeStatus[dimension]=GLOBAL` при `reviewStatus=REVIEWED` — что по инварианту truth table §5.1 означает заполненные `reviewedBy` И `reviewedAt`. *(В PR A4 уточнено: раньше здесь требовался только `reviewedBy`.)*
7. **(новый)** Ни один PR, трогающий `enhanced-answering-engine.ts`/`vector-search.ts`/`chat-provider.ts` (hot path v1), не мержится без прогона на EvalCase-корпусе (Задача 0.2) и без feature-флага, позволяющего откатить именно эту правку независимо от остальных.

---

## Этап 0 — Фундамент (SERIAL — один владелец, файлы пересекаются)

### Задача 0.0: Тестовая инфраструктура + починка CI

**Почему первая:** весь план опирается на `npx vitest`, которого нет в проекте (подтверждено: `grep -i vitest package.json` — пусто). Без этого «Step 1: написать падающий тест» невыполним ни для одной задачи ниже.

**Файлы:**
- Modify: `package.json` (добавить vitest, `test`/`typecheck` скрипты)
- Create: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml` — сейчас слушает `main`, репозиторий живёт на `master` (см. `git branch --show-current` в текущей сессии); `pnpm lint || echo ...` маскирует падения — убрать маску.
- Create: `src/lib/ai/__tests__/` (директория)

**Приёмка:**
- `npx vitest run` работает на пустом наборе (0 failed, 0 passed — ОК, инфраструктура жива).
- CI триггерится на push в `master`, падает явно (без `|| echo`) при сломанном lint/test/build.
- `npx prisma validate` — отдельный обязательный шаг CI (находка Codex #18 — без этого невалидная схема пройдёт незамеченной).

---

### Задача 0.1 (SERIAL, зависит от 0.0): Golden regression corpus — EvalCase ДО любых изменений кода

**Почему до кода, не после (Codex, находка 34):** без корпуса, зафиксированного ДО правок, нельзя доказать, что задачи 0.3+ не ухудшили v1 — только «стало непохоже на то, что было».

**Файлы:**
- Create: `src/lib/ai/__tests__/fixtures/eval-corpus.json` (или таблица `EvalCase`, если проще сразу в БД — на усмотрение исполнителя, но зафиксировать выбор)

**Содержимое (минимум, собрать из уже готовых сегодняшних артефактов, не с нуля):**
- Живые wrong-scope случаи из обоих сегодняшних аудитов (`.claude/audits/2026-08-05-full-retrieval-audit-claude.md` вопрос №11, `docs/bot-audit/2026-08-05-full-architecture-audit-codex.md` вопросы №13-14, №16-18).
- Hard negatives («причесать» vs «почесать» — с ПРАВИЛЬНОЙ методологией: реальный вызов `questionTermOverlapForTests` на живых вопросах, не алгебра — см. разбор в сводном отчёте кросс-ревью аудитов).
- Отрицания, недостающие условия, известные корректные ответы v1 (не только баги — нужен baseline «что не должно сломаться»).
- Client/internal leakage кейсы.

**Приёмка:** скрипт `scripts/run-eval-corpus.ts`, гоняющий весь корпус через `answerQuestionEnhanced` (read-only, `railway run`) и печатающий pass/fail по каждому кейсу + агрегат (wrong-scope rate, hold rate, и т.д.). Запускается вручную после каждой задачи 0.3+ — не автоматизируется в CI на этом этапе (требует прод-БД).

---

### Задача 0.2 (SERIAL, зависит от 0.1): Security — закрыть credential-like находку формально

**Контекст:** Codex независимо (в исходном полном аудите) нашёл строки, похожие на API-ключи, в `SESSION_NOTES.md`/`SESSION_2026-01-20_...md`. Я лично проверил: это описание уже закрытого январского инцидента (ключ был случайно закоммичен, GitHub secret scanning поймал, OpenAI автоматически отозвал, в файлах — только обрезанные значения, полного ключа нет нигде в истории git). Но по правилу «не полагаться на устное заверение одного агента» — формализовать проверку.

**Шаги:**
1. `git log --all -p -S"sk-proj-" -- '*.md'` и аналогично для `sk-svcacct-` — подтвердить (или опровергнуть) отсутствие полного значения в истории. (Уже выполнено сегодня в этой сессии — исполнитель следующей сессии обязан перепроверить сам, не копировать вывод из чата.)
2. Если подтверждено — закрыть находку письменно в этом же файле плана (добавить секцию "Security review: closed, see commit <hash> or session log").
3. Включить secret scanning в CI (GitHub secret scanning — уже, по логам сессии, включён на уровне организации; проверить `gh api repos/filippmiller/knowledge-librarian/vulnerability-alerts` или аналог).

**Security review: closed.** Независимая перепроверка следующим исполнителем (не копируя вывод из чата, Beads translation-q1s), 2026-08-05:

1. `git log --all --oneline -S"sk-proj-"`, `-S"sk-svcacct-"`, `-S"sk-ant-"` (без ограничения путём `*.md` — по всей истории, всем типам файлов) нашли только commits `c8d7b3d`, `98ba615`, `7bf4fa5` (и `d4901ea` для `sk-ant-`, где строка — не ключ, а название паттерна в тексте security-аудита). Во всех найденных диффах значение присутствует ТОЛЬКО в обрезанном виде: `` sk-proj-uckSc_X6-... `` и `` sk-svcacct-... `` — полного ключа нигде нет.
2. Точечная проверка видимого фрагмента `git log --all -p -S"uckSc_X6"` — единственное вхождение то же самое обрезанное `sk-proj-uckSc_X6-...`, более длинной/полной формы нигде не всплывает.
3. `gh api repos/filippmiller/knowledge-librarian --jq '.security_and_analysis'` подтверждает `secret_scanning: enabled` и `secret_scanning_push_protection: enabled` на уровне репозитория (не только организации).
4. Не проверялись индивидуально dangling/unreachable объекты (`git fsck --unreachable` вернул несколько десятков) — непропорционально задаче: это обычный мусор git-истории (rebase/amend), а не то, что когда-либо было запушено и потенциально видно GitHub secret scanning, который и поймал исходный инцидент.

**Вердикт: находка ложноположительная относительно риска — в истории git нет ни одного полного значения ключа, только заведомо обрезанные строки в документации инцидента. Secret scanning + push protection включены. Закрывающий коммит: см. Beads translation-q1s.**

---

### Задача 0.3 (SERIAL, зависит от 0.0-0.2): Prisma baseline — от РЕАЛЬНОЙ БД, не от git-схемы

**Почему не так, как в v1 плана (Grok+Codex сошлись):** локальный `schema.prisma` на момент старта НЕ содержит `LlmCallLog` (она только в PR #52) и не содержит колонку `embeddingVector` (код пишет в неё raw SQL, но в Prisma-схеме её нет). Baseline, снятый с git-схемы, а не с прода, зафиксирует ложь.

**Шаги:**
1. `railway run npx prisma db pull --print` — получить схему РЕАЛЬНОЙ прод-БД целиком.
2. Сравнить с текущим `prisma/schema.prisma` — вручную выписать ВСЕ расхождения (не только LlmCallLog — искать по всему выводу).
3. Обновить `prisma/schema.prisma`, чтобы он **точно** соответствовал прод-БД (включая `embeddingVector` как `Unsupported("vector(1536)")`, если колонка физически существует — проверить `information_schema.columns`).
4. `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma` → сгенерировать SQL, вручную проверить (не слепо доверять).
5. Развернуть этот SQL с нуля во ВРЕМЕННОЙ БД (не проде) — подтвердить, что результат идентичен прод-снимку.
6. Только после этого: `prisma migrate resolve --applied <baseline>` на реальном проде (с backup перед этим шагом — `railway run` бэкап или Railway snapshot).
7. `prisma migrate status` на проде показывает "up to date".

**Явно НЕ входит в эту задачу:** включение записи PII в LlmCallLog (см. Задачу 0.3b) — это отдельное решение.

---

### Задача 0.3b (SERIAL, зависит от 0.3): PR #52 — instrumentation отдельно от schema

**Контекст (Codex, находка 4):** PR #52 несёт не только модель `LlmCallLog`, но и живую запись полных system/user prompt + raw response — потенциально с PII клиентов и содержимым документов, без retention policy, без redaction, без access control.

**Шаги:**
1. Схема `LlmCallLog` уже в baseline (Задача 0.3) — код инструментации мержить ОТДЕЛЬНО.
2. Добавить TTL (retention) — например cron/scheduled job, удаляющий записи старше N дней (`scripts/cleanup-llm-log.ts` уже существует в репозитории — проверить/доработать под реальную policy).
3. Redaction — оценить, нужно ли маскировать PII (номера документов, ФИО) в `userMessage`/`rawResponse` перед записью, или ограничить доступ к таблице на уровне БД-прав.
4. Только после 1-3 — мержить `feat/llm-call-logging` (или его актуальную версию).

---

### Задача 0.4 (может параллелиться с 0.3b — разные файлы): Timeout на LLM-вызовы, исправленная версия

**Что изменилось после ревью:** единый end-to-end deadline (25-40с), не per-attempt, чтобы 4 попытки × 45с не давали 180с итого. Тест — с моком, который реально подписывается на `AbortSignal.abort`, не «promise, который никогда не резолвится» (такой мок не реагирует на abort вообще — находка Codex #29).

**Файлы:** `src/lib/ai/chat-provider.ts`

```typescript
const LLM_DEADLINE_MS = Number(process.env.LLM_DEADLINE_MS || 30000); // ОБЩИЙ бюджет на всю цепочку retry+fallback одного вызова

async function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
```

Тест:
```typescript
test('aborts when deadline exceeded', async () => {
  let capturedSignal: AbortSignal;
  global.fetch = vi.fn((url, opts) => {
    capturedSignal = opts.signal;
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
  vi.useFakeTimers();
  const promise = withDeadline((signal) => fetch('...', { signal }), 5000);
  vi.advanceTimersByTime(5000);
  await expect(promise).rejects.toThrow(/abort/i);
});
```

---

### Задача 0.5 (может параллелиться): Fail-fast на модель — исправленная версия

**Что изменилось:** проверка не «при первом вызове» (проявится на клиентском запросе), а на старте процесса/readiness-проверке. `anthropicModel` и `openaiModel` — раздельные переменные, fallback не переиспользует `options.model` одного провайдера для другого (находка Codex #30).

---

### Задача 0.6 (SERIAL с 0.7 — тот же файл `enhanced-answering-engine.ts`): Null-wildcard — ОБЕ ветки

**Что изменилось (главная поправка после ревью):** PR #53 (сегодня) закрыл только open-lookup ветку. Строка `enhanced-answering-engine.ts:1059-1061` — ветка ИЗВЕСТНОГО сценария — всё ещё `OR: [{scenarioKey: null}, {scenarioKey: {in: ancestors}}]`, то есть null остаётся безусловным wildcard даже когда сценарий распознан. Это и есть найденная Grok дыра (задача #30 в трекере сессии).

**Шаги:**
1. Ввести временное поле `isExplicitlyGlobal` (не полноценный `ApplicabilityProfile` — это будет в Этапе 2) — булево на Rule/QAPair/DocChunk.
2. **Единая, непротиворечивая политика** (Grok указал на внутреннее противоречие в v1 плана — «не участвует в поиске вообще» vs «участвует, но requiresHumanReview» одновременно):
   - **confidence-top pool** (`byConfidence`/`qaRecent`/vector-path top-by-score): null+!global — **исключить полностью**, в обеих ветках (known-scenario И open-lookup).
   - **keyword-match pool** (термин реально встречается в тексте): null+!global — **допустить**, но результат принудительно получает `requiresHumanReview=true`.
3. Dry-run на EvalCase-корпусе (Задача 0.1) ДО включения в проде — измерить, сколько ответов уйдёт в hold. При ~79% Rule и ~90% DocChunk с null (по аудиту) — риск реального взлёта hold-rate, который завалит операторов (находка Grok по 0.2 v1-плана). Если hold-rate неприемлемо высокий — сначала allowlist явно-глобальных правил (например «мы не работаем по праздникам»), потом enforcement.
4. Feature flag `SCOPE_NULL_STRICT=true|false`, дефолт `false` до успешного dry-run.

---

### Задача 0.7 (SERIAL с 0.6): Canonical override для client — отключить fuzzy полностью, не просто ужесточить

**Что изменилось:** exact-match вместо fuzzy (как было в v1 плана) не решает главный класс wrong-scope ошибок — точный текст вопроса не доказывает, что ответ применим (пара могла быть записана для другого города/услуги, но с тем же текстом вопроса случайно). Оба ревьюера сошлись: безопаснее полностью отключить canonical override для `audience=client` до появления в v2 полноценной scope-проверки, оставить только `audience=internal` (сотрудник видит источник и сам оценивает).

**Тест:** production-проверка через `diagnose-answer.ts` должна явно передавать `--audience client` (сейчас скрипт жёстко использует `internal` на строке 69 — находка Codex #10, менять сам скрипт, не полагаться на дефолт) и работать в sandbox-режиме без побочных записей в HallucinationLog/LlmCallLog.

---

### Задача 0.8: HeldAnswer mojibake — исправленная методология

**Что изменилось:** не сразу чинить `held-answers.ts` (недоказанная гипотеза — Codex #31). Сначала: сравнить байты `HeldAnswer.question` с соответствующим `ChatMessage.content` (тот же вопрос от того же пользователя, если он логируется отдельно) для одной и той же сессии/времени — это покажет, порча происходит ДО записи в `HeldAnswer` (например на приёме из Telegram) или ВО ВРЕМЯ (в самом `recordHeldAnswer`). Чинить нужно место реальной порчи, не первое подозрительное.

---

### Задача 0.9: Физическая очистка тестовых данных — с манифестом

**Что изменилось:** предположение "QAPair с evalCaseId" неверно для LlmCallLog (там нет такого поля — находка Codex #32). Составить точный manifest ID по каждой таблице отдельно, экспортировать перед удалением, удалять транзакционно с проверкой количества до/после.

---

## Этап 1 — Facade (SERIAL, блокирует всё, что зависит от переключения v1/v2)

### Задача 1.1: Единый `answerQuestion()` facade

**Почему нужен раньше shadow mode (Codex, находка 35):** `ANSWER_ENGINE_VERSION` бесполезен, пока API/Telegram/mini-app/callbacks вызывают `answerQuestionEnhanced` напрямую в разных местах. Нужен один вход, за которым уже прячется выбор v1/shadow/v2.

**Шаги:** найти все call sites `answerQuestionEnhanced(` (grep по `src/`), завести `src/lib/ai/answer-question.ts` с единым контрактом результата, перевести все call sites на него в режиме `v1` (чистый passthrough, поведение не меняется). Это отдельный, изолированный рефакторинг — можно и нужно делать параллельно с Этапом 0 (не пересекается по файлам с retrieval-логикой).

---

## Этап 2 — Пилот извлечения (НЕ полная схема сразу)

### Задача 2.1: Truth table для ApplicabilityProfile — до Prisma-схемы

Зафиксировать на бумаге (markdown-таблица в этом же docs/plans/ файле или отдельном): для пары (профиль, запрос) — что даёт `MATCH`, что `CONFLICT`, что `UNKNOWN`; пустой список поля = `UNKNOWN`, не `ANY`; обязательные поля по типу знания (например `DELIVERY_RULE` обязан иметь `deliveryCityCodes`, иначе создание запрещено).

**Готово:** `docs/plans/2026-08-05-applicability-truth-table.md` — truth table по измерениям (scenario/audience/geography/conditionType/numericConstraint), обязательные поля по типу знания, обоснована живым прогоном `scripts/test-extraction-pack.ts` на тестовом пакете `semantic_rule_extraction_test_pack.zip` (10 правил документа → 44 извлечённые атомарные строки без структурного поля условия — конкретное эмпирическое подтверждение проблемы, не гипотеза).

### Задача 2.2: Concept/ConceptAlias — контролируемый словарь, до QueryFrame

Без него `serviceCodes: string[]` в профиле и в QueryFrame почти гарантированно не совпадут («апостиль» vs `apostille` vs `apostille.zags`) — hard filter даст 0 результатов везде вместо утечки не туда (тот же класс проблемы, другой полюс).

### Задача 2.3: Пилот — вручную разметить 3-5 документов, включая документ про Орёл/FPM

**Это единственный источник реальной оценки трудоёмкости остальных 39-41 документов** (Codex, находка 33/38) — до пилота никакие "недели" не подтверждены цифрами. Измерить: units/страница, доля UNCLASSIFIED, минуты ревьюера на unit, disagreement rate (если ревьюеров двое), покрытие legacy-чеклиста (сколько из существующих Rule/QAPair по этой теме нашли соответствие в новом извлечении).

### Задача 2.4 (SERIAL, зависит от 2.1-2.3): Финальная Prisma-схема v2 — с исправлениями находок Codex #17-22

- Реальные `@relation` с FK, не строки-указатели без связи.
- `contentHash` — `@unique` в рамках (content, applicability, audience, sourceRevision), не голый текстовый дедуп.
- `EvidenceChunk.section` — обратное поле `DocumentSectionV2.chunks` (иначе `prisma validate` падает).
- `KnowledgeEvidence(unitId, chunkId, relation: SUPPORTS|CONTRADICTS, sourceSpan)` — явная связь между утверждением и доказательством, не дублирующийся `EVIDENCE_CHUNK` kind без связи.
- Immutable `SourceRevision`/`ExtractionRun` — секции/чанки/units ссылаются на конкретную ревизию, не на изменяемый `Document`.
- `AnswerVariant(unitId, audience, text, status, reviewedBy)` отдельно от `KnowledgeUnit` — не `answerClient`/`answerInternal` как два необязательных поля на одной записи (закрывает и находку про polish без audience, и находку Codex #22).

---

## Этап 3 — pgvector (порядок исправлен: extension раньше колонки)

### Задача 3.1 (независима от 2.4, обязательна ДО 3.2): `CREATE EXTENSION vector`

Только расширение, без миграции колонки. Проверить доступность на текущем Railway-тарифе — если недоступно, это блокер-развилка для эскалации владельцу ДО того, как Задача 3.2 попытается создать колонку типа `vector`.

**Порядок относительно 2.4 намеренно не задан.** У relational-части Задачи 2.4 (`KnowledgeUnit`, `KnowledgeEvidence`, `AnswerVariant`, `SourceRevision` и т.д.) зависимости от pgvector нет вообще — она появляется только у Задачи 3.2, которая и так объявлена зависящей от обеих (3.1 и 2.4). Прежний заголовок «(ПЕРЕД 2.4, не после)» буквально противоречил разделу «Исправленный критический путь» ниже; исправлен заголовок, критический путь оставлен без изменений.

### Задача 3.2 (зависит от 3.1 и 2.4): Колонка + backfill + индекс — раздельные подзадачи

Column → resumable idempotent backfill 228+ существующих embeddings → HNSW/IVFFlat индекс → `EXPLAIN ANALYZE` на реальных запросах → только после зелёного health переключать v2 на строгий fail-loud (никакого тихого in-memory fallback — но **только для v2**; v1 сохраняет свой текущий fallback без изменений, иначе временный сбой pgvector после этой правки остановит живой прод — находка Codex #24).

---

## Этап 4+ — не детализируется до результатов пилота (2.3) и провайдер-контракта

Provider-capability adapter (typed `structured<T>()` для Anthropic tool-use и OpenAI Structured Outputs с contract-тестами) — отдельная задача ПЕРЕД QueryFrame, не после (находка Codex #26 — это не «новый файл query-frame.ts», это переработка provider layer). QueryFrame, hard-filter retrieval, reranker, conflict governance, shadow mode с ресурсными лимитами (sampling, concurrency limiter, cost ceiling — находка Codex #36), release gates с числами (находка Codex #37) — детальные планы пишутся отдельными документами `docs/plans/2026-XX-XX-aurora-v2-<phase>.md`, когда до них дойдёт очередь и появятся цифры из пилота.

---

## Исправленный критический путь (из ревью Codex, принят как есть)

```
security review (0.2) → test/CI foundation (0.0) → EvalCase baseline (0.1)
  → schema inventory + Prisma baseline (0.3) → PII hardening (0.3b)
  → facade (1.1) → controlled vocab + truth table (2.1-2.2)
  → 3-5 document pilot (2.3) → schema correction (2.4)
  → pgvector extension (3.1) → column/backfill/index (3.2)
  → provider structured contract → QueryFrame → hard-filter retrieval
  → shadow isolation → measured canary
```

Задачи 0.4-0.9 (timeout, fail-fast, null-wildcard, canonical, mojibake, cleanup) — safety-патчи на v1, идут ПАРАЛЛЕЛЬНО с основным путём, но каждая — под своим feature-флагом, с dry-run на EvalCase-корпусе до включения в проде.
