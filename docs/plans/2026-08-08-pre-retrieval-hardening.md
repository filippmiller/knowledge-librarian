# Pre-Retrieval Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or execute directly with superpowers:test-driven-development discipline per task) to implement this plan task-by-task.

**Goal:** Close the ten technical gaps blocking retrieval-answer work on Aurora v2 (PR #76 remains unmerged, human review happens separately) — extraction-drift semantics, reviewed-snapshot provenance binding, embedding batch/model integrity, retrieval-text completeness, QueryFrame trust boundary, additive-history reconciliation, recall metric hardening, multi-clause coverage grading, oracle-taint per-secret coverage, and a `--stage=qualify` CLI skeleton (no human decision fabricated).

**Architecture:** Ten independent-ish TDD tasks against `src/lib/eval/` and `src/lib/knowledge/`. Each task: RED tests first (either new tests on existing files, or a new module + its test), then the minimal implementation, then full verification. No task deploys, runs e2e, or touches `src/lib/eval/semantic-rule-oracle.ts` / oracle data / review decisions.

**Tech Stack:** TypeScript, Vitest, Zod, `node:crypto` (`createHash('sha256')`), pnpm.

**Verify commands (run after every task):**
```bash
pnpm test -- <changed-test-file-glob>
pnpm typecheck
pnpm lint
```
Full suite (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`) runs once at the end (Task 11).

---

## Task 1: Extraction drift metric semantics (`compareExtractionRuns`)

**Files:**
- Modify: `src/lib/eval/extraction-drift.ts`
- Modify: `src/lib/eval/__tests__/extraction-drift.test.ts`

**Problem confirmed by reading the code:** `extraction-drift.ts:229` sets `status: detail.contentHashChanged ? 'CONTENT_CHANGE' : 'STABLE'` — `status` ignores `parentDrift`/`triggerDrift`/`uncertaintyDrift` entirely. The existing test at lines 76-99 only asserts `detail?.parentDrift === true` / `detail?.triggerDrift === true`, never checking `status`, so today those cases silently report `status: 'STABLE'`. `stableCount` therefore overcounts.

**New shape (replaces `UnitDriftStatus`/`status` — no shadow field, full replacement per reference sweep: only consumers are this file and its test, confirmed via grep):**

```typescript
export type IdentityStatus = 'PRESENT_BOTH' | 'OMITTED' | 'ADDED' | 'AMBIGUOUS';

export interface UnitDriftDetail {
  readonly contentChanged: boolean;
  readonly parentChanged: boolean;
  readonly triggerChanged: boolean;
  readonly uncertaintyChanged: boolean;
}

export interface UnitDriftEntry {
  readonly unitId: string;
  readonly identityStatus: IdentityStatus;
  /** true iff identityStatus === 'PRESENT_BOTH' AND every *Changed flag is false. */
  readonly fullyStable: boolean;
  readonly sourceBlockAnchor: string | null;
  /** non-null iff identityStatus === 'PRESENT_BOTH'. */
  readonly detail: UnitDriftDetail | null;
}

export interface ExtractionDriftReport {
  readonly fullyStableCount: number;
  readonly contentChangedCount: number;
  readonly parentChangedCount: number;
  readonly triggerChangedCount: number;
  readonly uncertaintyChangedCount: number;
  readonly omittedCount: number;
  readonly addedCount: number;
  readonly ambiguousCount: number;
  readonly entries: readonly UnitDriftEntry[];
  readonly fragmentationChanges: readonly FragmentationChangeGroup[];
}
```

Rename `computeDrift`'s returned booleans to match (`contentChanged`, `parentChanged`, `triggerChanged`, `uncertaintyChanged` — same computations, new names). `computeFragmentationChanges` switches its filter from `e.status === 'CONTENT_OMISSION'` to `e.identityStatus === 'OMITTED'` (and `'ADDED'` for the addition side). The `AMBIGUOUS_DUPLICATE_UNIT_ID` branch becomes `identityStatus: 'AMBIGUOUS'`, `fullyStable: false`, `detail: null`.

**Step 1: Update the RED tests in `extraction-drift.test.ts`.**

Rewrite the field names in existing assertions (`status: 'STABLE'` → `identityStatus: 'PRESENT_BOTH'`, `report.stableCount` → `report.fullyStableCount`, `detail?.parentDrift` → `detail?.parentChanged`, etc. — mechanical rename across the file), **and add the load-bearing new assertions** that catch today's bug:

```typescript
it('тот же unitId, тот же contentHash, но parentRuleRef изменился -> identityStatus НЕ PRESENT_BOTH-как-STABLE, fullyStable=false', () => {
  const report = compareExtractionRuns(
    [unit({ parentRuleRef: null })],
    [unit({ parentRuleRef: 'some-other-unit' })]
  );
  expect(report.entries[0].identityStatus).toBe('PRESENT_BOTH');
  expect(report.entries[0].detail?.parentChanged).toBe(true);
  expect(report.entries[0].fullyStable).toBe(false);
  expect(report.fullyStableCount).toBe(0);
  expect(report.parentChangedCount).toBe(1);
});

it('triggerCondition изменился по составу -> fullyStable=false, triggerChangedCount=1, НЕ засчитан в fullyStableCount', () => {
  const report = compareExtractionRuns(
    [unit({ triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] } })],
    [unit({ triggerCondition: { all: [{ fact: 'consentStatus', equals: 'EXPLICIT' }, { fact: 'helperPresent', equals: true }] } })]
  );
  expect(report.entries[0].fullyStable).toBe(false);
  expect(report.triggerChangedCount).toBe(1);
  expect(report.fullyStableCount).toBe(0);
});

it('uncertainties изменились -> fullyStable=false, uncertaintyChangedCount=1', () => {
  const report = compareExtractionRuns(
    [unit({ uncertainties: [] })],
    [unit({ uncertainties: [{ kind: 'OTHER', description: 'новая находка', quote: 'x' }] })]
  );
  expect(report.entries[0].fullyStable).toBe(false);
  expect(report.uncertaintyChangedCount).toBe(1);
});

it('ничего не изменилось -> fullyStable=true, все *ChangedCount=0', () => {
  const report = compareExtractionRuns([unit()], [unit()]);
  expect(report.entries[0].fullyStable).toBe(true);
  expect(report.fullyStableCount).toBe(1);
  expect(report.parentChangedCount).toBe(0);
  expect(report.triggerChangedCount).toBe(0);
  expect(report.uncertaintyChangedCount).toBe(0);
});

it('contentHash И parentRuleRef оба изменились одновременно -> оба счётчика инкрементятся, не взаимоисключающе', () => {
  const report = compareExtractionRuns(
    [unit({ parentRuleRef: null })],
    [unit({ contentHash: 'hash-2', parentRuleRef: 'other' })]
  );
  expect(report.contentChangedCount).toBe(1);
  expect(report.parentChangedCount).toBe(1);
  expect(report.fullyStableCount).toBe(0);
});
```

**Step 2:** Run `pnpm test -- extraction-drift` — new assertions fail against current code (proves RED).

**Step 3:** Implement the refactor in `extraction-drift.ts`: rename types/fields as above, change the entry-construction branch (`b !== undefined && c !== undefined`) to always set `identityStatus: 'PRESENT_BOTH'` and compute `fullyStable = !detail.contentChanged && !detail.parentChanged && !detail.triggerChanged && !detail.uncertaintyChanged`, update the summary-count `.filter()` calls at the bottom to the new field names, update `computeFragmentationChanges`'s status checks.

**Step 4:** Run `pnpm test -- extraction-drift` — green.

**Step 5:** Commit: `fix(eval): extraction drift status no longer hides parent/trigger/uncertainty drift as STABLE`

---

## Task 2: Bind reviewed-snapshot provenance to a single trusted artifact

**Files:**
- Create: `src/lib/eval/extraction-qualification-artifact.ts`
- Create: `src/lib/eval/__tests__/extraction-qualification-artifact.test.ts`
- Modify: `src/lib/eval/reviewed-snapshot.ts`
- Modify: `src/lib/eval/__tests__/reviewed-snapshot.test.ts`

Confirmed via grep: `buildReviewedSnapshot`/`ReviewedKnowledgeSnapshot`/`SnapshotProvenance` have zero consumers outside `reviewed-snapshot.ts` and its own test — safe to change the signature outright, no shadow system needed.

**New artifact module** (mirrors the existing `stableStringify` pattern already duplicated per-module in `identity.ts` and `review-manifest.ts` for infra-layer reasons — same convention, no cross-module coupling):

```typescript
// src/lib/eval/extraction-qualification-artifact.ts
import { createHash } from 'node:crypto';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

export interface ExtractionQualificationMetadata {
  readonly sourceRevisionHash: string;
  readonly canonicalTextHash: string;
  readonly parserVersion: string;
  readonly extractionProvider: string;
  readonly extractionModel: string;
  readonly extractionPromptVersion: string;
  readonly extractionSchemaVersion: string;
}

export interface ExtractionQualificationArtifact extends ExtractionQualificationMetadata {
  readonly persistedUnits: readonly PersistedKnowledgeUnit[];
  readonly artifactHash: string;
}

function stableStringify(value: unknown): string { /* same body as review-manifest.ts:124-132 */ }

export function computeExtractionQualificationArtifactHash(
  metadata: ExtractionQualificationMetadata,
  persistedUnits: readonly PersistedKnowledgeUnit[]
): string {
  return createHash('sha256').update(stableStringify({ metadata, persistedUnits }), 'utf8').digest('hex');
}

export function buildExtractionQualificationArtifact(
  metadata: ExtractionQualificationMetadata,
  persistedUnits: readonly PersistedKnowledgeUnit[]
): ExtractionQualificationArtifact {
  return { ...metadata, persistedUnits, artifactHash: computeExtractionQualificationArtifactHash(metadata, persistedUnits) };
}

export function verifyExtractionQualificationArtifact(artifact: ExtractionQualificationArtifact): boolean {
  const { persistedUnits, artifactHash, ...metadata } = artifact;
  return computeExtractionQualificationArtifactHash(metadata, persistedUnits) === artifactHash;
}
```

**RED tests (`extraction-qualification-artifact.test.ts`), write first:**
- `buildExtractionQualificationArtifact` produces a `verifyExtractionQualificationArtifact(...) === true` artifact.
- Changing one unit's `contentHash` after building → `verifyExtractionQualificationArtifact({ ...artifact, persistedUnits: [...] })` → `false`.
- Changing one metadata field (e.g. `extractionModel`) with the same `persistedUnits` and the *original* `artifactHash` → `false`.
- Same metadata + same units, built twice → identical `artifactHash` (determinism, no `Date.now()`/random involved).
- Different unit order in `persistedUnits` → **document current behavior explicitly**: since `stableStringify` sorts object keys but not array order, and unit arrays are meaningfully ordered data (not a set), a reordered `persistedUnits` array is expected to produce a **different** `artifactHash`. Write this as an explicit assertion, not an oversight — callers must pass `persistedUnits` in the same order used at extraction time (e.g. `identity.units` order, already stable within one run).

**Modify `reviewed-snapshot.ts`:**

```typescript
export interface ReviewedKnowledgeSnapshot extends ExtractionQualificationMetadata {
  readonly qualificationArtifactHash: string;
  readonly qualifiedAt: string;
  readonly units: readonly PersistedKnowledgeUnit[];
}

export function buildReviewedSnapshot(
  artifact: ExtractionQualificationArtifact,
  manifest: readonly ReviewManifestEntry[],
  qualifiedAt: string
): BuildSnapshotResult {
  if (!verifyExtractionQualificationArtifact(artifact)) {
    throw new Error(
      'buildReviewedSnapshot: artifactHash не совпадает с (metadata, persistedUnits) — ' +
        'артефакт собран из несогласованных частей (например, units одного прогона и provenance другого)'
    );
  }
  const gate = applyReviewManifest(artifact.persistedUnits, manifest);
  if (!gate.ok) return { ok: false, failures: gate.failures };
  const { persistedUnits, artifactHash, ...metadata } = artifact;
  return {
    ok: true,
    snapshot: { ...metadata, qualificationArtifactHash: artifactHash, qualifiedAt, units: gate.confirmed },
    sourceRuleByUnitId: gate.sourceRuleByUnitId,
  };
}
```

`SnapshotProvenance` is removed (superseded by `ExtractionQualificationMetadata` — same shape, one name, no duplicate type).

**RED regression in `reviewed-snapshot.test.ts`** (the exact scenario from the task):

```typescript
it('units из артефакта A + metadata из артефакта B — artifactHash не бьётся, buildReviewedSnapshot бросает, snapshot не создаётся', () => {
  const artifactA = buildExtractionQualificationArtifact(METADATA_A, [unitA]);
  const artifactB = buildExtractionQualificationArtifact(METADATA_B, [unitB]);
  const frankenArtifact = { ...artifactB, persistedUnits: artifactA.persistedUnits }; // units A, metadata+hash B
  expect(() => buildReviewedSnapshot(frankenArtifact, [entryFor(unitA)], '2026-08-08T00:00:00Z')).toThrow(/artifactHash/);
});

it('снимок несёт qualificationArtifactHash от использованного артефакта', () => {
  const artifact = buildExtractionQualificationArtifact(METADATA_A, [unitA]);
  const result = buildReviewedSnapshot(artifact, [entryFor(unitA)], '2026-08-08T00:00:00Z');
  expect(result.ok && result.snapshot.qualificationArtifactHash).toBe(artifact.artifactHash);
});
```

Update the rest of `reviewed-snapshot.test.ts`'s existing three tests to build via `buildExtractionQualificationArtifact` instead of passing `freshUnits`/`provenance` separately, and add `canonicalTextHash` to the fixture metadata (new required field).

**Verify:** `pnpm test -- extraction-qualification-artifact reviewed-snapshot`, `pnpm typecheck`.

**Commit:** `feat(eval): bind ReviewedKnowledgeSnapshot to a single hashed ExtractionQualificationArtifact`

---

## Task 3: `semantic-retrieval.ts` — embedding batch cardinality + provenance (closes translation-kis)

**Files:**
- Modify: `src/lib/knowledge/semantic-retrieval.ts`
- Modify: `src/lib/knowledge/__tests__/semantic-retrieval.test.ts`

Confirmed via grep: `embedCandidates`/`retrieveUnits`/`EmbeddedCandidate`/`RetrievalArtifact` have no consumers outside this module + its test — safe to change shapes directly.

**3A — batch cardinality.** `embedCandidates` (currently `semantic-retrieval.ts:25-32`) must reject `vectors.length !== candidates.length` before building any `EmbeddedCandidate`.

**3B — embedding provenance.** `EmbeddedCandidate` gains `embeddingModel: ModelInfo` (stamped from `provider.modelInfo()` inside `embedCandidates`). `RetrievalArtifact.embeddingModel` (currently one field, ambiguous — is it the corpus's or the query's?) splits into `corpusEmbeddingModel` and `queryEmbeddingModel`, both populated truthfully: corpus from the (single, validated) `candidates[*].embeddingModel`, query from `options.embeddingProvider.modelInfo()`. `retrieveUnits` throws before doing any ranking work if candidates carry more than one distinct corpus model identity, or if the corpus model doesn't match the query model. Model identity = `provider:model` string (per the task: same dimensions ≠ same model, must still reject).

**New/changed shapes:**

```typescript
export interface EmbeddedCandidate extends RetrievalCandidate {
  readonly embedding: number[];
  readonly embeddingModel: ModelInfo;
}

export interface RetrievalArtifact {
  readonly corpusEmbeddingModel: ModelInfo | null; // null only when candidatePoolSize === 0
  readonly queryEmbeddingModel: ModelInfo;
  readonly rerankerModel: ModelInfo;
  readonly rrfK: number;
  readonly candidatePoolSize: number;
}
```

**Step 1 — RED tests, `semantic-retrieval.test.ts`:**

```typescript
describe('embedCandidates — cardinality', () => {
  it('provider вернул МЕНЬШЕ векторов, чем кандидатов — явная ошибка, не тихий undefined в embedding', async () => {
    const shortProvider: EmbeddingProvider = {
      async embed(texts) { return texts.slice(0, -1).map(() => [0, 0, 0]); },
      modelInfo: () => ({ provider: 'fake', model: 'fake' }),
    };
    await expect(embedCandidates(CANDIDATES, shortProvider)).rejects.toThrow(/length/i);
  });

  it('provider вернул БОЛЬШЕ векторов, чем кандидатов — тоже явная ошибка', async () => {
    const longProvider: EmbeddingProvider = {
      async embed(texts) { return [...texts, 'extra'].map(() => [0, 0, 0]); },
      modelInfo: () => ({ provider: 'fake', model: 'fake' }),
    };
    await expect(embedCandidates(CANDIDATES, longProvider)).rejects.toThrow(/length/i);
  });

  it('каждый EmbeddedCandidate несёт embeddingModel провайдера', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    expect(embedded[0].embeddingModel).toEqual({ provider: 'fake', model: 'fake-embed-v1', dimensions: 3 });
  });
});

describe('retrieveUnits — embedding provenance', () => {
  it('кандидаты от ДВУХ разных моделей — явная ошибка перед ранжированием', async () => {
    const embeddedA = await embedCandidates([CANDIDATES[0]], new FakeEmbeddingProvider());
    const embeddedB = await embedCandidates([CANDIDATES[1]], new OtherFakeEmbeddingProvider());
    await expect(
      retrieveUnits('апостиль', [...embeddedA, ...embeddedB], {
        embeddingProvider: new FakeEmbeddingProvider(),
        rerankerProvider: new FakeRerankerProvider({}),
      })
    ).rejects.toThrow(/model/i);
  });

  it('query embedded моделью B, corpus — моделью A -> явное несовпадение отвергается', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    await expect(
      retrieveUnits('апостиль', embedded, {
        embeddingProvider: new OtherFakeEmbeddingProvider(),
        rerankerProvider: new FakeRerankerProvider({}),
      })
    ).rejects.toThrow(/model/i);
  });

  it('тот же provider/model, РАЗНАЯ размерность в ModelInfo.dimensions — тоже reject (dimensions не заменяет identity)', async () => {
    // OtherFakeEmbeddingProvider: same provider+model string as FakeEmbeddingProvider but different `dimensions` in modelInfo()
    // constructed specifically for this case — proves the identity key is provider:model, not dimensions alone,
    // AND that a same-provider-same-model-different-dimensions mismatch is still caught if it occurs.
  });

  it('идентичная модель corpus/query -> работает как раньше', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    expect(result.artifact.corpusEmbeddingModel).toEqual({ provider: 'fake', model: 'fake-embed-v1', dimensions: 3 });
    expect(result.artifact.queryEmbeddingModel).toEqual(result.artifact.corpusEmbeddingModel);
  });

  it('пустые candidates остаются валидными — corpusEmbeddingModel=null, не бросает', async () => {
    const result = await retrieveUnits('апостиль', [], {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    expect(result.artifact.corpusEmbeddingModel).toBeNull();
    expect(result.topK).toEqual([]);
  });
});
```

Add a second fake provider class in the test file, e.g. `OtherFakeEmbeddingProvider` (`modelInfo()` → `{ provider: 'fake', model: 'fake-embed-v2', dimensions: 3 }`) to exercise the mismatch cases, matching the existing `FakeEmbeddingProvider`/`FakeRerankerProvider` style.

**Step 2:** Run — new tests fail (RED).

**Step 3 — implement:**
- `embedCandidates`: after `provider.embed(...)`, `if (vectors.length !== candidates.length) throw new Error(...)`; stamp `embeddingModel: provider.modelInfo()` on each result.
- `retrieveUnits`: add a `modelIdentity(info) => \`${info.provider}:${info.model}\`` helper. After the existing numeric-option validation and before the `candidates.length === 0` early return, compute `corpusEmbeddingModel` (only when `candidates.length > 0`): collect `new Set(candidates.map(c => modelIdentity(c.embeddingModel)))`; if `size > 1` throw; else take `candidates[0].embeddingModel`. Compare its identity against `options.embeddingProvider.modelInfo()`; throw on mismatch — **before** calling `options.embeddingProvider.embed([query])`, so a mismatched call never hits the network. Build `artifact` with `corpusEmbeddingModel: candidates.length > 0 ? corpusModel : null` and `queryEmbeddingModel: options.embeddingProvider.modelInfo()`.

**Step 4:** Green. **Step 5:** `pnpm typecheck` (catches any other file referencing the old `artifact.embeddingModel` field name — expected: none, per the grep above).

**Commit:** `fix(knowledge): embedCandidates rejects batch-length mismatch; retrieveUnits rejects mixed embedding-model identity (translation-kis)`

---

## Task 4: Retrieval text completeness — scenario & documentForm

**Files:**
- Modify: `src/lib/knowledge/applicability/retrieval-text.ts`
- Modify: `src/lib/knowledge/applicability/__tests__/retrieval-text.test.ts`

`scenario` and `documentForm` are deliberately excluded from `CONCEPT_VOCABULARY_BY_FACET` (`concept-registry.ts:171`, "обрабатываются отдельно на месте использования") — but nobody built that "elsewhere" for `retrievalText`, so `facetsText()` silently drops them (its `labelForFacetValue` returns `undefined` when there's no vocabulary entry).

**Step 1 — RED test:**

```typescript
it('scenario — единственный семантический контекст statement — сохраняется в retrievalText человекочитаемой меткой (регрессия: facetsText молча пропускает facet без ConceptVocabulary)', () => {
  const genericUnit = unit({
    statement: 'Требуется оригинал документа.', // generic on its own — no apostille/zags words
    facets: { scenario: 'apostille.zags.spb' },
  });
  const text = buildRetrievalText(genericUnit, new Map());
  expect(text).toContain('Апостиль в КЗАГС Санкт-Петербурга'); // SCENARIOS['apostille.zags.spb'].label
});

it('documentForm попадает в retrievalText читаемым словом, не кодом ORIGINAL/SCAN/COPY', () => {
  const text = buildRetrievalText(unit({ facets: { documentForm: 'SCAN' } }), new Map());
  expect(text).toContain('скан');
  expect(text).not.toContain('SCAN');
});
```

**Step 2:** RED (fails — neither label appears today).

**Step 3 — implement in `retrieval-text.ts`:**

```typescript
import { getScenario } from '@/lib/knowledge/scenarios';

const DOCUMENT_FORM_LABELS: Record<'ORIGINAL' | 'SCAN' | 'COPY', string> = {
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
  const label = DOCUMENT_FORM_LABELS[value as keyof typeof DOCUMENT_FORM_LABELS];
  return label ? [label] : [];
}
```
Add both to the `parts` array in `buildRetrievalText` (alongside `facetsText`). Do not touch `facetsText`/`CONCEPT_VOCABULARY_BY_FACET` — scenario/documentForm stay intentionally outside that registry; this is the "elsewhere" the comment refers to.

**Step 4:** Green. **Commit:** `fix(knowledge): retrievalText no longer drops scenario/documentForm — the only facets without a ConceptVocabulary entry`

---

## Task 5: QueryFrame trust boundary (message id / quote validation)

**Files:**
- Modify: `src/lib/knowledge/applicability/query-frame-builder.ts`
- Modify: `src/lib/knowledge/applicability/__tests__/query-frame-builder.test.ts`
- Check: `src/lib/knowledge/query-frame-extractor.ts` (confirm `extractQueryFrame` already routes through `buildQueryFrame` — it does, per `query-frame-extractor.ts:88-104` — so fixing `buildQueryFrame` covers both call paths; add one assertion in `query-frame-extractor.test.ts` only if it currently bypasses validation, otherwise no change needed there)

**Gap confirmed by reading the code:** `buildQueryFrame` (`query-frame-builder.ts:310-356`) validates `messageId ∈ knownMessageIds` (line 325-329) but never checks that `quote` is an actual substring of the referenced message's `text`. Schema-level `quote` validation (`query-frame.ts:45-52`) only requires non-blank.

**Step 1 — RED tests in `query-frame-builder.test.ts`:**

```typescript
describe('buildQueryFrame — trust boundary: messageId и quote (независимая проверка перед retrieval)', () => {
  it('каждое ConversationMessage.id непусто и уникально — buildQueryFrame бросает при дубле id', () => {
    const messages = [msg('m1', 'user', 'нужен перевод'), msg('m1', 'user', 'и апостиль')];
    expect(() => buildQueryFrame(EMPTY_EXTRACTION, messages)).toThrow(/id/i);
  });

  it('пустой (пробельный) message.id — бросает', () => {
    const messages = [msg('  ', 'user', 'нужен перевод')];
    expect(() => buildQueryFrame(EMPTY_EXTRACTION, messages)).toThrow(/id/i);
  });

  it('quote — НЕ дословная подстрока текста referenced-сообщения (сфабрикованная цитата) -> mention отбрасывается, не доезжает до QueryFrame', () => {
    const messages = [msg('m1', 'user', 'нужен перевод паспорта')];
    const extraction = withFacetMention({ facet: 'service', polarity: 'INCLUDE', rawValue: 'apostille_spb', messageId: 'm1', quote: 'нужен апостиль' }); // fabricated — real text says "перевод паспорта"
    const frame = buildQueryFrame(extraction, messages);
    expect(frame.facets.service.state).toBe('UNKNOWN');
  });

  it('сфабрикованная цитата + РЕАЛЬНЫЙ messageId — тоже отбрасывается (не только неизвестный messageId защищён)', () => {
    // same as above, explicit case naming — covers item C distinctly from D
  });

  it('quote — дословная подстрока -> mention принимается как раньше', () => {
    const messages = [msg('m1', 'user', 'нужен апостиль срочно')];
    const extraction = withFacetMention({ facet: 'service', polarity: 'INCLUDE', rawValue: 'apostille_spb', messageId: 'm1', quote: 'нужен апостиль' });
    const frame = buildQueryFrame(extraction, messages);
    expect(frame.facets.service.state).toBe('KNOWN');
  });

  it('неизвестный messageId — уже отбрасывается (regression guard, existing behavior)', () => { /* keep existing test as-is */ });
});
```

Add equivalent cases for `RawTriggerFactMention` (same quote-verification code path, different mention type).

**Step 2:** RED — quote fabrication currently passes through uncaught; duplicate/blank id currently isn't checked (only presence in `messages.length === 0` gate).

**Step 3 — implement in `buildQueryFrame`:**

```typescript
if (messages.length === 0) {
  throw new Error('buildQueryFrame: messages не может быть пуст — нет текущего сообщения');
}
const seenIds = new Set<string>();
for (const m of messages) {
  if (m.id.trim().length === 0) {
    throw new Error(`buildQueryFrame: ConversationMessage.id не может быть пустым (текст: "${m.text.slice(0, 40)}")`);
  }
  if (seenIds.has(m.id)) {
    throw new Error(`buildQueryFrame: ConversationMessage.id "${m.id}" встречается дважды — сообщения неразличимы`);
  }
  seenIds.add(m.id);
}
const messageById = new Map(messages.map((m) => [m.id, m]));
// ...
const facetMentions = extraction.facetMentions.filter(
  (m) => knownMessageIds.has(m.messageId) && messageById.get(m.messageId)!.text.includes(m.quote)
);
const triggerFactMentions = extraction.triggerFactMentions.filter(
  (m) => knownMessageIds.has(m.messageId) && messageById.get(m.messageId)!.text.includes(m.quote)
);
```

(Substring check via `.includes()` — same exactness bar `resolveEvidenceOffsets` already applies elsewhere in the codebase, no new heuristic invented.)

**Step 4 (item E — direct `buildQueryFrame` callers get the same validation as `extractQueryFrame`):** confirmed by reading `query-frame-extractor.ts:88-104` — `extractQueryFrame` calls `buildQueryFrame(rawExtraction, options.messages)` directly with no separate validation layer in between, so this is automatically satisfied once `buildQueryFrame` itself validates. Add one test in `query-frame-extractor.test.ts` asserting `extractQueryFrame` propagates the same throw for a duplicate-id `messages` array (cheap confirmation, not a new mechanism).

**Step 5:** Green, typecheck, lint. **Commit:** `fix(knowledge): buildQueryFrame enforces message id uniqueness and quote-is-real-substring before trusting a mention`

---

## Task 6: Additive vs. replacement history reconciliation

**Files:**
- Modify: `src/lib/knowledge/applicability/query-frame-builder.ts` (`buildFacetState` only — `buildTriggerFactState` is single-valued per fact and its current current-overrides-history-with-ambiguity-flag behavior is already correct for that case, not touched)
- Modify: `src/lib/knowledge/applicability/__tests__/query-frame-builder.test.ts`

**Bug confirmed by tracing the code, NOT already fixed despite the docstring's mention of the "и апостиль тоже" example:** `buildFacetState` (`query-frame-builder.ts:153-208`) sets `winning = current.length > 0 ? current : history` — when the current message mentions a facet AT ALL, `winning = current` **only**, and `history` is dropped from `include`/`exclude` entirely. The subset check (lines 168-181) only controls whether an `ambiguities` message is *added*; it never restores the history values into the result. Concretely: history `INCLUDE translation`, current `INCLUDE apostille` (a real "и апостиль тоже" utterance, where the current message does NOT re-mention "перевод") → `historyValues = {INCLUDE:translation}` is not a subset of `currentValues = {INCLUDE:apostille}` → **flagged as a contradiction**, and `translation` is silently dropped from `include` — exactly backwards from the requirement.

**Fix — per-value reconciliation (current message's stance on a specific value wins for that value; a value untouched by the current message is inherited from history unchanged):**

```typescript
function buildFacetState(
  facet: FacetKey,
  mentions: readonly RawFacetMention[],
  currentMessageId: string,
  ambiguities: string[]
): QueryFacetState<unknown> {
  const resolved = resolveFacetMentions(facet, mentions);
  const current = resolved.filter((m) => m.evidence.messageId === currentMessageId);
  const history = resolved.filter((m) => m.evidence.messageId !== currentMessageId);
  if (current.length === 0 && history.length === 0) return { state: 'UNKNOWN' };

  // Self-contradiction WITHIN current (same value, both polarities in this message) — drop that
  // value from current entirely and flag; it cannot override anything credibly.
  const currentByValue = new Map<string, Set<'INCLUDE' | 'EXCLUDE'>>();
  for (const m of current) {
    const set = currentByValue.get(m.value) ?? new Set<'INCLUDE' | 'EXCLUDE'>();
    set.add(m.polarity);
    currentByValue.set(m.value, set);
  }
  for (const [value, polarities] of currentByValue) {
    if (polarities.size > 1) {
      ambiguities.push(`${facet}: значение ${value} упомянуто в текущем сообщении и как INCLUDE, и как EXCLUDE — отброшено`);
      currentByValue.delete(value);
    }
  }

  // Per-value merge: current's polarity for a value wins (replacement); a value current
  // doesn't touch at all is carried forward from history (addition preserved). This is NOT
  // "always union history" — a value current explicitly re-polarizes is overridden, not unioned.
  const finalByValue = new Map<string, 'INCLUDE' | 'EXCLUDE'>();
  for (const m of history) {
    if (!currentByValue.has(m.value)) finalByValue.set(m.value, m.polarity);
  }
  for (const [value, polarities] of currentByValue) {
    finalByValue.set(value, [...polarities][0]);
  }

  if (finalByValue.size === 0) return { state: 'UNKNOWN' };

  const include = [...finalByValue].filter(([, p]) => p === 'INCLUDE').map(([v]) => v);
  const exclude = [...finalByValue].filter(([, p]) => p === 'EXCLUDE').map(([v]) => v);
  const evidenceSourceFor = (value: string): 'CURRENT_MESSAGE' | 'HISTORY' => (currentByValue.has(value) ? 'CURRENT_MESSAGE' : 'HISTORY');
  const winningMentions = [...current, ...history].filter((m) => finalByValue.get(m.value) === m.polarity);

  return {
    state: 'KNOWN',
    include,
    exclude,
    evidence: dedupeEvidence(winningMentions.map((m) => ({ ...m.evidence, source: evidenceSourceFor(m.value) }))),
  };
}
```

(`ambiguities` no longer gets a "current contradicts history" message for the additive case — there IS no contradiction once merge is per-value. A genuine same-value flip, e.g. history `INCLUDE apostille` + current `EXCLUDE apostille`, is not an ambiguity either — it's a clean, intentional override, which is exactly what the second required scenario needs.)

**Step 1 — RED tests (this is the load-bearing pair from the task):**

```typescript
it('аддитивная история: "нужен перевод" (история) + "и апостиль тоже" (текущее) -> ОБА value сохраняются в include', () => {
  const messages = [msg('h1', 'user', 'нужен перевод'), msg('c1', 'user', 'и апостиль тоже')];
  const extraction = extractionWith([
    mention({ facet: 'service', polarity: 'INCLUDE', rawValue: 'perevod_alias', messageId: 'h1', quote: 'нужен перевод' }),
    mention({ facet: 'service', polarity: 'INCLUDE', rawValue: 'apostille_alias', messageId: 'c1', quote: 'апостиль' }),
  ]);
  const frame = buildQueryFrame(extraction, messages);
  expect(frame.facets.service.state).toBe('KNOWN');
  if (frame.facets.service.state === 'KNOWN') {
    expect(new Set(frame.facets.service.include)).toEqual(new Set(['translation', 'apostille_spb'])); // resolved concept ids
  }
  expect(frame.ambiguities).toEqual([]); // NOT flagged as a conflict
});

it('замена: "нужен апостиль" (история) + "нет, не апостиль, а легализация" (текущее, EXCLUDE apostille + INCLUDE legalization) -> apostille исключён, legalization включён, история НЕ выигрывает', () => {
  const messages = [msg('h1', 'user', 'нужен апостиль'), msg('c1', 'user', 'нет, не апостиль, а легализация')];
  const extraction = extractionWith([
    mention({ facet: 'service', polarity: 'INCLUDE', rawValue: 'apostille_alias', messageId: 'h1', quote: 'нужен апостиль' }),
    mention({ facet: 'service', polarity: 'EXCLUDE', rawValue: 'apostille_alias', messageId: 'c1', quote: 'не апостиль' }),
    mention({ facet: 'service', polarity: 'INCLUDE', rawValue: 'legalization_alias', messageId: 'c1', quote: 'легализация' }),
  ]);
  const frame = buildQueryFrame(extraction, messages);
  if (frame.facets.service.state === 'KNOWN') {
    expect(frame.facets.service.include).not.toContain('apostille_spb');
    expect(frame.facets.service.exclude).toContain('apostille_spb');
    expect(frame.facets.service.include).toContain('legalization');
  }
});
```

Use real resolvable aliases from `SERVICE_CONCEPTS` (`concept-registry.ts`) for `apostille_alias`/`perevod_alias`/`legalization_alias` — check that file for exact alias strings that resolve to `apostille_spb`/`translation`/`legalization` concept ids before finalizing the fixture (read `concept-registry.ts:21-58` `SERVICE_CONCEPTS`).

**Step 2:** RED — with current code, test 1 gets `include: ['apostille_spb']` only (translation dropped) plus a spurious ambiguity; test 2's exact semantics differ from current single-value-current-only logic (may accidentally pass or fail depending on fixture — verify by running before assuming).

**Step 3:** Implement as above.

**Step 4:** Also re-run the FULL existing `query-frame-builder.test.ts` suite — several existing tests assert the OLD "current overrides history entirely" behavior and the OLD ambiguities message text; these need deliberate review: tests asserting genuine self-contradiction (same value, both polarities, one message) keep passing unchanged (that logic is untouched). Tests that asserted "history dropped when current says anything" for a DIFFERENT value need their expectations corrected to the new additive semantics — this is expected, intentional test churn, not breakage to work around.

**Step 5:** Green, typecheck. **Commit:** `fix(knowledge): buildQueryFrame reconciles facet history per-value — additive by default, explicit re-polarization overrides`

---

## Task 7: `evaluateRecall` — reject invalid `k`

**Files:**
- Modify: `src/lib/eval/retrieval-metrics.ts`
- Modify: `src/lib/eval/__tests__/retrieval-metrics.test.ts`

**Decision (stated, not left implicit): `k=0` is allowed** — it's a legitimate diagnostic degenerate case ("how many hits if we only look at rank 0 candidates" = always 0 unless `expectedUnitIds` is empty), same class as `finalLimit`/`rerankPoolSize` in `semantic-retrieval.ts` which explicitly treat `0` as legal ("естественно пустой результат") and only reject negative/non-finite. Consistent with existing project convention — not a new judgment call.

**Step 1 — RED tests:**

```typescript
it.each([
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['negative', -1],
  ['fractional', 2.5],
])('k=%s отвергается явно', (_label, k) => {
  expect(() => evaluateRecall([caseFixture()], k)).toThrow(/k/i);
});

it('k=0 — легален (диагностический вырожденный случай), не бросает', () => {
  expect(() => evaluateRecall([caseFixture()], 0)).not.toThrow();
});

it('k=5 (обычный acceptance-порог) — по-прежнему работает как раньше', () => {
  expect(() => evaluateRecall([caseFixture()], 5)).not.toThrow();
});
```

**Step 2:** RED (no validation exists today — `slice(0, NaN)` / `slice(0, -1)` currently silently misbehave per the same JS-coercion class of bug already fixed in `semantic-retrieval.ts`).

**Step 3 — implement:**

```typescript
export function evaluateRecall(cases: readonly RetrievalCase[], k: number): RecallResult {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error(`evaluateRecall: "k" обязан быть неотрицательным целым числом, получено ${k}`);
  }
  // ...unchanged
}
```
(`Number.isInteger` rejects `NaN`, `±Infinity`, and fractional values in one check; `k < 0` rejects negatives.)

**Step 4:** Green. Confirm `case-grader.ts`'s hardcoded `ACCEPTANCE_TOP_K = 5` is untouched (it doesn't call `evaluateRecall` — confirmed by grep, no cross-module change needed).

**Commit:** `fix(eval): evaluateRecall rejects NaN/Infinity/negative/fractional k; k=0 stays legal (diagnostic)`

---

## Task 8: Multi-clause coverage — evidence groups for rules 9 & 10

**Files:**
- Read first: the committed extraction stability report at `.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md` and whatever real persisted-units artifact from a `--stage=extraction` run is available under the repo (check `scripts/fixtures/` or wherever prior runs wrote `persisted-units.candidate.jsonl`) — **the evidence groups must be defined from the ACTUAL fragmentation shape of rules 9/10 in that data, not invented**. If no real extraction artifact is available in this session, this task's evidence-group *definitions* are a placeholder keyed by `sourceRuleId` alone (fails safe — see below) with a Beads follow-up filed to fill in real per-clause groups once a fresh `--stage=extraction` run exists; do not fabricate specific fragment content to make the mechanism look complete.
- Modify: `src/lib/eval/case-grader.ts`
- Modify: `src/lib/eval/__tests__/case-grader-hardening-*.test.ts` (add a new one, e.g. `case-grader-hardening-5.test.ts`, matching the existing numbering convention) or a new `evidence-groups.test.ts` if the mechanism becomes its own module (preferred — keep `case-grader.ts` from growing an unrelated concept inline; see below)

**Design — new module, not inline in `case-grader.ts`** (single utility for this policy, not scattered):

```typescript
// src/lib/eval/evidence-groups.ts
export interface RequiredEvidenceGroup {
  readonly ruleId: number;
  readonly description: string;
  /** Each inner array is a set of unitIds where AT LEAST ONE must be selected —
   *  models "this clause may have been extracted as unit X or unit Y depending
   *  on how the run fragmented it." The OUTER array is a conjunction: ALL
   *  clauses must be covered, not just one. */
  readonly requiredClauses: readonly (readonly string[])[];
}

export function evaluateEvidenceGroupCoverage(
  group: RequiredEvidenceGroup,
  selectedUnitIds: readonly string[]
): { readonly covered: boolean; readonly uncoveredClauseIndexes: readonly number[] } {
  const selected = new Set(selectedUnitIds);
  const uncoveredClauseIndexes = group.requiredClauses
    .map((clause, i) => (clause.some((id) => selected.has(id)) ? -1 : i))
    .filter((i) => i !== -1);
  return { covered: uncoveredClauseIndexes.length === 0, uncoveredClauseIndexes };
}
```

This directly generalizes the existing `requiredNumerics`/`numericKey` pattern (`case-grader.ts:336-352`, per-selected-unit coverage aggregation) to boolean/clause coverage — same shape, same place in the pipeline (only evaluated for `DIRECT_ANSWER` cases with `expectedRuleIds` touching rule 9 or 10).

Wire into `gradeCase`: add optional `CaseExpectation.requiredEvidenceGroups?: readonly RequiredEvidenceGroup[]`; inside the `DIRECT_ANSWER` branch, for each group check `evaluateEvidenceGroupCoverage(group, observed.selectedUnitIds)`, push a `reasons` entry naming the uncovered clause indexes if `!covered`. **Explicitly do not** derive groups from `sourceBlockAnchor` alone (task's constraint) — groups are authored from the real `sourceRuleId` → fragment mapping observed in extraction output, same provenance chain as `UnitProvenance.sourceRuleId`.

**Step 1 — RED tests in `evidence-groups.test.ts` (pure unit, no case-grader involvement needed for the core logic):**

```typescript
it('все required clauses покрыты хотя бы одним selected unit каждая -> covered=true', () => {
  const group: RequiredEvidenceGroup = {
    ruleId: 9, description: 'согласие + перчатки + остановка',
    requiredClauses: [['consent-unit'], ['gloves-unit'], ['stop-unit']],
  };
  expect(evaluateEvidenceGroupCoverage(group, ['consent-unit', 'gloves-unit', 'stop-unit']).covered).toBe(true);
});

it('выбран только ОДИН фрагмент из трёх required clauses -> covered=false, остальные названы', () => {
  const group: RequiredEvidenceGroup = {
    ruleId: 9, description: 'согласие + перчатки + остановка',
    requiredClauses: [['consent-unit'], ['gloves-unit'], ['stop-unit']],
  };
  const result = evaluateEvidenceGroupCoverage(group, ['consent-unit']);
  expect(result.covered).toBe(false);
  expect(result.uncoveredClauseIndexes).toEqual([1, 2]);
});

it('альтернативная фрагментация одной клаузы (unit X ИЛИ unit Y) — любой из двух закрывает клаузу', () => {
  const group: RequiredEvidenceGroup = {
    ruleId: 10, description: 'ограниченная подвижность — альтернативные извлечения',
    requiredClauses: [['mobility-unit-variant-a', 'mobility-unit-variant-b']],
  };
  expect(evaluateEvidenceGroupCoverage(group, ['mobility-unit-variant-b']).covered).toBe(true);
});
```

Then a `gradeCase`-level test in the new `case-grader-hardening-5.test.ts` proving a case selecting only ONE of rule 9's required fragments now **FAILs** the grader (this is the direct regression for "grader must not count a rule as satisfied merely because one fragment with sourceRuleId=9 was selected").

**Step 2:** RED. **Step 3:** Implement `evidence-groups.ts` + the `gradeCase` wiring. **Step 4:** Green.

**Explicitly out of scope / do not do:** tuning retrieval aliases to Q09/Q10 wording (task constraint) — this task only adds the grading mechanism, it does not touch `concept-registry.ts` or any alias list.

**Commit:** `feat(eval): evidence-group coverage grading for multi-clause rules (9, 10) — closes single-fragment false-pass`

---

## Task 9: Oracle taint — per-secret coverage

**Files:**
- Modify: `src/lib/eval/oracle-taint.ts`
- Modify: `src/lib/eval/__tests__/oracle-taint.test.ts`

**Gap confirmed by reading the code:** `buildOracleTaintDetector` (`oracle-taint.ts:92-127`) pools ALL secrets' shingles into one global `tainted` set and only ever reports `tainted.size` (`taintedShingleCount`). A secret shorter than `shingleSize` words produces zero shingles from `shingles(normalize(secret), shingleSize)` (the sliding-window loop `for (let i = 0; i + size <= words.length; i++)` never executes) — it silently contributes nothing and is never checked by `assertClean`. A secret ≥ `shingleSize` words whose every 8-word window happens to already exist in `sourceShingles` also contributes zero — same silent gap, different cause.

**Design — add per-secret coverage tracking + an exact-substring fallback for secrets that can't be shingle-protected (the "safe shorter-secret mechanism" the task allows):**

```typescript
export type SecretGuardKind = 'SHINGLE' | 'EXACT_SUBSTRING' | 'UNGUARDED';

export interface SecretCoverageEntry {
  readonly caseId: string;
  readonly field: 'expectedAnswer' | 'matchReason';
  /** null for the case's own field; index into negativeCases for a negative case's field. */
  readonly negativeIndex: number | null;
  readonly guard: SecretGuardKind;
}

export interface OracleTaintDetector {
  assertClean(payload: unknown, label: string): void;
  readonly taintedShingleCount: number;
  readonly secretCoverage: readonly SecretCoverageEntry[];
  readonly unguardedSecretCount: number;
}
```

`collectSecrets` changes from `string[]` to carry `{ caseId, field, negativeIndex, text }` so coverage can be attributed and reported per-secret (needed for "Expose/report unguarded secrets"). For each secret:
1. Compute its shingles (size `shingleSize`) minus `sourceShingles` (existing logic) → if non-empty, `guard: 'SHINGLE'`, add its shingles to the global `tainted` set (unchanged aggregate behavior).
2. Else (empty — either too-short or fully-overlapping-with-source): check whether the secret's normalized text is a literal substring of normalized `sourceText`. If **not** present in source → `guard: 'EXACT_SUBSTRING'`; register the normalized secret text in a separate `taintedPhrases: Set<string>` checked in `assertClean` via substring search (not shingle search) against each normalized payload string.
3. Else (its exact wording is literally sourced text) → `guard: 'UNGUARDED'` — this is a real, reportable limitation (the secret's wording is indistinguishable from legitimate source quoting), not a bug in the mechanism; it must show up in `secretCoverage`/`unguardedSecretCount`, not be hidden.

`assertClean` extends its check: alongside the existing shingle-membership scan, also do a substring scan of each payload string against `taintedPhrases`.

**Step 1 — RED tests in `oracle-taint.test.ts`:**

```typescript
it('короткий secret (< shingleSize слов) — не даёт нулевое покрытие: guard=EXACT_SUBSTRING, а не молча отсутствует', () => {
  const oracle = [oracleCase({ id: 'q1', expectedAnswer: 'да', matchReason: 'нет' })]; // 1-word secrets, shingleSize default 8
  const detector = buildOracleTaintDetector({ oracle, sourceText: SOURCE_TEXT_WITHOUT_THESE_WORDS });
  const entries = detector.secretCoverage.filter((e) => e.caseId === 'q1');
  expect(entries.every((e) => e.guard !== 'UNGUARDED')).toBe(true);
});

it('короткий secret, ГАРАНТИРОВАННО EXACT_SUBSTRING-защищённый, ловит утечку дословного значения даже без общего shingle', () => {
  const oracle = [oracleCase({ id: 'q1', expectedAnswer: 'зелёныйключ', matchReason: 'причина' })];
  const detector = buildOracleTaintDetector({ oracle, sourceText: 'документ не содержит этого слова вообще' });
  expect(() => detector.assertClean({ answer: 'ответ содержит зелёныйключ внутри' }, 'test')).toThrow();
});

it('unguardedSecretCount репортит секреты, чьё точное написание дословно есть в источнике (не защитим никаким текстовым механизмом честно)', () => {
  const oracle = [oracleCase({ id: 'q1', expectedAnswer: 'общееслово', matchReason: 'x' })];
  const detector = buildOracleTaintDetector({ oracle, sourceText: 'в тексте документа есть общееслово буквально' });
  const entry = detector.secretCoverage.find((e) => e.caseId === 'q1' && e.field === 'expectedAnswer')!;
  expect(entry.guard).toBe('UNGUARDED');
  expect(detector.unguardedSecretCount).toBeGreaterThan(0);
});

it('на реальном пакете (beforeAll fixture) — считает и репортит unguardedSecretCount вместо тихого пропуска (не обязательно 0 — если >0, это известная находка, не провал теста)', () => {
  // in the existing describe('buildOracleTaintDetector на реальном пакете', ...) block:
  // console.log or expect(Number.isFinite(detector.unguardedSecretCount)).toBe(true) at minimum;
  // if unguardedSecretCount > 0, log which caseIds/fields for the final report — do not assert === 0
  // blindly (task explicitly says "expose/report", not "force to zero by any means").
});
```

**Step 2:** RED — today there's no `secretCoverage`/`unguardedSecretCount` at all (compile error against the new interface until implemented), and the short-secret leak test fails against current `assertClean` (misses it).

**Step 3:** Implement per the design above.

**Step 4:** Green + run against the real fixture pack; **record the actual `unguardedSecretCount` result** for the final report (do not assume it's zero).

**Commit:** `fix(eval): oracle-taint tracks per-secret coverage, adds exact-substring guard for short/fully-overlapping secrets, reports unguarded ones`

---

## Task 10: `--stage=qualify` CLI skeleton (no human decision fabricated)

**Files:**
- Create: `scripts/run-qualify.ts`
- Create: `scripts/__tests__/run-qualify.test.ts` (test the exported, non-`main()` functions — same pattern as `run-extraction.ts`'s `require.main === module` guard)

**Design decision (stated explicitly, not left implicit):** this is a **new, separate script**, NOT a new stage bolted onto `scripts/run-extraction.ts`. Reason, grounded in what's already machine-enforced: `oracle-isolation.test.ts`'s `ORACLE_BLIND_SCRIPTS` allowlist (`= ['scripts/run-extraction.ts']`) asserts that file imports **nothing** from `src/lib/eval/` — and `buildReviewedSnapshot`/`applyReviewManifest`/`loadReviewManifest` all live there by design (oracle-adjacent, human-review layer). Adding `--stage=qualify` to `run-extraction.ts` would force it to import `src/lib/eval/reviewed-snapshot.ts`, breaking its oracle-blind guarantee and failing the existing static gate. `scripts/run-qualify.ts` is **not** added to `ORACLE_BLIND_SCRIPTS` — it plays the same already-legitimate role as `scripts/run-eval-corpus.ts`/`scripts/test-extraction-pack.ts` (comment at `oracle-isolation.test.ts:161-164`: reading oracle-adjacent manifest/review data is these scripts' explicit job, §0.3 №3).

**CLI shape** (matches `run-extraction.ts`'s manual `--flag=` parsing convention):

```typescript
// scripts/run-qualify.ts
const SUPPORTED_STAGES = ['qualify'] as const;
type Stage = (typeof SUPPORTED_STAGES)[number];

interface CliArgs {
  readonly stage: Stage;
  /** Dir written by a prior `--stage=extraction` run (persisted-units.candidate.jsonl, extraction-summary.json). */
  readonly extractionDir: string;
  readonly manifestPath: string; // defaults to REVIEW_MANIFEST_PATH if omitted — same default as loadReviewManifest
  readonly outPath: string; // where reviewed-knowledge-snapshot.json is written
}

const USAGE = 'Usage: npx tsx scripts/run-qualify.ts --stage=qualify --extraction-dir=path/to/dir --out=path/to/reviewed-knowledge-snapshot.json [--manifest=path]';

function parseArgs(argv: readonly string[]): CliArgs { /* same style as run-extraction.ts:72-93 */ }

export function loadExtractionArtifact(extractionDir: string): ExtractionQualificationArtifact {
  // reads persisted-units.candidate.jsonl + extraction-summary.json (sourceRevisionHash,
  // canonicalTextHash, parserVersion, runConfig.{provider,model,promptVersion,extractionSchemaVersion})
  // written by run-extraction.ts's main(), builds via buildExtractionQualificationArtifact(...)
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifact = loadExtractionArtifact(args.extractionDir);

  let manifest;
  try {
    manifest = loadReviewManifest(args.manifestPath);
  } catch (err) {
    console.error(
      `FATAL: не удалось прочитать human review manifest по пути "${args.manifestPath}" — ` +
        'qualify не может создать ReviewedKnowledgeSnapshot без человеческого решения.\n' +
        String(err)
    );
    process.exitCode = 1;
    return;
  }

  const qualifiedAt = new Date().toISOString(); // computed ONCE here, per reviewed-snapshot.ts's design note
  const result = buildReviewedSnapshot(artifact, manifest, qualifiedAt);
  if (!result.ok) {
    console.error('QUALIFY GATE FAIL:');
    for (const f of result.failures) console.error(`  [${f.code}] ${f.unitId}: ${f.detail}`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(args.outPath, JSON.stringify(result.snapshot, null, 2), 'utf8');
  console.log(`ReviewedKnowledgeSnapshot written to ${args.outPath} (${result.snapshot.units.length} units).`);
}

if (require.main === module) {
  main().catch((err) => { console.error('FATAL ERROR:', err); process.exit(1); });
}
```

**Step 1 — RED tests in `run-qualify.test.ts`** (unit-test the exported pieces, not `main()`'s I/O directly — matches how `run-extraction.ts` stays testable per its `require.main` guard):

```typescript
it('parseArgs — --stage=qualify обязателен и единственный поддержанный', () => {
  expect(() => parseArgs(['--stage=extraction', '--extraction-dir=x', '--out=y'])).toThrow(/Неподдержанная стадия/);
});

it('parseArgs — отсутствие --extraction-dir или --out — явная ошибка с USAGE', () => {
  expect(() => parseArgs(['--stage=qualify'])).toThrow();
});

it('loadExtractionArtifact — читает persisted-units.candidate.jsonl + extraction-summary.json из fixture-каталога и строит валидный ExtractionQualificationArtifact', () => {
  const artifact = loadExtractionArtifact(FIXTURE_EXTRACTION_DIR);
  expect(verifyExtractionQualificationArtifact(artifact)).toBe(true);
});

it('main() — manifestPath указывает на несуществующий файл -> завершается чисто (exitCode=1, понятное сообщение), НЕ бросает неотловленное исключение со стектрейсом', async () => {
  process.argv = ['node', 'run-qualify.ts', '--stage=qualify', `--extraction-dir=${FIXTURE_EXTRACTION_DIR}`, '--out=/tmp/x.json', '--manifest=/does/not/exist.jsonl'];
  await main();
  expect(process.exitCode).toBe(1);
});
```

**Step 2:** RED (`run-qualify.ts` doesn't exist yet — everything fails to import).

**Step 3:** Implement `parseArgs` + `loadExtractionArtifact` + `main` as above. Create a small fixture extraction-dir under `scripts/fixtures/` (or `scripts/__tests__/fixtures/`) with a synthetic `persisted-units.candidate.jsonl` + `extraction-summary.json` for the `loadExtractionArtifact` test — **synthetic units only, not derived from the real oracle DOCX**, consistent with this file's non-oracle-blind-but-still-not-oracle-authoring role.

**Step 4: hard stop — do NOT run `run-qualify.ts` against the real extraction output + the real (nonexistent) manifest.** Confirmed via grep: `scripts/fixtures/semantic-rule-review-manifest.jsonl` does not exist yet in this repo, so `main()` run for real would hit the clean-failure path anyway — but do not construct or commit a manifest to make it succeed. That is explicitly the separate oracle-blind human's job.

**Step 5:** Green, typecheck, lint. **Commit:** `feat(cli): --stage=qualify skeleton — materializes ReviewedKnowledgeSnapshot from an extraction artifact + human manifest, fails cleanly with no manifest (no review fabricated)`

---

## Task 11: Full verification + PR update

**Steps:**
1. `pnpm test` — full suite green (all ten tasks' tests + untouched existing tests).
2. `pnpm typecheck` — no errors (catches any missed reference from the `RetrievalArtifact.embeddingModel` rename, `ExtractionDriftReport` field renames, `SnapshotProvenance` removal, etc. — expected zero stragglers per the grep-confirmed no-external-consumers checks in Tasks 1-3, but this is the actual proof, not the grep).
3. `pnpm lint` — clean.
4. `pnpm build` — clean (per global CLAUDE.md Pre-Deploy Build Gate).
5. Push the branch, confirm GitHub CI green (`gh run list`, `gh run watch` on the latest run for `feat/canonical-docx-blocks`).
6. Update PR #76 description/body with a short changelog of the 10 fixes (do not merge — PR stays open for the separate oracle-blind human review, per the task's explicit constraint).
7. Write the final report (see below) — do not fabricate a review, do not start e2e/retrieval-answer runs.

**Final report must state, explicitly separated:**
- **READY FOR HUMAN REVIEW** — what's true now that wasn't before (extraction-drift semantics correct, snapshot provenance bound, oracle-taint per-secret coverage known).
- **READY FOR RETRIEVAL** — embedding cardinality/provenance enforced, retrievalText complete, QueryFrame trust boundary closed, additive history correct, recall metric hardened, multi-clause coverage gradeable.
- **NOT YET READY FOR E2E** — no `ReviewedKnowledgeSnapshot` has actually been materialized (no manifest exists), `run-qualify.ts` has never been run against real data, Task 8's evidence groups may be placeholder-only if no real extraction artifact was available this session (flag this explicitly if so), Task 9's `unguardedSecretCount` result on the real pack (report the actual number, whatever it is).
