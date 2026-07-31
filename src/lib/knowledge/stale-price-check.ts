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
import type { TariffRecord } from '@/lib/knowledge/tariffs';

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
 * Ключевые слова услуги для сопоставления с предложением ответа.
 *
 * Берутся из самой сетки, а не пишутся руками: список услуг меняется вместе с
 * прайсом, и второй источник названий разошёлся бы с первым.
 */
function serviceKeywords(tariff: TariffRecord): string[] {
  return tariff.serviceName
    .toLowerCase()
    .split(/[^а-яёa-z0-9]+/u)
    .filter((w) => w.length >= 5);
}

export function checkStalePrice(answer: string, tariffs: TariffRecord[]): StalePriceVerdict {
  if (tariffs.length === 0) return { ok: true, findings: [], checked: 0 };

  const findings: StalePriceFinding[] = [];
  let checked = 0;

  const sentences = answer.split(/(?<=[.!?])\s+|\n+/u);
  const re = new RegExp(String.raw`(\d[\d\s   ]*)\s*${MONEY}`, 'giu');

  for (const sentence of sentences) {
    if (NOT_A_TARIFF.test(sentence)) continue;
    const lower = sentence.toLowerCase();

    // Услуга из сетки, названная в этом предложении. Без неё число не привязано
    // ни к чему, и требовать его присутствия в сетке нельзя.
    const named = tariffs.filter((t) => {
      const words = serviceKeywords(t);
      return words.length > 0 && words.every((w) => lower.includes(w));
    });
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

    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(sentence)) !== null) {
      const amount = normalizeAmount(m[1]);
      if (!Number.isFinite(amount) || amount === 0) continue;
      checked += 1;
      if (allowed.has(amount)) continue;
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
