/**
 * Machine-readable oracle для 6 negative-кейсов (план §0.3 [R4a], PR H).
 *
 * ЗАЧЕМ. У negative-кейса в поставленном пакете есть только `expected_behavior`
 * и текст ожидаемого ответа. По ним можно проверить красивую прозу, но нельзя
 * доказать, что applicability engine принял ВЕРНОЕ решение: для `Q05-N1` нужно
 * утверждать, что правило 5 не было выбрано, а не что модель удачно написала
 * «нет». Ровно этот ложноположительный исход план и называет опасным.
 *
 * ПОЧЕМУ SIDECAR, А НЕ ПРАВКА ПАКЕТА. Поставленный acceptance pack остаётся
 * нетронутым, а правило изоляции сводится к одной проверяемой фразе: движку
 * разрешён РОВНО ОДИН файл пакета — DOCX. Всё остальное здесь — oracle.
 *
 * КОДЫ ПРИЧИН ПРОВЕРЯЮТСЯ ПО РЕЕСТРАМ B2. Иллюстративный код из плана
 * (`public_place_condition_not_satisfied`) в системе не существует: реальные
 * коды выводятся из `TRIGGER_FACT_REGISTRY`/`FACET_REGISTRY`. Sidecar,
 * ссылающийся на несуществующий код, — это ворота, ожидающие того, чего движок
 * никогда не выдаст, поэтому схема отвергает такой код при загрузке.
 */

import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { parseJsonl } from '@/lib/knowledge/applicability/jsonl';
import {
  ELIGIBILITY_REASON_CODES,
  RESOLUTION_REASON_CODES,
  SCOPE_REASON_CODES,
  TRIGGER_REASON_CODES,
} from '@/lib/knowledge/applicability/reasons';
import { ORACLE_PACK_DIR } from './semantic-rule-oracle';

const SIDECAR_FILENAME = 'negative_case_applicability_oracle.jsonl';

/** Полное пространство кодов причин, которые движок вообще способен выдать. */
export const KNOWN_REASON_CODES: readonly string[] = Object.freeze([
  ...SCOPE_REASON_CODES,
  ...TRIGGER_REASON_CODES,
  ...ELIGIBILITY_REASON_CODES,
  ...RESOLUTION_REASON_CODES,
]);

const knownReasonCodeSet = new Set(KNOWN_REASON_CODES);

const ruleIdSchema = z.number().int().min(1).max(10);

const reasonCodeSchema = z.string().superRefine((code, ctx) => {
  if (!knownReasonCodeSet.has(code)) {
    ctx.addIssue({
      code: 'custom',
      message: `неизвестный код причины «${code}» — движок такого не выдаёт`,
    });
  }
});

export interface NumericAssertion {
  readonly value: number;
  readonly unit: string;
}

export interface NegativeCaseApplicabilityOracle {
  readonly id: string;
  readonly expectedDisposition: 'DIRECT_ANSWER' | 'HOLD';
  /** Должны попасть в пул кандидатов ДО применения правил годности. */
  readonly requiredCandidateRuleIds?: readonly number[];
  /** Должны оказаться среди выбранных. */
  readonly requiredSelectedRuleIds?: readonly number[];
  /** НЕ должны оказаться среди выбранных — суть must_not_apply. */
  readonly forbiddenSelectedRuleIds?: readonly number[];
  /** Триггер-факты, отсутствие которых обязано вызвать уточнение. */
  readonly expectedMissingTriggerFacts?: readonly string[];
  readonly expectedReasonCodes?: readonly string[];
  readonly numericAssertions?: readonly NumericAssertion[];
}

const entrySchema = z
  .strictObject({
    id: z.string().min(1),
    expectedDisposition: z.enum(['DIRECT_ANSWER', 'HOLD']),
    requiredCandidateRuleIds: z.array(ruleIdSchema).optional(),
    requiredSelectedRuleIds: z.array(ruleIdSchema).optional(),
    forbiddenSelectedRuleIds: z.array(ruleIdSchema).optional(),
    expectedMissingTriggerFacts: z.array(z.string().min(1)).optional(),
    expectedReasonCodes: z.array(reasonCodeSchema).optional(),
    numericAssertions: z
      .array(z.strictObject({ value: z.number(), unit: z.string().min(1) }))
      .optional(),
  })
  .superRefine((entry, ctx) => {
    const forbidden = new Set(entry.forbiddenSelectedRuleIds ?? []);
    for (const required of entry.requiredSelectedRuleIds ?? []) {
      if (forbidden.has(required)) {
        ctx.addIssue({
          code: 'custom',
          message: `правило ${required} одновременно обязательно и запрещено — утверждение противоречиво`,
        });
      }
    }
  });

export function parseNegativeCaseOracle(text: string): NegativeCaseApplicabilityOracle[] {
  return parseJsonl(text, entrySchema);
}

export function loadNegativeCaseOracle(): NegativeCaseApplicabilityOracle[] {
  const sidecarPath = path.join(ORACLE_PACK_DIR, SIDECAR_FILENAME);
  return parseNegativeCaseOracle(fs.readFileSync(sidecarPath, 'utf8'));
}
