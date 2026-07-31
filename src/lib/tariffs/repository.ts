/**
 * Обращения к базе, общие для создания и правки тарифа.
 *
 * Отбор кандидатов на пересечение вынесен сюда, потому что он обязан быть
 * одинаковым в POST и PATCH: если при правке искать конфликт по другому набору
 * признаков, чем при создании, дыра появится ровно в том сценарии, ради
 * которого проверка написана.
 */
import prisma from '@/lib/db';
import { normalizeText } from '@/lib/knowledge/tariffs';
import type { ExistingTariff, NormalizedTariff, TariffIdentity } from './validation';

/**
 * Действующие строки, которые могут оказаться ценой той же услуги.
 *
 * Из базы отбирается заведомо более широкий круг, чем нужно: язык сравнивается
 * по основе слова, а это в SQL не выражается — сужение делает
 * `findOverlappingTariffs` в памяти. Разделы небольшие (самый крупный кусок
 * матрицы после фильтров — 52 языка), так что запас безвреден.
 */
export async function findOverlapCandidates(identity: TariffIdentity): Promise<ExistingTariff[]> {
  const rows = await prisma.tariff.findMany({
    where: {
      section: identity.section,
      audience: identity.audience,
      isActive: true,
      ...(identity.section === 'TRANSLATION'
        ? {
            complexityCategory: identity.complexityCategory,
            direction: identity.direction,
            turnaround: identity.turnaround,
            includesNotary: identity.includesNotary,
          }
        : {}),
    },
    select: {
      id: true,
      section: true,
      audience: true,
      serviceName: true,
      authority: true,
      termText: true,
      language: true,
      complexityCategory: true,
      direction: true,
      turnaround: true,
      includesNotary: true,
      priceText: true,
      effectiveFrom: true,
      effectiveTo: true,
      isActive: true,
    },
  });
  return rows as ExistingTariff[];
}

function slugify(value: string): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/**
 * Ключ строки, добавленной руками.
 *
 * Собирается из смысловых признаков, как и у импорта, но с пометкой `admin`:
 * повторный прогон импорта прайса не должен ни перезаписать ручную строку, ни
 * споткнуться о неё.
 */
export async function generateNaturalKey(value: NormalizedTariff): Promise<string> {
  const parts =
    value.section === 'TRANSLATION'
      ? [
          'admin',
          'translation',
          slugify(value.language ?? ''),
          String(value.complexityCategory ?? ''),
          (value.direction ?? '').toLowerCase(),
          (value.turnaround ?? '').toLowerCase(),
          value.includesNotary ? 'nz' : 'net',
        ]
      : ['admin', value.section.toLowerCase(), slugify(value.serviceName)];

  const base = `${parts.filter(Boolean).join('|')}|${value.effectiveFrom.toISOString().slice(0, 10)}`;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}#${attempt + 1}`;
    const taken = await prisma.tariff.findUnique({
      where: { naturalKey: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new Error(`Не удалось подобрать уникальный ключ для «${value.serviceName}»`);
}
