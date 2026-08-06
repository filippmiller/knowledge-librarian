import { z } from 'zod';
import type { QueryFrame } from './query-frame';
import { triggerReason, type TriggerReasonCode, type TriggerSituation } from './reasons';
import {
  TRIGGER_FACT_REGISTRY,
  type ConsentStatus,
  type PrivacyContext,
  type Reachability,
  type TriggerFactKey,
} from './trigger-facts';

/**
 * `triggerCondition` — когда включается `EXCEPTION_RULE` (truth table §4.1 п.2).
 *
 * Условие выражается В ТЕРМИНАХ `TRIGGER_FACT_REGISTRY`, а не свободным
 * текстом: строка «в общественном месте» не сравнима с чем-либо программно, и
 * evaluator был бы вынужден угадывать. Truth table §8 оставляет структуру
 * данных открытым вопросом Задачи 2.4 — здесь вводится минимальная форма,
 * которой хватает всем четырём кейсам учебной фикстуры (Q05/Q05-N1 — место,
 * Q09-N1 — согласие, Q10/Q10-N1 — подвижность), и ни ключа больше.
 *
 * Дизъюнкция и отрицание сознательно НЕ вводятся: ни одно правило фикстуры их
 * не требует, а неиспользуемая форма условия — это код, поведение которого
 * никто не проверял.
 */
export type TriggerClause =
  | { readonly fact: 'privacyContext'; readonly equals: PrivacyContext }
  | { readonly fact: 'consentStatus'; readonly equals: ConsentStatus }
  | { readonly fact: 'reachability'; readonly equals: Reachability }
  | { readonly fact: 'helperPresent'; readonly equals: boolean };

export interface TriggerCondition {
  /**
   * Конъюнкция. Пустой список запрещён схемой: условие, не ограничивающее
   * ничего, делает исключение активным всегда — то есть перестаёт быть
   * исключением и начинает молча переопределять родительское правило.
   */
  readonly all: readonly TriggerClause[];
}

export const triggerClauseSchema = z.discriminatedUnion('fact', [
  z.strictObject({
    fact: z.literal('privacyContext'),
    equals: TRIGGER_FACT_REGISTRY.privacyContext.valueSchema,
  }),
  z.strictObject({
    fact: z.literal('consentStatus'),
    equals: TRIGGER_FACT_REGISTRY.consentStatus.valueSchema,
  }),
  z.strictObject({
    fact: z.literal('reachability'),
    equals: TRIGGER_FACT_REGISTRY.reachability.valueSchema,
  }),
  z.strictObject({
    fact: z.literal('helperPresent'),
    equals: TRIGGER_FACT_REGISTRY.helperPresent.valueSchema,
  }),
]);

export const triggerConditionSchema = z
  .strictObject({
    all: z.array(triggerClauseSchema).min(1).readonly(),
  })
  .superRefine((condition, ctx) => {
    const seen = new Set<string>();
    for (const clause of condition.all) {
      if (seen.has(clause.fact)) {
        ctx.addIssue({
          code: 'custom',
          path: ['all'],
          // Два условия на один факт — либо дубль, либо противоречие
          // (`PRIVATE` И `PUBLIC` одновременно). Оба случая означают, что
          // условие собрано неверно, и оба тихо давали бы INACTIVE навсегда.
          message: `факт "${clause.fact}" встречается в условии дважды`,
        });
      }
      seen.add(clause.fact);
    }
  });

type Assert<T extends true> = T;
type _SchemaMatchesInterface = Assert<
  z.infer<typeof triggerConditionSchema> extends TriggerCondition ? true : false
>;
type _InterfaceMatchesSchema = Assert<
  TriggerCondition extends z.infer<typeof triggerConditionSchema> ? true : false
>;

/**
 * `INACTIVE` — «условие точно не выполнено», `UNKNOWN` — «мы не знаем».
 * Разные вещи: первое позволяет спокойно отвечать общим правилом, второе
 * означает, что отвечать общим правилом = угадывать (§4.1 п.2 + ворота
 * `Q05-M1`/`Q01-M1`).
 */
export type TriggerVerdict = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';

export interface TriggerClauseVerdict {
  readonly fact: TriggerFactKey;
  readonly situation: TriggerSituation;
  readonly reason: TriggerReasonCode;
}

export interface TriggerDecision {
  readonly verdict: TriggerVerdict;
  readonly clauseVerdicts: readonly TriggerClauseVerdict[];
  readonly satisfiedFacts: readonly TriggerFactKey[];
  readonly violatedFacts: readonly TriggerFactKey[];
  /**
   * Ситуационные факты, которых не хватает.
   *
   * Отдельное поле, а НЕ `missingFacets`: отсутствие места или согласия — не
   * пробел в разметке знания, а пробел в описании ситуации, и лечится он другим
   * уточняющим вопросом. Слить их в одно поле значило бы снова смешать два
   * разных понятия (план, [R4b]).
   */
  readonly missingFacts: readonly TriggerFactKey[];
  readonly requiresClarification: boolean;
  readonly reasons: readonly TriggerReasonCode[];
}

/**
 * Активно ли условие исключения для этого запроса — truth table §4.1 п.2
 * (Stage B: всё ещё unit × query, но по ситуационным фактам, а не по фасетам).
 *
 * Читается ИСКЛЮЧИТЕЛЬНО `query.triggerFacts`. `query.facets` здесь не
 * используется и использоваться не может: truth table §6 разводит два класса
 * сигналов на живом примере — «прихватило в автобусе» это признак публичного
 * места для `triggerCondition`, а НЕ geography-фасета. Вывести `privacyContext`
 * из `deliveryCity` значило бы вернуть ровно ту ошибку, ради которой
 * `TRIGGER_FACT_REGISTRY` живёт отдельным реестром.
 */
export function evaluateTrigger(
  triggerCondition: TriggerCondition,
  query: QueryFrame
): TriggerDecision {
  const clauseVerdicts: TriggerClauseVerdict[] = [];
  const satisfiedFacts: TriggerFactKey[] = [];
  const violatedFacts: TriggerFactKey[] = [];
  const missingFacts: TriggerFactKey[] = [];
  const reasons: TriggerReasonCode[] = [];

  // Пустая конъюнкция истинна вакуумно — и это ровно тот способ, которым
  // сломанные данные молча активируют исключение ВСЕГДА. Схема такое условие
  // отвергает, но функция экспортируется и типом пустой массив разрешён,
  // поэтому проверка дублируется здесь: fail-closed в UNKNOWN (исключение не
  // активируется, кандидат удерживается), а не ACTIVE.
  if (triggerCondition.all.length === 0) {
    return {
      verdict: 'UNKNOWN',
      clauseVerdicts: [],
      satisfiedFacts: [],
      violatedFacts: [],
      missingFacts: [],
      requiresClarification: false,
      reasons: ['trigger_condition_empty'],
    };
  }

  for (const clause of triggerCondition.all) {
    const factState = query.triggerFacts[clause.fact];

    let situation: TriggerSituation;
    if (factState.state === 'UNKNOWN') {
      situation = 'unknown';
      missingFacts.push(clause.fact);
    } else if (factState.value === clause.equals) {
      situation = 'satisfied';
      satisfiedFacts.push(clause.fact);
    } else {
      situation = 'violated';
      violatedFacts.push(clause.fact);
    }

    const reason = triggerReason(clause.fact, situation);
    clauseVerdicts.push({ fact: clause.fact, situation, reason });
    reasons.push(reason);
  }

  // Конъюнкция: один достоверно нарушенный факт делает всё условие достоверно
  // ложным, независимо от того, что неизвестно про остальные. Поэтому
  // `violated` доминирует над `unknown`, а не наоборот.
  const verdict: TriggerVerdict =
    violatedFacts.length > 0 ? 'INACTIVE' : missingFacts.length > 0 ? 'UNKNOWN' : 'ACTIVE';

  return {
    verdict,
    clauseVerdicts,
    satisfiedFacts,
    violatedFacts,
    missingFacts,
    requiresClarification: verdict === 'UNKNOWN',
    reasons,
  };
}
