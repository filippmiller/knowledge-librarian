/**
 * Test oracle учебного пакета (план §0.3, Beads translation-yz9 / PR H).
 *
 * ГРАНИЦА ИЗОЛЯЦИИ. Правило §0.3 №3: «Grader/раннер может читать oracle. Сам
 * движок — нет». Этот модуль — единственная разрешённая точка чтения oracle,
 * и импортировать его вправе только раннер/грейдер. Любой импорт из движка
 * (retrieval, extraction, synthesis) делает прогон недействительным — на это
 * есть отдельный тест изоляции, а не только договорённость.
 *
 * Из всего пакета движку разрешён РОВНО ОДИН файл — `SOURCE_DOCX_FILENAME`.
 * Всё остальное в `ORACLE_PACK_DIR` — oracle.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseJsonl } from '@/lib/knowledge/applicability/jsonl';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Каталог acceptance pack. Всё здесь, кроме DOCX, — oracle. */
export const ORACLE_PACK_DIR = path.resolve(
  HERE,
  '../../../scripts/fixtures/semantic-rule-extraction-test-pack'
);

/** Единственный файл пакета, который разрешено загружать в систему (§0.3 №1). */
export const SOURCE_DOCX_FILENAME =
  'uchebnaya_instrukciya_semanticheskoe_izvlechenie_pravil.docx';

const ORACLE_JSONL_FILENAME = 'test_cases_semantic_rules.jsonl';

/**
 * Правил в учебном документе ровно десять, и `expected_rule_ids` ссылается
 * на их нумерацию. Диапазон проверяется схемой: опечатка в oracle должна
 * падать при загрузке, а не превращаться в тихо недостижимый кейс.
 */
const ruleIdSchema = z.number().int().min(1).max(10);

/**
 * Непустая строка ПОСЛЕ обрезки пробелов. `min(1)` пропускал `" "` и `"	"`,
 * и грейдер молча оставался с пустым ожидаемым ответом или пустым вопросом.
 */
const meaningfulText = z
  .string()
  .refine((value) => value.trim().length > 0, 'ожидается непустой текст, а не пробелы');

export const NEGATIVE_BEHAVIORS = ['must_clarify', 'must_not_apply'] as const;
export type NegativeBehavior = (typeof NEGATIVE_BEHAVIORS)[number];

export interface NegativeCase {
  readonly id: string;
  readonly question: string;
  readonly expectedBehavior: NegativeBehavior;
  readonly expectedAnswer: string;
  readonly matchReason: string;
}

export interface OracleCase {
  readonly id: string;
  readonly question: string;
  readonly expectedRuleIds: readonly number[];
  readonly expectedAnswer: string;
  readonly matchReason: string;
  readonly negativeCases: readonly NegativeCase[];
}

const negativeCaseSchema = z
  .strictObject({
    id: meaningfulText,
    question: meaningfulText,
    expected_behavior: z.enum(NEGATIVE_BEHAVIORS),
    expected_answer: meaningfulText,
    match_reason: meaningfulText,
  })
  .transform(
    (raw): NegativeCase => ({
      id: raw.id,
      question: raw.question,
      expectedBehavior: raw.expected_behavior,
      expectedAnswer: raw.expected_answer,
      matchReason: raw.match_reason,
    })
  );

const oracleCaseSchema = z
  .strictObject({
    id: meaningfulText,
    question: meaningfulText,
    expected_rule_ids: z.array(ruleIdSchema).min(1),
    expected_answer: meaningfulText,
    match_reason: meaningfulText,
    negativeCases: z.array(negativeCaseSchema).optional(),
  })
  .transform(
    (raw): OracleCase => ({
      id: raw.id,
      question: raw.question,
      expectedRuleIds: raw.expected_rule_ids,
      expectedAnswer: raw.expected_answer,
      matchReason: raw.match_reason,
      negativeCases: raw.negativeCases ?? [],
    })
  );

/** Разбирает oracle-JSONL. Строгая схема: лишнее поле — ошибка, не подсказка. */
export function parseSemanticRuleOracle(text: string): OracleCase[] {
  return parseJsonl(text, oracleCaseSchema);
}

/** Читает зафиксированный в git acceptance pack. Только для раннера/грейдера. */
export function loadSemanticRuleOracle(): OracleCase[] {
  const jsonlPath = path.join(ORACLE_PACK_DIR, ORACLE_JSONL_FILENAME);
  return parseSemanticRuleOracle(fs.readFileSync(jsonlPath, 'utf8'));
}
