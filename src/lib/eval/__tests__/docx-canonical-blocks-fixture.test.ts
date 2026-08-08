import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCanonicalDocxBlocks } from '@/lib/knowledge/docx-canonical-blocks';
import { resolveEvidenceOffsets } from '@/lib/knowledge/applicability/identity';
import { assignIdentity, type SourceBlockLocation } from '@/lib/knowledge/applicability/identity-assignment';
import type { ExtractedKnowledgeUnit } from '@/lib/knowledge/applicability/extraction';
import { ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from '../semantic-rule-oracle';

/**
 * H slice 5b на РЕАЛЬНОМ учебном DOCX (план §3 PR H, Beads translation-yz9).
 *
 * Изоляция oracle (§0.3): этот файл читает ТОЛЬКО DOCX через
 * `ORACLE_PACK_DIR`/`SOURCE_DOCX_FILENAME` (единственный разрешённый файл
 * пакета) — ни `test_cases_semantic_rules.jsonl`, ни
 * `kontrolnye_voprosy_i_klyuch.md` здесь не открываются и не импортируются.
 * Живёт в `src/lib/eval/__tests__/` намеренно: `oracle-isolation.test.ts`
 * запрещает продуктовому коду (`src/` за вычетом `src/lib/eval/`) упоминать
 * `SOURCE_DOCX_FILENAME`/имя пакета строковым литералом — тот же прецедент,
 * что `source-rule-segmentation.ts`.
 */

function loadFixtureBuffer(): Buffer {
  return fs.readFileSync(path.join(ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME));
}

describe('extractCanonicalDocxBlocks на реальном учебном DOCX', () => {
  it('даёт ровно 15 непустых блоков (10 правил + преамбула + таблица «Назначение»)', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    expect(doc.blocks).toHaveLength(15);
  });

  it('каждый блок сохраняет offset-инвариант block.text === canonicalText.slice(blockStart, blockEnd)', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    for (const block of doc.blocks) {
      expect(doc.canonicalText.slice(block.blockStart, block.blockEnd)).toBe(block.text);
    }
  });

  it('правило 4: split-run label+тело склеены в один блок, все три числа сохранены дословно (Q04)', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    const rule4 = doc.blocks.find((b) => b.text.startsWith('4. Сила и продолжительность.'));

    expect(rule4).toBeDefined();
    expect(rule4!.text).toContain('не дольше 15 секунд');
    expect(rule4!.text).toContain('не менее 30 секунд');
    expect(rule4!.text).toContain('не более трёх таких циклов');
  });

  it('таблица «Назначение»: bold-label run и italic-body run склеены без разрыва', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    const purpose = doc.blocks.find((b) => b.text.startsWith('Назначение:'));

    expect(purpose?.text).toBe(
      'Назначение: вымышленный документ для проверки семантического поиска и извлечения правил. Он не является медицинской рекомендацией.'
    );
  });

  it('повторный прогон на том же DOCX даёт идентичный результат (offsets, anchors, sectionPath)', async () => {
    const buffer = loadFixtureBuffer();
    const run1 = await extractCanonicalDocxBlocks(buffer);
    const run2 = await extractCanonicalDocxBlocks(buffer);
    expect(run2).toEqual(run1);
  });

  it('критический инвариант: цитата из block.text резолвится единственным indexOf() через resolveEvidenceOffsets', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    const rule4 = doc.blocks.find((b) => b.text.startsWith('4. Сила и продолжительность.'))!;

    for (const quote of ['не дольше 15 секунд', 'не менее 30 секунд', 'не более трёх таких циклов']) {
      const offsets = resolveEvidenceOffsets(rule4.text, quote);
      expect(offsets, `quote "${quote}" обязана резолвиться однозначно`).not.toBeNull();
      expect(rule4.text.slice(offsets!.start, offsets!.end)).toBe(quote);
    }
  });

  it('end-to-end с assignIdentity: unit, сославшийся на anchor+quote реального блока, получает unitId со стабильными абсолютными офсетами', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    const rule9 = doc.blocks.find((b) => b.text.startsWith('9. Помощь другого человека.'))!;
    const quote = 'обязан надеть чистые одноразовые перчатки';
    expect(rule9.text).toContain(quote);

    const blocksByAnchor = new Map<string, SourceBlockLocation>(doc.blocks.map((b) => [b.anchor, b]));
    const unit: ExtractedKnowledgeUnit = {
      kind: 'EXCEPTION_RULE',
      statement: 'Помощник обязан надеть чистые перчатки.',
      facets: {},
      triggerCondition: null,
      numericConstraint: null,
      parentRuleRef: null,
      sourceSpan: { anchor: rule9.anchor, quote },
      evidenceByField: { statement: { anchor: rule9.anchor, quote } },
      uncertainties: [],
    };

    const result = assignIdentity([unit], blocksByAnchor, doc.sourceRevisionHash);

    expect(result.unresolvedEvidence).toEqual([]);
    expect(result.units).toHaveLength(1);
    const localOffset = rule9.text.indexOf(quote);
    expect(localOffset).toBeGreaterThanOrEqual(0);

    // Повторный прогон с теми же байтами обязан дать тот же unitId — план §3
    // PR H: "повторный прогон даёт те же unitId".
    const secondDoc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    const secondBlocksByAnchor = new Map<string, SourceBlockLocation>(
      secondDoc.blocks.map((b) => [b.anchor, b])
    );
    const secondResult = assignIdentity([unit], secondBlocksByAnchor, secondDoc.sourceRevisionHash);
    expect(secondResult.units[0]?.unitId).toBe(result.units[0]?.unitId);
  });

  it('доступен напрямую как SourceBlock[] для extractKnowledgeUnits — anchor+text присутствуют без адаптации', async () => {
    const doc = await extractCanonicalDocxBlocks(loadFixtureBuffer());
    const sourceBlocks = doc.blocks.map((b) => ({ anchor: b.anchor, text: b.text }));
    expect(sourceBlocks.length).toBe(doc.blocks.length);
    expect(sourceBlocks.every((b) => b.anchor.length > 0 && b.text.length > 0)).toBe(true);
  });
});
