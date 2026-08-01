/**
 * Гасит правила языковой матрицы перевода, которые дословно дублируют
 * тарифную сетку — единственный источник, который сейчас активно
 * поддерживается (`/admin/tariffs`). Правила извлекались из того же
 * документа генеральным пайплайном ДО того, как сетка стала единственным
 * источником цен, и с тех пор обновляются независимо: ровно так родился
 * прошлогодний баг «20 000 вместо 22 000» (см. `stale-price-check.ts`).
 *
 * Гасит ТОЛЬКО строки языковой матрицы (категории 1/2/3) — они мехбанически
 * проверяемы через структурные поля `Tariff.language` / `complexityCategory`,
 * без нечёткого сопоставления по названию. Плоские сертификационные правила
 * (заверение/сканирование/вёрстка) и правила-определения («условная страница
 * = 1800 знаков») сюда намеренно НЕ входят — им нужна отдельная, более
 * аккуратная сверка, не автоматизируется в этом проходе.
 *
 * Гасить — значит `status: DEPRECATED`, НЕ удалять физически: правило,
 * удалённое сегодня утром вместе с документом, осиротело на 114 копий —
 * повторять эту ошибку здесь нельзя. Рядом пишется `KnowledgeChange`
 * (`changeType: 'DEPRECATE'`, `initiatedBy: 'AI'`) — тот же паттерн, что у
 * ручного гашения через админку (`api/rules/[id]/route.ts`), с `reason`,
 * фиксирующим ИМЕННО ту сверку, которая разрешила гашение.
 *
 * ПРАВИЛО ГАШЕНИЯ: каждое число, встречающееся в теле правила, обязано
 * найтись среди сумм тарифов, сопоставленных по (язык, категория). Если хотя
 * бы одно число не находится — это не дубликат, а расхождение, и правило
 * остаётся активным с пометкой в отчёте. Ложное гашение верного правила
 * дороже, чем оставить дубликат ещё на день.
 *
 * Запуск:
 *   railway run npx tsx scripts/retire-matrix-duplicate-rules.ts            — сухой прогон, отчёт
 *   railway run npx tsx scripts/retire-matrix-duplicate-rules.ts --apply    — гасит подтверждённые
 */
import prisma from '../src/lib/db';

const APPLY = process.argv.includes('--apply');
const DOC_FILENAME_CONTAINS = 'Прайс на перевод и заверение-010126';

const MONEY = /(\d[\d\s ]{2,})\s*(?:₽|руб)/giu;
const normalizeAmount = (raw: string) => Number(raw.replace(/[\s ]/g, ''));

/** Заголовки правил матрицы — три формата, встреченные в этом документе. */
const TITLE_PATTERNS: { re: RegExp; category: (m: RegExpMatchArray) => number; lang: (m: RegExpMatchArray) => string }[] = [
  // «Тарифы на перевод с английского языка, категория 1» / «...категория 2»
  {
    re: /^Тарифы на перевод (?:с|со) (.+?)(?: языка)?,? категория (\d+)$/iu,
    category: (m) => Number(m[2]),
    lang: (m) => m[1],
  },
  // «Тарифы на письменный перевод категория 3 с абхазского языка»
  {
    re: /^Тарифы на письменный перевод категория (\d+) (?:с|со) (.+?)(?: языка)?$/iu,
    category: (m) => Number(m[1]),
    lang: (m) => m[2],
  },
];

/**
 * Родительный падеж (как в заголовке правила) → именительный (как в
 * `Tariff.language`). Явная таблица, а не стемминг: окончание родительного
 * падежа («-ого», «-его») отъедает от 3 до 4 букв неравномерно («чешского» →
 * «чешск», «казахского» → «казахск» — стебель то 5, то 7 букв), и формула
 * среза, годная для многословных названий услуг (`service-terms.ts`), на
 * одиночном слове давала на первом прогоне 12 совпадений из ожидаемых ~150.
 * Языков ровно 52 — под явную таблицу, без риска и без гадания.
 */
const GENITIVE_TO_NOMINATIVE: Record<string, string> = {
  английского: 'АНГЛИЙСКИЙ',
  арабского: 'АРАБСКИЙ',
  венгерского: 'ВЕНГЕРСКИЙ',
  вьетнамского: 'ВЬЕТНАМСКИЙ',
  греческого: 'ГРЕЧЕСКИЙ',
  датского: 'ДАТСКИЙ',
  дари: 'ДАРИ',
  иврита: 'ИВРИТ',
  индонезийского: 'ИНДОНЕЗИЙСКИЙ',
  испанского: 'ИСПАНСКИЙ',
  итальянского: 'ИТАЛЬЯНСКИЙ',
  каталонского: 'КАТАЛОНСКИЙ',
  китайского: 'КИТАЙСКИЙ',
  корейского: 'КОРЕЙСКИЙ',
  малайского: 'МАЛАЙСКИЙ',
  монгольского: 'МОНГОЛЬСКИЙ',
  немецкого: 'НЕМЕЦКИЙ',
  нидерландского: 'НИДЕРЛАНДСКИЙ',
  норвежского: 'НОРВЕЖСКИЙ',
  португальского: 'ПОРТУГАЛЬСКИЙ',
  пушту: 'ПУШТУ',
  сербского: 'СЕРБСКИЙ',
  словацкого: 'СЛОВАЦКИЙ',
  словенского: 'СЛОВЕНСКИЙ',
  тайского: 'ТАЙСКИЙ',
  турецкого: 'ТУРЕЦКИЙ',
  фарси: 'ФАРСИ',
  финского: 'ФИНСКИЙ',
  французского: 'ФРАНЦУЗСКИЙ',
  хорватского: 'ХОРВАТСКИЙ',
  черногорского: 'ЧЕРНОГОРСКИЙ',
  чешского: 'ЧЕШСКИЙ',
  шведского: 'ШВЕДСКИЙ',
  эстонского: 'ЭСТОНСКИЙ',
  японского: 'ЯПОНСКИЙ',
  азербайджанского: 'АЗЕРБАЙДЖАНСКИЙ',
  абхазского: 'АБХАЗСКИЙ',
  армянского: 'АРМЯНСКИЙ',
  белорусского: 'БЕЛОРУССКИЙ',
  болгарского: 'БОЛГАРСКИЙ',
  грузинского: 'ГРУЗИНСКИЙ',
  казахского: 'КАЗАХСКИЙ',
  киргизского: 'КИРГИЗСКИЙ',
  латышского: 'ЛАТЫШСКИЙ',
  литовского: 'ЛИТОВСКИЙ',
  молдавского: 'МОЛДАВСКИЙ',
  польского: 'ПОЛЬСКИЙ',
  румынского: 'РУМЫНСКИЙ',
  таджикского: 'ТАДЖИКСКИЙ',
  туркменского: 'ТУРКМЕНСКИЙ',
  узбекского: 'УЗБЕКСКИЙ',
  украинского: 'УКРАИНСКИЙ',
};

/** Проверка полноты таблицы на старте — молчаливый пробел здесь опаснее шума. */
function assertLanguageTableComplete(gridLanguages: string[]): void {
  const covered = new Set(Object.values(GENITIVE_TO_NOMINATIVE));
  const missing = gridLanguages.filter((l) => !covered.has(l));
  if (missing.length > 0) {
    throw new Error(
      `Таблица GENITIVE_TO_NOMINATIVE не покрывает языки сетки: ${missing.join(', ')}. ` +
        `Добавь родительный падеж для них перед запуском — иначе их правила молча уйдут в NO_TARIFF_MATCH.`
    );
  }
}

function langKey(word: string): string {
  return word.toLowerCase().replace(/ё/g, 'е').trim();
}

interface MatrixMatch {
  language: string;
  category: number;
}

function matchTitle(title: string): MatrixMatch | null {
  for (const p of TITLE_PATTERNS) {
    const m = title.match(p.re);
    if (m) return { language: p.lang(m), category: p.category(m) };
  }
  return null;
}

type Verdict = 'DUPLICATE' | 'DISCREPANCY' | 'NO_TARIFF_MATCH' | 'NOT_MATRIX';

interface Result {
  ruleCode: string;
  title: string;
  verdict: Verdict;
  detail: string;
}

async function main() {
  const doc = await prisma.document.findFirst({
    where: { filename: { contains: DOC_FILENAME_CONTAINS } },
    select: { id: true, filename: true },
  });
  if (!doc) {
    console.error('документ не найден');
    process.exit(1);
  }
  console.log(`документ: ${doc.filename}\n`);

  const rules = await prisma.rule.findMany({
    where: { status: 'ACTIVE', documentId: doc.id },
    select: { id: true, ruleCode: true, title: true, body: true },
    orderBy: { ruleCode: 'asc' },
  });

  const tariffs = await prisma.tariff.findMany({
    where: { section: 'TRANSLATION', language: { not: null }, complexityCategory: { not: null } },
    select: { language: true, complexityCategory: true, amount: true },
  });

  assertLanguageTableComplete([...new Set(tariffs.map((t) => t.language!))]);

  const results: Result[] = [];
  const toDeprecate: { ruleId: string; ruleCode: string; reason: string; body: string }[] = [];

  for (const r of rules) {
    const match = matchTitle(r.title);
    if (!match) {
      results.push({ ruleCode: r.ruleCode, title: r.title, verdict: 'NOT_MATRIX', detail: '' });
      continue;
    }

    const nominative = GENITIVE_TO_NOMINATIVE[langKey(match.language)];
    if (!nominative) {
      results.push({
        ruleCode: r.ruleCode,
        title: r.title,
        verdict: 'NO_TARIFF_MATCH',
        detail: `язык «${match.language}» не опознан таблицей падежей — проверь заголовок вручную`,
      });
      continue;
    }

    const candidates = tariffs.filter(
      (t) => t.complexityCategory === match.category && t.language === nominative
    );

    if (candidates.length === 0) {
      results.push({
        ruleCode: r.ruleCode,
        title: r.title,
        verdict: 'NO_TARIFF_MATCH',
        detail: `язык «${match.language}» → ${nominative}, категория ${match.category} — строк в сетке не нашлось`,
      });
      continue;
    }

    const allowed = new Set(
      candidates.map((t) => (t.amount !== null ? Number(t.amount) : null)).filter((x): x is number => x !== null)
    );
    const bodyAmounts = [...r.body.matchAll(MONEY)].map((m) => normalizeAmount(m[1]));

    if (bodyAmounts.length === 0) {
      results.push({
        ruleCode: r.ruleCode,
        title: r.title,
        verdict: 'NO_TARIFF_MATCH',
        detail: 'в тексте правила не нашлось ни одной суммы — разбор тела не сработал, не гашу',
      });
      continue;
    }

    const missing = bodyAmounts.filter((a) => !allowed.has(a));
    if (missing.length > 0) {
      results.push({
        ruleCode: r.ruleCode,
        title: r.title,
        verdict: 'DISCREPANCY',
        detail: `в теле есть ${missing.join(', ')} — этих сумм нет среди ${candidates.length} строк сетки (${[...allowed].sort((a, b) => a - b).join(', ')})`,
      });
      continue;
    }

    const reason =
      `Дубликат тарифной сетки: язык «${match.language}» (${nominative}), категория ${match.category}. ` +
      `Все ${bodyAmounts.length} сумм из тела правила (${[...new Set(bodyAmounts)].sort((a, b) => a - b).join(', ')}) ` +
      `совпадают со строками сетки Tariff (section=TRANSLATION, language=${nominative}, complexityCategory=${match.category}, ` +
      `${candidates.length} строк). Сетка — единственный поддерживаемый источник цен перевода (/admin/tariffs), правило дублирует ` +
      `и рискует разойтись при обновлении сетки. Проверено скриптом scripts/retire-matrix-duplicate-rules.ts, ` +
      `решение подтверждено владельцем устно в сессии 2026-08-01.`;

    results.push({
      ruleCode: r.ruleCode,
      title: r.title,
      verdict: 'DUPLICATE',
      detail: `${bodyAmounts.length} сумм, все совпали с ${candidates.length} строками сетки`,
    });
    toDeprecate.push({ ruleId: r.id, ruleCode: r.ruleCode, reason, body: r.body });
  }

  const byVerdict = (v: Verdict) => results.filter((r) => r.verdict === v);
  console.log(`правил всего: ${rules.length}`);
  console.log(`  подтверждённые дубликаты сетки: ${byVerdict('DUPLICATE').length}`);
  console.log(`  РАСХОЖДЕНИЕ с сеткой (не гасится, нужен разбор): ${byVerdict('DISCREPANCY').length}`);
  console.log(`  не нашлось строк сетки (не гасится): ${byVerdict('NO_TARIFF_MATCH').length}`);
  console.log(`  не похоже на строку матрицы (другой класс правил, вне этого прохода): ${byVerdict('NOT_MATRIX').length}`);

  if (byVerdict('DISCREPANCY').length > 0) {
    console.log(`\n=== РАСХОЖДЕНИЯ — ЭТО ВАЖНО, ЧИТАТЬ ===`);
    for (const r of byVerdict('DISCREPANCY')) console.log(`  ${r.ruleCode} :: ${r.title}\n    ${r.detail}`);
  }

  if (byVerdict('NO_TARIFF_MATCH').length > 0) {
    console.log(`\n=== НЕТ СТРОК В СЕТКЕ ===`);
    for (const r of byVerdict('NO_TARIFF_MATCH')) console.log(`  ${r.ruleCode} :: ${r.title}\n    ${r.detail}`);
  }

  console.log(`\n=== НЕ МАТРИЦА (вне этого прохода, для проверки глазами) ===`);
  for (const r of byVerdict('NOT_MATRIX')) console.log(`  ${r.ruleCode} :: ${r.title}`);

  console.log(`\n=== ПОДТВЕРЖДЁННЫЕ ДУБЛИКАТЫ (первые 10 из ${toDeprecate.length}) ===`);
  for (const d of toDeprecate.slice(0, 10)) console.log(`  ${d.ruleCode}`);

  if (!APPLY) {
    console.log(`\nСУХОЙ ПРОГОН. Ничего не изменено. Запусти с --apply, чтобы погасить ${toDeprecate.length} правил.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== ПРИМЕНЯЮ: гашу ${toDeprecate.length} правил ===`);
  let done = 0;
  for (const d of toDeprecate) {
    await prisma.$transaction([
      prisma.rule.update({ where: { id: d.ruleId }, data: { status: 'DEPRECATED' } }),
      prisma.knowledgeChange.create({
        data: {
          targetType: 'RULE',
          targetId: d.ruleId,
          changeType: 'DEPRECATE',
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'DEPRECATED' },
          reason: d.reason,
          initiatedBy: 'AI',
          approvedBy: 'Filipp Miller (устно, в сессии 2026-08-01)',
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      }),
    ]);
    done++;
    if (done % 20 === 0) console.log(`  ${done}/${toDeprecate.length}...`);
  }
  console.log(`Готово: погашено ${done} правил.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
