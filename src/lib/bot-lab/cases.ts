import knowledgeBase from '../../../docs/email-bot/may2026-knowledge-base-final.json';

export interface BotLabCase {
  id: string;
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
  confidence: number;
}

type EmailKnowledgeItem = Omit<BotLabCase, 'id'>;

export const botLabCases: BotLabCase[] = (knowledgeBase as EmailKnowledgeItem[]).map((item, index) => ({
  id: `bitrix-may-2026-${String(index + 1).padStart(3, '0')}`,
  ...item,
}));

export function getBotLabCase(id: string): BotLabCase | undefined {
  return botLabCases.find((item) => item.id === id);
}

export function getBotLabDatasetSummary() {
  const categoryCounts = botLabCases.reduce<Record<string, number>>((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
  const totalFrequency = botLabCases.reduce((sum, item) => sum + item.freq, 0);
  const averageConfidence = botLabCases.length
    ? botLabCases.reduce((sum, item) => sum + item.confidence, 0) / botLabCases.length
    : 0;

  return {
    title: 'Bitrix · Май 2026',
    description: 'Обезличенная и дедуплицированная база знаний из переписок сделок',
    sourceThreads: 145,
    cases: botLabCases.length,
    totalFrequency,
    priceDependent: botLabCases.filter((item) => item.price_dependent).length,
    averageConfidence,
    categoryCounts,
  };
}
