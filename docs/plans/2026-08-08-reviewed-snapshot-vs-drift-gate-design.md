# Design note: immutable reviewed snapshot vs extraction-drift gate

**Дата:** 2026-08-08. **Beads:** translation-yz9 (родитель), новая задача для
этого шага заводится после этого документа. **Требуется:** внешнее ревью PR
#76 ("Не начинать 2.3 (пилот на реальных документах)... Нужно спроектировать и
реализовать разделение двух независимых gates. Перед изменением
review-manifest.ts сначала напиши короткий design note").

## Почему текущий дизайн не работает на реальных данных

`applyReviewManifest()` (`src/lib/eval/review-manifest.ts`) сегодня — ОДНА
функция с ОДНОЙ семантикой: "свежая экстракция ДОЛЖНА побайтово (по
`contentHash` + `reviewedUnitHash`) совпасть с тем, что видел человек при
ревью, иначе `confirmed = []` целиком, gate падает."

Два реальных прогона `--stage=extraction` на одном и том же DOCX одной и той
же моделью (`.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md`)
показали:

```text
run1: 41 units       run2: 38 units
36 общих unitId       10 из 36 — другой contentHash
5 unitId только run1  2 unitId только run2
```

Если человек сейчас review'ит `run1` и коммитит manifest, то `run2` (тот же
DOCX, тот же конфиг, просто следующий вызов LLM) почти гарантированно провалит
`applyReviewManifest()`: `unit_missing_from_extraction` × 5,
`unit_absent_from_manifest` × 2, `content_hash_changed` × 10 (в среднем).
`confirmed` станет пустым множеством — не потому что ретрив/applicability
сломаны, а потому что LLM-экстракция сама по себе не бит-в-бит детерминирована
(и не обязана быть — реальная модель, реальный prompt, реальный текст).

Смешаны два вопроса, которые ломаются по разным причинам:

```text
"Работает ли наш retrieval/applicability/synthesis?"
```

и

```text
"Стабильна ли LLM-экстракция между прогонами?"
```

Если Q05 проваливается, а gate одновременно кричит про 15 `content_hash_changed`,
невозможно понять, ЧТО СЛОМАНО — retrieval не нашёл reviewed-правило 5, или
экстракция сегодня его не выдала вообще. Это ровно та путаница, вокруг которой
построена архитектура всей Aurora v2 (semantic recall vs applicability
precision, extraction fidelity vs retrieval correctness — план §0.2).

## Артефакты: какой из них — source of truth для чего

| Артефакт | Кто производит | Изменчивость | Source of truth для |
|---|---|---|---|
| `extracted-units.raw.jsonl` (per-run) | `--stage=extraction` (raw LLM output) | Меняется КАЖДЫЙ прогон | Ничего постоянного — сырой вход в assignIdentity одного конкретного прогона |
| `persisted-units.candidate.jsonl` (per-run) | `--stage=extraction` (после assignIdentity) | Меняется каждый прогон | Кандидат на ревью ОДНОГО конкретного прогона |
| `review-packet.json` (per-run) | `--stage=extraction` | Меняется каждый прогон | Материал для oracle-blind человека — НЕ knowledge base |
| **`reviewed-knowledge-snapshot.json`** (NEW, этот design) | Человек (`applyReviewManifest` в РЕЖИМЕ QUALIFICATION, разово) | **Иммутабельный** после создания — правится только новым явным ре-ревью | **ЕДИНСТВЕННЫЙ** trusted вход для retrieval/applicability/synthesis/grader тестов |
| `extraction-drift-report.json` (NEW, этот design) | `compareExtractionRuns()` (свежий прогон vs snapshot) | Меняется каждый прогон | Диагностика "экстракция сегодня уехала от того, что было ревьюено" — НЕ блокирует чтение snapshot |

**Ключевое решение:** `reviewed-knowledge-snapshot.json` — новый, ОТДЕЛЬНЫЙ
файл (не `review-manifest.jsonl` в его нынешнем виде). Manifest (решения
человека по unitId) остаётся АУДИТ-ТРЕЙЛОМ ("кто, когда, что решил и почему"),
а snapshot — МАТЕРИАЛИЗОВАННЫЙ РЕЗУЛЬТАТ применения этих решений к КОНКРЕТНОМУ
прогону экстракции, который человек фактически видел. Snapshot содержит сами
`PersistedKnowledgeUnit` (не только решения) — retrieval/applicability не
обязаны знать про manifest вообще, они читают snapshot напрямую.

## Два gate'а, что каждый сравнивает

### Gate 1 — Extraction Qualification (создание snapshot, разовая операция)

```text
DOCX + конкретный прогон --stage=extraction (persisted-units.candidate.jsonl)
  + committed review manifest (решения человека ПО ЭТОМУ прогону)
  ──▶ applyReviewManifest() — ТА ЖЕ функция, ТА ЖЕ all-or-nothing семантика,
      что и сегодня: если manifest не описывает ТОЧНО этот прогон
      (contentHash/reviewedUnitHash не совпали хоть где-то) — QUALIFICATION_FAILED,
      snapshot не создаётся, человек должен либо провести ревью заново на
      актуальном прогоне, либо (после этого design) — ре-ревью НЕ обязано
      быть "с нуля": manifest хранит решения по unitId, стабильные части
      сохранятся автоматически (см. "Инкрементальное ре-ревью" ниже).
  ──▶ QUALIFICATION_PASSED ──▶ reviewed-knowledge-snapshot.json (иммутабельный)
```

Эта all-or-nothing строгость ЗДЕСЬ ОСТАЁТСЯ ПРАВИЛЬНОЙ: при создании snapshot
мы ОБЯЗАНЫ быть уверены, что каждый unit в нём — это то, что человек
действительно видел и одобрил, ни байтом иначе. Слабое сравнение здесь
означало бы автоматическое одобрение LLM-выдумки — ровно то, против чего весь
механизм построен (план §0.3 №5: "человеческое accept НЕ автоматизируется через
LLM ни в каком виде").

### Gate 2 — Extraction Reproducibility / Drift (диагностика, не блокирует)

```text
reviewed-knowledge-snapshot.json (frozen, source of truth)
  + N свежих прогонов --stage=extraction
  ──▶ compareExtractionRuns(snapshot.units, freshRun.units)
  ──▶ extraction-drift-report.json:
        - STABLE: unitId есть в обоих, contentHash совпал
        - CONTENT_CHANGE: unitId есть в обоих, contentHash отличается
        - CONTENT_OMISSION: unitId есть в snapshot, отсутствует в freshRun
        - CONTENT_ADDITION: unitId есть в freshRun, отсутствует в snapshot
        - FRAGMENTATION_CHANGE: эвристический сигнал (см. ниже) —
          несколько CONTENT_OMISSION + CONTENT_ADDITION на ОДНОМ
          sourceBlockAnchor одновременно
        - PARENT_DRIFT: unitId стабилен, parentRuleRef изменился
          (null↔unitId или другой unitId)
        - TRIGGER_DRIFT: unitId стабилен, triggerCondition изменился
        - UNCERTAINTY_DRIFT: unitId стабилен, состав uncertainties изменился
```

Результат этого gate НЕ блокирует retrieval/applicability/synthesis тесты —
те продолжают читать `reviewed-knowledge-snapshot.json` напрямую и НИКОГДА не
запускают LLM-экстракцию заново. Drift-report — это отдельный, параллельный
сигнал: "если бы мы ревьюили СЕГОДНЯШНИЙ прогон, что изменилось бы". Полезен
для мониторинга регрессий промпта/модели/схемы, но не является precondition
для retrieval-answer тестов.

## Инкрементальное ре-ревью (не решается в этом PR, но не блокируется дизайном)

Snapshot иммутабелен, но НЕ вечен: когда prompt/schema/model меняются
достаточно, чтобы drift stало значительным, нужно новое qualification-ревью.
Дизайн НЕ требует "review всё с нуля" — `applyReviewManifest()` уже сопоставляет
по `unitId`, так что старые решения по СТАБИЛЬНЫМ units можно перенести
автоматически (тот же unitId + тот же contentHash + тот же reviewedUnitHash),
а человеку нужно решить только по units, попавшим в `CONTENT_ADDITION`.
Это ЕСТЕСТВЕННОЕ развитие текущего кода (тот же `applyReviewManifest`,
запущенный на новом прогоне против старого manifest, УЖЕ считает
"unit_missing_from_extraction"/"unit_absent_from_manifest" — просто раньше
единственной реакцией было "гейт упал", а теперь это может стать "вот units
для точечного ре-ревью"). Явная реализация этого сценария — за рамками
данного шага (translation-yz9 явно просит НЕ строить новый большой функционал
в этой сессии); зафиксировано здесь, чтобы не потерять направление.

## Что НЕ меняется

- `applyReviewManifest()` — сигнатура и all-or-nothing семантика Gate 1
  СОХРАНЯЮТСЯ буквально. Это НЕ ослабление human review — снапшот создаётся
  строго или не создаётся вообще.
- Committed review manifest по-прежнему oracle-blind, по-прежнему не
  автоматизирует human accept/reject/edit.
- `MANIFEST_GATE_FAILURE_CODES` остаются осмысленными кодами ошибок Gate 1
  (создание snapshot) — их нельзя путать с drift-кодами Gate 2, поэтому у
  `compareExtractionRuns()` СВОЙ, отдельный набор кодов
  (`ExtractionDriftKind`), не переиспользующий `ManifestGateFailureCode`.

## Что меняется (реализуется этим шагом)

1. Новый тип `ReviewedKnowledgeSnapshot` + функция `buildReviewedSnapshot()`
   — тонкая обёртка над существующим `applyReviewManifest()`, материализующая
   его `confirmed` в персистентный, версионированный артефакт с provenance
   (sourceRevisionHash, parserVersion, extraction provider/model/promptVersion/
   schemaVersion, reviewedAt/reviewedBy сводно).
2. Новый модуль `extraction-drift.ts`: `compareExtractionRuns()` +
   `ExtractionDriftKind` + классификация из раздела Gate 2 выше.
3. Существующий `review-manifest.ts` НЕ переписывается с нуля — Gate 1 логика
   остаётся, только оборачивается в snapshot-материализацию.

RED-тесты пишутся против ЭТОГО контракта, не наоборот.
