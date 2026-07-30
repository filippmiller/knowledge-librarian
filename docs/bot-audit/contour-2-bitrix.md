# Контур №2 — «Bitrix-бот»: технический аудит

**Дата:** 2026-07-30
**Ревизия репозитория:** `89e0af5` (master), `C:\dev\translation`
**Режим:** read-only. Ничего в коде не менялось.

---

## Резюме (10 строк)

1. **Продового контура «сообщение из Bitrix → ответ → отправка обратно в Bitrix» НЕ существует.** В `src/app/api/**` нет ни одного роута, принимающего вебхук от Bitrix24, и ни одного вызова Bitrix REST из рантайма приложения.
2. Единственный код, который вообще ходит в Bitrix, — это **офлайн-скрипты** `scripts/email-mining/*.mjs` и `scripts/create-bitrix-task.mjs`, запускаемые вручную с локальной машины (`node scripts/...`).
3. Связь с Bitrix — **исходящая (inbound webhook Bitrix'а, мы дёргаем их API)**, а не входящая. Обратного канала (`ONCRMACTIVITYADD`, очередь, cron) нет: `railway.toml` содержит только healthcheck, cron/queue в проекте отсутствуют.
4. То, что называется «контуром №2», фактически = **три отдельные вещи**: (а) офлайн-майнинг знаний из переписки Bitrix, (б) админ-инструмент `/admin/bot-lab` («Bot Decision Lab»), (в) обучающий цикл canonical Q&A внутри общего движка.
5. `/admin/bot-lab` — **ручная песочница оператора**. Она грузит 180 обезличенных кейсов из **статического файла** `docs/email-bot/may2026-knowledge-base-final.json`, а не из БД и не из Bitrix. В UI это прямо написано: бейдж «Никаких отправок в Bitrix» (`src/app/admin/bot-lab/page.tsx:437`).
6. **Отдельного пайплайна генерации ответа у контура №2 нет.** Bot Lab бьёт в тот же `POST /api/ask` → `answerQuestionEnhanced()`, что и веб-плейграунд (`src/app/admin/bot-lab/page.tsx:331`).
7. Единственное, что Bot Lab добавляет своего, — **UI-эвристика решения** (`deriveDecision`, `page.tsx:125-193`), помеченная в интерфейсе бейджем `UI-DERIVED`. Движок такого решения не возвращает; в Telegram она не применяется.
8. Реальный продовый эффект от контура №2 идёт **через общий движок**: кнопки Bot Lab пишут `QAPair` с `metadata.authorityTag = VOICE_ANSWER_AUTHORITY | HISTORICAL_ANSWER_AUTHORITY`, а движок для таких пар делает **canonical-override** (`enhanced-answering-engine.ts:424-500`). То есть обучение из Bot Lab влияет на **контур №1 (Telegram)**, а не на несуществующий Bitrix-бот.
9. Данные Bitrix в БД **не затянуты вообще**: в `prisma/schema.prisma` нет ни одной таблицы под звонки/сделки/переписку/таймлайн. Артефакты майнинга лежат файлами в `docs/email-bot/`, промежуточные — в gitignored `scratchpad/`.
10. Импортёра 180 правил в БД тоже нет — они читаются только Bot Lab'ом. Шаги 4–7 из собственного дизайн-документа (`docs/plans/2026-06-04-email-bot-training-design.md:74-75`) не реализованы.

---

## 1. Инвентарь кода, роутов и таблиц

### 1.1 Рантайм приложения (Next.js) — то, что живёт в проде

| Путь | Что это | Bitrix-связь |
|---|---|---|
| `src/app/admin/bot-lab/page.tsx` (621 стр.) | UI «Bot Decision Lab» | только название и статический датасет |
| `src/app/api/admin/bot-lab/cases/route.ts` | `GET` — отдаёт датасет кейсов | нет |
| `src/app/api/admin/bot-lab/historical-answers/route.ts` | `POST` — исторический ответ → `QAPair` | нет |
| `src/app/api/admin/bot-lab/knowledge-candidates/route.ts` | `POST` — правка оператора → `AIQuestion` (очередь) | нет |
| `src/app/api/admin/bot-lab/voice-answers/route.ts` | `POST` / `PUT` — надиктованный ответ → `QAPair` | нет |
| `src/lib/bot-lab/cases.ts` | загрузка датасета **из JSON-файла** | нет |
| `src/components/bot-lab/voice-answer-capture.tsx` (257) | запись голоса → полировка → сохранение | нет |
| `src/components/bot-lab/voice-rule-capture.tsx` (301) | запись голоса → извлечение правил → публикация | нет |
| `src/app/admin/voice-training/page.tsx` (328) | «Voice Rule Studio» (отдельная страница) | нет |
| `src/app/api/admin/voice-training/transcribe/route.ts` | Whisper/`gpt-4o-mini-transcribe` | нет |
| `src/app/api/admin/voice-training/extract/route.ts` | LLM-извлечение правил из расшифровки | нет |
| `src/app/api/admin/voice-training/approve/route.ts` | публикация правил в `Rule` с `VOICE_AUTHORITY` | нет |
| `src/lib/ai/voice-answer-polisher.ts` | LLM-полировка надиктованного ответа | нет |
| `src/lib/ai/voice-rule-extractor.ts` | LLM-извлечение `VoiceRuleCandidate[]` | нет |
| `src/lib/ai/canonical-answer-polisher.ts` | LLM-полировка канонического ответа перед выдачей | нет |
| `src/lib/ai/enhanced-answering-engine.ts:374-500` | authority-бусты + canonical-override | нет |

**Полный список API-роутов проекта** (`src/app/api/**`, 41 файл) не содержит ничего вида `bitrix`, `crm`, `openlines`, `webhook/bitrix`. Единственный входящий вебхук в системе — телеграмный: `src/app/api/telegram/route.ts:17` (`TELEGRAM_WEBHOOK_SECRET`).

### 1.2 Офлайн-скрипты (запускаются руками, не деплоятся)

| Скрипт | Функция | Bitrix-метод |
|---|---|---|
| `scripts/email-mining/pilot.mjs` (125) | пилот: пары «вопрос→ответ» из писем | `crm.activity.list` |
| `scripts/email-mining/build-threads.mjs` (68) | треды писем по Deal/Lead | `crm.activity.list`, `TYPE_ID=4` |
| `scripts/email-mining/build-chats.mjs` (81) | транскрипты открытых линий (TG/WA/VK/Avito) | `imopenlines.session.history.get` |
| `scripts/email-mining/read-threads.mjs` | чтение/очистка тредов | `crm.*` |
| `scripts/email-mining/extract-knowledge.mjs` (139) | извлечение знаний из полного треда, `EXTRACT_MODEL` по умолчанию `gpt-4o` | `crm.activity.list` |
| `scripts/email-mining/classify.mjs` (88) | классификация пар, `gpt-4o-mini` | — |
| `scripts/email-mining/aggregate.mjs` (24) | сведение + **прайс-каталог** | `crm.product.list` |
| `scripts/email-mining/assemble-final.mjs` (48) | сборка финального MD/JSON | — |
| `scripts/email-mining/probe-{sources,channels,chat-text,openlines}.mjs` | разведка API портала | `im.recent.get`, `crm.activity.list` |
| `scripts/create-bitrix-task.mjs` (45) | создать задачу в Bitrix (утилита разработчика) | `tasks.task.add` |

Все они читают `process.env.BITRIX24_WEBHOOK_URL` и пишут результат **в файлы** (`scratchpad/…`, затем вручную скопировано в `docs/email-bot/`). Ни один не пишет в Postgres.

### 1.3 Артефакты данных

| Файл | Содержимое |
|---|---|
| `docs/email-bot/may2026-knowledge-base-final.json` | **180 канонических правил** (проверено: `capability 56, process 47, policy 29, requirement 22, pricing_policy 15, location 11`; `price_dependent = 56`) |
| `docs/email-bot/may2026-knowledge-base-final.md` / `-readable.md` | человекочитаемые версии для ревью |
| `docs/email-bot/may2026-deals-only-deduped.md` | промежуточный срез |
| `docs/email-bot/price-catalog.json` | 28 услуг с ценами из `crm.product.list` |
| `docs/email-bot/EXTRACT_RULES.md` | промпт/правила для субагентов-экстракторов |
| `docs/plans/2026-06-04-email-bot-training-design.md` | утверждённый дизайн (112 стр.) |
| `.claude/handoffs/2026-06-04-210028.md` | хендофф с фактическим статусом |

### 1.4 Таблицы БД

**Bitrix-специфичных таблиц нет.** В `prisma/schema.prisma` (818 строк, 30 моделей) нет `BitrixDeal`, `BitrixActivity`, `Call`, `CrmMessage` и т.п. Контур №2 переиспользует общие таблицы:

| Таблица | Как используется контуром №2 |
|---|---|
| `QAPair` (`prisma/schema.prisma:191-219`) | канонические Q&A из Bot Lab; отличаются полем `metadata` (`authorityTag`, `origin`, `evalCaseId`) |
| `Rule` | правила из Voice Rule Studio; маркер в `sourceSpan.authorityTag = 'VOICE_AUTHORITY'` |
| `AIQuestion` | очередь кандидатов знаний (`issueType='knowledge_gap'`, `context.source='BOT_DECISION_LAB'`) |
| `KnowledgeChange` | аудит всех публикаций из Bot Lab / Voice Studio |
| `AISettings` (`prisma/schema.prisma:503-520`) | тумблер автоответа — **используется только Telegram-контуром** |
| `AnswerFeedback` | оценки оператора из Bot Lab (`page.tsx:351`) |

`QAPair.metadata` — свободный JSON, схема его не типизирует (комментарий `prisma/schema.prisma:205-206`), поэтому `authorityTag` держится только соглашением в коде.

---

## 2. Что работает / что заготовка

### 2.1 ❌ Продовый путь «Bitrix → ответ → Bitrix» — НЕ СУЩЕСТВУЕТ

Это главный вывод. Доказательства:

- **Нет входящего вебхука.** Полный листинг `src/app/api/**` — 41 роут, ни одного `bitrix`. Grep по `src/` на `crm\.|imopenlines|ONCRM|openlines|activity\.list|tasks\.task` даёт **ноль совпадений** — все хиты только в `scripts/`.
- **Нет исходящей отправки в Bitrix.** Тот же grep. Единственный write-вызов в Bitrix во всём репозитории — `scripts/create-bitrix-task.mjs:19` (`tasks.task.add`), и это утилита для создания задач разработчику, не ответ клиенту.
- **Нет cron/очереди.** `railway.toml` содержит только `[build]` и `[deploy] healthcheckPath="/"`. В `package.json` нет worker-скрипта. Grep по `cron|Queue|node-cron` в `src/` даёт только `setInterval` для SSE-heartbeat (`process-stream/route.ts:240`) и очистки rate-limiter (`rate-limiter.ts:36`).
- **Признание в самом UI:** `src/app/admin/bot-lab/page.tsx:437` — бейдж `Никаких отправок в Bitrix`; `page.tsx:189` — «Auto-send в песочнице отключён».
- **Признание в дизайн-документе:** `docs/plans/2026-06-04-email-bot-training-design.md:109-110` — «Exact Bitrix write-back method for the draft» и «Trigger for new incoming email (`ONCRMACTIVITYADD` vs polling)» перечислены как **открытые вопросы, требующие решения при планировании**. Шаг 7 архитектуры (`:46-53`, «EMAIL-ANSWER LAYER») — не реализован.
- **Признание в хендоффе:** `.claude/handoffs/2026-06-04-210028.md:134` — пункт 6 «Email/chat answer layer» в разделе **REMAINING WORK**.

### 2.2 ✅ Работает: офлайн-майнинг знаний из Bitrix (ручной запуск)

- Скрипты рабочие и уже отработали один прогон: май 2026, 1275 писем сделок + 1376 писем лидов + 130 чатов → 406 сырых пунктов → 180 канонических правил (`.claude/handoffs/2026-06-04-210028.md:57`).
- Экстракция выполнялась **не программно, а Claude-субагентами** по `docs/email-bot/EXTRACT_RULES.md` (`handoffs:52`), то есть шаг пайплайна не воспроизводится одной командой.
- Результат лежит **файлами**, в БД не залит. Импортёра нет: grep по `may2026-knowledge-base-final` во всём репозитории даёт единственную ссылку из рантайма — `src/lib/bot-lab/cases.ts:1`.

### 2.3 ✅ Работает: ручной инструмент оператора `/admin/bot-lab`

Полный контур страницы:

1. `GET /api/admin/bot-lab/cases` (`route.ts:5-20`, только admin-auth) → `botLabCases` из статического JSON (`src/lib/bot-lab/cases.ts:15-18`, id вида `bitrix-may-2026-001`).
2. Оператор выбирает кейс → в textarea подставляется вопрос (`page.tsx:296-310`).
3. «Запустить бота» → `POST /api/ask` с `includeDebug: true` (`page.tsx:331-335`). **Это ровно тот же публичный эндпоинт, что и веб-плейграунд.**
4. Слева показывается «Исторический ответ сотрудника» (из JSON), справа — ответ движка. Эталон в движок **не передаётся** (`page.tsx:540`).
5. Кнопки записи результата:
   - «Сделать эталонным ответом» → `POST /api/admin/bot-lab/historical-answers` → `QAPair` c `metadata.authorityTag='HISTORICAL_ANSWER_AUTHORITY'`, `confidence: 1.0`, старая активная пара переводится в `SUPERSEDED` (`route.ts:39-102`).
   - «Отправить на проверку» (правка оператора) → `POST /api/admin/bot-lab/knowledge-candidates` → `AIQuestion(issueType='knowledge_gap', status='OPEN')` с дедупом по `evalCaseId`/нормализованному вопросу (`route.ts:40-70`). В KB попадает **только после отдельного утверждения** в `/admin/ai-questions`.
   - `VoiceAnswerCapture` → `POST /api/admin/bot-lab/voice-answers` → `QAPair` c `VOICE_ANSWER_AUTHORITY` (`route.ts:63-128`).
   - `VoiceRuleCapture` → `POST /api/admin/voice-training/approve` → `Rule` c `sourceSpan.authorityTag='VOICE_AUTHORITY'`, `operatorApproved: true`, `origin: 'BOT_DECISION_LAB'` (`route.ts:88-120`).
   - Оценка → `POST /api/feedback` (`page.tsx:351`).

Все мутирующие роуты требуют `role === 'ADMIN'` (`historical-answers/route.ts:9`, `knowledge-candidates/route.ts:14`, `voice-answers/route.ts:15`, `voice-training/approve/route.ts:38`).

### 2.4 ⚠️ Полу-заготовка: «решение» в Bot Lab считается в браузере

`deriveDecision()` (`page.tsx:125-193`) выдаёт коды `NOT_RUN / REVIEW_REQUIRED / LIVE_DATA_REQUIRED / CLARIFY / ESCALATE / DRAFT_WITH_WARNING / DRAFT_READY`. Это **клиентская эвристика поверх ответа `/api/ask`**, а не решение движка — UI сам это признаёт бейджем `UI-DERIVED` (`page.tsx:574`) и меткой `UI` на шаге «Final action» (`page.tsx:599`, `:603`).

Практическое следствие: пороги Bot Lab (`<0.5` → escalate, `<0.7` → draft-with-warning, `page.tsx:168`, `:177`) **не совпадают** с продовой политикой Telegram и нигде не переиспользуются. Это дублирование политики в обход `src/lib/telegram/auto-answer-policy.ts`.

### 2.5 ❌ Заготовки, не начатые

- **Прайс-каталог как источник истины.** Дизайн (`design:103`) и хендофф (`handoffs:133`, п.5) требуют отвечать на ценовые вопросы из `crm.product.list`. В `src/` нет ни одного обращения к каталогу; `docs/email-bot/price-catalog.json` рантаймом не читается. Признак «нужен живой расчёт» существует только как флаг `price_dependent` в JSON-датасете и лампочка в UI (`page.tsx:150-158`).
- **Eval-харнесс на 200 hold-out пар** (`design:66`, `handoffs:135` п.7) — нет. Существующий `scripts/eval/cases.json` — это 19 кейсов по апостилю, к Bitrix-датасету отношения не имеет.
- **Прогон майнинга за остальные месяцы 2026** (`handoffs:130`) — не выполнен, есть только май.
- **Кросс-категорийный второй дедуп** (`handoffs:132`) — не выполнен.

---

## 3. Путь генерации ответа

### 3.1 Собственного пайплайна нет

Bot Lab использует **тот же движок**, что и Telegram-бот, веб-плейграунд и мини-апп:

```
/admin/bot-lab (page.tsx:331)
   └─> POST /api/ask (src/app/api/ask/route.ts:18)
         ├─ rate-limit (route.ts:20-39)
         ├─ getOrCreateSession('API') (route.ts:81)
         ├─ кеш пропускается, т.к. includeDebug=true (route.ts:91)
         └─> answerQuestionEnhanced(question, sessionId, true)
              (src/lib/ai/enhanced-answering-engine.ts:504)
```

Отдельных промптов, отдельной модели, отдельного retrieval у контура №2 нет. Единственные «свои» LLM-вызовы — вспомогательные, на этапе **записи** знания, а не выдачи ответа: `voice-answer-polisher.ts`, `voice-rule-extractor.ts`, `canonical-answer-polisher.ts`.

### 3.2 Как связаны исторические ответы / canonical Q&A / VOICE_ANSWER_AUTHORITY

Это **общий для обоих контуров** механизм внутри движка. Пошагово:

1. **Запись.** Bot Lab создаёт `QAPair` с `metadata.authorityTag` = `VOICE_ANSWER_AUTHORITY` (`voice-answers/route.ts:91`) или `HISTORICAL_ANSWER_AUTHORITY` (`historical-answers/route.ts:66`), `confidence: 1.0`, `approvedBy: web:<username>`.

2. **Распознавание авторитета.** `getQaAuthority()` (`enhanced-answering-engine.ts:383-393`) возвращает `boost: 30` для обоих тегов (и для `origin: 'voice-operator' | 'historical-operator'`). Аналогично `getVoiceAuthority()` (`:374-381`) для правил: `PRIMARY → +40`, `HIGH → +20`, иначе `+8`.

3. **Canonical override (главная развилка).** `findCanonicalQaOverride()` (`:424-447`):
   - берёт до 200 последних `QAPair` со `status='ACTIVE'` (`:426-430`);
   - оставляет только те, у кого `getQaAuthority(...).boost > 0` (`:431`);
   - считает `questionTermOverlap()` — доля общих значимых терминов относительно **более короткой** стороны (`:365-372`);
   - **порог 0.55** (`:439`), берёт лучший.

4. **Место вызова:** `answerQuestionEnhanced` сначала гоняет scenario-gate (`:518`), но override проверяется **сразу после** и **до** обработки `needs_clarification` / `out_of_scope` (`:531-535`). То есть канонический Q&A **обходит сценарный гейт** (коммит `4d53ce8`).

5. **Сборка ответа:** `buildCanonicalQaResult()` (`:449-500`):
   - `polishCanonicalAnswer()` (`canonical-answer-polisher.ts:24`) — LLM (`temperature 0.25`, `json_object`) добавляет приветствие и завершающую фразу, запрещая ссылки на «базу знаний/правила/документы»; при ошибке — сырой текст (`:460-463`);
   - жёстко проставляется `confidence: 1.0`, `confidenceLevel: 'high'`, `needsClarification: false`, `requiresHumanReview: false`, `answerSource: 'knowledge_base'` (`:466-487`);
   - `citations` — одна псевдоцитата: первые 250 символов самого же ответа (`:470-476`);
   - `domainsUsed: []`, `debug.chunks: []`, intent = `canonical_qa_override` (`:492`).

6. **Если override не сработал** — обычный путь: scenario gate → guardrails → query expansion + глоссарий (`:613`) → гибридный retrieval (rules + `QAPair` + `DocChunk`) с authority-бустами (`:760-800`) → синтез → consistency gate → `confidenceLevel` по порогам `0.7 / 0.5 / 0.3` (`:24-26`, `:851-862`).

**Ключевое наблюдение о рисках:** override — это единственная ветка движка, где `confidence` не вычисляется, а назначается. Комбинация «порог overlap 0.55 по более короткой стороне» + «`confidence = 1.0`» + «обход сценарного гейта» означает, что коротко сформулированный клиентский вопрос может зацепить неподходящую каноническую пару и уйти клиенту как высокоуверенный ответ. Плюс окно поиска ограничено 200 последними активными парами (`:428`) — при росте базы старые эталоны молча перестанут находиться.

---

## 4. Данные Bitrix в системе

| Тип данных | Как забирается | Куда попадает | Объём | Синхронизация |
|---|---|---|---|---|
| Письма сделок/лидов | `crm.activity.list` `TYPE_ID=4` (`build-threads.mjs:16-21`) | `scratchpad/threads-*.json` (gitignored) | май 2026: 1275 + 1376 | нет, ручной запуск |
| Чаты открытых линий (TG/WA/VK/Avito) | `imopenlines.session.history.get` (`build-chats.mjs`) | `scratchpad/chats-*.json` | май 2026: 130 | нет |
| Прайс-каталог | `crm.product.list` (`aggregate.mjs:21-23`) | `docs/email-bot/price-catalog.json` | 28 услуг | нет |
| Задачи | `tasks.task.add` (`create-bitrix-task.mjs:19`) — **запись**, утилита разработчика | Bitrix | — | — |
| Звонки (105 954 записи) | не забираются | — | — | явно out of scope (`design:80`) |
| Сделки/таймлайн как сущности | не забираются | — | — | — |

**В Postgres не попало ничего.** Дистиллят (180 правил) существует как файл и читается только Bot Lab'ом.

---

## 5. Настройки и флаги

### 5.1 Env-переменные (`.env.example:8-11`)

| Переменная | Кто читает | Значение по умолчанию |
|---|---|---|
| `BITRIX24_PORTAL` | нигде в коде (документационная) | — |
| `BITRIX24_WEBHOOK_URL` | только `scripts/email-mining/*`, `scripts/create-bitrix-task.mjs` | не задана |
| `BITRIX24_WEBHOOK_USER_ID` | `create-bitrix-task.mjs:4` | не задана |
| `BITRIX24_WEBHOOK_TOKEN` | нигде в коде | — |
| `EXTRACT_MODEL` | `extract-knowledge.mjs:13` | `gpt-4o` |
| `OPENAI_TRANSCRIPTION_MODEL` | `voice-training/transcribe/route.ts:39` | `gpt-4o-mini-transcribe` |

**Ни одна `BITRIX24_*` переменная не читается кодом, который деплоится на Railway.** Их отсутствие в проде ничего не ломает.

### 5.2 Тумблеры БД (`AISettings`, `prisma/schema.prisma:503-520`)

| Поле | Дефолт | Влияет на контур №2? |
|---|---|---|
| `autoAnswerEnabled` | `false` (`schema:514`) | **Нет.** Читается только `getAutoAnswerSettings()` (`auto-answer-policy.ts:68-90`), который дёргается исключительно из `src/lib/telegram/*` |
| `autoAnswerMinConfidence` | `0.5` (`schema:517`, `constants.ts:15`) | Нет |
| `isActive`, `provider`, `model` | `true` / `openai` / `gpt-4o` | Косвенно — общий провайдер LLM |

### 5.3 Тумблеры UI контура №2

**Их нет.** `/admin/bot-lab` не имеет ни одного переключателя поведения: нет auto-send, нет порогов, нет выбора модели. Пороги решения зашиты константами в `deriveDecision` (`page.tsx:168`, `:177`). Единственные ручки — фильтры списка кейсов (категория / риск / поиск, `page.tsx:273-283`).

---

## 6. Отличия контура №2 от контура №1

| Критерий | Контур №1 — Telegram (@avroratranslatebot) | Контур №2 — «Bitrix» / Bot Lab |
|---|---|---|
| **Входящий канал** | реальный вебхук `POST /api/telegram` с проверкой `x-telegram-bot-api-secret-token` (`src/app/api/telegram/route.ts:17-20`) | **отсутствует**; вход = клик оператора в браузере |
| **Исходящий канал** | `sendMessage()` в Telegram Bot API (`auto-answer-policy.ts:121`, `:127`) | **отсутствует**; ответ рисуется на экране |
| **Кто инициирует** | клиент | оператор-администратор |
| **Аутентификация** | `TELEGRAM_ALLOWED_USERS` + роли `TelegramUser` | Basic/session auth, мутации только `role === 'ADMIN'` |
| **Источник вопросов** | живые сообщения клиентов | 180 записей из `docs/email-bot/may2026-knowledge-base-final.json` (обезличенная переписка Bitrix за май 2026) |
| **Источник эталона** | нет | «Исторический ответ сотрудника» из того же JSON |
| **Движок ответа** | `answerQuestionEnhanced` (`commands.ts:581`, `voice-handler.ts:166`, `scenario-callback.ts:109`) | **тот же** `answerQuestionEnhanced` через `POST /api/ask` (`page.tsx:331`) |
| **Кеш ответов** | берётся (`commands.ts:581`, `cached?.result`) | обходится: `includeDebug=true` отключает кеш (`ask/route.ts:91`) |
| **Кто принимает решение** | сервер: `decideDelivery()` — единая точка (`auto-answer-policy.ts:60-66`) | браузер: `deriveDecision()` — UI-эвристика, помечена `UI-DERIVED` (`page.tsx:125`, `:574`) |
| **Исходы решения** | `clarify` / `answer` / `escalate` (3) | `NOT_RUN / REVIEW_REQUIRED / LIVE_DATA_REQUIRED / CLARIFY / ESCALATE / DRAFT_WITH_WARNING / DRAFT_READY` (7) |
| **Порог уверенности** | `AISettings.autoAnswerMinConfidence`, дефолт `0.5`; плюс отсечка по `confidenceLevel ∈ {low, insufficient}` (`auto-answer-policy.ts:38-39`) | зашитые в UI `0.5` и `0.7` (`page.tsx:168`, `:177`); из БД ничего не читается |
| **Тумблер включения** | `AISettings.autoAnswerEnabled` (дефолт `false`) | тумблера нет — отправки нет в принципе |
| **Правило «не отвечать»** | никогда при `requiresHumanReview`, `answerSource='general_ai'`, `confidenceLevel ∈ {low,insufficient}` (`auto-answer-policy.ts:36-38`) | тот же результат движка интерпретируется UI, но дополнительно введён исход `LIVE_DATA_REQUIRED` для `price_dependent` кейсов (`page.tsx:150-158`) — в Telegram такого сигнала нет вообще |
| **Эскалация** | `escalateToHuman()` — рассылка админам + сообщение клиенту (`auto-answer-policy.ts:96-131`) | нет эскалации; оператор уже здесь |
| **Уточняющий вопрос** | шлётся клиенту вне зависимости от тумблера (`auto-answer-policy.ts:64`) | только показывается как код решения `CLARIFY` |
| **Тон / постобработка** | canonical-путь → `polishCanonicalAnswer` (приветствие + закрывающая фраза); обычный путь → синтез + consistency gate | тот же результат, но UI дополнительно чистит Markdown в предпросмотре (`cleanMarkdown`, `page.tsx:195-203`) |
| **Обратная связь / обучение** | `/add`, `/correct`, голосовые команды в чате (`telegram/knowledge-manager.ts`) | 4 канала записи: historical → `QAPair`, voice-answer → `QAPair`, voice-rule → `Rule`, правка → `AIQuestion` |
| **Куда влияет обучение** | в общую KB | **в ту же общую KB** → то есть обучение в контуре №2 меняет поведение контура №1 |

**Итог сравнения:** это не два бота, а **один движок + один живой канал (Telegram) + одна админ-песочница**, которая пока лишь наполняет знания для этого единственного канала. «Bitrix» в названии контура №2 обозначает **происхождение обучающих данных**, а не канал доставки.

---

## 7. Открытые вопросы

1. **Продуктовый.** Планируется ли вообще Bitrix как канал доставки, или контур №2 задумывался только как тренажёр для Telegram-бота? От ответа зависит, нужны ли пункты 2–5 ниже.
2. **Триггер.** Дизайн (`design:110`) оставляет открытым выбор: outbound-вебхук Bitrix `ONCRMACTIVITYADD` против поллинга `crm.activity.list`. Ни один не выбран. Поллинг на Railway потребует worker/cron — сейчас инфраструктуры под это нет (`railway.toml` — только web).
3. **Write-back.** Не решено (`design:109`), куда класть черновик: комментарий в таймлайн сделки, draft-активность или черновик письма. От этого зависят требуемые скоупы вебхука.
4. **180 правил.** Ревью пользователем завершено? (`handoffs:129` — «Do NOT import to DB before this»). Если да — нужен импортёр в `QAPair` + эмбеддинги через `commit.ts`. Если нет — датасет Bot Lab остаётся только тренировочным.
5. **Прайс.** Пока прайс-каталог не подключён, любой `price_dependent` кейс (56 из 180 = 31%) не может быть закрыт автоматически ни в одном контуре. Подключать `crm.product.list` живьём или снапшотом?
6. **Дублирование политики решения.** `deriveDecision()` в браузере и `decideDelivery()` на сервере разошлись по порогам и по числу исходов. Если Bot Lab должен показывать «что бот реально сделает», он обязан вызывать серверную политику, а не свою копию.
7. **Риск canonical-override.** Порог `overlap ≥ 0.55` + `confidence = 1.0` + обход сценарного гейта + окно в 200 последних пар — эту связку стоит покрыть тестами (сейчас `scripts/eval/cases.json` её не проверяет) и/или ограничить `scenarioKey`.
8. **`scenarioKey` из категории.** `historical-answers/route.ts:63` и `voice-answers/route.ts:88` пишут в `QAPair.scenarioKey` категорию датасета (`capability`, `process`, `policy`…), тогда как остальная система ожидает ключи вида `apostille.zags.spb` (`scripts/eval/cases.json`). Пространства имён смешаны — нужно решить, намеренно ли это.
9. **Воспроизводимость майнинга.** Шаг извлечения выполнялся Claude-субагентами вручную (`handoffs:52`), а не скриптом. Прогон остальных месяцев потребует либо повторения ручной процедуры, либо кодификации шага.
10. **`scratchpad/` gitignored** (`handoffs:119`) — сырьё майнинга невоспроизводимо без повторного обращения к Bitrix; при отзыве вебхука восстановить исходники будет нечем.
