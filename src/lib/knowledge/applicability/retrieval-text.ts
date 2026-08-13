import { CONCEPT_VOCABULARY_BY_FACET } from './concept-registry';
import { isKnownConcept } from './concepts';
import { FACET_KEYS, type FacetKey } from './facets';
import type { PersistedKnowledgeUnit } from './identity-assignment';
import { TRIGGER_FACT_REGISTRY, type TriggerFactKey } from './trigger-facts';
import { getScenario } from '@/lib/knowledge/scenarios';

/**
 * Индексируемый текст unit'а (PR G, план §3). НЕ только `statement`:
 * "не более 15 секунд подряд" обязано находиться вопросом "как долго можно
 * водить пальцами", а изолированный statement числового фрагмента этого не
 * несёт — сематическая связь с "почёсыванием" живёт в РОДИТЕЛЬСКОМ unit'е,
 * в исходной цитате и в facets/условиях, не в самой фразе про секунды.
 */

function labelForFacetValue(key: FacetKey, value: string): string | undefined {
  const vocabulary = CONCEPT_VOCABULARY_BY_FACET[key];
  if (!vocabulary || !isKnownConcept(vocabulary, value)) return undefined;
  return vocabulary[value].label;
}

function facetsText(unit: PersistedKnowledgeUnit): string[] {
  const parts: string[] = [];
  for (const key of FACET_KEYS) {
    const value = unit.facets[key];
    if (value === undefined) continue;
    const label = labelForFacetValue(key, value);
    if (label) parts.push(label);
  }
  return parts;
}

/** `scenario`/`documentForm` — единственные facets БЕЗ записи в
 *  `CONCEPT_VOCABULARY_BY_FACET` (`concept-registry.ts`, "обрабатываются
 *  отдельно на месте использования"). `facetsText()` их поэтому молча
 *  пропускает — это то самое "место использования". */
const DOCUMENT_FORM_LABELS: Record<string, string> = {
  ORIGINAL: 'оригинал',
  SCAN: 'скан',
  COPY: 'копия',
};

function scenarioText(unit: PersistedKnowledgeUnit): string[] {
  const value = unit.facets.scenario;
  if (value === undefined) return [];
  const label = getScenario(value)?.label;
  return label ? [label] : [];
}

function documentFormText(unit: PersistedKnowledgeUnit): string[] {
  const value = unit.facets.documentForm;
  if (value === undefined) return [];
  const label = DOCUMENT_FORM_LABELS[value];
  return label ? [label] : [];
}

function triggerConditionText(unit: PersistedKnowledgeUnit): string[] {
  if (!unit.triggerCondition) return [];
  return unit.triggerCondition.all.map((clause) => {
    const fact = clause.fact as TriggerFactKey;
    const description = TRIGGER_FACT_REGISTRY[fact].description;
    return `${description}: ${String(clause.equals)}`;
  });
}

function numericConstraintText(unit: PersistedKnowledgeUnit): string[] {
  if (!unit.numericConstraint) return [];
  const { factKey, value, unit: measureUnit } = unit.numericConstraint;
  return [`${factKey}: ${value} ${measureUnit}`];
}

/**
 * Верхняя граница числа СОСЕДНИХ statement'ов (см. `siblingContextText`
 * ниже), которые Fix 2 (2026-08-11, контекст по `sourceBlockAnchor`) может
 * добавить в retrieval-текст одного unit'а. Источник блока может содержать
 * сколько угодно фрагментов (нумерованный список, длинная процедура); без
 * границы инъекция превратила бы retrieval-текст КАЖДОГО фрагмента в
 * пересказ ВСЕГО блока — ровно то, от чего предостерегает бриф этого фикса:
 * не «concatenate the whole block into every unit», иначе фрагменты внутри
 * одного блока перестают различаться при ретриве. Граница — число
 * ДОБАВЛЯЕМЫХ statement'ов, не символов: statement здесь уже намеренно
 * абстрагирован/короток (та же дисциплина экстракции, что и у соседних
 * `numericConstraintText`/`facetsText`), так что счётная граница на практике
 * даёт и умеренную границу по символам (для блока правила 4 регрессии,
 * `d9e946dfcdcb3d2a`, 4 чужих statement'а — это ~460 символов). Значение
 * подобрано так, чтобы покрыть ВЕСЬ реальный блок правила 4 (5 units, то
 * есть 4 ДРУГИХ соседа у каждого) — не общее «круглое число».
 */
const MAX_SIBLING_CONTEXT_UNITS = 4;

/**
 * Контекст от соседей по ОДНОМУ И ТОМУ ЖЕ `sourceBlockAnchor` — обобщение
 * логики «родитель на один уровень вверх» (см. комментарий над
 * `buildRetrievalText`) на форму, которая больше не полагается на
 * `parentRuleRef`. Обоснование ключа: живой прогон измерил `parentRuleRef`
 * ненадёжным между прогонами экстракции (дисциплинированная экстракция
 * больше не выдумывает общего родителя для совместно обязательных
 * фрагментов), тогда как `sourceBlockAnchor` — производная от позиции в
 * источнике, а не от потенциально отсутствующей связи экстракции — остаётся
 * стабильным (`translation-rw3`,
 * `.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md` §4).
 *
 * `alreadyIncluded` — statement'ы, уже присутствующие в тексте (свой
 * собственный + родительский, если инъекция родителя выше сработала):
 * дедупликация, чтобы один и тот же statement не попал в текст дважды — в
 * частности когда родитель и ребёнок делят один блок (типичная форма для
 * фикстур этого файла).
 *
 * Порядок — по `unitId` (лексикографически). Это единственный стабильный
 * ключ, доступный на уровне `PersistedKnowledgeUnit`: офсеты положения в
 * источнике НЕ переживают persistence (см. `PersistedKnowledgeUnit` в
 * `identity-assignment.ts` — из них считается `sourceBlockAnchor`, но сами
 * они на unit'е не хранятся), а порядок обхода `unitsById` зависит от того,
 * КАК вызывающий собрал Map, а не от положения unit'а в источнике. `unitId`
 * — непрозрачный хэш и не отражает порядок в документе, но он
 * ДЕТЕРМИНИРОВАН: тот же вход всегда даёт тот же порядок инъекции.
 */
function siblingContextText(
  unit: PersistedKnowledgeUnit,
  unitsById: ReadonlyMap<string, PersistedKnowledgeUnit>,
  alreadyIncluded: ReadonlySet<string>
): string[] {
  const siblings: PersistedKnowledgeUnit[] = [];
  for (const candidate of unitsById.values()) {
    if (candidate.unitId === unit.unitId) continue;
    if (candidate.sourceBlockAnchor !== unit.sourceBlockAnchor) continue;
    siblings.push(candidate);
  }
  siblings.sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));

  const seen = new Set(alreadyIncluded);
  const parts: string[] = [];
  for (const sibling of siblings) {
    if (parts.length >= MAX_SIBLING_CONTEXT_UNITS) break;
    const statement = sibling.statement;
    if (statement.length === 0 || seen.has(statement)) continue;
    seen.add(statement);
    parts.push(statement);
  }
  return parts;
}

/**
 * `unitsById` — все units этого прогона (или как минимум родители фрагментов
 * и их соседи по блоку). Родитель ищется по `unit.parentRuleRef` — после
 * preflight C (translation-djc) это ВСЕГДА либо настоящий `unitId`, либо
 * `null`, никогда сырая ссылка (`extractionRef`/anchor не переживают
 * persistence). `if (parent)` здесь — не откат на случай нерезолвившейся
 * ссылки, а защита от ситуации, когда `unitsById`, переданный ЭТИМ вызовом,
 * просто не включает родителя (например, родитель — в `ambiguousDuplicates`,
 * не в основном наборе units): контекст родителя опционален, а не обязателен
 * для построения текста. То же самое верно для соседей по
 * `sourceBlockAnchor` (`siblingContextText`) — их присутствие в `unitsById`
 * тоже опционально, отсутствие соседей просто не добавляет контекста.
 */
export function buildRetrievalText(
  unit: PersistedKnowledgeUnit,
  unitsById: ReadonlyMap<string, PersistedKnowledgeUnit>
): string {
  const parts: string[] = [];

  if (unit.title) parts.push(unit.title);
  parts.push(unit.statement);

  // РОВНО один уровень вверх, намеренно: закрывает регрессию Q04
  // (числовой фрагмент получает контекст своего прямого родителя). Цепочка
  // глубже одного уровня (фрагмент → фрагмент → базовое правило) сегодня НЕ
  // разворачивается — известное ограничение (независимое ревью этого PR),
  // не пропущенный случай: реальные фикстуры фрагментируются на один
  // уровень, а рекурсивный обход потребовал бы защиты от циклов
  // (parentRuleRef, ссылающийся сам на себя транзитивно), которой сегодня
  // негде взяться из PersistedKnowledgeUnit в отрыве от остального прогона.
  let parentStatement: string | null = null;
  if (unit.parentRuleRef !== null) {
    const parent = unitsById.get(unit.parentRuleRef);
    if (parent) {
      parentStatement = parent.statement;
      parts.push(parent.statement);
    }
  }

  // Fix 2 (2026-08-11): контекст СОСЕДЕЙ по `sourceBlockAnchor` — обобщение
  // пункта выше, которое больше не требует `parentRuleRef`. Реальный случай:
  // пять units правила 4 (лимит 15с непрерывного почёсывания / пауза 30с /
  // не более 3 циклов за эпизод) делят один `sourceBlockAnchor` и НЕ имеют
  // родителя вовсе — дисциплинированная экстракция перестала выдумывать для
  // них общего родителя, и вместе с ним пропал единственный источник
  // контекста, связывающего "лимит 15 секунд" с "почёсыванием". Действует
  // ДОПОЛНИТЕЛЬНО к пункту выше, не вместо него: если родитель есть и найден
  // в `unitsById`, его statement уже в `parts`/`parentStatement` и не
  // попадёт сюда повторно — `siblingContextText` дедуплицирует по точному
  // тексту statement'а через `alreadyIncluded`.
  parts.push(
    ...siblingContextText(
      unit,
      unitsById,
      new Set([unit.statement, ...(parentStatement !== null ? [parentStatement] : [])])
    )
  );

  parts.push(unit.sourceSpan.quote);
  parts.push(...facetsText(unit));
  parts.push(...scenarioText(unit));
  parts.push(...documentFormText(unit));
  parts.push(...triggerConditionText(unit));
  parts.push(...numericConstraintText(unit));

  return parts.filter((p) => p.length > 0).join('. ');
}
