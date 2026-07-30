/**
 * Замер на вопросах ВНЕ корпуса.
 *
 * Прогон scripts/live-corpus-run.mjs берёт вопросы из того же корпуса, который
 * импортирован в базу как канонические пары. Часть из них совпадает буквально,
 * поэтому он проверяет доставку импорта, а не способность обобщать.
 *
 * Здесь корпусные вопросы переписываются другими словами с сохранением смысла, а
 * эталоном остаётся операторский ответ на ИСХОДНЫЙ вопрос. Это даёт две вещи
 * сразу:
 *   · точность на формулировках, которых бот не видел;
 *   · проверку того, не сломал ли порог по длинной стороне узнавание
 *     переформулировок (recall canonical-override).
 *
 * Переформулировки пишет модель, а не автор скрипта: писать их вручную значит
 * невольно подгонять под то, что бот умеет.
 *
 * Запуск: railway run npx tsx scripts/run-out-of-corpus.ts [N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createChatCompletion, normalizeJsonResponse } from '../src/lib/ai/chat-provider';

const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';
const ASK_URL = 'https://avrora-library-production.up.railway.app/api/ask';
const SAMPLE = Number(process.argv[2] ?? 15);
const PACE_MS = 3500;

interface CorpusCase {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq?: number;
}

const REPHRASE_PROMPT = `Переформулируй вопрос клиента бюро переводов так, как его мог бы задать ДРУГОЙ человек: своими словами, с другим порядком слов и другой лексикой, возможно короче или разговорнее.

Требования:
· смысл и объём запроса сохраняются полностью — нельзя ни сужать, ни расширять;
· формулировка должна заметно отличаться от исходной, не только заменой одного слова;
· звучит как живое обращение клиента, а не как заголовок;
· без приветствий и подписей, только сам вопрос.

Ответ строго JSON: {"rephrased": "..."}`;

const JUDGE_PROMPT = `Ты строгий проверяющий в бюро переводов. Сравниваешь ответ бота с ответом, который реально дал клиенту опытный оператор на тот же по смыслу вопрос.

Оператор — эталон по СМЫСЛУ, но не по полноте: бот законно может назвать цену из прайса, которой оператор не назвал. Отсутствие факта у оператора само по себе не ошибка бота.

Ошибка бота — это:
· ответ не на заданный вопрос;
· противоречие оператору по существу (разные цены за одно и то же, «делаем» против «не делаем», разные сроки);
· пропуск условия, без которого ответ вводит в заблуждение.

Ответ строго JSON:
{"answers_question":"yes"|"partial"|"no","contradicts":true|false,"contradiction_detail":"","missing_essential":"","verdict":"OK"|"WEAK"|"WRONG","reason":""}

Вердикт применяй буквально: contradicts=true → WRONG; answers_question="no" → WRONG; "partial" или есть missing_essential → WEAK; иначе OK.`;

async function llmJson<T>(system: string, user: string, temperature: number): Promise<T> {
  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    responseFormat: 'json_object',
    temperature,
    maxTokens: 700,
  });
  return JSON.parse(normalizeJsonResponse(raw)) as T;
}

async function ask(question: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ question, includeDebug: true }),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return (await res.json()) as Record<string, unknown>;
    } catch {
      if (attempt === 2) return { error: 'network' };
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return { error: 'unreachable' };
}

const MIN_CONFIDENCE = 0.5;
function decide(r: Record<string, unknown>): string {
  if (r.scenarioClarification) return 'clarify';
  if (r.requiresHumanReview) return 'escalate';
  if (r.answerSource === 'general_ai') return 'escalate';
  const level = r.confidenceLevel;
  if (level === 'low' || level === 'insufficient') return 'escalate';
  return (r.confidence as number ?? 0) >= MIN_CONFIDENCE ? 'answer' : 'escalate';
}

async function main(): Promise<void> {
  const corpus: CorpusCase[] = JSON.parse(readFileSync(CORPUS, 'utf8'));
  // Самые частотные — то, что реально спрашивают чаще всего.
  const picked = [...corpus]
    .filter((c) => c.question?.trim() && c.answer?.trim())
    .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0))
    .slice(0, SAMPLE);

  const rows: Array<{
    c: CorpusCase;
    rephrased: string;
    decision: string;
    confidence: number;
    level: string;
    intent: string;
    botAnswer: string;
    verdict: Record<string, unknown>;
  }> = [];

  for (const [i, c] of picked.entries()) {
    process.stdout.write(`[${i + 1}/${picked.length}] `);
    const { rephrased } = await llmJson<{ rephrased: string }>(
      REPHRASE_PROMPT,
      `Исходный вопрос: ${c.question}`,
      0.8
    );
    const r = await ask(rephrased);
    if (r.error) {
      console.log(`ОШИБКА ${r.error}`);
      continue;
    }
    const decision = decide(r);
    const botAnswer = String(r.answer ?? '');
    const debug = r.debug as { intentClassification?: { intent?: string } } | undefined;
    const intent = debug?.intentClassification?.intent ?? '—';

    let verdict: Record<string, unknown> = { verdict: 'НЕ СУДИЛСЯ', reason: 'бот не отправил бы ответ' };
    if (decision === 'answer') {
      verdict = await llmJson<Record<string, unknown>>(
        JUDGE_PROMPT,
        `ВОПРОС КЛИЕНТА:\n${rephrased}\n\nОТВЕТ БОТА:\n${botAnswer}\n\nОТВЕТ ОПЕРАТОРА (эталон по смыслу, на исходную формулировку «${c.question}»):\n${c.answer}`,
        0
      );
    }

    console.log(
      `${decision} ${Math.round((r.confidence as number ?? 0) * 100)}% ${verdict.verdict} ${intent === 'canonical_qa_override' ? '[канон]' : ''}`
    );
    rows.push({
      c,
      rephrased,
      decision,
      confidence: (r.confidence as number) ?? 0,
      level: String(r.confidenceLevel ?? '—'),
      intent,
      botAnswer,
      verdict,
    });
    await new Promise((r2) => setTimeout(r2, PACE_MS));
  }

  const answered = rows.filter((r) => r.decision === 'answer');
  const canon = rows.filter((r) => r.intent === 'canonical_qa_override');
  const count = (v: string) => answered.filter((r) => r.verdict.verdict === v).length;

  const lines: string[] = [];
  lines.push('# Замер вне корпуса: переформулированные вопросы');
  lines.push('');
  lines.push(
    'Вопросы взяты из корпуса и переписаны моделью другими словами с сохранением смысла. Эталон — операторский ответ на исходную формулировку. Бот таких формулировок не видел.'
  );
  lines.push('');
  lines.push('## Итог');
  lines.push('');
  lines.push('| показатель | значение |');
  lines.push('|---|---|');
  lines.push(`| вопросов | ${rows.length} |`);
  lines.push(`| бот отправил бы ответ | ${answered.length} (${Math.round((answered.length / rows.length) * 100)}%) |`);
  lines.push(`| узнал канонический эталон | ${canon.length} (${Math.round((canon.length / rows.length) * 100)}%) |`);
  lines.push(`| OK | ${count('OK')} |`);
  lines.push(`| WEAK | ${count('WEAK')} |`);
  lines.push(`| WRONG | ${count('WRONG')} |`);
  lines.push('');
  lines.push(
    `Точных ответов от всей выборки: **${count('OK')} из ${rows.length}** — ${Math.round((count('OK') / rows.length) * 100)}%.`
  );
  lines.push('');
  lines.push('## Подробно');
  lines.push('');
  for (const r of rows) {
    lines.push(`### [${r.verdict.verdict}] ${r.rephrased}`);
    lines.push('');
    lines.push(`Исходная формулировка из корпуса: *${r.c.question}*`);
    lines.push('');
    lines.push(
      `\`решение: ${r.decision}\` · \`уверенность: ${Math.round(r.confidence * 100)}% ${r.level}\` · \`интент: ${r.intent}\``
    );
    lines.push('');
    if (r.verdict.reason) lines.push(`**Судья:** ${r.verdict.reason}`);
    if (r.verdict.contradicts) lines.push(`- **противоречие:** ${r.verdict.contradiction_detail}`);
    if (r.verdict.missing_essential) lines.push(`- пропущено: ${r.verdict.missing_essential}`);
    lines.push('');
    lines.push('**Бот:**');
    lines.push('');
    lines.push('> ' + r.botAnswer.split('\n').join('\n> '));
    lines.push('');
    lines.push('**Оператор (эталон):**');
    lines.push('');
    lines.push('> ' + r.c.answer.split('\n').join('\n> '));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const out = 'docs/bot-audit/out-of-corpus-rephrased.md';
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(
    `\nОтправил бы ${answered.length}/${rows.length} · канон узнан ${canon.length} · OK ${count('OK')} · WEAK ${count('WEAK')} · WRONG ${count('WRONG')}`
  );
  console.log(`Отчёт: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
