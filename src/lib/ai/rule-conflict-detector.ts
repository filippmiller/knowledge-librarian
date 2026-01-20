/**
 * Rule Conflict Detection Module
 *
 * Automatically detects when new rules conflict with existing ones.
 * Critical for maintaining accuracy - conflicting rules lead to wrong answers.
 */

import { openai, CHAT_MODEL } from '@/lib/openai';
import prisma from '@/lib/db';
import { generateEmbedding } from '@/lib/openai';

export interface ConflictDetectionResult {
  hasConflict: boolean;
  conflicts: RuleConflict[];
  warnings: RuleWarning[];
}

export interface RuleConflict {
  newRule: {
    title: string;
    body: string;
  };
  existingRule: {
    id: string;
    ruleCode: string;
    title: string;
    body: string;
  };
  conflictType: 'price_contradiction' | 'procedure_contradiction' | 'timeline_contradiction' | 'requirement_contradiction' | 'general_contradiction';
  severity: 'critical' | 'high' | 'medium' | 'low';
  explanation: string;
  suggestedResolution: string;
}

export interface RuleWarning {
  ruleTitle: string;
  warningType: 'potential_duplicate' | 'outdated_reference' | 'ambiguous_scope' | 'missing_context';
  explanation: string;
}

const CONFLICT_DETECTION_PROMPT = `Ты - эксперт по анализу бизнес-правил для бюро переводов.

Проанализируй НОВОЕ правило и сравни его с СУЩЕСТВУЮЩИМ правилом.
Определи, есть ли между ними конфликт.

Типы конфликтов:
1. price_contradiction - разные цены на одну услугу
2. procedure_contradiction - разные процедуры для одного действия
3. timeline_contradiction - разные сроки выполнения
4. requirement_contradiction - разные требования к документам
5. general_contradiction - другие противоречия

Уровни серьёзности:
- critical: прямое противоречие, невозможно следовать обоим правилам
- high: значительное расхождение, может ввести в заблуждение
- medium: частичное расхождение, требует уточнения
- low: незначительное расхождение, возможно устаревшая информация

Ответь в формате JSON:
{
  "hasConflict": boolean,
  "conflictType": "тип или null",
  "severity": "уровень или null",
  "explanation": "объяснение конфликта на русском",
  "suggestedResolution": "предложение по разрешению на русском"
}`;

/**
 * Detect conflicts between a new rule and existing rules
 */
export async function detectRuleConflicts(
  newRule: { title: string; body: string; domains?: string[] }
): Promise<ConflictDetectionResult> {
  const conflicts: RuleConflict[] = [];
  const warnings: RuleWarning[] = [];

  // Step 1: Find semantically similar existing rules
  const newRuleText = `${newRule.title}\n${newRule.body}`;
  const newRuleEmbedding = await generateEmbedding(newRuleText);

  // Get all active rules
  const existingRules = await prisma.rule.findMany({
    where: { status: 'ACTIVE' },
    include: {
      domains: { include: { domain: true } },
    },
  });

  // Calculate similarity with each existing rule
  const similarRules = await Promise.all(
    existingRules.map(async (rule) => {
      const ruleText = `${rule.title}\n${rule.body}`;
      const ruleEmbedding = await generateEmbedding(ruleText);
      const similarity = cosineSimilarity(newRuleEmbedding, ruleEmbedding);
      return { rule, similarity };
    })
  );

  // Filter to rules with similarity > 0.5 (potential conflicts or duplicates)
  const potentialConflicts = similarRules
    .filter(r => r.similarity > 0.5)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  // Check for potential duplicates (very high similarity)
  for (const { rule, similarity } of potentialConflicts) {
    if (similarity > 0.9) {
      warnings.push({
        ruleTitle: newRule.title,
        warningType: 'potential_duplicate',
        explanation: `Это правило очень похоже на существующее правило ${rule.ruleCode}: "${rule.title}". Возможно, это дубликат.`,
      });
    }
  }

  // Step 2: Use LLM to detect actual conflicts
  for (const { rule, similarity } of potentialConflicts) {
    if (similarity < 0.5) continue;

    const conflictAnalysis = await analyzeRuleConflict(newRule, rule);

    if (conflictAnalysis.hasConflict) {
      conflicts.push({
        newRule: {
          title: newRule.title,
          body: newRule.body,
        },
        existingRule: {
          id: rule.id,
          ruleCode: rule.ruleCode,
          title: rule.title,
          body: rule.body,
        },
        conflictType: conflictAnalysis.conflictType!,
        severity: conflictAnalysis.severity!,
        explanation: conflictAnalysis.explanation,
        suggestedResolution: conflictAnalysis.suggestedResolution,
      });
    }
  }

  // Step 3: Check for outdated references (dates in the past)
  const datePattern = /(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{2,4})|(\d{4}[-\/]\d{2}[-\/]\d{2})|(январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*\s+\d{4}/gi;
  const dates = newRule.body.match(datePattern);

  if (dates) {
    const now = new Date();
    for (const dateStr of dates) {
      const parsedDate = parseRussianDate(dateStr);
      if (parsedDate && parsedDate < now) {
        warnings.push({
          ruleTitle: newRule.title,
          warningType: 'outdated_reference',
          explanation: `Правило содержит дату "${dateStr}", которая уже прошла. Возможно, информация устарела.`,
        });
        break;
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts,
    warnings,
  };
}

async function analyzeRuleConflict(
  newRule: { title: string; body: string },
  existingRule: { ruleCode: string; title: string; body: string }
): Promise<{
  hasConflict: boolean;
  conflictType?: RuleConflict['conflictType'];
  severity?: RuleConflict['severity'];
  explanation: string;
  suggestedResolution: string;
}> {
  try {
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: CONFLICT_DETECTION_PROMPT },
        {
          role: 'user',
          content: `НОВОЕ ПРАВИЛО:
Заголовок: ${newRule.title}
Содержание: ${newRule.body}

СУЩЕСТВУЮЩЕЕ ПРАВИЛО [${existingRule.ruleCode}]:
Заголовок: ${existingRule.title}
Содержание: ${existingRule.body}

Проанализируй, есть ли конфликт между этими правилами.`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const content = response.choices[0].message.content;
    if (!content) {
      return { hasConflict: false, explanation: '', suggestedResolution: '' };
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('Conflict analysis failed:', error);
    return { hasConflict: false, explanation: '', suggestedResolution: '' };
  }
}

/**
 * Detect expiring rules (rules with dates approaching expiration)
 */
export async function detectExpiringRules(
  daysAhead: number = 30
): Promise<{ ruleId: string; ruleCode: string; expirationDate: Date; reason: string }[]> {
  const rules = await prisma.rule.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, ruleCode: true, title: true, body: true },
  });

  const expiringRules: { ruleId: string; ruleCode: string; expirationDate: Date; reason: string }[] = [];
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  for (const rule of rules) {
    const dates = extractDates(rule.body);
    for (const date of dates) {
      if (date > new Date() && date <= futureDate) {
        expiringRules.push({
          ruleId: rule.id,
          ruleCode: rule.ruleCode,
          expirationDate: date,
          reason: `Правило "${rule.title}" содержит дату ${date.toLocaleDateString('ru-RU')}, которая наступит в течение ${daysAhead} дней.`,
        });
        break;
      }
    }
  }

  return expiringRules;
}

/**
 * Create AIQuestion record for detected conflict
 */
export async function createConflictQuestion(conflict: RuleConflict): Promise<string> {
  const question = await prisma.aIQuestion.create({
    data: {
      issueType: 'rule_conflict',
      question: `Обнаружен конфликт между правилами:\n\nНовое правило: ${conflict.newRule.title}\nСуществующее правило [${conflict.existingRule.ruleCode}]: ${conflict.existingRule.title}\n\n${conflict.explanation}`,
      context: {
        newRule: conflict.newRule,
        existingRule: {
          id: conflict.existingRule.id,
          ruleCode: conflict.existingRule.ruleCode,
        },
        conflictType: conflict.conflictType,
        severity: conflict.severity,
      },
      proposedChange: {
        suggestion: conflict.suggestedResolution,
      },
      affectedRuleId: conflict.existingRule.id,
      status: 'OPEN',
    },
  });

  return question.id;
}

// Utility functions

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

function parseRussianDate(dateStr: string): Date | null {
  const months: Record<string, number> = {
    'январ': 0, 'феврал': 1, 'март': 2, 'апрел': 3,
    'май': 4, 'июн': 5, 'июл': 6, 'август': 7,
    'сентябр': 8, 'октябр': 9, 'ноябр': 10, 'декабр': 11,
  };

  // Try Russian month format
  for (const [monthPrefix, monthNum] of Object.entries(months)) {
    if (dateStr.toLowerCase().includes(monthPrefix)) {
      const yearMatch = dateStr.match(/\d{4}/);
      if (yearMatch) {
        return new Date(parseInt(yearMatch[0]), monthNum, 1);
      }
    }
  }

  // Try numeric formats
  const numericMatch = dateStr.match(/(\d{1,4})[\.\/\-](\d{1,2})[\.\/\-](\d{2,4})/);
  if (numericMatch) {
    let [, first, second, third] = numericMatch;
    let year: number, month: number, day: number;

    if (first.length === 4) {
      // YYYY-MM-DD format
      year = parseInt(first);
      month = parseInt(second) - 1;
      day = parseInt(third);
    } else {
      // DD.MM.YYYY or DD.MM.YY format
      day = parseInt(first);
      month = parseInt(second) - 1;
      year = parseInt(third);
      if (year < 100) year += 2000;
    }

    return new Date(year, month, day);
  }

  return null;
}

function extractDates(text: string): Date[] {
  const datePattern = /(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{2,4})|(\d{4}[-\/]\d{2}[-\/]\d{2})|(январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*\s+\d{4}/gi;
  const matches = text.match(datePattern) || [];

  return matches
    .map(m => parseRussianDate(m))
    .filter((d): d is Date => d !== null);
}
