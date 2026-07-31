/**
 * Поиск цены в тарифной сетке по тексту вопроса.
 *
 * Это связь между строкой, которую владелец добавил в сетку, и ответом бота.
 * Цепочка ровно такая:
 *
 *   вопрос клиента → опознание услуги по словам её названия и синонимам
 *                  → строка сетки → цена, единица, срок, сноска
 *                  → детерминированный ответ, минуя поиск по смыслу
 *
 * Опознание идёт по СЛОВАМ САМОЙ СЕТКИ, а не по отдельному справочнику: новая
 * строка становится находимой сразу после добавления, без правки кода. Но это
 * работает, только пока клиент называет услугу теми же словами, что и прайс.
 * Для всех прочих формулировок нужны синонимы — поле `synonyms` в строке сетки.
 * Без них «можно сжечь апостиль» не найдёт строку «торжественное сжигание
 * апостиля»: у существительного и глагола разные корни, и никакая
 * нормализация их не сведёт.
 *
 * При неоднозначности модуль молчит. Замер показал, что детерминированные ветки
 * были худшим источником ответов именно из-за срабатываний невпопад, поэтому
 * порог здесь высокий: одна услуга, названная целиком.
 */
import type { TariffRecord } from '@/lib/knowledge/tariffs';
import { formatTariffPrice } from '@/lib/knowledge/tariffs';
import { serviceTerms as significantStems } from '@/lib/knowledge/service-terms';

/**
 * Вопрос вообще про цену. Без этого поиск лез бы в любой вопрос про услугу.
 *
 * Короткие слова закрыты границами по-русски. Измеренный дефект: «почем» входит
 * в «ПОЧЕМУ», и КАЖДЫЙ вопрос, начинающийся с «Почему…», считался ценовым —
 * поймано на корпусе вопросом «Почему документ тождественности рекомендуют
 * отправлять по месту требования как можно скорее?». Так же «цена» входит в
 * «сцена». `\b` тут не годится: он опирается на ASCII и вокруг кириллицы не
 * работает.
 */
const ASKS_PRICE =
  /сколько\s+стоит|стоимост|(?<![а-яё])цен[аыу](?![а-яё])|(?<![а-яё])почём(?![а-яё])|(?<![а-яё])почем(?![а-яё])|прайс|тариф|во\s+сколько\s+обойд|какая\s+цена/iu;

/**
 * Те же ворота, но снаружи.
 *
 * Нужны замеру: когда сетка промолчала, надо отличить «вопрос не про цену»
 * от «вопрос про цену, а услугу не опознали». Второе — промах, первое — нет,
 * и без этого различения доля промахов считается по неверному знаменателю.
 */
export function questionAsksPrice(question: string): boolean {
  return ASKS_PRICE.test(question);
}

/**
 * Слова названия, которые клиент вправе не повторять: место и орган.
 *
 * Всё остальное обязано совпасть целиком. Долевой порог (совпало 70% слов) не
 * годится: у «Срочного нотариального заверения перевода» из четырёх слов три
 * общие с обычным заверением, и вопрос про ОБЫЧНОЕ заверение опознавал заодно
 * срочное — две услуги, разные цены, ответ считался неоднозначным, и бот
 * молчал. Отличительное слово («срочное», «двуязычное», «копии») пропущенным
 * быть не может; «перед ЗАГС» и «СПб» — могут.
 */
const OPTIONAL_TAIL = /^(?:загс|спб|мск|мо|ло|мю|мид|санкт|петербург|москв\w*)$/iu;

/**
 * Взаимозаменяемые слова названия: последнее перед косой чертой и все после.
 * «копии перевода/оригинала» → перевод и оригинал равноправны.
 */
function alternationStems(serviceName: string): string[] {
  if (!serviceName.includes('/')) return [];
  const [head, ...rest] = serviceName.split('/');
  const headStems = significantStems(head);
  const lastOfHead = headStems.length > 0 ? [headStems[headStems.length - 1]] : [];
  return [...lastOfHead, ...significantStems(rest.join(' '))];
}

/** Сколько слов названия услуги нашлось в вопросе. `-1` — услуга не опознана. */
function serviceMatchStrength(question: string, tariff: TariffRecord): number {
  const lower = question.toLowerCase();
  const nameStems = significantStems(tariff.serviceName);
  if (nameStems.length > 0) {
    // Косая черта в названии — перечисление, а не требование: «заверение копии
    // перевода/оригинала» верно и для перевода, и для оригинала. Взаимными
    // альтернативами являются слово ПЕРЕД чертой и слова ПОСЛЕ неё; достаточно
    // любого одного из них. Без этого вопрос «заверение копии оригинала» не
    // находил строку и доставался общему заверению перевода — то есть цена
    // 1100 ₽ вместо 260 ₽, ровно исходный дефект.
    const alternatives = alternationStems(tariff.serviceName);
    const missing = nameStems.filter((stem) => !lower.includes(stem));
    const alternativeSatisfied =
      alternatives.length === 0 || alternatives.some((stem) => lower.includes(stem));
    const allMissingAreOptional = missing.every(
      (stem) => OPTIONAL_TAIL.test(stem) || alternatives.includes(stem)
    );
    const hit = nameStems.length - missing.length;
    if (hit > 0 && alternativeSatisfied && allMissingAreOptional) return hit;
  }

  // Синонимы проверяются ВСЕГДА, даже когда название состоит из коротких слов.
  // Прежняя версия выходила раньше — и «ТПП СПб» не находилась ни по названию,
  // ни по синониму.
  for (const syn of tariff.synonyms ?? []) {
    const stems = significantStems(syn);
    if (stems.length > 0 && stems.every((stem) => lower.includes(stem))) return stems.length;
  }
  return -1;
}

export type TariffLookupVerdict =
  /** Найдена ровно одна услуга — можно отвечать ценой. */
  | { kind: 'single'; tariff: TariffRecord }
  /** Найдено несколько вариантов одной услуги (сроки, срочность) — перечислить. */
  | { kind: 'variants'; service: string; tariffs: TariffRecord[] }
  /** Не опознано или неоднозначно — обычный путь. */
  | { kind: 'unknown' };

export function lookupTariffForQuestion(
  question: string,
  tariffs: TariffRecord[]
): TariffLookupVerdict {
  if (!ASKS_PRICE.test(question)) return { kind: 'unknown' };

  const scored = tariffs
    .map((t) => ({ tariff: t, strength: serviceMatchStrength(question, t) }))
    .filter((x) => x.strength > 0);
  if (scored.length === 0) return { kind: 'unknown' };

  // Матрицу перевода детерминированно не отвечаем: цена там зависит от языка,
  // категории сложности и объёма, а граница 2 и 3 категории в самом прайсе не
  // разрешена — одни и те же типы документов лежат в обеих.
  if (scored.some((x) => x.tariff.section === 'TRANSLATION')) return { kind: 'unknown' };

  // Побеждает САМОЕ ЧАСТНОЕ совпадение — то, где нашлось больше слов названия.
  // Общее название почти всегда является подмножеством частного: «нотариальное
  // заверение копии перевода» содержит в себе «нотариальное заверение
  // перевода». Без этого правила оба совпадали, ответ считался неоднозначным, и
  // бот молчал там, где цена однозначна. Найдено аудитом Codex.
  const best = Math.max(...scored.map((x) => x.strength));
  const matched = scored.filter((x) => x.strength === best).map((x) => x.tariff);

  // Слабое совпадение допустимо отбросить, только если оно — ОБОБЩЕНИЕ
  // победителя: все его слова входят в название победившей услуги. Иначе в
  // вопросе названы две разные услуги, и выбирать одну нельзя. Без этой
  // проверки «сколько стоит апостиль и сжечь апостиль?» отвечал ценой сжигания,
  // умалчивая про апостиль.
  const winnerStems = new Set(matched.flatMap((t) => significantStems(t.serviceName)));
  const losers = scored.filter((x) => x.strength < best);
  const someLoserIsDistinct = losers.some((x) =>
    significantStems(x.tariff.serviceName).some((stem) => !winnerStems.has(stem))
  );
  if (someLoserIsDistinct) return { kind: 'unknown' };

  if (matched.length === 1) return { kind: 'single', tariff: matched[0] };

  // Несколько строк одной услуги — это варианты по сроку. Разные услуги при
  // равной силе совпадения — настоящая неоднозначность, и тогда молчим.
  const services = new Set(matched.map((t) => t.serviceName));
  if (services.size > 1) return { kind: 'unknown' };

  return { kind: 'variants', service: matched[0].serviceName, tariffs: matched };
}

/**
 * Текст ответа по найденному тарифу.
 *
 * Сноска обязана ехать вместе с ценой: без неё «7500 ₽ за легализацию»
 * умалчивает, что перевод, пересылка и консульский сбор считаются сверх.
 */
export function describeTariff(tariff: TariffRecord): string {
  const parts = [`${tariff.serviceName} — ${formatTariffPrice(tariff)}`];
  if (tariff.termText) parts.push(`Срок: ${tariff.termText}.`);
  if (tariff.conditions) parts.push(tariff.conditions);
  if (tariff.footnote) parts.push(tariff.footnote);
  return parts.join('\n');
}
