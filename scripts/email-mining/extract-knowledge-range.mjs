/**
 * Извлечение переиспользуемых знаний из уже выгруженных тредов
 * (scratchpad/threads-{deal,lead}-<from>.json, см. build-threads.mjs).
 *
 * В отличие от extract-knowledge.mjs — не тянет из Bitrix сам (это уже сделано
 * build-threads.mjs, бесплатно, без LLM), а работает по готовым файлам. Так
 * извлечение можно перезапускать без повторного пула из Bitrix, и диапазон дат
 * не зашит внутри скрипта — он был зашит в build-threads.mjs при выгрузке.
 *
 * Промпт — дословно из extract-knowledge.mjs (проверен на майском корпусе,
 * переписывать риска ради нет смысла).
 *
 *   node scripts/email-mining/extract-knowledge-range.mjs <файл1.json> [файл2.json ...] [--out=имя]
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { extract, MAX_RETRIES } from './openai-extract.mjs';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }
const MODEL = process.env.EXTRACT_MODEL || 'gpt-4o';

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice('--out='.length) : 'email-knowledge-range';
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) { console.error('Укажи хотя бы один файл threads-*.json'); process.exit(1); }

const pii = (s) => s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]').replace(/(\+?\d[\d\-\s()]{8,}\d)/g, '[phone]');

/**
 * Прогон на 640 тредах пришлось остановить вручную на середине (внешний сбой
 * биллинга Anthropic потребовал немедленно освободить квоту OpenAI для
 * диагностики) — и весь накопленный результат пропал, потому что запись на
 * диск происходила один раз, в самом конце. Здесь — сохранение каждые 20
 * тредов и после каждого штатного или аварийного завершения, плюс список
 * обработанных id рядом, чтобы следующий запуск с тем же --out мог
 * ДОПРОДОЛЖИТЬ, а не заново платить за уже извлечённое.
 */
const pool = async (items, n, fn, checkpoint) => {
  const out = []; let i = 0; let done = 0; const failed = [];
  // Множество, не срез по индексу: при concurrency>1 треды завершаются не по
  // порядку выдачи, срез до текущего k пометил бы «обработанным» то, что ещё
  // реально в полёте.
  const processedIds = new Set();
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out.push(...await fn(items[k])); } catch (e) {
        console.error(`  ! thread ${items[k].dealId}: ${String(e).slice(0, 160)}`);
        failed.push(items[k].dealId);
      }
      processedIds.add(items[k].dealId);
      done++;
      if (done % 20 === 0) {
        console.log(`  ${done}/${items.length}...`);
        checkpoint?.(out, [...processedIds]);
      }
    }
  }));
  checkpoint?.(out, [...processedIds]);
  if (failed.length > 0) console.log(`\nОКОНЧАТЕЛЬНО НЕ ИЗВЛЕЧЕНО (после ${MAX_RETRIES + 1} попыток каждый): ${failed.length} — ${failed.join(', ')}`);
  return out;
};

mkdirSync('scratchpad', { recursive: true });
const outPath = `scratchpad/${OUT}.json`;
const progressPath = `scratchpad/${OUT}.progress.json`;

(async () => {
  let threads = [];
  for (const f of files) {
    const rows = JSON.parse(readFileSync(f, 'utf8'));
    const srcType = f.includes('lead') ? 'email-lead' : 'email-deal';
    for (const r of rows) threads.push({ ...r, transcript: pii(r.transcript).slice(0, 4000), src_type: srcType });
    console.log(`  ${f}: ${rows.length} тредов`);
  }

  // Резюме: если рядом лежит прогресс от прерванного прошлого запуска с тем же
  // --out, уже обработанные id пропускаем — не платим за них второй раз.
  let priorItems = [];
  let doneIds = new Set();
  if (existsSync(outPath) && existsSync(progressPath)) {
    priorItems = JSON.parse(readFileSync(outPath, 'utf8'));
    doneIds = new Set(JSON.parse(readFileSync(progressPath, 'utf8')));
    console.log(`  найден прогресс прошлого запуска: ${doneIds.size} тредов уже обработано, ${priorItems.length} пунктов сохранено`);
  }
  const todo = threads.filter((t) => !doneIds.has(t.dealId));
  console.log(`\nВсего тредов: ${threads.length}, к извлечению сейчас: ${todo.length}, модель ${MODEL}\n`);

  const save = (freshItems, freshIds) => {
    const merged = [...priorItems, ...freshItems];
    const allIds = new Set([...doneIds, ...freshIds]);
    writeFileSync(outPath, JSON.stringify(merged, null, 2));
    writeFileSync(progressPath, JSON.stringify([...allIds], null, 2));
  };

  // concurrency=6 без ретраев уложило 608/640 тредов в TPM-лимит gpt-4o в первую
  // же минуту. С ретраями порог сам себя выправит, но ниже стартовая
  // параллельность — меньше выброшенных впустую первых попыток.
  const newItems = await pool(
    todo,
    3,
    async (t) => (await extract(t.transcript, `deal ${t.dealId}`)).map((it) => ({ ...it, dealId: t.dealId, src_type: t.src_type })),
    save
  );

  const items = [...priorItems, ...newItems];
  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  console.log(`\n=== ВСЕГО ${items.length} пунктов из ${threads.length} тредов (${newItems.length} новых в этом запуске) ===`);
  console.log('  by type:', JSON.stringify(byType));
  console.log('  price_dependent:', items.filter((i) => i.price_dependent).length);
  console.log(`  saved -> ${outPath}\n`);
})();
