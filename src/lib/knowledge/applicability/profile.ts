import { z } from 'zod';
import { facetMapSchema, isFacetKey, type FacetKey, type FacetMap } from './facets';
import {
  applicableFacetsOf,
  knowledgeUnitKindSchema,
  requiredFacetsOf,
  type KnowledgeUnitKind,
} from './kinds';
import { isoTimestampSchema, reviewerIdSchema, reviewStatusSchema, type ReviewStatus } from './review';

/**
 * Аудитория — действующая семантика v1 (`KnowledgeAudience` в Prisma,
 * `src/lib/knowledge/audience.ts`). Схема `CLIENT | INTERNAL | BOTH`,
 * предлагавшаяся в одной из ревизий плана, здесь НЕ вводится: truth table §3.2
 * отклонила её как смену модели без анализа миграции пяти таблиц v1.
 */
export const AUDIENCES = ['CLIENT_SAFE', 'INTERNAL_ONLY'] as const;
export type ProfileAudience = (typeof AUDIENCES)[number];
export const audienceSchema = z.enum(AUDIENCES);

/**
 * Профиль применимости knowledge unit'а — К ЧЕМУ знание применимо.
 *
 * `audience` — отдельное поле, а не фасета: фасету можно «не заполнить», а
 * truth table §3.2 требует значение всегда, иначе `INTERNAL_ONLY`-знание
 * утекает клиенту через пустое поле.
 *
 * `reviewedAt` — ISO-8601 СТРОКА. `Date` допустим только внутри рантайма после
 * явного parse и никогда в самом контракте (truth table §5.1).
 */
export interface ApplicabilityProfile {
  readonly kind: KnowledgeUnitKind;
  readonly facets: FacetMap;
  readonly audience: ProfileAudience;
  readonly reviewStatus: ReviewStatus;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
}

const applicabilityProfileBaseSchema = z.strictObject({
  kind: knowledgeUnitKindSchema,
  facets: facetMapSchema,
  audience: audienceSchema,
  reviewStatus: reviewStatusSchema,
  reviewedBy: reviewerIdSchema.nullable(),
  reviewedAt: isoTimestampSchema.nullable(),
});

/**
 * Ключ считается присутствующим, только если его значение не `undefined`:
 * контракт живёт на границе JSON, где `{ partner: undefined }` и пропущенный
 * ключ — одно и то же. Иначе появился бы третий способ записать отсутствие.
 */
function presentFacetKeys(facets: FacetMap): FacetKey[] {
  return Object.keys(facets).filter(
    (key): key is FacetKey => isFacetKey(key) && facets[key] !== undefined
  );
}

/**
 * Схема профиля. Ровно здесь NOT_APPLICABLE перестаёт быть неотличимым от
 * UNKNOWN: обе ситуации выглядят как «в объекте нет значения», и различает их
 * только сверка с `KNOWLEDGE_KIND_REGISTRY[kind]`, а не имя поля.
 *
 * Неизвестный ключ фасеты отсекается раньше — `facetMapSchema` объявлен
 * `strictObject`, и разбор падает до `superRefine` (fail-closed, не no-op).
 */
export const applicabilityProfileSchema = applicabilityProfileBaseSchema.superRefine(
  (profile, ctx) => {
    const applicable = applicableFacetsOf(profile.kind);
    const required = requiredFacetsOf(profile.kind);
    const present = presentFacetKeys(profile.facets);

    for (const facet of applicable) {
      if (!present.includes(facet)) {
        ctx.addIssue({
          code: 'custom',
          path: ['facets', facet],
          message:
            `фасета "${facet}" применима к ${profile.kind} и обязана присутствовать ` +
            'явным состоянием (UNKNOWN | GLOBAL | SCOPED); отсутствие ключа означает ' +
            'NOT_APPLICABLE и это другое утверждение',
        });
      }
    }

    for (const facet of present) {
      if (!applicable.includes(facet)) {
        ctx.addIssue({
          code: 'custom',
          path: ['facets', facet],
          message:
            `фасета "${facet}" не применима к ${profile.kind} — ключ обязан ` +
            'отсутствовать вовсе, а не стоять в UNKNOWN: неприменимое измерение не ' +
            'голосует в §3, а неизвестное голосует',
        });
      }
    }

    for (const facet of required) {
      const state = profile.facets[facet];
      if (state?.state === 'UNKNOWN') {
        ctx.addIssue({
          code: 'custom',
          path: ['facets', facet],
          // Безусловно, без оговорки про audience: truth table §2.1 явно
          // разрешила это расхождение с наброском плана в свою пользу —
          // INTERNAL_ONLY-unit без scenario так же нелегален на create, как
          // клиентский. Условной остаётся рантайм-часть (evaluateUnitEligibility).
          message:
            `фасета "${facet}" обязательна для ${profile.kind}: требуется SCOPED или ` +
            'GLOBAL, UNKNOWN запрещён на create/publish',
        });
      }
    }

    // GLOBAL — единственный легальный wildcard, и он по определению означает
    // «человек подтвердил, что применимо ко всему» (truth table §1, §5).
    if (profile.reviewStatus !== 'REVIEWED') {
      for (const facet of present) {
        if (profile.facets[facet]?.state === 'GLOBAL') {
          ctx.addIssue({
            code: 'custom',
            path: ['facets', facet],
            message: `состояние GLOBAL требует reviewStatus='REVIEWED' на unit'е`,
          });
        }
      }
    }

    // Таблица легальности truth table §5.1 целиком. Биконъюнкция
    // (REVIEWED ⟺ оба заданы) сама по себе разрешила бы UNCLASSIFIED с ОДНИМ
    // заполненным полем, поэтому §5.1 усиливает её явно: UNCLASSIFIED ⟹ оба null.
    if (profile.reviewStatus === 'REVIEWED') {
      if (profile.reviewedBy === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reviewedBy'],
          message: "reviewStatus='REVIEWED' без reviewedBy — подтверждено неизвестно кем",
        });
      }
      if (profile.reviewedAt === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reviewedAt'],
          message: "reviewStatus='REVIEWED' без reviewedAt — подтверждено неизвестно когда",
        });
      }
    } else {
      // Статус подставляется, а не зашит строкой: если в реестре статусов
      // когда-нибудь появится третий, сообщение не начнёт врать.
      if (profile.reviewedBy !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reviewedBy'],
          message: `reviewedBy при reviewStatus='${profile.reviewStatus}' — след ревью без статуса ревью`,
        });
      }
      if (profile.reviewedAt !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['reviewedAt'],
          message: `reviewedAt при reviewStatus='${profile.reviewStatus}' — время ревью без статуса ревью`,
        });
      }
    }

    // Нефасетное обязательное поле TERM_DEFINITION (truth table §2, §2.1): у
    // этого kind нет ни одной применимой фасеты, и подтверждение человеком —
    // единственное, что отделяет его от «извлечено и не проверено». Где живёт
    // черновик ДО ревью — открытый вопрос §8 (решает Задача 2.4), но он живёт
    // не здесь: неподтверждённый TERM_DEFINITION не является валидным профилем.
    if (profile.kind === 'TERM_DEFINITION' && profile.reviewStatus !== 'REVIEWED') {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewStatus'],
        message: "TERM_DEFINITION обязан быть reviewStatus='REVIEWED' при создании",
      });
    }
  }
);

type Assert<T extends true> = T;

/** Разбор схемы обязан давать ровно объявленный интерфейс, и наоборот. */
type _SchemaMatchesInterface = Assert<
  z.infer<typeof applicabilityProfileSchema> extends ApplicabilityProfile ? true : false
>;
type _InterfaceMatchesSchema = Assert<
  ApplicabilityProfile extends z.infer<typeof applicabilityProfileSchema> ? true : false
>;
