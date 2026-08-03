/**
 * Гасит правила, дублирующие `CERTIFICATION_SERVICES` — вручную выверенную
 * таблицу 23 сертификационных услуг в коде (`certification-price.ts`),
 * источник для сторожа приписки цены. Правила извлекались из того же
 * документа генеральным пайплайном раньше, чем эта таблица была построена, и
 * с тех пор — второй, независимо обновляемый источник тех же 23 фактов.
 *
 * ПОЧЕМУ НЕ ПЕРЕИСПОЛЬЗУЕТСЯ `checkCertificationPriceAttribution` НАПРЯМУЮ.
 * Та функция сверяет цену и услугу, названные В ОДНОМ ПРЕДЛОЖЕНИИ живого
 * ответа бота. У этих правил услуга — в `title`, цена — в `body`, разных
 * полях; предложение с ценой само по себе не называет услугу (`Заверение
 * перевода... стоит 250 руб.` — да, а `1450 рублей за один документ...` —
 * нет), и `services.length === 0` в проверке просто пропустил бы пару молча.
 * Поэтому опознавание услуги — по `title+body` целиком, без требования
 * соседства, а сравнение цены — своим кодом ниже. Регулярки самих услуг
 * ИМПОРТИРУЮТСЯ из `CERTIFICATION_SERVICES`, а не переписываются: второй
 * список регулярок для тех же услуг рискует разойтись с первым так же, как
 * уже разошлись правила и таблица.
 *
 * У шести услуг таблицы цена не число (проценты/нижняя граница/составная):
 * `price: null`. Для них сверяется ключевое число из `priceText` (70%, 10%,
 * 20%, 60 ₽, либо оба числа составной цены устава) — тоже строгое совпадение,
 * не выбор по смыслу.
 *
 * Гасить — `status: DEPRECATED`, не удалять. Рядом — `KnowledgeChange`
 * (`changeType: 'DEPRECATE'`, `initiatedBy: 'AI'`), тот же паттерн, что и в
 * `retire-matrix-duplicate-rules.ts` и в ручном гашении через админку.
 *
 * Запуск:
 *   railway run npx tsx scripts/retire-certification-duplicate-rules.ts            — сухой прогон
 *   railway run npx tsx scripts/retire-certification-duplicate-rules.ts --apply    — гасит подтверждённые
 */
import prisma from '../src/lib/db';
import { CERTIFICATION_SERVICES, type CertificationService } from '../src/lib/knowledge/certification-price';

const APPLY = process.argv.includes('--apply');
const DOC_FILENAME_CONTAINS = 'Прайс на перевод и заверение-010126';

const MONEY = /(\d[\d\s ]{2,})\s*(?:₽|руб)/giu;
const PERCENT = /(\d+)\s*(?:%|процент)/giu;
const normalizeAmount = (raw: string) => Number(raw.replace(/[\s ]/g, ''));

/** См. комментарий у места использования — только для правил, где regex-опознание не сработало. */
const FALLBACK_KEY_BY_RULE_CODE: Record<string, string> = {
  'R-2008': 'marks', // «Стоимость перевода отметок в документе» — 20 руб./отметка
  'R-2009': 'visas', // «Стоимость перевода виз в документе» — 100 руб./виза
  'R-2012': 'typing_ru', // «Стоимость набора текста на русском языке» — 180 руб./усл. страница
  'R-2013': 'typing_eu', // «...на английском, французском, немецком, испанском, итальянском» — 220 руб.
  'R-2014': 'typing_east', // «...на арабском, турецком, армянском, грузинском, греческом» — 300 руб.
};

interface ServiceHit {
  service: CertificationService;
  start: number;
  end: number;
}

/**
 * Все услуги, названные в тексте, самое длинное совпадение побеждает при
 * пересечении — тот же приём, что `matchServices` в `certification-price.ts`
 * (не экспортирована, поэтому здесь минимальная копия ровно этой части: без
 * предложений, без `carriedService` — на одном изолированном правиле это не
 * нужно, правило и так об одном факте).
 */
function matchServices(text: string): ServiceHit[] {
  const raw: ServiceHit[] = [];
  for (const service of CERTIFICATION_SERVICES) {
    const re = new RegExp(service.pattern.source, 'giu');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      raw.push({ service, start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  raw.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: ServiceHit[] = [];
  for (const c of raw) {
    if (!kept.some((k) => c.start < k.end && k.start < c.end)) kept.push(c);
  }
  return kept;
}

type Verdict = 'DUPLICATE' | 'DISCREPANCY' | 'AMBIGUOUS' | 'NO_SERVICE_MATCH' | 'NOT_PRICE_RULE';

interface Result {
  ruleCode: string;
  title: string;
  verdict: Verdict;
  detail: string;
}

/** Ключевое число из priceText нечисловой услуги: «70% от...», «от 60 руб. за...». */
function keyNumbersOf(priceText: string): number[] {
  const pct = [...priceText.matchAll(PERCENT)].map((m) => Number(m[1]));
  const money = [...priceText.matchAll(MONEY)].map((m) => normalizeAmount(m[1]));
  return [...pct, ...money];
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

  const results: Result[] = [];
  const toDeprecate: { ruleId: string; ruleCode: string; reason: string }[] = [];
  const usedServiceKeys = new Set<string>();

  for (const r of rules) {
    const combined = `${r.title}. ${r.body}`;
    let hits = matchServices(combined);

    // Регулярки CERTIFICATION_SERVICES заточены под живые предложения бота
    // («Перевод отметок стоит 20 рублей»), а заголовки этих правил — под
    // канцелярский родительный падеж («Стоимость перевод А отметок»): пробел
    // после «перевод» в тексте нет, паттерн не совпадает ни с заголовком, ни
    // с телом (тело вообще не называет услугу словами, только сумму). Для
    // пяти таких правил — явное сопоставление вручную, каждое прочитано
    // глазами. Числовая проверка ниже всё равно автоматическая: неверный ключ
    // здесь почти наверняка дал бы DISCREPANCY, а не ложный DUPLICATE.
    if (hits.length === 0) {
      const fallbackKey = FALLBACK_KEY_BY_RULE_CODE[r.ruleCode];
      if (fallbackKey) {
        const service = CERTIFICATION_SERVICES.find((s) => s.key === fallbackKey)!;
        hits = [{ service, start: 0, end: 0 }];
      }
    }

    if (hits.length === 0) {
      results.push({ ruleCode: r.ruleCode, title: r.title, verdict: 'NOT_PRICE_RULE', detail: '' });
      continue;
    }

    // Одна и та же услуга нередко названа дважды — в title кратко, в body в
    // самом ценовом предложении: это ДВА непересекающихся совпадения ОДНОГО
    // ключа, не две разные услуги. Различать нужно по service.key, а не по
    // числу совпадений — иначе «bureau_stamp, bureau_stamp» ошибочно читалось
    // бы как неоднозначность.
    const distinctKeys = new Set(hits.map((h) => h.service.key));
    if (distinctKeys.size > 1) {
      results.push({
        ruleCode: r.ruleCode,
        title: r.title,
        verdict: 'AMBIGUOUS',
        detail: `совпало ${distinctKeys.size} разных услуг: ${[...distinctKeys].join(', ')} — не гашу`,
      });
      continue;
    }

    const service = hits[0].service;
    usedServiceKeys.add(service.key);

    if (service.price !== null) {
      const bodyAmounts = [...r.body.matchAll(MONEY)].map((m) => normalizeAmount(m[1]));
      if (bodyAmounts.length === 0) {
        results.push({
          ruleCode: r.ruleCode,
          title: r.title,
          verdict: 'NO_SERVICE_MATCH',
          detail: `услуга «${service.key}» опознана, но в теле нет суммы — не гашу`,
        });
        continue;
      }
      if (!bodyAmounts.includes(service.price.amount)) {
        results.push({
          ruleCode: r.ruleCode,
          title: r.title,
          verdict: 'DISCREPANCY',
          detail: `тело называет ${bodyAmounts.join(', ')}, таблица для «${service.key}» — ${service.price.amount} ₽ (${service.priceText})`,
        });
        continue;
      }
      toDeprecate.push({
        ruleId: r.id,
        ruleCode: r.ruleCode,
        reason:
          `Дубликат CERTIFICATION_SERVICES['${service.key}'] («${service.label}»). ` +
          `Тело правила называет ${service.price.amount} ₽ — совпадает с ${service.priceText} из certification-price.ts. ` +
          `Таблица в коде — источник сторожа приписки цены, правило дублирует и рискует разойтись при правке таблицы. ` +
          `Проверено скриптом scripts/retire-certification-duplicate-rules.ts, решение подтверждено владельцем устно в сессии 2026-08-01.`,
      });
      results.push({ ruleCode: r.ruleCode, title: r.title, verdict: 'DUPLICATE', detail: service.key });
    } else {
      // Нечисловая цена: сверяем ключевые числа priceText («70%», «60 ₽»).
      const wanted = keyNumbersOf(service.priceText);
      const bodyPct = [...r.body.matchAll(PERCENT)].map((m) => Number(m[1]));
      const bodyMoney = [...r.body.matchAll(MONEY)].map((m) => normalizeAmount(m[1]));
      const bodyNumbers = [...bodyPct, ...bodyMoney];

      if (wanted.length === 0 || bodyNumbers.length === 0) {
        results.push({
          ruleCode: r.ruleCode,
          title: r.title,
          verdict: 'NO_SERVICE_MATCH',
          detail: `услуга «${service.key}» без числа для сверки (priceText: ${service.priceText}) — не гашу`,
        });
        continue;
      }
      const missing = wanted.filter((n) => !bodyNumbers.includes(n));
      if (missing.length > 0) {
        results.push({
          ruleCode: r.ruleCode,
          title: r.title,
          verdict: 'DISCREPANCY',
          detail: `таблица «${service.key}» ждёт числа ${wanted.join(', ')} (${service.priceText}), в теле — ${bodyNumbers.join(', ')}`,
        });
        continue;
      }
      toDeprecate.push({
        ruleId: r.id,
        ruleCode: r.ruleCode,
        reason:
          `Дубликат CERTIFICATION_SERVICES['${service.key}'] («${service.label}»). ` +
          `Ключевые числа тела правила (${bodyNumbers.join(', ')}) совпадают с ${service.priceText} из certification-price.ts. ` +
          `Проверено скриптом scripts/retire-certification-duplicate-rules.ts, решение подтверждено владельцем устно в сессии 2026-08-01.`,
      });
      results.push({ ruleCode: r.ruleCode, title: r.title, verdict: 'DUPLICATE', detail: service.key });
    }
  }

  const byVerdict = (v: Verdict) => results.filter((r) => r.verdict === v);
  console.log(`правил всего: ${rules.length}`);
  console.log(`  подтверждённые дубликаты CERTIFICATION_SERVICES: ${byVerdict('DUPLICATE').length}`);
  console.log(`  РАСХОЖДЕНИЕ с таблицей (не гасится): ${byVerdict('DISCREPANCY').length}`);
  console.log(`  неоднозначно (совпало >1 услуги, не гасится): ${byVerdict('AMBIGUOUS').length}`);
  console.log(`  услуга опознана, но нет числа для сверки (не гасится): ${byVerdict('NO_SERVICE_MATCH').length}`);
  console.log(`  вообще не про сертификационную услугу (вне таблицы): ${byVerdict('NOT_PRICE_RULE').length}`);

  const missingServices = CERTIFICATION_SERVICES.filter((s) => !usedServiceKeys.has(s.key));
  console.log(`\nуслуг таблицы БЕЗ найденного правила-дубликата: ${missingServices.length}`);
  for (const s of missingServices) console.log(`  ${s.key} — ${s.label}`);

  if (byVerdict('DISCREPANCY').length > 0) {
    console.log(`\n=== РАСХОЖДЕНИЯ — ЧИТАТЬ ===`);
    for (const r of byVerdict('DISCREPANCY')) console.log(`  ${r.ruleCode} :: ${r.title}\n    ${r.detail}`);
  }
  if (byVerdict('AMBIGUOUS').length > 0) {
    console.log(`\n=== НЕОДНОЗНАЧНЫЕ ===`);
    for (const r of byVerdict('AMBIGUOUS')) console.log(`  ${r.ruleCode} :: ${r.title}\n    ${r.detail}`);
  }
  if (byVerdict('NO_SERVICE_MATCH').length > 0) {
    console.log(`\n=== НЕТ ЧИСЛА ДЛЯ СВЕРКИ ===`);
    for (const r of byVerdict('NO_SERVICE_MATCH')) console.log(`  ${r.ruleCode} :: ${r.title}\n    ${r.detail}`);
  }
  console.log(`\n=== ВНЕ ТАБЛИЦЫ (для проверки глазами) ===`);
  for (const r of byVerdict('NOT_PRICE_RULE')) console.log(`  ${r.ruleCode} :: ${r.title}`);

  console.log(`\n=== ПОДТВЕРЖДЁННЫЕ ДУБЛИКАТЫ (${toDeprecate.length}) ===`);
  for (const d of toDeprecate) console.log(`  ${d.ruleCode}`);

  if (!APPLY) {
    console.log(`\nСУХОЙ ПРОГОН. Ничего не изменено. Запусти с --apply, чтобы погасить ${toDeprecate.length} правил.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\n=== ПРИМЕНЯЮ: гашу ${toDeprecate.length} правил ===`);
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
  }
  console.log(`Готово: погашено ${toDeprecate.length} правил.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
