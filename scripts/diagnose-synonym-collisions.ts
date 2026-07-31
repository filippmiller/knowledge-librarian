/**
 * Какой именно синоним отнимает у услуги находимость.
 *
 * Ворота показали, что предложенный набор в МИНУСЕ: три услуги перестали
 * находиться по собственному названию (было 25, стало 22). Само по себе
 * пересечение синонима с чужим названием НЕ является дефектом — в опознании
 * есть правило «частное побеждает общее», и «нотариальное заверение перевода»
 * законно уступает «срочному нотариальному заверению перевода».
 *
 * Поэтому виновные ищутся не рассуждением, а проверкой: синоним удаляется, и
 * смотрится, вернулась ли находимость. Печатается точный список к удалению.
 *
 * Запуск: npx tsx scripts/diagnose-synonym-collisions.ts
 */
import { readFileSync } from 'node:fs';
import { TARIFF_SYNONYMS, type SynonymProposal } from './seed-tariff-synonyms';
import { lookupTariffForQuestion } from '../src/lib/knowledge/tariff-lookup';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';

/** Снимок сетки, снятый до падения авторизации Railway. */
function loadSnapshot(): TariffRecord[] {
  const raw = JSON.parse(readFileSync('scripts/tariff-snapshot.json', 'utf8')) as unknown;
  const rows = (Array.isArray(raw) ? raw : ((raw as { tariffs?: unknown[] }).tariffs ?? [])) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    ...(r as unknown as TariffRecord),
    effectiveFrom: new Date(String(r.effectiveFrom ?? '2026-01-01')),
    effectiveTo: r.effectiveTo ? new Date(String(r.effectiveTo)) : null,
    synonyms: [],
  }));
}

/** Услуги, находимые вопросом «Сколько стоит <название>?». */
function findable(tariffs: TariffRecord[]): Set<string> {
  const names = [...new Set(tariffs.map((t) => t.serviceName))];
  const found = new Set<string>();
  for (const name of names) {
    const verdict = lookupTariffForQuestion(`Сколько стоит ${name}?`, tariffs);
    if (verdict.kind === 'single' && verdict.tariff.serviceName === name) found.add(name);
    else if (verdict.kind === 'variants' && verdict.service === name) found.add(name);
  }
  return found;
}

/** Сетка со списком синонимов, наложенным поверх снимка. */
function withSynonyms(base: TariffRecord[], proposals: SynonymProposal[]): TariffRecord[] {
  const byService = new Map<string, string[]>();
  for (const p of proposals) byService.set(p.serviceName, p.synonyms);
  return base.map((t) => ({ ...t, synonyms: byService.get(t.serviceName) ?? [] }));
}

function main() {
  const base = loadSnapshot();
  const before = findable(base);
  const after = findable(withSynonyms(base, TARIFF_SYNONYMS));

  const lost = [...before].filter((n) => !after.has(n));
  const gained = [...after].filter((n) => !before.has(n));

  console.log(`услуг в снимке: ${new Set(base.map((t) => t.serviceName)).size}`);
  console.log(`находимо до: ${before.size}, после: ${after.size}`);
  console.log(`потеряно: ${lost.length}, приобретено: ${gained.length}\n`);

  if (lost.length === 0) {
    console.log('Потерь нет — удалять нечего.');
    return;
  }

  for (const name of lost) console.log(`ПОТЕРЯНО: ${name}`);
  console.log('');

  // По одному синониму: возвращает ли его удаление потерянную услугу.
  const guilty: Array<{ synonym: string; owner: string; restores: string[] }> = [];
  for (const proposal of TARIFF_SYNONYMS) {
    for (const synonym of proposal.synonyms) {
      const trimmed = TARIFF_SYNONYMS.map((p) =>
        p.serviceName === proposal.serviceName
          ? { ...p, synonyms: p.synonyms.filter((s) => s !== synonym) }
          : p
      );
      const probe = findable(withSynonyms(base, trimmed));
      const restores = lost.filter((n) => probe.has(n));
      if (restores.length > 0) guilty.push({ synonym, owner: proposal.serviceName, restores });
    }
  }

  console.log('=== СИНОНИМЫ К УДАЛЕНИЮ ===\n');
  for (const g of guilty) {
    console.log(`«${g.synonym}»`);
    console.log(`   у услуги: ${g.owner}`);
    console.log(`   удаление возвращает: ${g.restores.join(' | ')}\n`);
  }
  console.log(`всего к удалению: ${guilty.length}`);
}

main();
