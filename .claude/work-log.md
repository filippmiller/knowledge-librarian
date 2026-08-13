# Knowledge Librarian - Work Log

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — the most recent entry is always first. NEVER append to the bottom.

---

## 2026-08-13 — Четыре правки против вранья в ответах (Grok)

**Status**: незакоммичено на `feat/canonical-docx-blocks`. `tsc --noEmit` чист. Новые тесты зелёные.
**Промпт**: `.claude/prompts/grok-implementation-task.md`

### Что сделано

1. `answerSource: 'none'` на отказе (`insufficient`). Больше не помечаем «нет данных» как ответ из базы.
2. Отбор контекста по учреждению: чанки/правила ЗАГС ЛО не попадают в ответ про КЗАГС СПб / Минюст. Дыра была в `scenarioKey IS NULL`, не в преамбуле.
3. Lint: адреса в теле должны быть в цитате (так ловится Исаакиевская vs Оптиков) + `polarity_conflict` по стему.
4. Кейс «Китай»: убран `source: knowledge_base`, добавлен запрет «не требуется» (Китая нет в списке изъятий). Казахстан **не трогал** — пункт 9 документа «Страны, для которых не нужен апостиль МЮ 2023».

### Замер после интеграции

`railway run npx tsx scripts/eval/run.ts` — биткоин должен стать `source=none`; 17 остальных без регрессии. Казахстан оставить `knowledge_base` + «не требуется».

---

## 2026-08-12 — Извлечение доведено до конца; первые счета; журнал деградаций; переоценка каталога фактов

**Status**: `feat/canonical-docx-blocks` = `8969d4a`, всё запушено, дерево чистое. Сьют 97 файлов / 1966 тестов, typecheck чистый.
**Хендофф**: `.claude/handoffs/2026-08-12-153000.md`

### Что сделано

Довёл извлечение с «падает на первом блоке» до «проходит целиком»: 7 платных прогонов, 6 фиксов
(`67ab5c6`, `f20a44c`, `ff48ddf`, `438cd21`, `ff8a70c`, `89cbb43`). **Четыре из шести оказались
расхождением статических текстов промптов, а не ошибками модели** — одно правило жило в трёх промптах
и чинилось в одном. Корень вынесен в `src/lib/knowledge/prompt-taxonomy-rules.ts` с тестом, который
сравнивает все три промпта разом.

Получены первые счета на текущем коде (оба **не приёмочные**, граф пропущен): 6/10+0/6 на замороженном
извлечении, 4/10+3/6 на свежем. Разница НЕ атрибутирована — в замерах менялись две переменные сразу.
Базовый флейк не измерялся ни разу.

Журнал деградаций (`8969d4a`): фатальные гейты (taint resample, malformed exception repair, граф) больше
не убивают прогон, а записывают деградацию. Приёмка по-прежнему требует чистого прогона — грейдер
отказывает без `--accept-degraded-run`. Разведены «нельзя измерить» и «нельзя принять».

### Главная находка

В ядре два жёстко зашитых доменных словаря из разных доменов: `TRIGGER_FACT_REGISTRY` (5 фактов из
фикстуры про почёсывание) и `FACET_REGISTRY` (10 фасет из апостиля). Условие вне списка непредставимо.
В живых прогонах все 10 доменных фасет висят UNKNOWN — четыре дня ушло на половину движка, которую
реальные документы бюро не задействуют. Заведено `translation-0lr` (P0), `translation-69e` поднят P3→P1.

Владелец сменил мишень приёмки на **таблицу решений по апостилю из тетради стажёра**.

---

## 2026-08-11 — Актуальный счёт 4/10 + 6/6; найден блокер стриминга; передача на другую машину

**Status**: `feat/canonical-docx-blocks` = `2669607`, всё запушено, дерево чистое. Живой прогон на HEAD невозможен — блокирует `translation-gy3`.
**Хендофф**: `.claude/handoffs/2026-08-11-092000.md`

### Что сделано

Собрал 73 файла (5 865 строк), висевших вне гита, — граф зависимостей правил, `challenge-compatibility`,
`condition-preservation`, журнал результатов по вопросам (`a0a17ba`). Навсегда закрыл флаки-тест
`oracle-taint.test.ts`, валивший полный сьют по таймауту хука (`2669607`). Сьют: 92 файла, 1829 тестов.

Установил актуальный счёт детерминированной перегрейдовкой закоммиченным грейдером: **4/10 позитивных,
6/6 негативных** — не 1/10 и не 3/10, как считалось. Негативные кейсы закрыты полностью. Отчёт ChatGPT
устарел по двум из трёх пунктов: COMPLETE-артефакт получен, decision-relevance и embeddings тарифицируются.

### Главный содержательный вывод

Владелец предположил, что систему перезакрутили проверками. Проверил на Q02: движок ответил «трогать кожу
можно только после мытья с мылом 20 секунд», а классификатор релевантности выбросил правило «при отсутствии
воды допустимо использовать кожный антисептик». Ответ неполон и вводит в заблуждение — **гейт вероятностного
исключения сработал правильно**. Ослаблять его нельзя; чинить надо классификатор выше по потоку.

Собственную раннюю версию диагноза («гейт заклинил, открывающего пути нет») пришлось отозвать: читал поле,
которого в артефакте нет. Поймали независимо Grok и Codex.

### Блокер

Прогон на HEAD падает до первого вопроса: `SocketError: other side closed (UND_ERR_SOCKET)` на стадии графа
зависимостей, три попытки подряд, стоимость $0.00. Причина — непотоковый запрос с `max_tokens=16000` на
`claude-sonnet-5` с промптом на 45 unit'ов; спецификация Anthropic требует стриминг для таких объёмов.
На Sonnet 5 отсутствие поля `thinking` вдобавок означает включённое adaptive thinking. Тот же механизм
объясняет ERROR на Q07/Q08 в прогоне v3.

### Заведено в Beads
`translation-gy3` (P0, блокер — стриминг), `translation-77m` (P0, актуальный счёт; блокируется gy3),
`translation-me6` (P1, классификатор), `translation-5zk` (P1, составные правила), `translation-8fm` (P2, стоимость).

### Обстановка
Kimi исчерпал квоту биллингового цикла — основной критик недоступен. Четыре субагента из шести умерли
с обрывом соединения, поэтому работа передаётся на машину со стабильным каналом. `ANTHROPIC_API_KEY`
был по неосторожности напечатан в вывод — требуется ротация.

---

## 2026-08-06 — План Aurora v2 утверждён и запущен: волна 1 реализована (9 PR)

**Status**: PR #61–#68 влиты в `master` (`990f41d`). PR #69 (B2) и #70 (hl0) готовы и проверены, ждут только зелёного CI.
**Хендофф**: `.claude/handoffs/2026-08-06-220900.md`

### Что сделано

План `docs/plans/2026-08-06-hardening-and-domain-contract-plan.md` прошёл пять раундов внешнего
ревью (R2→R4b) и утверждён к реализации. Ключевой разворот произошёл на Revision 4: три ревизии
подряд уходили всё глубже в контракты, и ни одна не требовала измерить главное — попадает ли нужное
правило в candidate pool ДО генерации ответа. Появился §0 North Star: задача считается решённой
только полным проходом `DOCX → извлечение → JSONL → семантический поиск → применимость → ответ по
доказательствам` на пакете Q01–Q10 + 6 отрицательных кейсов, причём правильный ответ через
`general_ai` без найденного unit'а засчитывается как FAIL.

Реализовано и влито: A1 (provider routing, #63), A2 (extraction consistency, #66), A3 (eval gate,
#64), A4 (нормализация truth table, #62), eda (эагерный стрим, #67), B1 (типизированный доменный
контракт, #65), C (structured-output адаптер, #68).

### Что это дало

Верификация ловила настоящие баги на КАЖДОМ этапе, и ни разу — у автора кода. Три агента отчитались
о правках, которых в коде не было; независимый ревьюер нашёл все три. Codex нашёл в B2 три бага,
которые пропустили и Grok, и собственный adversarial-проход агента, и мои мутационные проверки —
включая путь, где решающая неизвестность давала уверенный ответ. Он же нашёл три дефекта в
детекторе, который написал я сам: главный — что провайдеры СООБЩАЮТ об обрыве
(`finish_reason: length`), а мы эту метаданную выбрасывали и гадали по тексту.

Отдельный класс дефектов, встретившийся шесть раз за день: «по форме валидно, по смыслу пусто» —
пробельные строки и значения, не проверенные против реестра. Закрыт одной функцией `nonBlankString`.

### Инфраструктура

CI падал ~8 раз в конце сессии по двум разным причинам, обе не связаны с кодом: серверные сбои
GitHub Actions (`Service Unavailable` на шаге `Set up job`) и отказ DNS на этой машине (лечится
`ipconfig /flushdns`). Оба PR прогнаны локально по полному пайплайну CI. На красном гейте не
мержили.

Заведён `translation-yg9`: рекурсивное удаление ворктри проходит ПО junction'у `node_modules` и
уничтожает общий store — junction нужно снимать до удаления.

---

## 2026-08-01 — Цены из сетки в проде, объяснимые решения, первые честные замеры

**Status**: PR #39–#45 влиты, `e49a1a3` выкачен и проверен живым вопросом на проде.
**Хендофф**: `.claude/handoffs/2026-08-01-190000.md`

### Что изменилось для клиента

Верный ответ про заверение копии («260 ₽/стр, срочное 300 ₽/стр») перестал уходить
оператору вместо клиента. Сторож приписки цен разбирал предложения по одному и не видел,
что тема задана предыдущим — по-русски подлежащее опускают. Проверено на проде до и после.

### Сделано

- цены берутся из тарифной сетки: прайс в контекст синтеза (отбор разделом), сторож
  устаревших цен, детерминированная ветка только когда база пуста;
- синонимы услуг засеяны: 23 услуги, 63 синонима;
- песочница: выкинута вторая копия политики отправки, перестала слать настоящие
  уведомления, показывает оба контура рядом и причину решения;
- петля обратной связи: `HeldAnswer` + кнопка вердикта под эскалацией в Телеграме;
- замеры: доля ошибок среди отправленных, качество контролей подмешанными дефектами.

### Измерено

- **доля ошибок среди отправленных: 6,3%** (1 из 16), ДИ 1,1–28,3% — цель 2% не доказана;
- из 15 удержаний клиенту 11 — низкая уверенность движка, 4 — контроли;
- сторож утечки клиентского контура ловил **2 подложенные утечки из 125**: адрес требовал
  канцелярского «д. 3», часы — формата ЧЧ:ММ. После правки 125/125 без роста ложных тревог.

### Найдено критиками

- Codex перевернул мой довод о реестре контролей: «бездействующий» для контроля
  безопасности означает молча снятую защиту;
- Kimi K3 нашёл, что дыра «тихой смерти контроля» переехала в список порядка —
  воспроизведено удалением записи при чистой сборке;
- K3 указал, что цель владельца не измерял ни один инструмент. Теперь измеряет.

### Ошибки

Подагент в общем дереве переключил ветку; дважды сломал конфиг Railway через шелл;
коммитил в локальный master в обход ветки; объявил закрытой дыру, которая переехала.

---

## 2026-07-30 (вечер) — Независимый аудит → containment пяти генераторов ошибок → прод

**Status**: PR #23 и #24 влиты, задеплоено и проверено на проде. Цель не достигнута, но фундамент расчищен.
**Метрика согласована с владельцем**: ошибка = противоречие фактам (неполнота не считается), цель ≤2% среди отправленных.

### Аудит: вердикт «нет»

Прежний путь — «размечать аудиторию и импортировать всё больше операторских эталонов» — к цели не ведёт. Корпус эталонов сам себе противоречит: четыре авторитетные пары на узле «нужен ли оригинал», одна исключает три остальные, все ACTIVE и с бустом в синтез. Судья оценивал каждый ответ против его собственного эталона, поэтому оба противоречащих ответа получали OK — **метрика 60% этот класс ошибок не видит**. Импорт противоречий не проверял.

Владелец объяснил причину точнее аудита: операторские ответы — частные, верные в своей переписке. Импорт оторвал ответ от условия и записал как общее правило.

### Найдено сверх

- **Тетрадь стажёра** (12 стр., от владельца) содержит готовую детерминированную таблицу: четыре органа апостилирования × типы документов × территориальность × сроки × доверенность. **В базе её нет**, 6 из 8 ключевых фактов не встречаются ни в одном из 1723 правил. Опровергает записанное ранее: у образовательного комитета территориального признака НЕТ.
- **Прайсы разобраны верно** — моё утверждение «107 из 160 правил без языка» опровергнуто кросс-аудитом: язык лежит в `title`, рантайм ранжирует по `title + body`.

### Containment (PR #24)

Пять механизмов, каждый молча превращал частный случай в общее утверждение:

1. **Кэш** терял отрицание (термы <3 символов): «Не нужен ли оригинал» получал ответ на «Нужен ли оригинал». Нечёткий проход удалён.
2. **122 импортированные пары** лишены авторитета: убраны из canonical-override, из буста +30 и из `hasStrongQaMatch` — последнее оказалось главным, оно поднимало уверенность до автоотправки при нуле чанков.
3. **Контур самообучения** создавал пары без `audience` и искал по одному тексту вопроса — внутренний черновик гасил клиентскую пару. Общая утилита `upsertLearnedQaPair` + advisory-lock.
4. **Политика доставки** применялась только в Telegram; `/api/ask` и мини-приложение отдавали сырой результат. Общий `resolveDelivery`, черновик только по сессии сотрудника.
5. **Заземление чисел** (`claim-grounding`): каждое число как деньги/срок/процент обязано встречаться в контексте синтеза, сравнение по паре (единица, значение).

Тот же дефект отрицания найден Kimi в `questionTermOverlap` — добавлена проверка полярности.

### Замер

Те же 15 вопросов, движок в процессе на продовой базе (прод не задействован).

| | базовый | после |
|---|---|---|
| отправлено | 12 | 11 |
| WRONG | **1** | **0** |

Оговорки: разница в пределах шума при n=15; заземление чисел не сработало ни разу — улучшение дало снятие авторитета; 0 из 11 не доказывает 2% (верхняя граница ~24%, нужно ~150 ответов на живом трафике).

### Ревью

Codex (8 блокирующих), Kimi (6), CodeRabbit (2) — все проверены по коду и закрыты. Ни один не нашёл того, что нашли другие.

### Таблица территориальности (PR #25, #26, #27) — в проде

`src/lib/knowledge/apostille-authority.ts` из тетради, с. 10. Схема базы не тронута: Kimi обоснованно возразил против свободного JSON и против автоматической разметки 1723 правил (случайная ошибка станет детерминированной).

Проверено живыми запросами: диплом из Саратова → «да, регион не помеха» (заказ, который раньше терялся), справка о несудимости из Саратова → продающий выход через нотариальную копию.

**Три слоя, каждый вскрылся только на проде:** таблицу никто не спрашивал (guardrail вызывался на двух ветках маршрутизатора, вопросы уходили по третьей); клиенту глушился любой детерминированный ответ; клиентский текст обязан проходить сигнализацию утечки.

Kimi нашёл в таблице четыре дефекта, все воспроизведены: половина названий городов — русские имена и фамилии («выданная Иванову» читалось как Иваново); нотариальный перевод диплома попадал в образование; «да, можем» обещало без условий; тест врал о собственном объёме.

### Дальше

Цены как таблица → разрешение противоречия про оригинал → замер на объёме (~150 ответов). Хендофф: `.claude/handoffs/2026-07-30-233000.md`.

---

## 2026-07-30 — Инцидент «бот молчал» → два контура ответа → замеры точности

**Status**: инфраструктура двух контуров в проде. Точность на невиданных формулировках 60% (было 3%). Цель «без ошибок» не достигнута.
**Handoff**: `.claude/handoffs/2026-07-30-170400.md` — **следующая сессия начинает с независимого критического аудита, а не с имплементации** (условие владельца).

### Что сделано
1. **Инцидент (PR #16, #17)** — Telegram-бот не отвечал с 17 июля: гейт автоответа читал `AISettings`, а активной строки в проде не существовало ни одной. Плюс порог 0.7 отсекал весь средний диапазон движка, уточнения уходили админу вместо клиента, детектор «нет данных» не ловил женский род.
2. **Два контура (PR #18–#21)** — аудитория как первоклассная сущность: `KnowledgeAudience` на Document/Rule/QAPair/DocChunk, фильтр во всех семи путях извлечения, обязательный `audience` в сигнатуре движка, отдельный клиентский промпт, сигнализация утечки. Разделение на уровне данных, не текста.
3. **Разметка и импорт (PR #22)** — 8 документов из 44 клиентские (548 правил), 117 операторских ответов из корпуса Bitrix импортированы, 58 отложены до решения владельца по ценам. Canonical override ужесточён.
4. **Замеры** — четыре прогона по 30 вопросов + замер точности против операторских эталонов + замер на 15 переформулировках вне корпуса.

### Цифры
- Клиентский контур отправляет ответ: 53% → 70% (после правки промпта) → 80% на переформулировках
- **Точность: 1 из 30 (3%) до импорта → 9 из 15 (60%) после**
- Внутренний контур: 43% отправляемых, точность не мерилась

### Ключевые находки
- Битрикс-бота как рантайма **не существует**: нет вебхука, нет отправки, нет очереди
- Сценарный гейт покрывает 15% правил и отсекает четыре самых частых вопроса корпуса до поиска
- Canonical override ищет по пересечению слов: настоящие переформулировки дают 0.34/0.24, узнавание нулевое. Нужны эмбеддинги
- Кэш — `Map` в памяти, умирает при редеплое. Требование владельца о сохранении знаний не выполнено
- 104 дублирующихся `ruleCode` среди ACTIVE; `R-1384` — три разных правила
- Цикл обучения работал в обратную сторону: утверждение отписки навсегда закрывало вопрос

### Уроки
- `` в JS не работает с кириллицей; отрицательный просмотр вперёд побеждается откатом `[а-яё]*`. Три ложных срабатывания сигнализации найдены на живых данных — все молча превращали годные ответы в эскалации
- Скриптовые замены в больших файлах молча промахиваются: проверять результат по содержимому, а не по коду возврата
- Пример с реальной ценой в системном промпте подсказывает модели цифру

---

## 2026-06-04 — Bitrix24 access + Security hardening + Email-bot knowledge mining

**Status**: Security shipped (PR #13, merged & deployed). Mining: May 2026 done (180 rules), awaiting review. Handoff created.
**Handoff**: `.claude/handoffs/2026-06-04-210028.md` (full detail — read this to continue).

### What was done
1. **Bitrix24 inbound webhook** set up (portal `aurora-piter`, 11 scopes). Secrets in `.env` (gitignored). Memory: `bitrix24-integration.md`. Note: `mailservice` scope unavailable in UI → emails read via `crm.activity TYPE_ID=4`.
2. **Security audit + fixes (PR #13, merged to master, deployed)** — 12 findings. Telegram webhook secret-token verify; removed hardcoded `ENCRYPTION_KEY` fallback (fail-fast); `getDocument` no longer public; rate-limit all mini-app POSTs; constant-time HMAC; feedback caps; generic errors. `scripts/set-telegram-webhook.mjs` added; `TELEGRAM_WEBHOOK_SECRET` set on Railway. Report: `security-scan-report.md`. Memory: `security-posture.md`. ⚠ live API keys printed to transcript via `railway variables` — suggested rotation.
3. **Email/chat knowledge-mining pipeline** — `scripts/email-mining/*`. Mines reusable company knowledge (not transactional pairs) from CRM emails (Deals+Leads) + open-line chats (Telegram/WhatsApp/VK) via Sonnet subagents, reconciles prices with `crm.product.list`. May 2026: 406 raw → **180 canonical rules**. Deliverables in `docs/email-bot/`.

### Key lessons / problems
- First extraction paired adjacent emails → transactional slag (user: "это шлак"). Fixed: full-thread + strong rules + Leads/chats (user: "почему только треды"). Prices from catalog, not memorized (user: "живой расчёт"). Extraction via Sonnet subagents, not API (user: "используй свою модель SONNET").
- Bash PATH glitches → use PowerShell for node. Bitrix socket timeouts → retry/backoff. Subagent timeouts on big tasks → split small. `scratchpad/` gitignored → deliverables copied to `docs/email-bot/`.

### Channel visibility
Can read incoming from Telegram, WhatsApp, VK, Avito. **MAX not connected** to Bitrix — can't train/answer there yet.

---

## 2026-05-31 (cont.) — Clarification-flow fixes + Codex loop hardening (PR #9)

**Status**: Completed, merged & deployed (Railway `a4978a34` = master `a29c04b`). Verified.
**Commits**: `2b433f8`, `10957ee` (PR #9, merged `a29c04b`)

> The "pause" never happened — user sent a live-bot screenshot and a Codex review, so we kept
> going. This entry supersedes the "PAUSED" status of the entry below.

### What was done
**Batch 1 — clarification-flow bugs (from a live Telegram screenshot):**
- **A** Clarification turns no longer escalate ("Требуется проверка ответа ИИ" spam). A clarification
  is healthy behaviour → `isClarificationTurn()` early-return in `escalateUnconvincingAIAnswer`.
- **B** Typed clarification replies (e.g. "Москва" instead of tapping the region button) no longer
  lose context. `handleQuestion` detects a pending clarification (`getPendingClarificationAnchor`) +
  a typed reply (`looksLikeClarificationReply`) and merges into the original question + chain.
- **C** Loop no longer files junk drafts ("Москва" → "нет данных"). `isDraftableDraft()` rejects
  context-less fragments and no-data/clarification non-answers.
- All three predicates → one pure module `src/lib/ai/answer-policy.ts` (unit-tested, no heavy imports).

**Batch 2 — Codex adversarial review (verdict FIX-FIRST), all 7 findings:**
- **P1 security**: web approve/reject requires top web role (ADMIN) via `getAuthenticatedUser()`;
  `approvedBy` from authenticated principal, not request body. (`auth.ts`, `api/ai-questions/[id]/route.ts`)
- **P1 atomicity**: `approveKnowledgeGap` atomic `updateMany` claim in a `$transaction` — no duplicate
  QAPair on concurrent approve.
- **P1 recall (the big one)**: `overallConfidence` used ONLY chunks, so an approved QA-only pair scored
  0 → general_ai → loop never truly closed. `questionTermOverlap()` + `hasStrongQaMatch` (≥0.7) now
  treats a strong QA match as authoritative KB evidence. (`enhanced-answering-engine.ts`)
- **P2**: normalized draft dedup; Cyrillic `\w`→`[а-яё]*` in scenario-classifier (`министерство юстиции`).
- **P3**: consistency-gate strict `supported === true`; extraction-lint FILLER catches inflected forms.

### Verification (all green)
- `tsc --noEmit` clean · `npm run build` exit 0 · unit `scripts/eval/unit-guards.ts` 18/18 ·
  regression `scripts/eval/run.ts` 18/18.
- Functional on prod: **P1#3** QA-only → `knowledge_base`/high/100%; **P1#2** concurrent approve →
  1 fulfilled / 1 rejected / 1 QAPair; **B** context merge → anchor preserved + negative control.

### Recurring trap (now documented in memory)
JS `\w`/`\b` are ASCII-only → silently fail on Cyrillic. Russian tails use `[а-яё]*`; word-boundary
checks tokenize + Set-match instead of `\b`.

### Follow-ups (in handoff)
- Content gaps (China/Hague, МВД two-address, pricing) — need domain expert.
- Reconcile `DocumentRevision` schema drift (db push still unsafe).
- P2#4 dedup race: a partial-unique DB index is the robust version (normalized check ships now).

---

## 2026-05-29..31 — Answer-engine hardening + self-improving knowledge loop (PR #1–#7)

**Status**: Completed & deployed (Railway `98a2cf44` = master `061b06c`). Superseded by the entry above.
**Commits**: `0b872ba`, `07e4931`, `e3af4f5`, `76c456a`, `adaf347`, `c8302a2`, `061b06c` (+ merges)

### What was done
Two goals: (1) make the bot's answers honest about their source (документы vs общие знания ИИ)
and more correct; (2) build a self-improving loop — when uncertain, the bot answers from general
AI knowledge AND files a draft Q→A rule for super-admin approval; on approval it becomes an ACTIVE
QAPair so the next identical question is answered from the KB.

- **Source attribution + escalation** (PR#1): honest `answerSource`; every `general_ai` escalates.
- **Abbreviations** (PR#2/#4): `СО[РБС]` ЗАГС family; data-driven glossary `expandAbbreviations()`.
- **Tech debt + robustness** (PR#3/#4): honest confidence (`bestSemanticScore + coverageScore*0.1`),
  golden eval harness (`scripts/eval/`, 18 cases, deterministic), ingest quality gate
  (`extraction-lint.ts`), provenance-filtered citations.
- **Answer-quality v2** (PR#5): consistency gate checks chunks+rules+QA; general-requirement routing.
- **Country-destination** (PR#6): "апостиль для <страна>" → KB, fixed the "Китай" clarification loop.
- **Self-improving loop** (PR#7): `knowledge-feedback.ts`, TG inline ✅/✖️ approval
  (`knowledge-gap-callback.ts`), web review UI, `QAPair.metadata` provenance. Verified E2E on prod.

### Key bugs fixed
- `\w` doesn't match Cyrillic in JS → used `[а-я]*` (hit twice).
- Loop didn't close: Step 6 qaPairs fetched `take:100` with no prefilter → fresh approved pair
  dropped. Fixed with per-term keyword prefilter (mirrors Step 5 rules).
- `prisma db push` wanted to DROP `DocumentRevision` (drift) → used raw `ALTER ... ADD COLUMN
  IF NOT EXISTS` for `QAPair.metadata`. Drift still unreconciled (follow-up).

### Files
See `docs/reviews/2026-05-31-codex-review-request.md` for the full list + per-PR breakdown.
New: `knowledge-feedback.ts`, `knowledge-gap-callback.ts`, `glossary.ts`, `extraction-lint.ts`,
`scripts/eval/*`, `scripts/ask.ts`.

### Handoff
- **Continuation handoff**: `.claude/handoffs/2026-05-31-154600.md`
- **Codex review request**: `docs/reviews/2026-05-31-codex-review-request.md`
- Memory updated: `~/.claude/projects/C--dev-translation/memory/answer-source-routing.md`
- Remaining: run Codex review; content gaps (China/Hague, МВД two-address, pricing — need domain
  expert); reconcile schema drift; continue one-by-one question re-run via `scripts/ask.ts`.

---

## 2026-02-19 — UX: Forgiving Bot — Keyword Detection, Direct Rule Lookup

**Status**: Completed
**Commits**: 1ba28d3

### What was done
- **Keyword detection in text messages**: Admin text starting with "сохрани/добавь/запомни/запиши" now triggers `addKnowledge` directly (not RAG). Same for "поменяй/измени/исправь/обнови" → `correctKnowledge`. Previously this only worked for voice messages.
- **Direct rule lookup**: "правило 100" or "правило R-100" in any text message now queries the DB by ruleCode and shows the rule directly. Works for ALL users. Falls through to RAG only if not found.
- **Search includes ruleCode**: `executeSearchRules` in smart-admin now also searches by `ruleCode` field (was only title+body).
- **`add_rule` intent in smart-admin**: Added as fallback for SUPER_ADMIN AI classifier — catches "сохрани правило..." even if keyword regex doesn't match.

### Root cause
Bot was too "rigid" — keyword-based intent detection (add/correct) only worked for voice messages. Text messages went straight to RAG or required exact `/commands`. User wrote "сохрани правило..." as text → bot answered from RAG. After `/add` created R-100, user asked "покажи правило 100" → bot couldn't find it (no direct DB lookup).

### Files changed
- `src/lib/telegram/message-router.ts` — keyword detection + rule lookup pattern
- `src/lib/telegram/smart-admin.ts` — ruleCode in search + add_rule intent

### Deployment
- Railway: deployed via `railway up`, Next.js 16.1.3 started successfully

---

## 2026-02-14 — Telegram Bot: Access Control, Knowledge Management, Document Upload

**Status**: Completed
**Commits**: d023ba0, 1f781fd, d2f6e0e, cdd7d4b, b2bb344, dc04725

### What was done
- Built full Telegram bot system: DB-backed access control (SUPER_ADMIN/ADMIN/USER), 7 new module files
- User management: /grant, /revoke, /promote, /demote, /users commands
- Knowledge management: /add (AI parses text into rules+QA), /correct (in-place rule updates)
- Voice messages: Whisper transcription with keyword routing (add/correct/question)
- Document upload: 3-phase pipeline (classify, extract, chunk) with detailed summary
- Rule viewing: /show, /edit, /delete commands
- Slash command menu registered with Telegram API (12 commands)
- Added Яна (234742362) as SUPER_ADMIN

### Bugfixes
- Voice "поменяй" was routed to Q&A instead of correction (missing CORRECT_KEYWORDS)
- MarkdownV2 escaping split messages; switched to plain text
- /correct created duplicate rules; rewrote to update in-place + delete conflicting chunks
- /add had 2000 char limit; raised to 10000
- rawBytes not saved on document upload; fixed
- 0 QA pairs from documents; rewrote extraction prompt to require 1-2 QA per rule

### Decisions made
- Plain text over MarkdownV2 for all Telegram messages
- In-place rule correction over supersede pattern (avoids conflicting search results)
- Non-streaming pipeline for Telegram (no SSE needed)

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`
→ `.claude/agent-log.md` (6 entries)

---

## 2026-02-06 Session 2 - EXTRACTED Status & Production Processing

**Status**: Completed
**Duration**: ~3.5 hours
**Commits**: 9962c22

## 2026-02-06 Session 1 - Resilience & Error-Proofing

**Status**: Completed
**Commits**: 8787fce, and prior commits

### What was done
- Found and fixed critical bug: EXTRACTED documents re-processed from scratch on reopen (83s wasted + data loss)
- Added server-side guard to force resume mode for EXTRACTED documents
- End-to-end tested resume flow: 4.1s DB load vs 83s re-processing
- Deployed all changes to production Railway
- Processed all 5 PENDING documents on production (183 items in 168.7s, zero errors)
- Committed all 6 EXTRACTED documents to knowledge base
- Final state: 15/15 documents COMPLETED

### Decisions made
- Server-side resume guard chosen over client-side for robustness
- Sequential production processing to avoid Railway/AI API overload
- Node.js SSE consumer script when Playwright unavailable

### Issues encountered
- Playwright MCP tools became unavailable mid-session; switched to Node.js scripts
- PowerShell commands timeout on large API responses; used Node.js piping instead

### Next steps
- All documents processed and committed - knowledge base is complete
- Consider adding batch processing UI for multiple documents
- Address Next.js 16 middleware deprecation warning (middleware.ts -> proxy.ts)

---

### What was done
- Added EXTRACTED enum to ParseStatus in Prisma schema
- Implemented SSE disconnect resilience (processing continues in background)
- Added reconnection logic: 5 attempts, exponential backoff up to 10s
- Added React Strict Mode guard to prevent duplicate processing
- Added concurrent processing lock (in-memory Map)
- Added 6-hour auto-fail for stuck PROCESSING documents
- Added duplicate upload protection
- Added EXTRACTED badge, "Проверить" button, review counter in UI
- Reset 5 stuck PROCESSING documents to PENDING
- Successfully processed first test document end-to-end

### Issues encountered
- Prisma DLL lock from dev server holding query_engine-windows.dll.node
- PowerShell `$_` interpolation issues in bash shell
