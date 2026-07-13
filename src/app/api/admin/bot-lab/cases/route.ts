import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import knowledgeBase from '../../../../../../docs/email-bot/may2026-knowledge-base-final.json';

interface EmailKnowledgeItem {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
  confidence: number;
}

const cases = (knowledgeBase as EmailKnowledgeItem[]).map((item, index) => ({
  id: `bitrix-may-2026-${String(index + 1).padStart(3, '0')}`,
  ...item,
}));

export async function GET(request: NextRequest) {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const categoryCounts = cases.reduce<Record<string, number>>((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});

  const totalFrequency = cases.reduce((sum, item) => sum + item.freq, 0);
  const averageConfidence = cases.length
    ? cases.reduce((sum, item) => sum + item.confidence, 0) / cases.length
    : 0;

  return NextResponse.json(
    {
      dataset: {
        title: 'Bitrix · Май 2026',
        description: 'Обезличенная и дедуплицированная база знаний из переписок сделок',
        sourceThreads: 145,
        cases: cases.length,
        totalFrequency,
        priceDependent: cases.filter((item) => item.price_dependent).length,
        averageConfidence,
        categoryCounts,
      },
      cases,
    },
    {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    }
  );
}
