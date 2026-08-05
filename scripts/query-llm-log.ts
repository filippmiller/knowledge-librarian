/**
 * Human-readable dump of LlmCallLog — "what actually went into the model" for
 * a specific incident, question, or session.
 *
 * WHY THIS EXISTS: the answering engine makes 5-9 model calls per user
 * question (scenario gate, query expansion, entity extraction, synthesis,
 * hallucination-revision, general_ai fallback, ...). When the bot returns an
 * unexplainable bad answer (e.g. "как передать доки в Москву" → answer about
 * a partner office in Orel), there was previously no way to retrospectively
 * see the exact system prompt and raw model output behind it. This script
 * reads LlmCallLog (written by src/lib/ai/chat-provider.ts on every call) and
 * prints each call in order: callSite, provider/model, full system prompt,
 * full user message, raw response, latency, error.
 *
 * Usage (DB lives on Railway, so wrap with `railway run`):
 *   railway run npx tsx scripts/query-llm-log.ts --question="как передать доки в москву"
 *   railway run npx tsx scripts/query-llm-log.ts --session=<sessionId>
 *   railway run npx tsx scripts/query-llm-log.ts --last=20
 *   railway run npx tsx scripts/query-llm-log.ts --callSite=enhanced-answering:synthesis --last=5
 *   railway run npx tsx scripts/query-llm-log.ts --last=5 --full   # don't truncate for terminal
 */

import prisma from '../src/lib/db';

interface Args {
  question?: string;
  session?: string;
  callSite?: string;
  last: number;
  full: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { last: 10, full: false };
  for (const raw of argv) {
    if (raw === '--full') {
      args.full = true;
      continue;
    }
    const m = raw.match(/^--([a-zA-Z]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'question') args.question = value;
    else if (key === 'session') args.session = value;
    else if (key === 'callSite') args.callSite = value;
    else if (key === 'last') args.last = Number(value) || 10;
  }
  return args;
}

/** Терминал захлёбывается на 20000-символьном system prompt — сокращаем, если не --full. */
function displayText(text: string | null, full: boolean, limit = 2000): string {
  if (text === null) return '(null)';
  if (full || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[показано ${limit} из ${text.length} символов; используйте --full]`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const where: Record<string, unknown> = {};
  if (args.question) where.question = { contains: args.question, mode: 'insensitive' };
  if (args.session) where.sessionId = args.session;
  if (args.callSite) where.callSite = args.callSite;

  const rows = await prisma.llmCallLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: args.last,
  });

  if (rows.length === 0) {
    console.log('Ничего не найдено. Проверьте фильтры (--question / --session / --callSite).');
    await prisma.$disconnect();
    return;
  }

  // Печатаем в хронологическом порядке (старые сверху) — так читается как трасса одного ответа.
  const ordered = [...rows].reverse();

  for (const row of ordered) {
    console.log('='.repeat(100));
    console.log(`[${row.createdAt.toISOString()}]  ${row.callSite}  (${row.provider}/${row.model})`);
    console.log(`id=${row.id}  sessionId=${row.sessionId ?? '-'}  latency=${row.latencyMs ?? '?'}ms  streaming=${row.streaming}`);
    if (row.question) console.log(`question: ${row.question}`);
    if (row.temperature !== null) console.log(`temperature=${row.temperature}  maxTokens=${row.maxTokens ?? '-'}  responseFormat=${row.responseFormat ?? '-'}`);
    if (row.error) console.log(`ERROR: ${row.error}`);
    console.log('-'.repeat(100));
    console.log('SYSTEM PROMPT:');
    console.log(displayText(row.systemPrompt, args.full));
    console.log('-'.repeat(100));
    console.log('USER MESSAGE:');
    console.log(displayText(row.userMessage, args.full));
    console.log('-'.repeat(100));
    console.log('RAW RESPONSE:');
    console.log(displayText(row.rawResponse, args.full));
    console.log('');
  }

  console.log('='.repeat(100));
  console.log(`Показано ${rows.length} записей.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
