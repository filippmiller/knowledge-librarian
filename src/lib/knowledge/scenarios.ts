// Scenario taxonomy — hierarchical, declarative.
//
// A "scenario" is a mutually exclusive procedure that must not be blended with
// siblings at synthesis time. Example: apostille on a notary document (МЮ) vs.
// apostille on a ЗАГС certificate from СПб (КЗАГС) vs. from ЛО (Управление ЗАГС ЛО).
// Each has a different authority, address, schedule, and constraints.
//
// Keys use dot-notation to encode the path in a single string:
//   "apostille"                ← top-level service (non-leaf)
//   "apostille.min_justice"    ← one of its procedures (leaf)
//   "apostille.zags"           ← intermediate grouping (non-leaf)
//   "apostille.zags.spb"       ← terminal scenario (leaf)
//
// A rule/chunk/QA with scenarioKey = "apostille" applies to ALL apostille
// procedures. A rule at "apostille.zags.spb" applies only to the СПб ЗАГС path.
// Retrieval must use the ancestor-path filter (see scenarioFilterClause below).
//
// Cross-service universal rules (apply everywhere in the KB) have
// scenarioKey = null. Rare but reserved — e.g., "компания закрыта в гос.
// праздники" applies to apostille AND translation AND everything else.

import type { Prisma } from '@prisma/client';

/**
 * A scenario's stable identity — dot-notation path from root to this node.
 * Valid examples: "apostille", "apostille.min_justice", "apostille.zags.spb".
 * Invalid: "" (empty), ".apostille" (leading dot), "APOSTILLE" (uppercase).
 */
export type ScenarioKey = string;

/** Facets are queryable slices orthogonal to the tree: "all СПб procedures",
 *  "all КЗАГС work", "all notary doc types". Populated per leaf; bubble up
 *  for querying via the `facetsOf` helper. */
export interface ScenarioFacets {
  taxonomy: string;            // always the top-level key: "apostille"
  authority?: string;          // "МЮ" | "КЗАГС" | "ЗАГС_ЛО"
  region?: string;             // "СПб" | "ЛО" | "спб_и_ло"
  docTypes?: readonly DocType[];
}

export type DocType = 'notary' | 'opeka' | 'zags' | 'translation';

/** A node in the scenario tree. */
export interface ScenarioNode {
  key: ScenarioKey;
  parentKey: ScenarioKey | null;
  label: string;               // shown to the user ("Апостиль в МинЮсте")
  description?: string;        // optional short hint for admins
  facets: ScenarioFacets;      // empty object allowed on non-leaf roots
  /** Present on non-leaf nodes with >1 child that need a user question to pick
   *  one of them. Absent on leaves (no further disambiguation possible). */
  disambiguation?: Disambiguation;
}

export interface Disambiguation {
  /** A user-facing question rendered above the option buttons. */
  prompt: string;
  /** Each option picks a child scenario OR descends to another disambiguation
   *  node (when its target is itself non-leaf). */
  options: DisambiguationOption[];
}

export interface DisambiguationOption {
  id: string;                  // stable machine id, e.g., "notary", "spb"
  label: string;               // user-facing button text
  /** Where this choice leads. Either a concrete scenario (terminal),
   *  or another non-leaf scenarioKey whose disambiguation will fire next. */
  targetScenarioKey: ScenarioKey;
}

// ────────────────────────────────────────────────────────────────────────────
// Taxonomy definition
//
// Keep this as the SINGLE SOURCE OF TRUTH for what scenarios exist. Adding a
// new scenario = adding a node here + re-running the backfill script. No
// database record of scenarios is maintained — they're code, versioned in git.
// ────────────────────────────────────────────────────────────────────────────

export const SCENARIOS: Record<string, ScenarioNode> = {
  // ─── APOSTILLE ─────────────────────────────────────────────────────────────
  apostille: {
    key: 'apostille',
    parentKey: null,
    label: 'Апостиль',
    facets: { taxonomy: 'apostille' },
    disambiguation: {
      // TODO(review wording): this is the FIRST question a user sees when they
      // ask something ambiguous like "АПОСТИЛЬ". The tone should match how the
      // operations team talks to their clients/translators. Edit freely.
      prompt: 'Какой документ нужно апостилировать?',
      options: [
        { id: 'notary', label: 'Нотариальный (доверенность, копия, перевод)', targetScenarioKey: 'apostille.min_justice' },
        { id: 'zags',   label: 'Свидетельство ЗАГС (о браке, рождении, смерти)', targetScenarioKey: 'apostille.zags' },
        { id: 'opeka',  label: 'Документ опеки',                                 targetScenarioKey: 'apostille.min_justice' },
      ],
    },
  },

  'apostille.min_justice': {
    key: 'apostille.min_justice',
    parentKey: 'apostille',
    label: 'Апостиль в МинЮсте',
    description: 'МЮ принимает нотариальные документы из СПб и ЛО (R-5). Опека тоже (R-62).',
    facets: {
      taxonomy: 'apostille',
      authority: 'МЮ',
      region: 'спб_и_ло',
      docTypes: ['notary', 'opeka'] as const,
    },
  },

  'apostille.zags': {
    key: 'apostille.zags',
    parentKey: 'apostille',
    label: 'Апостиль на свидетельство ЗАГС',
    description: 'Промежуточный узел. ЗАГС-документы жёстко разделены по региону выдачи.',
    facets: {
      taxonomy: 'apostille',
      docTypes: ['zags'] as const,
    },
    disambiguation: {
      prompt: 'Где был выдан документ?',
      options: [
        { id: 'spb', label: 'Санкт-Петербург',        targetScenarioKey: 'apostille.zags.spb' },
        { id: 'lo',  label: 'Ленинградская область',  targetScenarioKey: 'apostille.zags.lo' },
      ],
    },
  },

  'apostille.zags.spb': {
    key: 'apostille.zags.spb',
    parentKey: 'apostille.zags',
    label: 'Апостиль в КЗАГС Санкт-Петербурга',
    facets: {
      taxonomy: 'apostille',
      authority: 'КЗАГС',
      region: 'СПб',
      docTypes: ['zags'] as const,
    },
  },

  'apostille.zags.lo': {
    key: 'apostille.zags.lo',
    parentKey: 'apostille.zags',
    label: 'Апостиль в Управлении ЗАГС Ленинградской области',
    facets: {
      taxonomy: 'apostille',
      authority: 'ЗАГС_ЛО',
      region: 'ЛО',
      docTypes: ['zags'] as const,
    },
  },

  // ─── FUTURE SCENARIOS ──────────────────────────────────────────────────────
  // Template for the next services. Uncomment + fill when the first document
  // for that service is uploaded. Do NOT add domain-level placeholders — only
  // real procedures the business actually performs.
  //
  // 'translation': {
  //   key: 'translation', parentKey: null, label: 'Переводы',
  //   facets: { taxonomy: 'translation' },
  //   disambiguation: { prompt: 'Какой тип перевода?', options: [ ... ] },
  // },
  //
  // 'notarization.kzags.spb': { ... },
  // 'legalization.consulate': { ... },
};

// ────────────────────────────────────────────────────────────────────────────
// Query helpers — used at runtime by the answering engine and backfill script.
// ────────────────────────────────────────────────────────────────────────────

/** All ancestors of a key, including the key itself. Root-first.
 *  `ancestorsOf("apostille.zags.spb")` → ["apostille","apostille.zags","apostille.zags.spb"]
 *  Used by the retrieval filter: a rule at any ancestor applies to the leaf. */
export function ancestorsOf(key: ScenarioKey): ScenarioKey[] {
  const parts = key.split('.');
  const out: ScenarioKey[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('.'));
  return out;
}

/** Descendants of a key (including itself), for "all ЗАГС apostille" queries. */
export function descendantsOf(key: ScenarioKey): ScenarioKey[] {
  return Object.keys(SCENARIOS).filter((k) => k === key || k.startsWith(key + '.'));
}

/** Direct children of a non-leaf. */
export function childrenOf(key: ScenarioKey): ScenarioNode[] {
  return Object.values(SCENARIOS).filter((n) => n.parentKey === key);
}

export function isLeaf(key: ScenarioKey): boolean {
  return childrenOf(key).length === 0;
}

export function getScenario(key: ScenarioKey): ScenarioNode | undefined {
  return (SCENARIOS as Record<string, ScenarioNode>)[key];
}

/** Effective facets: walk up from the node to the root, merging facets so
 *  a leaf inherits its parent's `taxonomy`/`docTypes`/etc. when unspecified. */
export function facetsOf(key: ScenarioKey): ScenarioFacets {
  const chain = ancestorsOf(key).map(getScenario).filter(Boolean) as ScenarioNode[];
  const merged: ScenarioFacets = { taxonomy: chain[0]?.facets.taxonomy ?? key.split('.')[0] };
  for (const node of chain) Object.assign(merged, node.facets);
  return merged;
}

/** Prisma WHERE clause factor. Given a chosen scenarioKey, returns the filter
 *  for Rule/QAPair/DocChunk: include rules at the scenario itself, any of its
 *  ancestors (broader-but-applicable), AND universal cross-service NULLs. */
export function scenarioFilterClause(chosenKey: ScenarioKey): Prisma.RuleWhereInput {
  const chain = ancestorsOf(chosenKey);
  return { OR: [{ scenarioKey: null }, { scenarioKey: { in: chain } }] };
}

/** Validation — run at startup to catch typos that would otherwise break
 *  retrieval silently. Call from app bootstrap. */
export function assertTaxonomyConsistency(): void {
  const keys = new Set(Object.keys(SCENARIOS));
  for (const node of Object.values(SCENARIOS)) {
    if (node.parentKey !== null && !keys.has(node.parentKey)) {
      throw new Error(`Scenario "${node.key}" has unknown parent "${node.parentKey}"`);
    }
    if (node.disambiguation) {
      for (const opt of node.disambiguation.options) {
        if (!keys.has(opt.targetScenarioKey)) {
          throw new Error(`Disambig on "${node.key}" targets unknown "${opt.targetScenarioKey}"`);
        }
      }
    }
  }
}
