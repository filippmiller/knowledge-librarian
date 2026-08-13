# Прогон 2026-08-11 после восьми починок — первый полный за сессию

**Счёт: 4/10 положительных, 3/6 отрицательных.** Стоимость $0.4198, 92 платных
вызова, все 16 вопросов отвечены, код выхода 0.

## Как получен

    npx tsx scripts/run-aurora-fixture.ts --mode=e2e --extraction-runs=1 \
      --out=<dir> --max-cost-usd=2.50 --max-paid-calls=300 \
      --question-model=claude-sonnet-5 --question-provider=anthropic \
      --reuse-extraction=scripts/fixtures/semantic-rule-extraction-test-pack/frozen-extraction/extraction-artifact.json \
      --dependency-graph=skip

    npx tsx scripts/grade-aurora-fixture.ts --in=<dir> --out=<report> --accept-skipped-graph

## ЭТО НЕ ПРИЁМОЧНАЯ ОЦЕНКА

Стадия графа зависимостей пропущена (`dependencyGraphStage: SKIPPED`), поэтому
грейдер потребовал явного `--accept-skipped-graph`, а каждый вердикт помечен
`dependencyGraphSkipped: true`. Граф не сходится: после двух раундов ремонта
аудитор всё ещё возвращает обычные замечания. Он не декоративен — рёбра
REQUIRES/CO_REQUIRED помечают юниты доверенно-обязательными и проводят их мимо
вероятностного классификатора, то есть он потенциально лечит Q03. Пока он
выключен, эта защита отсутствует.

## Сопоставимость с базисом 2026-08-11 (4/10 + 6/6)

Прямо НЕ сопоставим, и вот почему:

- База знаний другая: 44 юнита против 45, извлечены изменёнными промптами.
  Прежний артефакт восстанавливается как
  `git show 697a6fd~1:scripts/fixtures/.../frozen-extraction/extraction-artifact.json`.
- Базис снят кодом до a0a17ba, в котором графа ещё не существовало.
- Q07 и Q08 в базисе не измерялись вовсе: они падали как ERROR terminated из-за
  дефекта транспорта. Здесь это первые настоящие показания по ним.

Отрицательные упали с 6/6 до 3/6 — регрессия, разбирается отдельно.

## Разбор девяти провалов

| Кейс | Стадия | Причина |
|---|---|---|
| Q01 | RESOLUTION | EVIDENCE_GROUP_UNCOVERED (правило 1): не покрыт переход в закрытое место |
| Q03 | APPLICABILITY | верный ответ заблокирован зависимостью от вероятностного исключения кандидата |
| Q05 | RESOLUTION | неожиданный CLARIFY: privacyContext_unknown, exception_trigger_unknown |
| Q07 | SYNTHESIS | condition_not_preserved: условие unit 3912e8aa9e61eba4 не сохранено однозначно |
| Q08 | SYNTHESIS | uncited_answer — ответ не сослался ни на один unit |
| Q10 | RESOLUTION | EVIDENCE_GROUP_UNCOVERED (правило 10): пять одновременных условий не покрыты |
| Q04-N1 | EVIDENCE | в выбранных доказательствах нет числа 15 секунд |
| Q05-N1 | RESOLUTION | правило 1 не выбрано; нет кодов privacyContext_violated, exception_trigger_inactive |
| Q09-N1 | APPLICABILITY | правило 9 попало в операционные основания, хотя должно быть контрпримером |

Q08 — самый опасный для продукта: ответ без единой ссылки на источник. Для
системы, продаваемой как отвечающая только по документу, это хуже неверного
ответа, потому что ничто не помечает такой ответ недостоверным.
