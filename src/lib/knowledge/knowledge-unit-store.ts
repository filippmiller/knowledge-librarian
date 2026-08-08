import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseJsonl, toJsonl } from './applicability/jsonl';
import type { PersistedKnowledgeUnit } from './applicability/identity-assignment';
import { persistedKnowledgeUnitSchema } from './applicability/persisted-unit';
import {
  reviewDecisionSchema,
  upsertReviewDecision,
  type ReviewDecision,
} from './applicability/review-decision';

/**
 * Файловая persistence (PR F, план §3) — JSONL безусловно, без альтернативы
 * "или временная таблица". НЕ production Prisma v2 (это 2.4, после пилота).
 */

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Пишет `filePath` атомарно: во временный файл РЯДОМ (та же директория, тот
 * же volume — `rename` атомарен только внутри одной файловой системы), затем
 * `rename` поверх цели. Прямой `writeFile` в целевой путь открывает файл с
 * усечением ДО того, как новые данные дописаны — крах процесса между
 * усечением и записью оставляет пустой или битый JSONL и молча теряет ВСЕ
 * прежние записи (review-решения — часы человеческой работы), не только
 * новую (независимая находка ревью Grok+Codex на этом PR).
 */
async function writeJsonlFile(filePath: string, text: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${Date.now()}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tempPath, text, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function readUnitsJsonl(filePath: string): Promise<PersistedKnowledgeUnit[]> {
  const text = await readTextOrEmpty(filePath);
  if (text.length === 0) return [];
  return parseJsonl(text, persistedKnowledgeUnitSchema);
}

export async function writeUnitsJsonl(
  filePath: string,
  units: readonly PersistedKnowledgeUnit[]
): Promise<void> {
  await writeJsonlFile(filePath, toJsonl(units));
}

export async function readReviewDecisionsJsonl(filePath: string): Promise<ReviewDecision[]> {
  const text = await readTextOrEmpty(filePath);
  if (text.length === 0) return [];
  return parseJsonl(text, reviewDecisionSchema);
}

/**
 * Добавляет/заменяет review-решение по `decision.unitId` и перезаписывает
 * файл целиком (upsert, не append) — повторный прогон по неизменному
 * документу не создаёт дубликат (acceptance criterion PR F). Возвращает
 * полный актуальный список для вызывающего кода.
 */
export async function appendReviewDecision(
  filePath: string,
  decision: ReviewDecision
): Promise<ReviewDecision[]> {
  const existing = await readReviewDecisionsJsonl(filePath);
  const updated = upsertReviewDecision(existing, decision);
  await writeJsonlFile(filePath, toJsonl(updated));
  return updated;
}
