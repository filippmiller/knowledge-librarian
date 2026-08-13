/**
 * Сегментация исходного DOCX на пронумерованные правила (план §0.3 [R4a],
 * Beads translation-yz9 / PR H).
 *
 * ЗАЧЕМ ЭТО ЖИВЁТ У РАННЕРА, А НЕ В ДВИЖКЕ. Oracle говорит
 * `expected_rule_ids: [4]`, но экстракция дробит правило 4 на несколько units
 * с хэшированными `unitId`. Без связи «unit → номер исходного правила»
 * recall@5 невозможно посчитать детерминированно.
 *
 * При этом §0.3 требует, чтобы `sourceRuleId` НЕ попадал в `retrievalText` —
 * иначе поиск сможет читерить по номеру правила вместо поиска по смыслу.
 * Сегментация выполняется раннером и сопоставляется с units по anchor уже
 * ПОСЛЕ извлечения, поэтому номер правила физически не проходит через движок,
 * а не «не должен проходить по договорённости».
 *
 * Нумерация читается из структуры документа регулярным выражением — не
 * генерируется LLM (прямое требование плана).
 */

import path from 'node:path';
import mammoth from 'mammoth';
import { ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from './semantic-rule-oracle';

/**
 * Начало правила: номер в начале АБЗАЦА, точка, заголовок, точка.
 * Якорь `^` обязателен — в преамбуле есть «УЧЕБНАЯ ИНСТРУКЦИЯ № 04», и
 * неякорёный поиск числа принял бы её за правило 4.
 */
const RULE_HEADING = /^(\d+)\.\s+([^.]+)\./;

export interface SourceRule {
  /** Номер правила из документа, 1–10. Часть evaluation provenance. */
  readonly sourceRuleId: number;
  /** Заголовок правила («Уединение и доступ»). */
  readonly title: string;
  /** Полный текст абзаца правила. */
  readonly text: string;
  /** Индекс абзаца в документе — основа стабильного anchor. */
  readonly paragraphIndex: number;
}

/**
 * Разбивает текст документа на правила.
 *
 * Отсутствие правил — пустой результат (документ мог быть без нумерации), но
 * ЛЮБАЯ аномалия самой нумерации (дубль, разрыв, старт не с единицы) — это
 * исключение: молча потерянное правило 7 превратилось бы в необъяснимый провал
 * кейса Q07 на стадии retrieval, где искать причину дороже всего.
 */
export function segmentSourceRules(rawText: string): SourceRule[] {
  const paragraphs = rawText.split(/\n+/).map((p) => p.trim());
  const rules: SourceRule[] = [];

  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    if (paragraph.length === 0) continue;

    const match = RULE_HEADING.exec(paragraph);
    if (match === null) continue;

    rules.push({
      sourceRuleId: Number(match[1]),
      title: match[2].trim(),
      text: paragraph,
      paragraphIndex,
    });
  }

  assertContiguousNumbering(rules);
  return rules;
}

function assertContiguousNumbering(rules: readonly SourceRule[]): void {
  if (rules.length === 0) return;

  const seen = new Set<number>();
  for (const rule of rules) {
    if (seen.has(rule.sourceRuleId)) {
      throw new Error(
        `segmentSourceRules: дубль номера правила ${rule.sourceRuleId} — структура документа неоднозначна`
      );
    }
    seen.add(rule.sourceRuleId);
  }

  for (let expected = 1; expected <= rules.length; expected++) {
    if (!seen.has(expected)) {
      throw new Error(
        `segmentSourceRules: в нумерации отсутствует правило ${expected} — сегментация потеряла абзац`
      );
    }
  }
}

/**
 * Читает учебный DOCX и сегментирует его. DOCX — единственный файл пакета,
 * который разрешено подавать в систему (§0.3 №1); oracle-файлы здесь не
 * открываются.
 */
export async function loadSourceRulesFromDocx(
  docxPath = path.join(ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME)
): Promise<SourceRule[]> {
  const { value } = await mammoth.extractRawText({ path: docxPath });
  return segmentSourceRules(value);
}
