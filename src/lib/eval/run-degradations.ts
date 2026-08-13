/**
 * Реестр деградаций прогона: «замер проходит всегда, приёмка — только на
 * чистом прогоне».
 *
 * ЗАЧЕМ ЭТОТ МОДУЛЬ СУЩЕСТВУЕТ (живая отладка 2026-08-12, семь платных
 * прогонов подряд ради ОДНОЙ цифры). Пайплайн — цепочка стадий, у каждой
 * свой судья, и КАЖДЫЙ судья закрывал прогон наглухо от одного «не уверен»:
 *
 *   coverage audit · taint resample · malformed exception repair ·
 *   assignIdentity · dependency graph · schema validation · focused repair
 *
 * Каждая дверь по отдельности защищаема — не пускать плохие данные дальше.
 * Вместе они дают здание, в которое нельзя войти: вероятность пройти
 * пайплайн есть произведение вероятностей всех судей, а судьи стохастические.
 * Прогоны 2,3,4,6 умерли на ремонтных стадиях, прогон 5 — на identity,
 * прогон 7 — на несходимости графа. Ни один вопрос при этом не был задан.
 *
 * РАЗДЕЛЕНИЕ, КОТОРОЕ ЭТО ЧИНИТ, НЕ ОСЛАБЛЯЯ ГАРАНТИЙ:
 * - «Нельзя измерить» и «нельзя принять» — РАЗНЫЕ вещи. Дефект блока больше
 *   не убивает прогон: он записывается сюда, прогон доходит до конца и даёт
 *   и цифру, и полный список деградаций.
 * - Приёмочный статус по-прежнему требует ЧИСТОГО прогона. Грейдер обязан
 *   отказаться назвать деградированный прогон приёмочным без явного флага —
 *   ровно как он уже делает для пропущенного графа
 *   (`resolveDependencyGraphGate`). Инвариант владельца «зелёный отчёт при
 *   неполном ответе — худший исход» сохраняется: зелёным такой прогон не
 *   станет, он станет ИЗМЕРИМЫМ.
 *
 * Это НЕ новый механизм: тот же паттерн уже дважды работает в кодовой базе
 * (`--accept-skipped-graph`; проверка отпечатка артефакта извлечения).
 * Модуль распространяет его на остальные двери.
 */

/** Стадия, на которой прогон был бы убит до появления этого реестра. */
export const DEGRADATION_STAGES = [
  'COVERAGE_AUDIT',
  'TAINT_RESAMPLE',
  'MALFORMED_EXCEPTION_REPAIR',
  'IDENTITY_ASSIGNMENT',
  'DEPENDENCY_GRAPH',
] as const;

export type DegradationStage = (typeof DEGRADATION_STAGES)[number];

export interface RunDegradation {
  readonly stage: DegradationStage;
  /** Анкер затронутого блока, если деградация локальна для блока. */
  readonly blockAnchor: string | null;
  /**
   * Units, чья достоверность пострадала. Пустой массив означает «стадия
   * деградировала целиком» (например, граф не сошёлся) — это НЕ то же самое,
   * что «никто не пострадал», и читатель обязан различать эти случаи по
   * `stage`, а не по длине массива.
   */
  readonly unitIds: readonly string[];
  /** Человекочитаемая причина — попадает в отчёт, а не только в лог. */
  readonly detail: string;
}

/**
 * Собиратель деградаций одного прогона. Намеренно тривиальный: ценность не
 * в логике, а в том, что у стадий появляется ОДНО место, куда сообщать о
 * деградации, вместо `throw` в каждой.
 */
export class RunDegradationLedger {
  private readonly entries: RunDegradation[] = [];

  record(degradation: RunDegradation): void {
    this.entries.push(degradation);
  }

  /** Снимок для сериализации в run-summary.json. */
  snapshot(): readonly RunDegradation[] {
    return [...this.entries];
  }

  get degraded(): boolean {
    return this.entries.length > 0;
  }

  /** Стадии, на которых что-то деградировало — для краткой строки в консоль. */
  stages(): readonly DegradationStage[] {
    return [...new Set(this.entries.map((entry) => entry.stage))];
  }
}

/** Поля run-summary.json, которые читает приёмочный гейт грейдера. */
export interface RunSummaryDegradationFields {
  readonly degradations?: readonly RunDegradation[];
}

/**
 * Приёмочный гейт. Зеркалит `resolveDependencyGraphGate`: деградированный
 * прогон измеряется, но приёмочным числом называться не может без явного,
 * видимого согласия вызывающего.
 *
 * Отсутствие поля `degradations` трактуется как чистый прогон — так
 * committed-артефакты, снятые до появления реестра, продолжают оцениваться
 * ровно как раньше (та же дисциплина, что у графового гейта: отсутствие
 * поля НИКОГДА не значит SKIPPED/деградацию).
 */
export function resolveDegradationGate(
  summary: RunSummaryDegradationFields,
  acceptDegradedRun: boolean
): { readonly degraded: boolean; readonly degradations: readonly RunDegradation[] } {
  const degradations = summary.degradations ?? [];
  if (degradations.length > 0 && !acceptDegradedRun) {
    const byStage = [...new Set(degradations.map((d) => d.stage))].join(', ');
    throw new Error(
      `Run completed with ${degradations.length} recorded degradation(s) [${byStage}]. ` +
        'Pass --accept-degraded-run to grade this as a non-acceptance measurement. ' +
        'Degradations mean some blocks/units are less trustworthy than a clean run, ' +
        'so the score is not an acceptance number.'
    );
  }
  return { degraded: degradations.length > 0, degradations };
}
