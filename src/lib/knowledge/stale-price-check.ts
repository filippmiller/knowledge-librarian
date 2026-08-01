/**
 * Устаревшая цена в ответе.
 *
 * Измеренный дефект: на вопрос про справку о несудимости за три рабочих дня бот
 * дважды из пяти назвал 20 000 ₽. Действующий прайс с 01.01.2026 говорит
 * 22 000 ₽, а 20 000 ₽ — цена прошлогоднего внутреннего прайса, оставшегося в
 * базе активным. Ни один существующий контроль этого не видел: заземление чисел
 * находило 20 000 в источниках, проверка связности сверяла ответ с тем же
 * контекстом, а таблица цен покрывала только заверение.
 *
 * Здесь проверка идёт против тарифной сетки — единственного источника цен.
 * Признак ошибки узкий и потому надёжный: названная сумма НЕ встречается среди
 * действующих тарифов вовсе. Если суммы нет в сетке, она либо устарела, либо
 * посчитана, либо выдумана — во всех трёх случаях клиенту её отправлять нельзя.
 *
 * Почему проверяются не все числа подряд: сумма может быть верной и при этом
 * отсутствовать в сетке — например, итог за три документа или цена перевода,
 * умноженная на объём. Поэтому проверка ограничена предложениями, где названа
 * услуга из сетки, и молчит на всём остальном.
 */
import type { TariffRecord, TariffUnitKey } from '@/lib/knowledge/tariffs';
import { serviceTerms } from '@/lib/knowledge/service-terms';
import { splitSentences } from '@/lib/knowledge/sentences';

/** Денежная сумма в тексте. Порядок ветвей важен — см. certification-price.ts. */
const MONEY = String.raw`(?:₽|рубл[а-яё]+|руб\.?|р\.(?![\s.]*д))`;

/** Слова, после которых число — не цена услуги, а итог или разница. */
const NOT_A_TARIFF =
  /итого|всего|в\s+сумме|суммарн|общая\s+стоимост|под\s+ключ|дороже|дешевле|больше|меньше|разниц|за\s+все|за\s+оба|за\s+три|госпошлин|пошлин/iu;

export interface StalePriceFinding {
  amount: number;
  sentence: string;
  /** Название услуги из сетки, названное в том же предложении. */
  serviceHint: string;
  /** Действующие суммы для этой услуги — то, что можно было назвать. */
  currentAmounts: number[];
}

export interface StalePriceVerdict {
  ok: boolean;
  findings: StalePriceFinding[];
  /** Сколько сумм вообще проверено — оценка применимости контроля. */
  checked: number;
}

function normalizeAmount(raw: string): number {
  return Number(raw.replace(/[\s   ]/g, ''));
}

/**
 * Единица измерения, названная сразу после суммы.
 *
 * Порядок ветвей важен: «условную страницу» обязана распознаться до просто
 * «страницы», иначе цена за условную страницу сойдёт за цену за страницу — а
 * это разные тарифы и разные деньги.
 */
function unitAfter(sentence: string, from: number): TariffUnitKey | null {
  const tail = sentence.slice(from, from + 40).toLowerCase();
  if (/^[\s/]*(?:за\s+)?(?:1\s+)?(?:у\.?\s?с\.?|усл\w*\s+страниц)/u.test(tail)) return 'CONDITIONAL_PAGE';
  if (/^[\s/]*(?:за\s+)?(?:1\s+)?(?:стр\b|страниц|лист)/u.test(tail)) return 'PAGE';
  if (/^[\s/]*(?:за\s+)?(?:1\s+)?(?:док\b|документ|экземпляр)/u.test(tail)) return 'DOCUMENT';
  if (/^[\s/]*(?:за\s+)?(?:1\s+)?виз/u.test(tail)) return 'VISA';
  if (/^[\s/]*(?:за\s+)?(?:1\s+)?отметк/u.test(tail)) return 'MARK';
  return null;
}

/**
 * Варианты слов, любой из которых считается названием услуги: слова самого
 * названия — ОДНИМ вариантом, и каждый синоним — своим отдельным вариантом.
 *
 * Название и синонимы не сливаются в один мешок слов: синоним — это цельная
 * альтернативная формулировка («заверить перевод у нотариуса»), а не довесок
 * опциональных слов к названию. Слияние позволило бы предложению набрать
 * совпадение из слов ДВУХ разных фраз, не содержащих полностью ни одну из них.
 *
 * Синонимы обязательны здесь ровно по той причине, по которой их завели для
 * `tariff-lookup.ts`: грубый стемминг связывает «заверение» и «заверения», но
 * не «заверение» и «заверить» — у существительного и глагола разные корни, и
 * никакая нормализация их не сведёт (см. `tariff-lookup.ts`). Список синонимов
 * — ОДИН на сетку, `scripts/seed-tariff-synonyms.ts`, и уже содержит нужные
 * глагольные формы: правка синонима лечит опознание сразу everywhere, а не
 * только здесь.
 */
function serviceKeywordVariants(tariff: TariffRecord): string[][] {
  const variants = [serviceTerms(tariff.serviceName), ...(tariff.synonyms ?? []).map(serviceTerms)];
  return variants.filter((words) => words.length > 0);
}

export function checkStalePrice(answer: string, tariffs: TariffRecord[]): StalePriceVerdict {
  if (tariffs.length === 0) return { ok: true, findings: [], checked: 0 };

  const findings: StalePriceFinding[] = [];
  let checked = 0;

  const sentences = splitSentences(answer);
  const re = new RegExp(String.raw`(\d[\d\s   ]*)\s*${MONEY}`, 'giu');

  for (const sentence of sentences) {
    if (NOT_A_TARIFF.test(sentence)) continue;
    const lower = sentence.toLowerCase();

    // Услуга из сетки, названная в этом предложении. Без неё число не привязано
    // ни к чему, и требовать его присутствия в сетке нельзя.
    const named = tariffs.filter((t) =>
      serviceKeywordVariants(t).some((words) => words.every((w) => lower.includes(w)))
    );
    if (named.length === 0) continue;

    // Названо несколько РАЗНЫХ услуг — какая из них хозяйка числа, по тексту не
    // определить. Молчим: ложная тревога стоит автономности.
    const distinctServices = new Set(named.map((t) => t.serviceName));
    if (distinctServices.size > 1) continue;

    // Сверка идёт с ценами ИМЕННО ЭТОЙ услуги, а не со всей сеткой.
    //
    // Первая версия проверяла принадлежность суммы глобальному списку всех
    // действующих цен — и потому пропускала ровно тот дефект, ради которого
    // писалась: «нотариальное заверение перевода — 260 рублей за страницу»
    // проходило, потому что 260 ₽ есть в сетке у заверения КОПИИ. Найдено
    // аудитом Codex и воспроизведено запуском.
    const allowed = new Set<number>();
    for (const t of named) {
      if (t.amount !== null) allowed.add(t.amount);
      if (t.baseFeeAmount !== null) allowed.add(t.baseFeeAmount);
    }
    // Строка с нижней границей («от 60 руб. за страницу») или с процентом
    // допускает любую сумму сверху — сверять её нечем.
    if (named.some((t) => t.amountKind !== 'FIXED')) continue;

    // Названное количество превращает цену за единицу в сумму заказа.
    //
    // «Сканирование обойдётся в 200 рублей за 5 страниц» — верный ответ при
    // цене 40 ₽ за страницу, а сторож объявлял его устаревшей ценой: 200 в
    // прайсе не значится. Дефект предсказан аудитом Codex и воспроизведён
    // запуском. Кратность допускается ТОЛЬКО когда в предложении названо
    // количество: иначе «нотариальное заверение перевода — 2200 рублей»
    // (ровно два тарифа по 1100) перестало бы быть ошибкой.
    const quantity = /\d+\s*(?:страниц|листов|документ|экземпляр|копи|виз|штук|шт\b)/iu.test(sentence);

    const tariffUnits = new Set(named.map((t) => t.unit));

    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(sentence)) !== null) {
      const amount = normalizeAmount(m[1]);
      if (!Number.isFinite(amount) || amount === 0) continue;

      // Единица рядом с числом — бесплатный признак того, ЧЬЯ это цена.
      //
      // «Перевод с английского стоит 530 рублей за условную страницу, а с
      // заверением подписью переводчика…»: в предложении названо заверение
      // штампом БП (250 ₽ за документ), и сторож приписывал 530 ₽ ему. Но
      // рядом с числом стоит «за условную страницу» — единица перевода, а не
      // заверения. Если названная единица прямо противоречит единице тарифа,
      // число принадлежит другой услуге, и сверять его здесь нельзя.
      const statedUnit = unitAfter(sentence, m.index + m[0].length);
      if (statedUnit && !tariffUnits.has(statedUnit)) continue;

      checked += 1;
      if (allowed.has(amount)) continue;
      if (
        quantity &&
        [...allowed].some((unit) => unit > 0 && amount > unit && amount % unit === 0)
      ) {
        continue;
      }
      findings.push({
        amount,
        sentence: sentence.trim(),
        serviceHint: named[0].serviceName,
        currentAmounts: [...allowed].sort((a, b) => a - b),
      });
    }
  }

  return { ok: findings.length === 0, findings, checked };
}
