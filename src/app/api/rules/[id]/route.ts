import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const rule = await prisma.rule.findUnique({
      where: { id },
      include: {
        document: { select: { title: true, filename: true } },
        domains: { include: { domain: true } },
        supersedesRule: true,
        supersededBy: true,
        qaPairs: { where: { status: 'ACTIVE' } },
        changes: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json(rule);
  } catch (error) {
    console.error('Error fetching rule:', error);
    return NextResponse.json({ error: 'Failed to fetch rule' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();
    const { title, body: ruleBody, action, reason } = body;

    const existingRule = await prisma.rule.findUnique({
      where: { id },
    });

    if (!existingRule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    // Handle different actions
    if (action === 'update') {
      // Create a new version that supersedes the old one
      const newRule = await prisma.rule.create({
        data: {
          documentId: existingRule.documentId,
          ruleCode: existingRule.ruleCode,
          title: title || existingRule.title,
          body: ruleBody || existingRule.body,
          confidence: existingRule.confidence,
          version: existingRule.version + 1,
          supersedesRuleId: existingRule.id,
          sourceSpan: existingRule.sourceSpan ?? undefined,
        },
      });

      // Mark old rule as superseded
      await prisma.rule.update({
        where: { id },
        data: { status: 'SUPERSEDED' },
      });

      // Copy domain associations
      const domains = await prisma.ruleDomain.findMany({
        where: { ruleId: id },
      });

      for (const domain of domains) {
        await prisma.ruleDomain.create({
          data: {
            ruleId: newRule.id,
            domainId: domain.domainId,
            confidence: domain.confidence,
          },
        });
      }

      // Log the change
      await prisma.knowledgeChange.create({
        data: {
          targetType: 'RULE',
          targetId: newRule.id,
          changeType: 'UPDATE',
          oldValue: { title: existingRule.title, body: existingRule.body },
          newValue: { title: newRule.title, body: newRule.body },
          reason: reason || 'Admin update',
          initiatedBy: 'ADMIN',
          approvedBy: 'admin',
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      });

      return NextResponse.json(newRule);
    } else if (action === 'deprecate') {
      await prisma.rule.update({
        where: { id },
        data: { status: 'DEPRECATED' },
      });

      await prisma.knowledgeChange.create({
        data: {
          targetType: 'RULE',
          targetId: id,
          changeType: 'DEPRECATE',
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'DEPRECATED' },
          reason: reason || 'Deprecated by admin',
          initiatedBy: 'ADMIN',
          approvedBy: 'admin',
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      });

      return NextResponse.json({ message: 'Rule deprecated' });
    } else {
      // Simple field update (no versioning)
      const updated = await prisma.rule.update({
        where: { id },
        data: {
          title: title || undefined,
          body: ruleBody || undefined,
        },
      });

      return NextResponse.json(updated);
    }
  } catch (error) {
    console.error('Error updating rule:', error);
    return NextResponse.json({ error: 'Failed to update rule' }, { status: 500 });
  }
}
