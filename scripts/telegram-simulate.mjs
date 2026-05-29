// Simulate a Telegram webhook flow against PROD /api/telegram without using
// a real Telegram client. Sends a text message, then the callback_query(ies)
// the real client would send when user clicks inline keyboard buttons.
//
// Requires: TEST_TELEGRAM_ID env var set to a telegramId that exists in the
// TelegramUser table (so access check passes). The bot will try to send
// outbound messages to that chat — if the chat ID is invalid (e.g. a test
// user with no real chat), those outbound calls silently fail but the
// INBOUND handler still runs to completion and writes session state we can
// inspect after the fact.

import https from 'node:https';
import { PrismaClient } from '@prisma/client';

const BASE = 'https://avrora-library-production.up.railway.app';
const TELEGRAM_ID = process.env.TEST_TELEGRAM_ID ?? process.argv[2];
if (!TELEGRAM_ID) {
  console.error('Usage: node scripts/telegram-simulate.mjs <telegram_id>');
  console.error('   or: TEST_TELEGRAM_ID=123456 node scripts/telegram-simulate.mjs');
  process.exit(1);
}
const CHAT_ID = Number(TELEGRAM_ID);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length },
      timeout: 180000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

const sendText = (text, updateId = Date.now()) =>
  post('/api/telegram', {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: CHAT_ID, type: 'private' },
      from: { id: CHAT_ID, first_name: 'TestRig', username: 'testrig' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });

const sendCallback = (data, updateId = Date.now()) =>
  post('/api/telegram', {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: CHAT_ID, first_name: 'TestRig', username: 'testrig' },
      message: {
        message_id: updateId,
        chat: { id: CHAT_ID, type: 'private' },
        from: { id: CHAT_ID, first_name: 'TestRig' },
        date: Math.floor(Date.now() / 1000),
      },
      data,
    },
  });

async function latestAssistantForSession(sessionId) {
  const p = new PrismaClient();
  try {
    return await p.chatMessage.findFirst({
      where: { sessionId, role: 'ASSISTANT' },
      orderBy: { createdAt: 'desc' },
    });
  } finally { await p.$disconnect(); }
}

async function latestSessionForTelegramId(telegramId) {
  const p = new PrismaClient();
  try {
    return await p.chatSession.findFirst({
      where: { userId: telegramId, source: 'TELEGRAM' },
      orderBy: { updatedAt: 'desc' },
    });
  } finally { await p.$disconnect(); }
}

function describeMeta(m) {
  const meta = m?.metadata;
  if (!meta) return '(no metadata)';
  const sc = meta.scenarioClarification;
  if (sc) return `clarification @ ${sc.atNodeKey}, ${sc.options?.length} options, originalQuestion="${meta.originalQuestion ?? '?'}"`;
  return `scenario_clear → ${meta.scenarioKey ?? '?'} (${meta.confidenceLevel ?? '?'})`;
}

async function main() {
  console.log(`Simulating Telegram flow for user ${TELEGRAM_ID}`);
  console.log(`Prod: ${BASE}`);
  console.log();

  // ── Step 1: send "АПОСТИЛЬ"
  console.log('[step 1] USER text "АПОСТИЛЬ"');
  let r = await sendText('АПОСТИЛЬ', 1);
  console.log(`  webhook: HTTP ${r.status}`);
  await new Promise((res) => setTimeout(res, 12000));
  let sess = await latestSessionForTelegramId(TELEGRAM_ID);
  let asst = sess ? await latestAssistantForSession(sess.id) : null;
  console.log(`  last ASSISTANT: ${describeMeta(asst)}`);
  console.log(`  answer (300): ${asst?.content?.slice(0, 300) ?? '(none)'}`);

  // ── Step 2: click "zags"
  console.log('\n[step 2] CALLBACK sc:zags');
  r = await sendCallback('sc:zags', 2);
  console.log(`  webhook: HTTP ${r.status}`);
  await new Promise((res) => setTimeout(res, 15000));
  asst = sess ? await latestAssistantForSession(sess.id) : null;
  console.log(`  last ASSISTANT: ${describeMeta(asst)}`);
  console.log(`  answer (300): ${asst?.content?.slice(0, 300) ?? '(none)'}`);

  // ── Step 3: click "spb"
  console.log('\n[step 3] CALLBACK sc:spb');
  r = await sendCallback('sc:spb', 3);
  console.log(`  webhook: HTTP ${r.status}`);
  await new Promise((res) => setTimeout(res, 25000));
  asst = sess ? await latestAssistantForSession(sess.id) : null;
  console.log(`  last ASSISTANT: ${describeMeta(asst)}`);
  console.log(`  answer (400): ${asst?.content?.slice(0, 400) ?? '(none)'}`);

  const finalOK = asst?.metadata?.scenarioKey === 'apostille.zags.spb';
  console.log(`\n━━━ VERDICT ━━━`);
  console.log(finalOK ? '✅ Telegram callback chain works — final scenarioKey=apostille.zags.spb'
                      : `❌ Final scenarioKey=${asst?.metadata?.scenarioKey ?? '(none)'}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
