/**
 * Чтение тарифной сетки движком.
 *
 * Сетка — единственный источник цен. Раньше цена жила текстом внутри правил, и
 * это дважды дало клиенту неверную цифру: «260 вместо 1100» (цена приписана не
 * той услуге) и «20 000 вместо 22 000» (в базе остался активным прошлогодний
 * прайс, а его формулировки многословнее и выигрывали в ранжировании).
 *
 * Кэш в памяти процесса нужен потому, что сетка читается на КАЖДЫЙ ответ, а
 * строк в ней 1622 — из них 1560 приходится на матрицу перевода. Тариф меняется
 * от силы раз в год, поэтому пять минут устаревания безопаснее, чем полторы
 * тысячи строк на каждый вопрос. Правка через админку станет видна ботом в
 * течение этого срока; мгновенная видимость здесь не нужна и стоила бы запроса
 * к базе на каждое сообщение.
 */
import prisma from '@/lib/db';
import {
  toTariffRecord,
  type TariffAudienceKey,
  type TariffRecord,
} from '@/lib/knowledge/tariffs';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  loadedAt: number;
  tariffs: TariffRecord[];
}

let cache: CacheEntry | null = null;

/** Контуры, чьи тарифы допустимо показать этой аудитории. */
function admissibleTariffAudiences(audience: 'client' | 'internal'): TariffAudienceKey[] {
  return audience === 'client' ? ['CLIENT_SAFE'] : ['CLIENT_SAFE', 'INTERNAL_ONLY'];
}

async function loadAll(): Promise<TariffRecord[]> {
  const fresh = cache && Date.now() - cache.loadedAt < CACHE_TTL_MS;
  if (fresh && cache) return cache.tariffs;

  const rows = await prisma.tariff.findMany({ where: { isActive: true } });
  const tariffs = rows.map(toTariffRecord);
  cache = { loadedAt: Date.now(), tariffs };
  return tariffs;
}

/**
 * Действующие тарифы, допустимые для этой аудитории.
 *
 * Сбой чтения не должен ронять ответ: сетка — это дополнительный контроль, а не
 * единственный источник ответа. Пустой список означает «сверять не с чем», и
 * проверка молчит, а не блокирует.
 */
export async function getTariffs(audience: 'client' | 'internal'): Promise<TariffRecord[]> {
  try {
    const all = await loadAll();
    const allowed = new Set(admissibleTariffAudiences(audience));
    const now = new Date();
    return all.filter(
      (t) =>
        allowed.has(t.audience) &&
        t.effectiveFrom <= now &&
        (t.effectiveTo === null || t.effectiveTo > now)
    );
  } catch (e) {
    console.warn('[tariff-store] чтение сетки не удалось, проверка цен пропущена:', e);
    return [];
  }
}

/** Сбросить кэш — вызывается админкой после правки тарифа. */
export function invalidateTariffCache(): void {
  cache = null;
}
