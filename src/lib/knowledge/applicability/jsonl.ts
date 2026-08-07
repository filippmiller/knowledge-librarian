import type { z } from 'zod';

/**
 * Сериализация JSONL — единственный persistence-контракт PR F (план §3,
 * "JSONL безусловно, без альтернативы «может быть временная таблица»").
 * Одна строка = один JSON-объект: артефакт читаем `cat`/`grep`/`jq` без
 * специального тулинга (acceptance criterion).
 */

export function toJsonl<T>(items: readonly T[]): string {
  if (items.length === 0) return '';
  return items.map((item) => JSON.stringify(item)).join('\n') + '\n';
}

/**
 * Разбирает JSONL, валидируя КАЖДУЮ строку схемой. Битая строка (не JSON,
 * или не проходящая схему) — исключение с номером строки, а не тихий
 * пропуск: артефакт ревью не должен молча терять записи из-за одной порчи.
 * Пустые строки между записями игнорируются.
 */
export function parseJsonl<T>(text: string, schema: z.ZodType<T>): T[] {
  const lines = text.split('\n');
  const items: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`parseJsonl: строка ${lineNumber} — невалидный JSON: ${message}`);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `parseJsonl: строка ${lineNumber} — не проходит схему: ${result.error.message}`
      );
    }
    items.push(result.data);
  }

  return items;
}
