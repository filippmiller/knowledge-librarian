/**
 * Fire-and-forget телеметрия качества ответа — с выключателем.
 *
 * Движок пишет находки consistency-gate в `HallucinationLog` на КАЖДЫЙ вопрос,
 * где сработал контроль. Для живого пользователя это правильно: по этой таблице
 * считают, какие сценарии врут чаще и помогает ли перегенерация.
 *
 * Для прогона золотого корпуса — нет. Корпус гоняется против продовой базы
 * (Beads translation-toh, план §3 PR A3), и десятки его синтетических вопросов
 * подмешивались бы в ту самую статистику, по которой потом делают выводы о
 * реальных пользователях. Отсюда `telemetryMode: 'disabled'` — режим, который
 * НЕ пишет ни строки.
 *
 * Умолчание — 'enabled': любой существующий вызов, не передавший режим (а это
 * все продовые пути: /api/ask, телеграм, мини-приложение), ведёт себя ровно как
 * раньше. Выключение возможно только явным словом на конкретный вызов.
 */

import prisma from '@/lib/db';

export type TelemetryMode = 'enabled' | 'disabled';

export interface HallucinationLogEntry {
  sessionId: string | null;
  question: string;
  scenarioKey: string | null;
  initialAnswer: string;
  regeneratedAnswer: string | null;
  unsupportedClaims: object;
  unsupportedCount: number;
  regenerated: boolean;
}

/** Пишем ли телеметрию при этом режиме. Неуказанный режим = пишем. */
export function isTelemetryEnabled(mode: TelemetryMode | undefined): boolean {
  return (mode ?? 'enabled') === 'enabled';
}

/**
 * Записать находку consistency-gate. Никогда не блокирует ответ и никогда не
 * бросает: неудачная запись телеметрии не имеет права уронить ответ клиенту.
 */
export function recordHallucinationLog(
  mode: TelemetryMode | undefined,
  entry: HallucinationLogEntry
): void {
  if (!isTelemetryEnabled(mode)) return;

  prisma.hallucinationLog
    .create({ data: entry })
    .catch((e) => console.warn('[answer-telemetry] HallucinationLog write failed:', e));
}
