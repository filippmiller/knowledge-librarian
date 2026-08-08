/**
 * Committed review manifest и ворота извлечения (план §3 PR H [R4a],
 * Beads translation-yz9).
 *
 * КАКОЕ ПРОТИВОРЕЧИЕ ЭТО РАЗРЕШАЕТ. PR F требует человеческих решений
 * accept/reject/edit — внутри автоматического прогона они физически произойти
 * не могут. Без явного механизма H имел бы три одинаково негодных исхода: взять
 * заранее заготовленный JSONL (и не проверить свежую экстракцию), ждать
 * человека, или одобрить результат автоматически — последнее уничтожило бы сам
 * смысл human review.
 *
 * Решение: человек один раз выносит решения по извлечённым units, они
 * коммитятся, а прогон ЗАНОВО извлекает DOCX и переприменяет эти решения только
 * там, где извлечение воспроизвелось. Так проверяется именно новая экстракция,
 * но автоматика не притворяется человеком.
 *
 * ЧТО СЧИТАЕТСЯ «ВОСПРОИЗВЕЛОСЬ». Сверяются два хэша, и оба обязаны совпасть:
 * `reviewedContentHash` (смысловое содержание — `contentHash` из PR F) и
 * `reviewedUnitHash` (структура целиком). Второй появился после ревью: первый
 * покрывает лишь `statement | facets | triggerCondition | numericConstraint`,
 * поэтому дрейф `parentRuleRef`, `title` или `uncertainties` проходил бы
 * незамеченным, меняя при этом и retrieval-контекст, и провенанс.
 *
 * ПОЧЕМУ `EDIT` ОСТАНАВЛИВАЕТ ПРОГОН. `EDIT` означает, что человек ОТВЕРГ
 * извлечённый текст и заменил его своим. Свежая экстракция по определению даёт
 * тот же самый забракованный текст — подтвердить его значило бы заново одобрить
 * ровно то, что человек исправил. Исправленного тела манифест не хранит, а
 * догадаться о нём нельзя, поэтому единственный честный исход — явный отказ.
 * Молчаливое одобрение здесь было бы тем самым «автоматика притворилась
 * человеком», против которого весь механизм и построен.
 *
 * ORACLE-BLIND (§0.3 №5). Манифест готовится по DOCX, units и их source
 * evidence. Контрольные вопросы и ключ ревьюеру недоступны: иначе он подгонит
 * формулировки под известные вопросы, и semantic gate пройдёт за счёт подгонки,
 * а не обобщения. Поэтому файл лежит ВНЕ каталога acceptance pack — всё, что
 * внутри него, кроме DOCX, считается oracle.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseJsonl } from '@/lib/knowledge/applicability/jsonl';
import { reviewDecisionSchema } from '@/lib/knowledge/applicability/review-decision';
import type { ReviewDecisionType } from '@/lib/knowledge/applicability/review-decision';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Вне acceptance pack — см. ORACLE-BLIND в шапке. */
export const REVIEW_MANIFEST_PATH = path.resolve(
  HERE,
  '../../../scripts/fixtures/semantic-rule-review-manifest.jsonl'
);

export interface ReviewManifestEntry {
  /** Номер правила исходного DOCX. Evaluation provenance, в движок не попадает. */
  readonly sourceRuleId: number;
  readonly unitId: string;
  /** `sourceBlockAnchor` unit'а — стабильная привязка к месту в документе. */
  readonly sourceAnchor: string;
  readonly decision: ReviewDecisionType;
  /** Хэш ИЗВЛЕЧЁННОГО unit'а на момент ревью. См. шапку. */
  readonly reviewedContentHash: string;
  /** Хэш всей структуры unit'а: ловит дрейф вне `contentHash`. */
  readonly reviewedUnitHash: string;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly notes?: string;
}

/**
 * Схема расширяет `reviewDecisionSchema` (PR F), а не повторяет её: решение
 * человека — один тип на весь репозиторий, манифест лишь добавляет привязку к
 * источнику и хэш проверки.
 */
const manifestEntrySchema = reviewDecisionSchema.extend({
  sourceRuleId: z.number().int().min(1).max(10),
  sourceAnchor: z.string().min(1),
  reviewedContentHash: z.string().min(1),
  reviewedUnitHash: z.string().min(1),
});

export function parseReviewManifest(text: string): ReviewManifestEntry[] {
  const entries = parseJsonl(text, manifestEntrySchema);

  const seen = new Set<string>();
  for (const item of entries) {
    if (seen.has(item.unitId)) {
      throw new Error(
        `parseReviewManifest: unitId «${item.unitId}» встречается дважды — ` +
          'два человеческих решения по одному unit неразрешимы автоматически'
      );
    }
    seen.add(item.unitId);
  }

  return entries;
}

export function loadReviewManifest(manifestPath = REVIEW_MANIFEST_PATH): ReviewManifestEntry[] {
  return parseReviewManifest(fs.readFileSync(manifestPath, 'utf8'));
}

/**
 * Хэш ВСЕГО unit'а, а не только его «содержания».
 *
 * `contentHash` (PR F) покрывает `statement | facets | triggerCondition |
 * numericConstraint` — и этого мало для ворот. Дрейф `parentRuleRef`, `title`,
 * `uncertainties` или `sourceSpan` его не меняет, но меняет то, что уйдёт в
 * retrieval и в провенанс. Человек, одобривший unit без неопределённостей и с
 * родителем P, не одобрял тот же unit с неопределённостями и родителем `null`.
 *
 * Поэтому ворота сверяют оба: `contentHash` — смысловое содержание,
 * `reviewedUnitHash` — структуру целиком. Диагностика от этого точнее: видно,
 * изменился текст правила или его обвязка.
 */
export function computeReviewedUnitHash(unit: PersistedKnowledgeUnit): string {
  return createHash('sha256').update(stableStringify(unit), 'utf8').digest('hex').slice(0, 16);
}

/** Порядок ключей в выдаче LLM не гарантирован — без сортировки хэш «дрейфует» сам по себе. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export const MANIFEST_GATE_FAILURE_CODES = [
  /** Экстракция выдала unit, которого человек не видел. */
  'unit_absent_from_manifest',
  /** Человек решал по unit'у, которого свежая экстракция не выдала. */
  'unit_missing_from_extraction',
  /** Unit тот же, содержание другое — решение больше не относится к нему. */
  'content_hash_changed',
  /** Запись манифеста правлена руками: якорь не совпадает с якорем unit'а. */
  'source_anchor_mismatch',
  /** Изменилось то, что `contentHash` не покрывает: title, parentRuleRef, uncertainties. */
  'reviewed_unit_changed',
  /** `EDIT` без исправленного тела переприменить нельзя — см. шапку. */
  'edit_decision_unsupported',
  /** Экстракция не выдала ничего: вырожденный «успех» скрыл бы сломанный пайплайн. */
  'empty_extraction',
  /** Один `unitId` дважды во входе — чьё решение применять, неизвестно. */
  'duplicate_unit_in_extraction',
] as const;

export type ManifestGateFailureCode = (typeof MANIFEST_GATE_FAILURE_CODES)[number];

export interface ManifestGateFailure {
  readonly code: ManifestGateFailureCode;
  readonly unitId: string;
  readonly detail: string;
}

export interface ManifestGateResult {
  /** `false` — EXTRACTION_GATE_FAIL: прогон обязан остановиться. */
  readonly ok: boolean;
  /** Units, чьё человеческое ACCEPT/EDIT переприменено. Только они идут дальше. */
  readonly confirmed: readonly PersistedKnowledgeUnit[];
  readonly failures: readonly ManifestGateFailure[];
  /** Связь «unit → номер исходного правила» для recall@5. */
  readonly sourceRuleByUnitId: ReadonlyMap<string, number>;
}

/**
 * Сопоставление идёт по `unitId`, а НЕ по `sourceBlockAnchor`.
 *
 * Якорь считается по границам БЛОКА (`computeSourceBlockAnchor`), поэтому у
 * всех units одного абзаца он общий. А раздробленное правило — основной случай,
 * а не исключение: план §0.3 требует, чтобы для Q04 три units (15 сек, 30 сек,
 * 3 цикла) СОВМЕСТНО покрывали ограничение, и происходят они из одного абзаца.
 * Сопоставление по якорю схлопнуло бы три решения человека в одно и валило бы
 * ворота на каждом дроблёном правиле.
 *
 * `unitId` при этом остаётся устойчивым к правкам содержания: он считается как
 * `f(anchor, evidenceStart, evidenceEnd, kind)` и НЕ включает `statement` или
 * facets — те живут в `contentHash`. Поэтому изменение содержания даёт честное
 * «тот же unit, другое содержание», а не «пропал старый, появился новый».
 */
export function applyReviewManifest(
  freshUnits: readonly PersistedKnowledgeUnit[],
  manifest: readonly ReviewManifestEntry[]
): ManifestGateResult {
  const failures: ManifestGateFailure[] = [];
  const confirmed: PersistedKnowledgeUnit[] = [];
  const sourceRuleByUnitId = new Map<string, number>();

  const entryByUnitId = new Map(manifest.map((e) => [e.unitId, e]));
  const seenUnitIds = new Set<string>();

  // Пустая экстракция при пустом манифесте формально «сходится», но это
  // сломанный пайплайн, а не пройденные ворота: дальше по прогону пустая база
  // знаний провалит Q01–Q10 без единого указания на причину.
  if (freshUnits.length === 0) {
    failures.push({
      code: 'empty_extraction',
      unitId: '',
      detail: 'свежая экстракция не выдала ни одного unit — проверять нечего',
    });
  }

  const duplicated = new Set(
    freshUnits.map((u) => u.unitId).filter((id, i, all) => all.indexOf(id) !== i)
  );
  for (const unitId of duplicated) {
    failures.push({
      code: 'duplicate_unit_in_extraction',
      unitId,
      detail: `unitId «${unitId}» встречается во входе дважды — решение применилось бы к обоим`,
    });
  }

  for (const unit of freshUnits) {
    const entry = entryByUnitId.get(unit.unitId);

    if (entry === undefined) {
      failures.push({
        code: 'unit_absent_from_manifest',
        unitId: unit.unitId,
        detail:
          `unit «${unit.unitId}» (якорь «${unit.sourceBlockAnchor}») отсутствует в манифесте — ` +
          'экстракция выдала то, чего человек не видел; автоматически одобрить нельзя',
      });
      continue;
    }

    seenUnitIds.add(entry.unitId);

    // `unitId` выводится из якоря, поэтому расхождение означает правку манифеста
    // руками, а не дрейф извлечения. Молча игнорировать поле в артефакте,
    // который человек читает глазами, нельзя.
    if (entry.sourceAnchor !== unit.sourceBlockAnchor) {
      failures.push({
        code: 'source_anchor_mismatch',
        unitId: unit.unitId,
        detail:
          `манифест указывает якорь «${entry.sourceAnchor}», у unit'а — «${unit.sourceBlockAnchor}»; ` +
          'запись манифеста не описывает этот unit',
      });
      continue;
    }

    if (entry.reviewedContentHash !== unit.contentHash) {
      failures.push({
        code: 'content_hash_changed',
        unitId: unit.unitId,
        detail:
          `содержание unit'а «${unit.unitId}» изменилось с момента ревью ` +
          `(было ${entry.reviewedContentHash}, стало ${unit.contentHash}) — решение человека к нему больше не относится`,
      });
      continue;
    }

    if (computeReviewedUnitHash(unit) !== entry.reviewedUnitHash) {
      failures.push({
        code: 'reviewed_unit_changed',
        unitId: unit.unitId,
        detail:
          `структура unit'а «${unit.unitId}» изменилась вне contentHash ` +
          '(title, parentRuleRef, uncertainties или sourceSpan) — человек одобрял не этот объект',
      });
      continue;
    }

    // EDIT означает, что человек ОТВЕРГ извлечённый текст и заменил его.
    // Подтвердить здесь свежую экстракцию — значит заново одобрить ровно тот
    // текст, который человек забраковал. Исправленного тела манифест не несёт,
    // поэтому единственный честный исход — остановка, а не тихое одобрение.
    if (entry.decision === 'EDIT') {
      failures.push({
        code: 'edit_decision_unsupported',
        unitId: unit.unitId,
        detail:
          `решение EDIT по «${unit.unitId}» переприменить нельзя: манифест не хранит ` +
          'исправленный человеком текст, а свежая экстракция даёт именно тот, который он правил',
      });
      continue;
    }

    sourceRuleByUnitId.set(unit.unitId, entry.sourceRuleId);
    // REJECT — законный исход ревью, а не сбой: unit просто не идёт в retrieval.
    if (entry.decision !== 'REJECT') confirmed.push(unit);
  }

  for (const entry of manifest) {
    if (seenUnitIds.has(entry.unitId)) continue;
    failures.push({
      code: 'unit_missing_from_extraction',
      unitId: entry.unitId,
      detail:
        `манифест содержит решение по unit'у «${entry.unitId}» (якорь «${entry.sourceAnchor}»), ` +
        'но свежая экстракция его не выдала — знание потеряно, а прогон бы этого не заметил',
    });
  }

  return {
    ok: failures.length === 0,
    // Ворота либо пройдены целиком, либо не пройдены: частично подтверждённый
    // набор — это молча уменьшившаяся база знаний, на которой Q01–Q10 провалятся
    // необъяснимо.
    confirmed: failures.length === 0 ? confirmed : [],
    failures,
    // Обнуляется вместе с `confirmed`: иначе рядом с пустым набором остаётся
    // «частично успешная» карта, по которой раннер посчитал бы recall@5, не
    // заметив, что ворота не пройдены. Тот же класс ловушки, ради которого
    // `confirmed` сделан всё-или-ничего, только на другом поле.
    sourceRuleByUnitId: failures.length === 0 ? sourceRuleByUnitId : new Map(),
  };
}
