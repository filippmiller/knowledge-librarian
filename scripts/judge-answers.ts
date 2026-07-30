/**
 * Замер точности: ответ бота против исторического ответа оператора.
 *
 * Прогон корпуса (scripts/live-corpus-run.mjs) измеряет РЕШЕНИЕ политики —
 * отправил бы бот ответ или отдал оператору. Он ничего не говорит о том,
 * отвечает ли отправленный текст на заданный вопрос. Этот скрипт добавляет
 * вторую цифру: из отправленных сколько попадают в вопрос и не противоречат
 * тому, что реально отвечал оператор.
 *
 * Двухступенчатая проверка, дешёвое перед дорогим:
 *   1. Программная — числа. Если бот назвал число, которого нет ни в ответе
 *      оператора, ни в найденных цитатах, это кандидат на выдуманную цифру.
 *      Бесплатно и объективно.
 *   2. Судья-модель — попадание в вопрос, противоречия, пропуски.
 *
 * Жёсткое вето: противоречие оператору = WRONG независимо от прочих оценок.
 * Средние баллы скрывают конкретные провалы, а именно они стоят денег.
 *
 * Запуск: railway run npx tsx scripts/judge-answers.ts [путь-к-отчёту]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createChatCompletion, normalizeJsonResponse } from '../src/lib/ai/chat-provider';

const REPORT = process.argv[2] ?? 'docs/bot-audit/live-30-sample-run-client.md';

interface Case {
  index: number;
  question: string;
  category: string;
  decision: string;
  confidence: string;
  botAnswer: string;
  operatorAnswer: string;
  citations: string;
}

/** Разбор markdown-отчёта прогона. Структуру генерируем мы же, поэтому она стабильна. */
function parseReport(md: string): Case[] {
  const cases: Case[] = [];
  const sections = md.split(/^### (\d+)\. /m).slice(1);
  for (let i = 0; i < sections.length; i += 2) {
    const index = Number(sections[i]);
    const body = sections[i + 1];
    const question = body.split('\n')[0].trim();

    const meta = body.match(/`категория: ([^`]+)`/);
    const decision = body.match(/\*\*Решение политики: `([^`]+)`\*\*/);
    const confidence = body.match(/уверенность (\d+)% \(([^)]+)\)/);

    const quote = (label: string): string => {
      const start = body.indexOf(`**${label}:**`);
      if (start === -1) return '';
      const rest = body.slice(start + label.length + 6);
      const lines: string[] = [];
      for (const line of rest.split('\n')) {
        if (line.startsWith('> ')) lines.push(line.slice(2));
        else if (line.startsWith('>')) lines.push('');
        else if (lines.length > 0 && line.trim() === '') continue;
        else if (lines.length > 0) break;
      }
      return lines.join('\n').trim();
    };

    const citStart = body.indexOf('**Цитаты, на которые сослался движок:**');
    const citations =
      citStart === -1
        ? ''
        : body
            .slice(citStart)
            .split('\n')
            .filter((l) => l.startsWith('- `'))
            .join('\n');

    cases.push({
      index,
      question,
      category: meta?.[1] ?? '—',
      decision: decision?.[1] ?? '—',
      confidence: confidence ? `${confidence[1]}% ${confidence[2]}` : '—',
      botAnswer: quote('Ответ бота'),
      operatorAnswer: quote('Исторический ответ оператора'),
      citations,
    });
  }
  return cases;
}

/** Числа, похожие на цену или срок: 4+ значные суммы и «N рабочих дней». */
function extractNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\b\d[\d\s]{2,}\d\b/gu)) {
    found.add(m[0].replace(/\s+/g, ''));
  }
  for (const m of text.matchAll(/\b(\d{1,3})\s*(?:рабочих\s+)?(?:дн|недел|месяц)/giu)) {
    found.add(`${m[1]}д`);
  }
  return [...found];
}

const JUDGE_PROMPT = `Ты строгий проверяющий в бюро переводов. Сравниваешь ответ бота с ответом, который реально дал клиенту опытный оператор.

Оператор — эталон по СМЫСЛУ, но не обязательно полный: он мог не назвать цену, которую бот законно взял из прайса. Отсутствие факта у оператора само по себе не ошибка бота.

Ошибка бота — это:
  · ответ не на заданный вопрос (клиент спросил одно, бот рассказал про другое);
  · противоречие оператору по существу (разные цены за одно и то же, «делаем» против «не делаем», разные сроки);
  · пропуск условия, без которого ответ вводит в заблуждение.

Отвечай СТРОГО в JSON:
{
  "answers_question": "yes" | "partial" | "no",
  "contradicts": true | false,
  "contradiction_detail": "что именно противоречит, или пустая строка",
  "missing_essential": "какое условие пропущено и почему это вводит в заблуждение, или пустая строка",
  "verdict": "OK" | "WEAK" | "WRONG",
  "reason": "одно предложение"
}

Правила вердикта, применяй буквально:
  · contradicts=true → verdict WRONG всегда, без исключений;
  · answers_question="no" → WRONG;
  · answers_question="partial" ИЛИ есть missing_essential → WEAK;
  · иначе OK.`;

interface Verdict {
  answers_question?: string;
  contradicts?: boolean;
  contradiction_detail?: string;
  missing_essential?: string;
  verdict?: string;
  reason?: string;
}

async function judge(c: Case): Promise<Verdict> {
  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      {
        role: 'user',
        content: `ВОПРОС КЛИЕНТА:\n${c.question}\n\nОТВЕТ БОТА:\n${c.botAnswer}\n\nОТВЕТ ОПЕРАТОРА (эталон по смыслу):\n${c.operatorAnswer}`,
      },
    ],
    responseFormat: 'json_object',
    temperature: 0,
    maxTokens: 700,
  });
  return JSON.parse(normalizeJsonResponse(raw)) as Verdict;
}

async function main(): Promise<void> {
  const cases = parseReport(readFileSync(REPORT, 'utf8'));
  const answered = cases.filter((c) => c.decision === 'answer');
  console.log(`Вопросов в отчёте: ${cases.length}`);
  console.log(`Из них бот отправил бы ответ: ${answered.length}`);
  console.log(`Судим только отправленные — эскалации к клиенту не попадают.\n`);

  const rows: Array<{ c: Case; v: Verdict; suspectNumbers: string[] }> = [];

  for (const c of answered) {
    // Ступень 1, бесплатная: числа бота, которых нет ни у оператора, ни в цитатах.
    const known = new Set([
      ...extractNumbers(c.operatorAnswer),
      ...extractNumbers(c.citations),
    ]);
    const suspectNumbers = extractNumbers(c.botAnswer).filter((n) => !known.has(n));

    let v: Verdict;
    try {
      v = await judge(c);
    } catch (e) {
      v = { verdict: 'ОШИБКА СУДЬИ', reason: String(e).slice(0, 120) };
    }
    rows.push({ c, v, suspectNumbers });
    console.log(
      `[${c.index}] ${v.verdict}  ${c.question.slice(0, 62)}` +
        (suspectNumbers.length ? `  ⚠числа: ${suspectNumbers.join(', ')}` : '')
    );
    await new Promise((r) => setTimeout(r, 700));
  }

  const count = (v: string) => rows.filter((r) => r.v.verdict === v).length;
  const ok = count('OK');
  const weak = count('WEAK');
  const wrong = count('WRONG');

  const lines: string[] = [];
  lines.push('# Точность клиентских ответов против операторских эталонов');
  lines.push('');
  lines.push(`Источник: \`${REPORT}\`. Судятся только те вопросы, на которые бот отправил бы ответ.`);
  lines.push('');
  lines.push('## Итог');
  lines.push('');
  lines.push('| вердикт | вопросов | доля отправленных |');
  lines.push('|---|---|---|');
  for (const [name, n] of [['OK', ok], ['WEAK', weak], ['WRONG', wrong]] as const) {
    lines.push(`| ${name} | ${n} | ${Math.round((n / rows.length) * 100)}% |`);
  }
  lines.push('');
  lines.push(
    `Из ${cases.length} вопросов корпуса бот отправил бы ответ на ${answered.length}. ` +
      `Из них попадают в вопрос без противоречий: **${ok}** — то есть **${Math.round((ok / cases.length) * 100)}% от всего корпуса**.`
  );
  lines.push('');
  const withSuspect = rows.filter((r) => r.suspectNumbers.length > 0);
  lines.push(
    `Ответов с числами, которых нет ни у оператора, ни в цитатах: ${withSuspect.length}. ` +
      'Это не всегда ошибка — число может быть законно взято из прайса, не попавшего в топ цитат, — но именно здесь искать выдуманные цифры.'
  );
  lines.push('');
  lines.push('## Подробно');
  lines.push('');
  for (const { c, v, suspectNumbers } of rows) {
    lines.push(`### [${v.verdict}] ${c.index}. ${c.question}`);
    lines.push('');
    lines.push(`\`категория: ${c.category}\` · \`уверенность: ${c.confidence}\``);
    lines.push('');
    lines.push(`**Вердикт судьи:** ${v.reason ?? '—'}`);
    lines.push('');
    lines.push(`- отвечает на вопрос: ${v.answers_question ?? '—'}`);
    if (v.contradicts) lines.push(`- **противоречие:** ${v.contradiction_detail}`);
    if (v.missing_essential) lines.push(`- пропущено важное: ${v.missing_essential}`);
    if (suspectNumbers.length) lines.push(`- числа без подтверждения: ${suspectNumbers.join(', ')}`);
    lines.push('');
    lines.push('**Бот:**');
    lines.push('');
    lines.push('> ' + c.botAnswer.split('\n').join('\n> '));
    lines.push('');
    lines.push('**Оператор:**');
    lines.push('');
    lines.push('> ' + c.operatorAnswer.split('\n').join('\n> '));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const out = 'docs/bot-audit/accuracy-vs-operator.md';
  writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`\nOK ${ok} · WEAK ${weak} · WRONG ${wrong}`);
  console.log(`Отчёт: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
