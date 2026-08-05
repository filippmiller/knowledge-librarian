import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { answerQuestionEnhanced } from '@/lib/ai/enhanced-answering-engine';
import { resolveDelivery } from '@/lib/ai/delivery';
import { findSimilarOperatorAnswer } from '@/lib/telegram-test/similar-operator-answer';
import { sendTestMessage, answerTestCallbackQuery, editTestMessageReplyMarkup, setTestBotCommands } from '@/lib/telegram-test/api';
import prisma from '@/lib/db';

/**
 * ВТОРОЙ, ИЗОЛИРОВАННЫЙ Telegram-бот — тренажёр клиентского контура.
 *
 * Зачем отдельный бот, а не режим внутри боевого: клиентский контур сегодня
 * сознательно не подключён ни к одному живому клиенту (см. аудит
 * .claude/audits/2026-08-05-two-contour-gap-analysis.md, разрыв №3) — качество
 * не доведено. Этот бот даёт сотруднику поговорить с клиентским контуром как
 * будущий клиент, БЕЗ риска, что черновик или удерживающий ответ попадёт
 * реальному человеку: доступ закрыт списком TELEGRAM_TEST_ALLOWED_USERS, и
 * никакой канал к настоящим клиентам сюда не ведёт.
 *
 * Каждый вопрос идёт как настоящий клиентский: audience='client' +
 * resolveDelivery — сотрудник видит РОВНО то, что увидел бы клиент, включая
 * подмену на CLIENT_HOLDING_ANSWER, если движок сам себе не доверяет. Это не
 * облегчённая версия для теста — тот же путь, только с меткой в БД.
 *
 * Рядом — ближайший РЕАЛЬНЫЙ операторский ответ на похожий вопрос (см.
 * similar-operator-answer.ts). Замер docs/bot-audit/accuracy-vs-operator.md
 * показал: 17 из 21 ответа бота потеряли условие, которое оператор всегда
 * называет. Видя оператора рядом на каждом вопросе, сотрудник сразу замечает
 * этот класс ошибки, а не только полную неправду.
 *
 * Три кнопки пишут в AnswerFeedback (модель в схеме была заведена, но нигде
 * не использовалась) — 👍 фиксирует, что бот ответил как оператор,
 * 👎 фиксирует расхождение, ✏️ просит сотрудника прислать правильный текст
 * следующим сообщением. Оператор так же вправе просто вставить его в чат сразу
 */

function isFromTelegramTest(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_TEST_WEBHOOK_SECRET ?? '';
  if (!expected) {
    console.error('[telegram-test] TELEGRAM_TEST_WEBHOOK_SECRET not set — rejecting webhook call');
    return false;
  }
  const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAllowed(telegramId: number): boolean {
  const allowed = (process.env.TELEGRAM_TEST_ALLOWED_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Пустой список — намеренный отказ всем, не «пускать всех». Тестовый бот
  // без явного списка не должен отвечать никому, в отличие от боевого, где
  // пустой TELEGRAM_ALLOWED_USERS исторически значил «пускать всех».
  return allowed.includes(String(telegramId));
}

// В памяти процесса: держит, о каком вопросе шла речь, пока сотрудник не
// нажал кнопку или не прислал правку. Тестовый инструмент для нескольких
// сотрудников — переживать рестарт процесса ему не обязательно.
const pendingByChatId = new Map<number, { question: string; botAnswer: string; awaitingCorrection: boolean }>();

let commandsRegistered = false;

export async function POST(request: NextRequest) {
  if (!isFromTelegramTest(request)) {
    return NextResponse.json({ ok: true });
  }
  if (!commandsRegistered) {
    commandsRegistered = true;
    setTestBotCommands().catch(() => {});
  }

  try {
    const update = await request.json();

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return NextResponse.json({ ok: true });
    }

    const message = update.message;
    const chatId: number | undefined = message?.chat?.id;
    const fromId: number | undefined = message?.from?.id;
    const text: string | undefined = message?.text;
    if (!chatId || !fromId || !text) return NextResponse.json({ ok: true });

    if (!isAllowed(fromId)) {
      await sendTestMessage(chatId, 'Этот бот — внутренний тренажёр, доступ только по списку сотрудников.');
      return NextResponse.json({ ok: true });
    }

    if (text === '/start') {
      await sendTestMessage(
        chatId,
        'Тренажёр клиентского контура. Пишите вопрос как будущий клиент — увидите то же, что увидел бы он, ' +
        'плюс ближайший реальный ответ оператора рядом. Отметьте 👍/👎, или ✏️ и пришлите верный текст следующим сообщением.'
      );
      return NextResponse.json({ ok: true });
    }

    const pending = pendingByChatId.get(chatId);
    if (pending?.awaitingCorrection) {
      await prisma.answerFeedback.create({
        data: {
          question: pending.question,
          answer: pending.botAnswer,
          rating: 'INCORRECT',
          feedbackType: 'MISSING_INFO',
          suggestedAnswer: text,
        },
      });
      pendingByChatId.delete(chatId);
      await sendTestMessage(chatId, 'Записал вашу правку. Спасибо — она пойдёт в разбор канонизации.');
      return NextResponse.json({ ok: true });
    }

    await sendTestMessage(chatId, '⏳ Спрашиваю клиентский контур...');

    const result = await answerQuestionEnhanced({ question: text, audience: 'client' });
    const outcome = await resolveDelivery(result, 'client');

    const [similar] = await Promise.all([findSimilarOperatorAnswer(text)]);

    let reply = `🧑‍💼 ОТВЕТ КЛИЕНТУ (${outcome.decision}${outcome.withheld ? ', подменён на удерживающий' : ''}):\n${outcome.outboundAnswer}`;
    if (outcome.withheld) {
      reply += `\n\n🔒 Черновик движка (клиент его не видит):\n${outcome.draftAnswer}`;
    }
    reply += `\n\n📊 confidence=${Math.round(result.confidence * 100)}% (${result.confidenceLevel}) · источник=${result.answerSource ?? '—'}`;

    if (similar) {
      reply += `\n\n👤 ПОХОЖИЙ ВОПРОС У ОПЕРАТОРА (сходство ${Math.round(similar.similarity * 100)}%):\n«${similar.question}»\n${similar.answer}`;
    } else {
      reply += `\n\n👤 Похожего прецедента в корпусе операторских ответов нет.`;
    }

    pendingByChatId.set(chatId, { question: text, botAnswer: outcome.outboundAnswer, awaitingCorrection: false });

    await sendTestMessage(chatId, reply, [
      { text: '👍 как оператор', callback_data: 'fb:helpful' },
      { text: '👎 хуже/неверно', callback_data: 'fb:incorrect' },
      { text: '✏️ дать правильный ответ', callback_data: 'fb:correct' },
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[telegram-test] webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}

async function handleCallback(cb: { id: string; from: { id: number }; message?: { chat: { id: number }; message_id: number }; data?: string }) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!chatId || !messageId || !cb.data) {
    await answerTestCallbackQuery(cb.id);
    return;
  }
  if (!isAllowed(cb.from.id)) {
    await answerTestCallbackQuery(cb.id, 'Нет доступа');
    return;
  }

  const pending = pendingByChatId.get(chatId);
  if (!pending) {
    await answerTestCallbackQuery(cb.id, 'Сессия истекла, задайте вопрос заново');
    return;
  }

  await editTestMessageReplyMarkup(chatId, messageId);

  if (cb.data === 'fb:helpful') {
    await prisma.answerFeedback.create({
      data: { question: pending.question, answer: pending.botAnswer, rating: 'HELPFUL' },
    });
    await answerTestCallbackQuery(cb.id, 'Записано 👍');
    pendingByChatId.delete(chatId);
  } else if (cb.data === 'fb:incorrect') {
    await prisma.answerFeedback.create({
      data: { question: pending.question, answer: pending.botAnswer, rating: 'INCORRECT' },
    });
    await answerTestCallbackQuery(cb.id, 'Записано 👎');
    pendingByChatId.delete(chatId);
  } else if (cb.data === 'fb:correct') {
    pendingByChatId.set(chatId, { ...pending, awaitingCorrection: true });
    await answerTestCallbackQuery(cb.id, 'Жду ваш вариант ответа следующим сообщением');
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    bot: process.env.TELEGRAM_TEST_BOT_TOKEN ? 'configured' : 'not configured',
    purpose: 'client-contour training sandbox',
  });
}
