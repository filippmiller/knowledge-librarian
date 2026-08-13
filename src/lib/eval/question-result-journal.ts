import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex');
const entrySchema = z.strictObject({ caseId: z.string().min(1), question: z.string().min(1), keyDigest: hex, result: z.unknown() });
const bodySchema = z.strictObject({ version: z.literal('2026-08-10-question-journal-v1'), artifactContentDigest: hex, configDigest: hex, entries: z.array(entrySchema) });
const fileSchema = bodySchema.extend({ contentDigest: hex });
export interface QuestionJournalFingerprint { readonly artifactContentDigest: string; readonly configDigest: string }
export function buildQuestionJournalFingerprint(artifactContentDigest: string, exactEngineConfig: unknown): QuestionJournalFingerprint {
  return { artifactContentDigest: hex.parse(artifactContentDigest), configDigest: digest(exactEngineConfig) };
}
export class QuestionResultJournal<T> {
  private entries = new Map<string, z.infer<typeof entrySchema>>();
  constructor(private filePath: string, readonly fingerprint: QuestionJournalFingerprint) {
    if (!existsSync(filePath)) return;
    const parsed = fileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')));
    const { contentDigest, ...body } = parsed;
    if (digest(body) !== contentDigest) throw new Error('Question journal content digest mismatch');
    if (parsed.artifactContentDigest !== fingerprint.artifactContentDigest || parsed.configDigest !== fingerprint.configDigest) throw new Error('Question journal artifact/config fingerprint mismatch');
    for (const entry of parsed.entries) this.entries.set(entry.keyDigest, entry);
  }
  load(caseId: string, question: string): T | undefined {
    const result = this.entries.get(digest({ caseId, question }))?.result as T | undefined;
    return isCacheableDisposition(result) ? result : undefined;
  }
  save(caseId: string, question: string, result: T): void {
    if (!isCacheableDisposition(result)) return;
    const keyDigest = digest({ caseId, question }); const next = { caseId, question, keyDigest, result }; const old = this.entries.get(keyDigest);
    if (old && digest(old) !== digest(next)) throw new Error(`Refusing to replace terminal question ${caseId}`); if (old) return;
    this.entries.set(keyDigest, next); const body = { version: '2026-08-10-question-journal-v1' as const, ...this.fingerprint, entries: [...this.entries.values()] };
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, JSON.stringify({ ...body, contentDigest: digest(body) }, null, 2), { encoding: 'utf8', flag: 'wx' }); renameSync(tmp, this.filePath); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
  }
}
function isCacheableDisposition(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('actualDisposition' in value)) return true;
  return new Set(['DIRECT_ANSWER', 'HOLD', 'UNVERIFIED_ANSWER']).has(
    String((value as { actualDisposition?: unknown }).actualDisposition)
  );
}
