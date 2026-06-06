// Scenario decision gate — runs BEFORE retrieval.
//
// Given a user question and the scenario taxonomy, decide one of:
//   1) SCENARIO_CLEAR     — we know exactly which leaf procedure applies
//   2) NEEDS_CLARIFICATION — question maps to a non-leaf node; need to ask user
//   3) OUT_OF_SCOPE       — question isn't about anything in our KB
//
// The gate is the single point where we enforce: "do not synthesize an answer
// if we don't know which scenario applies". All retrieval downstream is
// scenario-filtered, so a wrong gate decision produces a wrong answer — we'd
// rather ask a question than guess.

import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';
import {
  SCENARIOS,
  childrenOf,
  isLeaf,
  getScenario,
  type ScenarioKey,
  type ScenarioNode,
  type Disambiguation,
} from './scenarios';
import { expandAbbreviations } from './glossary';

export type ScenarioDecision =
  | { kind: 'scenario_clear'; scenarioKey: ScenarioKey; scenarioLabel: string; confidence: number; reasoning?: string }
  | { kind: 'needs_clarification'; atNodeKey: ScenarioKey; disambiguation: Disambiguation; reasoning?: string }
  | { kind: 'knowledge_lookup'; label: string; reasoning: string }
  | { kind: 'out_of_scope'; reasoning: string };

/** Compact representation of the taxonomy for the LLM — just keys, labels,
 *  facets, and parent structure. ~500 tokens regardless of tree size. */
function taxonomySummary(): string {
  const lines: string[] = [];
  function walk(parentKey: ScenarioKey | null, indent: string) {
    const children = Object.values(SCENARIOS).filter((n) => n.parentKey === parentKey);
    for (const n of children) {
      const facets = [
        n.facets.authority && `authority=${n.facets.authority}`,
        n.facets.region && `region=${n.facets.region}`,
        n.facets.docTypes && `docTypes=[${n.facets.docTypes.join(',')}]`,
      ].filter(Boolean).join(' ');
      const leaf = isLeaf(n.key) ? ' [leaf]' : '';
      lines.push(`${indent}${n.key}${leaf} — "${n.label}"${facets ? '  (' + facets + ')' : ''}`);
      if (n.description) lines.push(`${indent}  ↳ ${n.description}`);
      walk(n.key, indent + '  ');
    }
  }
  walk(null, '');
  return lines.join('\n');
}

const CLASSIFIER_PROMPT = `Ты — scenario-классификатор для системы знаний.

У нас есть древовидная таксономия процедур (сценариев). Твоя задача: определить, к какому УЗЛУ в дереве относится вопрос пользователя.

ВАЖНО:
- Если вопрос недвусмысленно указывает на конкретную листовую процедуру (leaf) — возвращай её ключ.
- Если вопрос попадает в промежуточный узел и нельзя однозначно выбрать из его детей — возвращай ключ промежуточного узла (система сама задаст уточняющий вопрос, не надо его сочинять).
- Если вопрос НЕ относится ни к одной из процедур (out_of_scope) — возвращай null.

Правила выбора:
1. Явные указатели (СПб, Ленинградская область, МЮ, КЗАГС, нотариальный, свидетельство ЗАГС) — используй их.
2. Если указателей мало или они противоречивы — возвращай промежуточный узел.
3. Если вопрос совсем короткий ("АПОСТИЛЬ") и это верхний узел таксономии — возвращай его ключ.

Ответ СТРОГО JSON:
{
  "scenarioKey": "apostille.zags.spb" | "apostille.zags" | "apostille" | null,
  "outOfScope": true | false,
  "reasoning": "краткое (1 предложение) объяснение выбора"
}`;

export async function classifyScenario(question: string): Promise<ScenarioDecision> {
  // Expand bureau abbreviations (СОР→свидетельство о рождении, КЗАГС→…) so both
  // the deterministic rules and the LLM see canonical terms instead of guessing.
  const q = expandAbbreviations(question);

  const deterministicDecision = classifyScenarioDeterministically(q);
  if (deterministicDecision) return deterministicDecision;

  const userPrompt = `Таксономия сценариев:
${taxonomySummary()}

Вопрос пользователя: "${q}"

Определи узел в таксономии (или out_of_scope).`;

  let raw: string | undefined;
  try {
    raw = (await createChatCompletion({
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      maxTokens: 256,
      responseFormat: 'json_object',
    })) ?? undefined;
  } catch (err) {
    console.error('[scenario-classifier] LLM call failed:', err);
    return { kind: 'out_of_scope', reasoning: 'classifier failed' };
  }

  if (!raw) {
    return { kind: 'out_of_scope', reasoning: 'classifier empty response' };
  }

  let parsed: { scenarioKey?: unknown; outOfScope?: unknown; reasoning?: unknown };
  try {
    parsed = JSON.parse(normalizeJsonResponse(raw));
  } catch (err) {
    console.error('[scenario-classifier] JSON parse failed:', err, 'raw:', raw.slice(0, 300));
    return { kind: 'out_of_scope', reasoning: 'classifier returned invalid JSON' };
  }

  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;

  if (parsed.outOfScope === true || parsed.scenarioKey === null || parsed.scenarioKey === undefined) {
    return { kind: 'out_of_scope', reasoning: reasoning ?? 'classifier marked out_of_scope' };
  }

  if (typeof parsed.scenarioKey !== 'string') {
    return { kind: 'out_of_scope', reasoning: 'classifier returned non-string key' };
  }

  const node: ScenarioNode | undefined = getScenario(parsed.scenarioKey);
  if (!node) {
    // LLM hallucinated a key. Be strict — treat as out_of_scope, log.
    console.warn('[scenario-classifier] LLM returned unknown key:', parsed.scenarioKey);
    return { kind: 'out_of_scope', reasoning: `unknown scenarioKey "${parsed.scenarioKey}"` };
  }

  if (isLeaf(node.key)) {
    return {
      kind: 'scenario_clear',
      scenarioKey: node.key,
      scenarioLabel: node.label,
      confidence: 0.9, // LLM-declared "clear" — real confidence comes from retrieval downstream
      reasoning,
    };
  }

  // Non-leaf: needs clarification. The node MUST have disambiguation defined
  // (enforced by assertTaxonomyConsistency). Fall back sensibly if not.
  if (!node.disambiguation) {
    // Non-leaf without disambig = taxonomy bug, but don't crash. Pick first
    // child and let retrieval fallback work as before.
    const children = childrenOf(node.key);
    if (children.length === 1) {
      const only = children[0];
      return {
        kind: 'scenario_clear',
        scenarioKey: only.key,
        scenarioLabel: only.label,
        confidence: 0.7,
        reasoning: `classifier chose non-leaf with single child; used child "${only.key}"`,
      };
    }
    console.error('[scenario-classifier] non-leaf without disambiguation:', node.key);
    return { kind: 'out_of_scope', reasoning: `taxonomy bug: non-leaf "${node.key}" has no disambiguation` };
  }

  return {
    kind: 'needs_clarification',
    atNodeKey: node.key,
    disambiguation: node.disambiguation,
    reasoning,
  };
}

function classifyScenarioDeterministically(question: string): ScenarioDecision | null {
  // All regexes use /iu flags and test the ORIGINAL question directly.
  // Do NOT call toLowerCase() or replace(/ё/г, 'е') — on Alpine Linux Node 20
  // (small-icu) those calls silently corrupt Cyrillic to U+FFFD, causing every
  // pattern to fail. The /i flag handles case, /u enables proper Unicode semantics.
  const mentionsApostille = /апостил/iu.test(question);
  const mentionsZags = /загс/iu.test(question);
  const mentionsConsularLegalization =
    /консульск[а-яёa-z]*\s+легализац|легализац[а-яёa-z]*\s+.*консульск|(?:^|[^а-яё])кл(?:[^а-яё]|$)/iu.test(question);
  const mentionsOperationalChecklist =
    /(?:^|[^а-яё])лид(?:а|е|ом|ы|ов)?(?:[^а-яё]|$)|сделк|бланк|битрикс|bitrix|карточк[а-яёa-z]*\s+(?:лид|сделк)/iu.test(question);
  const mentionsInternalOperations =
    /почт[а-яёa-z]*\s+росси|отправк[а-яёa-z]*\s+почт|наливайк|шушар|хранен|выдач[а-яёa-z]*\s+заказ|готов[а-яёa-z]*\s+заказ|машинн[а-яёa-z]*\s+перевод|молдавск|молдавск[а-яёa-z]*\s+язык|исходник|скан|маршрутн[а-яёa-z]*\s+лист|упд|эдо|фиксац[а-яёa-z]*\s+ошиб/iu.test(question);
  const asksCatalog =
    /(?:какие|какой|назов|перечисл|список|виды|типы|можешь\s+.*назвать|что\s+есть)/iu.test(question)
    && /документ|свидетельств|справк/iu.test(question);
  const asksReference =
    /(?:что\s+нужно\s+знать|как\s+заполн|как\s+делать|что\s+делать|процедур|порядок|инструкц|чек\s*-?\s*лист|можно\s+апостилир|нельзя\s+апостилир|для\s+каких\s+стран|какие\s+страны|нужна\s+ли)/iu.test(question);
  // NB: Russian tails must be [а-яё]*, NOT \w* — JS \w is ASCII-only and cannot
  // bridge a Cyrillic suffix to the next token, so "министерство юстиции" would
  // silently fail to match with \w*.
  const mentionsMinJustice = /мин\s*юст|минюст|(?:^|[^а-яё])мю(?:[^а-яё]|$)|министерств[а-яё]*\s+юстиц/iu.test(question);
  const mentionsSpb = /санкт\s*петербург|петербург|(?:^|[^а-яё])спб(?:[^а-яё]|$)/iu.test(question);
  const mentionsMoscow = /москв/iu.test(question);
  const mentionsEducation = /образован|диплом|аттестат|вуз|университет|колледж|школ/iu.test(question);
  const asksCountryRequirement = /нуж[а-яё]*|требу[а-яё]*|став[а-яё]*|простав[а-яё]*|не\s+нуж/iu.test(question);
  // A GENERAL requirement that is the same across every apostille scenario
  // (lamination, document condition, language, who submits). Such questions
  // must NOT be bounced to "which document type?" — the answer is universal and
  // lives in cross-scenario rules; route them to open knowledge lookup.
  // NB: \w does NOT match Cyrillic in JS — use [а-яё]* for word tails, else
  // "юридическ\w*" fails on "юридическ-ого".
  const asksGeneralRequirement =
    /ламинир|заламинир|состояни[а-яё]*\s+документ|поврежд|порван|ветх|на\s+каком\s+язык|язык[а-яё]*\s+документ|сшит|многостранич|требовани[а-яё]*\s+к\s+(?:документ|оригинал)|(?:^|[^а-яё])юр[а-яё]*\s*лиц|юридическ[а-яё]*\s+лиц|(?:^|[^а-яё])физ[а-яё]*\s*лиц|физическ[а-яё]*\s+лиц/iu.test(question);
  const mentionsTreatyCountry = /(азербайджан|албани|армени|белорус|болгари|босни|венгри|грузи|казахстан|киргиз|куб|латви|литв|молдов|монголи|польш|румын|серби|словени|таджикистан|узбекистан|украин|хорвати|черногори|чехи|эстони)/iu.test(question);

  if (mentionsApostille && mentionsSpb && mentionsMoscow && !mentionsEducation) {
    return {
      kind: 'out_of_scope',
      reasoning: 'Документ выдан в Москве, а СПб-сценарии покрывают только местные/ЛО документы; нужен guardrail по региону выдачи.',
    };
  }

  if (mentionsConsularLegalization) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по консульской легализации',
      reasoning: 'Вопрос про консульскую легализацию относится к общим материалам базы знаний, а не к сценарному дереву апостиля.',
    };
  }

  if (mentionsOperationalChecklist) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по операционным чек-листам',
      reasoning: 'Вопрос про лид, сделку или бланк должен идти в открытый поиск по базе знаний.',
    };
  }

  if (mentionsInternalOperations) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по внутренним инструкциям',
      reasoning: 'Вопрос относится к внутренним операционным инструкциям и должен идти в открытый поиск по базе знаний.',
    };
  }

  if (mentionsZags && asksCatalog && !mentionsApostille) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по базе знаний',
      reasoning: 'Справочный список документов ЗАГС должен идти в открытый поиск по базе, а не в региональную развилку апостиля.',
    };
  }

  if (mentionsApostille && asksCountryRequirement && mentionsTreatyCountry) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по требованиям к апостилю',
      reasoning: 'Вопрос про необходимость апостиля для страны; нужен открытый поиск по базе, а не сценарий подачи в конкретное ведомство.',
    };
  }

  if (mentionsApostille && asksReference && !mentionsMinJustice) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по апостилю',
      reasoning: 'Справочный вопрос по апостилю должен использовать общие материалы базы знаний, если пользователь не выбирает конкретное ведомство подачи.',
    };
  }

  if (mentionsApostille && mentionsMinJustice) {
    return {
      kind: 'scenario_clear',
      scenarioKey: 'apostille.min_justice',
      scenarioLabel: getScenario('apostille.min_justice')?.label ?? 'Апостиль в МинЮсте',
      confidence: 0.95,
      reasoning: 'Вопрос явно содержит апостиль и Минюст/МЮ.',
    };
  }

  // General apostille requirement (lamination/condition/language/who-submits)
  // with no specific authority chosen → open lookup, NOT a doc-type re-ask.
  if (mentionsApostille && asksGeneralRequirement) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по общим требованиям апостиля',
      reasoning: 'Общее требование к документу одинаково для всех сценариев апостиля; нужен открытый поиск по базе, а не выбор типа документа.',
    };
  }

  // P5: apostille + a clearly-named document type → route straight to the right
  // node so we never ask the user to re-pick a type they already named
  // ("доверенность" → option "Нотариальный (доверенность,…)"). Reaches here only
  // after the reference/catalog/country bypasses above, so справочные вопросы
  // still go to open lookup. Education is excluded (no scenario node — handled
  // by the bureau-topic open lookup downstream).
  if (mentionsApostille && !mentionsEducation) {
    const notaryDoc = /доверенност|нотариальн|нотариус|(?:^|[^а-яё])копи|перевод|согласие|довер/iu.test(question);
    const opekaDoc = /опек/iu.test(question);
    // СО[РБС] = abbreviations the bureau uses for ЗАГС certificates:
    // СОР (о рождении), СОБ (о браке), СОС (о смерти).
    const zagsDoc = /загс|свидетельств|(?:^|[^а-яё])со[рбс](?:[^а-яё]|$)|рожден|брак|растор|смерт|перемен.{0,4}имен|отцовств/iu.test(question);
    const mentionsLO = /ленинградск|лен\.?\s*обл/iu.test(question);

    // ЗАГС document (but NOT a notarized copy/translation of one — that goes to
    // МЮ as a notary doc). Region is the ONLY thing left to ask.
    if (zagsDoc && !notaryDoc && !opekaDoc) {
      if (mentionsSpb) {
        return {
          kind: 'scenario_clear',
          scenarioKey: 'apostille.zags.spb',
          scenarioLabel: getScenario('apostille.zags.spb')?.label ?? 'Апостиль в КЗАГС Санкт-Петербурга',
          confidence: 0.9,
          reasoning: 'Апостиль + ЗАГС-документ + Санкт-Петербург.',
        };
      }
      if (mentionsLO) {
        return {
          kind: 'scenario_clear',
          scenarioKey: 'apostille.zags.lo',
          scenarioLabel: getScenario('apostille.zags.lo')?.label ?? 'Апостиль в Управлении ЗАГС Ленинградской области',
          confidence: 0.9,
          reasoning: 'Апостиль + ЗАГС-документ + Ленинградская область.',
        };
      }
      const zagsNode = getScenario('apostille.zags');
      if (zagsNode?.disambiguation) {
        return {
          kind: 'needs_clarification',
          atNodeKey: 'apostille.zags',
          disambiguation: zagsNode.disambiguation,
          reasoning: 'Апостиль ЗАГС-документа; тип ясен, нужен только регион выдачи.',
        };
      }
    }

    // Notary or опека document → МинЮст (a leaf; accepts both СПб and ЛО, so no
    // region question). Answer directly.
    if (notaryDoc || opekaDoc) {
      return {
        kind: 'scenario_clear',
        scenarioKey: 'apostille.min_justice',
        scenarioLabel: getScenario('apostille.min_justice')?.label ?? 'Апостиль в МинЮсте',
        confidence: 0.9,
        reasoning: 'Апостиль нотариального/опекунского документа → МЮ, регион не требуется.',
      };
    }
  }

  // Apostille question aimed at a DESTINATION COUNTRY ("апостиль для Китая",
  // "нужен ли апостиль в Германию", "апостилировать документы для Италии").
  // These are about country requirements (Hague convention / treaties / КЛ),
  // NOT a document-submission scenario — route to open lookup over the country
  // lists instead of bouncing through "какой документ? → какой регион? → нет
  // данных". The negative lookahead excludes document nouns and domestic
  // regions so "апостиль для свидетельства" / "в спб" don't trigger.
  const mentionsDestinationCountry =
    /(?:для|в(?:о)?)\s+(?!докум|свидетельств|справк|диплом|перевод|оригинал|копи|нотари|загс|опек|юр|физ|клиент|себя|сам|любо|каки|како|этого|того|росси|рф(?:[^а-яё]|$)|спб|санкт|петербург|москв|ленинградск|област|город|регион|комитет|ведомств|учрежден|орган)[а-яё]{4,}/iu.test(question);
  if (mentionsApostille && mentionsDestinationCountry) {
    return {
      kind: 'knowledge_lookup',
      label: 'Справочный поиск по требованиям к апостилю для страны',
      reasoning: 'Вопрос про апостиль для страны назначения; нужен открытый поиск по страновым спискам (Гаагская конвенция / КЛ / договоры), а не выбор типа документа.',
    };
  }

  return null;
}
