/**
 * Тарифная сетка как источник цен для синтеза ответа.
 *
 * ЗАЧЕМ ЭТО, А НЕ ДЕТЕРМИНИРОВАННАЯ ВЕТКА
 *
 * Опознание услуги целиком (`tariff-lookup.ts`) отвечает само и потому обязано
 * быть придирчивым: назвать чужую цену дороже, чем промолчать. Замер на 180
 * реальных вопросах показал цену этой придирчивости — сетка срабатывает на
 * одном вопросе из 180 (`docs/bot-audit/15-tariff-shadow-run.md`).
 *
 * Здесь другая роль: строки прайса кладутся В КОНТЕКСТ синтеза как источник с
 * высшим приоритетом. Модель по-прежнему решает, что уместно, но цену берёт из
 * сверенной с бумагой таблицы, а не из текста правил, где она устарела.
 *
 * ПОЧЕМУ ОТБОР ИДЁТ РАЗДЕЛОМ, А НЕ СТРОКОЙ
 *
 * Первая версия искала строку по словам её названия — и провалилась на живом
 * вопросе «Сколько стоит заверение в Торгово-промышленной палате?»: строка
 * называется «ТПП СПб (от 2-х дней)», общих слов с вопросом ноль, и бот ответил
 * «в базе знаний не указано» при цене 6000 ₽ в прайсе. Причина глубже одной
 * строки: поле синонимов не заполнено НИ У ОДНОЙ из 62 услуг, то есть прайс
 * находится только собственными словами прайса.
 *
 * Раздел — правильная единица отбора. Их одиннадцать, они маленькие (кроме
 * матрицы перевода), словарь к ним пишется один раз, и ошибка отбора не может
 * назвать чужую услугу: раздел лишь приносит свои строки в контекст, а выбирает
 * из них модель. Цена ошибки здесь — лишние строки в промпте, а не неверный
 * ответ клиенту.
 */
import type { TariffRecord, TariffSectionKey } from '@/lib/knowledge/tariffs';
import { formatTariffPrice, matchesLanguage } from '@/lib/knowledge/tariffs';

/**
 * Потолок строк в промпте. Матрица перевода — 1560 строк, и без потолка один
 * вопрос про английский вытеснил бы всё остальное. Тридцать строк покрывают
 * язык целиком: 3 категории × 5 сроков × 2 колонки.
 */
const MAX_MATRIX_ROWS = 30;
const MAX_FLAT_ROWS = 40;
/** Сколько разделов берём. Два — это «апостиль» плюс «заверение», обычный набор. */
const MAX_SECTIONS = 2;

/**
 * Вопрос вообще про деньги. Шире, чем ворота детерминированной ветки.
 *
 * Короткие слова закрыты границами по-русски: «почем» входит в «ПОЧЕМУ», а
 * «цена» — в «сцена». Без границ блок прайса подставлялся в каждый вопрос,
 * начинающийся с «Почему…».
 */
const MONEY_TOPIC =
  /сколько\s+стоит|стоимост|(?<![а-яё])цен[аыу](?![а-яё])|прайс|тариф|(?<![а-яё])почём(?![а-яё])|(?<![а-яё])почем(?![а-яё])|платн|бесплатн|дешевл|дорож|скидк|доплат|наценк|обойдётся|обойдется|расцен|оплат|сколько\s+будет|во\s+сколько/iu;

/**
 * Границы слова и русское окончание.
 *
 * `\w` и `\b` в JavaScript опираются на ASCII даже под флагом `u`. Поэтому
 * `апостил\w*` не захватывает мягкий знак, а `/\bтпп\b/` не срабатывает
 * никогда. Оба дефекта поймала проверка на живых формулировках: «Сколько стоит
 * ТПП?» не подавал прайс вовсе, «Сколько стоит апостиль в Москве?» подавал
 * питерские цены. Русские окончания пишутся как `[а-яё]*`, границы — явными
 * lookaround'ами.
 */
const B = '(?<![а-яёa-z])';
const E = '(?![а-яёa-z])';
const S = '[а-яё]*';
const W = '\\s+';
const W0 = '\\s*';

/**
 * Слова, которыми КЛИЕНТ называет раздел прайса.
 *
 * Пишутся руками, потому что взять их неоткуда: поле синонимов у услуг пустое,
 * а названия строк — это язык бухгалтерии, не клиента. Список закрытый и
 * проверяемый: `scripts/verify-tariff-context.ts` требует, чтобы каждый раздел
 * находился хотя бы одной живой формулировкой.
 */
const SECTION_WORDS: Record<TariffSectionKey, string> = {
  TRANSLATION: `перевод|переве[сд]|письменн${S}${W}перевод|условн${S}${W}страниц`,
  CERTIFICATION: `завер${S}|нотариус|нотариальн${S}|штамп${S}${W}(?:бюро|бп)|подпис${S}${W}переводчик|ксерокопи|сканирован|печат${S}${W}бюро`,
  APOSTILLE_SPB: `апостил|минюст|${B}мю${E}`,
  APOSTILLE_MOSCOW: `апостил${S}${W0}(?:в${W})?москв|московск|${B}мск${E}|${B}мо${E}`,
  APOSTILLE_EDUCATION: `апостил${S}${W0}(?:на${W})?(?:диплом|аттестат)|образовательн${S}${W}документ|диплом|аттестат`,
  CONSULAR_LEGALIZATION: `консульск${S}|легализац|посольств|консульств|${B}мид${E}`,
  CHAMBER_OF_COMMERCE: `${B}тпп${E}|торгово[-\\s]?промышленн${S}|торговопромышленн${S}`,
  VITAL_RECORDS_SPB: `истребован|повторн${S}${W}(?:свидетельств|документ)|дубликат${S}${W}(?:свидетельств|документ)|запрос${S}${W}в${W}загс`,
  VITAL_RECORDS_URGENT: `срочн${S}${W}истребован|истребован|повторн${S}${W}свидетельств|дубликат${S}${W}свидетельств`,
  CRIMINAL_RECORD: `судимост|${B}сон${E}|справк${S}${W}о${W}несудимост|об${W}отсутствии${W}судимост`,
  CRIMINAL_RECORD_APOSTILLE: `судимост${S}${W0}(?:с|\\+)${W0}апостил|${B}сон${E}${W0}(?:с|\\+)${W0}апостил|справк${S}${W}о${W}несудимост${S}${W}с${W}апостил`,
  NOSTRIFICATION: `нострификац|признани${S}${W}(?:диплом|образован)|подтвержден${S}${W}диплом`,
};

/**
 * Регион, названный в вопросе. Апостиль в Москве и в Петербурге — это разные
 * органы и разные деньги (5000 ₽ против 17 000 ₽), а слово «апостиль» одинаково
 * подходит обоим разделам. Пока регион не назван, подаются оба.
 */
const MOSCOW_MARKER = new RegExp(`москв|московск|${B}мск${E}|${B}мо${E}`, 'iu');
const SPB_MARKER = new RegExp(`петербург|${B}спб${E}|питер|ленинградск|${B}ло${E}`, 'iu');

function scoreSection(question: string, section: TariffSectionKey): number {
  const matches = question.match(new RegExp(SECTION_WORDS[section], 'giu'));
  if (!matches) return 0;

  // Названный регион решает спор между питерским и московским апостилем: без
  // этого «Сколько стоит апостиль в Москве?» подавал питерские цены, потому что
  // слово «апостиль» есть в обоих разделах и счёт выходил равным.
  if (section === 'APOSTILLE_MOSCOW' && MOSCOW_MARKER.test(question)) return matches.length + 2;
  if (section === 'APOSTILLE_SPB' && MOSCOW_MARKER.test(question) && !SPB_MARKER.test(question)) {
    return 0;
  }
  return matches.length;
}

function languagesInQuestion(question: string, tariffs: TariffRecord[]): string[] {
  const languages = [...new Set(tariffs.map((t) => t.language).filter((l): l is string => l !== null))];
  const words = question.toLowerCase().split(/[^а-яёa-z]+/u).filter((w) => w.length >= 5);
  return languages.filter((lang) => words.some((w) => matchesLanguage(lang, w)));
}

export interface TariffContext {
  /** Готовый блок для промпта. Пустая строка — прайс к вопросу отношения не имеет. */
  block: string;
  /** Те же строки для проверок заземления и связности. */
  sources: string[];
  count: number;
  /** Какие разделы попали — для журнала и для проверок. */
  sections: TariffSectionKey[];
}

const EMPTY: TariffContext = { block: '', sources: [], count: 0, sections: [] };

export function buildTariffContext(question: string, tariffs: TariffRecord[]): TariffContext {
  if (tariffs.length === 0) return EMPTY;
  if (!MONEY_TOPIC.test(question)) return EMPTY;

  const present = [...new Set(tariffs.map((t) => t.section))];
  const scored = present
    .filter((s) => s !== 'TRANSLATION')
    .map((section) => ({ section, score: scoreSection(question, section) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, MAX_SECTIONS).map((x) => x.section);
  const selected: TariffRecord[] = [];

  for (const section of chosen) {
    // Берутся ВСЕ строки раздела, а не первые N: у услуги может быть пять строк
    // по срокам, и показать модели часть — прямой путь к ответу «апостиль стоит
    // 7000», когда есть ещё четыре цены.
    selected.push(...tariffs.filter((t) => t.section === section).slice(0, MAX_FLAT_ROWS));
  }

  // Матрица перевода — только когда язык назван. Иначе цена перевода зависит от
  // трёх неизвестных, и тридцать строк лишь запутают модель.
  const languages = languagesInQuestion(question, tariffs);
  const withMatrix = languages.length > 0 && scoreSection(question, 'TRANSLATION') > 0;
  if (withMatrix) {
    const matrix = tariffs.filter(
      (t) => t.section === 'TRANSLATION' && t.language !== null && languages.includes(t.language)
    );
    selected.push(...matrix.slice(0, MAX_MATRIX_ROWS));
  }

  if (selected.length === 0) return EMPTY;

  const lines = selected.map((t) => {
    const parts = [`· ${t.serviceName} — ${formatTariffPrice(t)}`];
    if (t.termText) parts.push(`срок: ${t.termText}`);
    if (t.conditions) parts.push(t.conditions);
    if (t.footnote) parts.push(t.footnote);
    return parts.join('; ');
  });

  const block = [
    '## ДЕЙСТВУЮЩИЙ ПРАЙС — ЕДИНСТВЕННЫЙ ИСТОЧНИК ЦЕН',
    'Цены ниже сверены с подписанным прайсом бюро и действуют сейчас.',
    'Если услуга есть здесь — называй ЕЁ цену, даже если в других сведениях стоит другая: там цена могла устареть.',
    'Если нужной услуги здесь нет — цену не называй вовсе и скажи, что её посчитает менеджер.',
    '',
    ...lines,
  ].join('\n');

  return {
    block,
    sources: lines,
    count: selected.length,
    sections: [...chosen, ...(withMatrix ? (['TRANSLATION'] as TariffSectionKey[]) : [])],
  };
}
