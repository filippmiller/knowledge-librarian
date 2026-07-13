import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import type { VoiceRuleCandidate, VoiceRulePriority, VoiceRuleType } from '@/lib/ai/voice-rule-extractor';

const PRIORITIES = new Set<VoiceRulePriority>(['PRIMARY', 'HIGH', 'NORMAL']);
const TYPES = new Set<VoiceRuleType>(['capability', 'procedure', 'requirement', 'price', 'deadline', 'prohibition', 'exception', 'escalation']);

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validateRule(value: unknown): VoiceRuleCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const rule = value as Record<string, unknown>;
  const title = clean(rule.title, 180);
  const body = clean(rule.body, 4000);
  const sourceQuote = clean(rule.sourceQuote, 500);
  if (title.length < 5 || body.length < 10 || sourceQuote.length < 3) return null;
  const type = TYPES.has(rule.type as VoiceRuleType) ? rule.type as VoiceRuleType : 'procedure';
  const priority = PRIORITIES.has(rule.priority as VoiceRulePriority) ? rule.priority as VoiceRulePriority : 'HIGH';
  return {
    title,
    body,
    sourceQuote,
    type,
    priority,
    scope: clean(rule.scope, 300) || 'Общее',
    conditions: Array.isArray(rule.conditions) ? rule.conditions.map((item) => clean(item, 500)).filter(Boolean).slice(0, 12) : [],
    requiresLiveData: rule.requiresLiveData === true || type === 'price' || type === 'deadline',
    extractionConfidence: typeof rule.extractionConfidence === 'number' ? Math.max(0, Math.min(rule.extractionConfidence, 1)) : 0.5,
    tags: Array.isArray(rule.tags) ? rule.tags.map((item) => clean(item, 60)).filter(Boolean).slice(0, 12) : [],
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();
  if (actor.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Публиковать правила может только администратор' }, { status: 403 });
  }

  const payload = await request.json().catch(() => null) as {
    rules?: unknown;
    sourceName?: unknown;
    audioHash?: unknown;
    reviewConfirmed?: unknown;
    acknowledgedUncertainties?: unknown;
  } | null;
  if (payload?.reviewConfirmed !== true) {
    return NextResponse.json({ error: 'Подтвердите операторскую проверку правил' }, { status: 400 });
  }
  const rules = Array.isArray(payload?.rules)
    ? payload.rules.slice(0, 20).map(validateRule).filter((rule): rule is VoiceRuleCandidate => rule !== null)
    : [];
  if (rules.length === 0) {
    return NextResponse.json({ error: 'Нет валидных правил для публикации' }, { status: 400 });
  }
  const sourceName = clean(payload?.sourceName, 180) || 'browser-recording.webm';
  const audioHash = clean(payload?.audioHash, 128);
  const acknowledgedUncertainties = Array.isArray(payload?.acknowledgedUncertainties)
    ? payload.acknowledgedUncertainties.map((item) => clean(item, 600)).filter(Boolean).slice(0, 30)
    : [];
  const approvedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const existingCodes = await tx.rule.findMany({ select: { ruleCode: true } });
    let nextCode = existingCodes.reduce((max, item) => {
      const value = Number.parseInt(item.ruleCode.replace(/^R-/i, ''), 10);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0) + 1;
    const created: Array<{ id: string; ruleCode: string; title: string; reused: boolean }> = [];

    for (const rule of rules) {
      const duplicate = await tx.rule.findFirst({
        where: { status: 'ACTIVE', title: rule.title, body: rule.body },
        select: { id: true, ruleCode: true, title: true },
      });
      if (duplicate) {
        created.push({ ...duplicate, reused: true });
        continue;
      }

      const createdRule = await tx.rule.create({
        data: {
          ruleCode: `R-${nextCode++}`,
          title: rule.title,
          body: rule.body,
          confidence: 1,
          status: 'ACTIVE',
          sourceSpan: {
            quote: rule.sourceQuote,
            locationHint: `Voice Rule Studio · ${sourceName}`,
            authorityTag: 'VOICE_AUTHORITY',
            priority: rule.priority,
            ruleType: rule.type,
            scope: rule.scope,
            conditions: rule.conditions,
            requiresLiveData: rule.requiresLiveData,
            tags: [...new Set(['VOICE_AUTHORITY', ...rule.tags])],
            extractionConfidence: rule.extractionConfidence,
            audioHash: audioHash || null,
            audioStored: false,
            operatorApproved: true,
            reviewConfirmed: true,
            acknowledgedUncertainties,
            approvedBy: actor.username,
            approvedAt: approvedAt.toISOString(),
          },
        },
      });
      await tx.knowledgeChange.create({
        data: {
          targetType: 'RULE',
          targetId: createdRule.id,
          changeType: 'CREATE',
          newValue: { ruleCode: createdRule.ruleCode, title: rule.title, body: rule.body, authorityTag: 'VOICE_AUTHORITY', priority: rule.priority },
          reason: 'Правило надиктовано экспертом и подтверждено в Voice Rule Studio',
          initiatedBy: 'ADMIN',
          approvedBy: `web:${actor.username}`,
          status: 'APPROVED',
          reviewedAt: approvedAt,
        },
      });
      created.push({ id: createdRule.id, ruleCode: createdRule.ruleCode, title: createdRule.title, reused: false });
    }
    return created;
  });

  return NextResponse.json({ rules: result, authorityTag: 'VOICE_AUTHORITY' }, { status: 201 });
}
