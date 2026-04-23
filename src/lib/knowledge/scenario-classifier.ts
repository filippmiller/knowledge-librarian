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

export type ScenarioDecision =
  | { kind: 'scenario_clear'; scenarioKey: ScenarioKey; scenarioLabel: string; confidence: number; reasoning?: string }
  | { kind: 'needs_clarification'; atNodeKey: ScenarioKey; disambiguation: Disambiguation; reasoning?: string }
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
  const userPrompt = `Таксономия сценариев:
${taxonomySummary()}

Вопрос пользователя: "${question}"

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
