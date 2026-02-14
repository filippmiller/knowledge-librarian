import { openai } from '@/lib/openai';
import { downloadFile, sendMessage, sendTypingIndicator } from './telegram-api';
import type { TelegramMessage } from './telegram-api';
import type { TelegramUserInfo } from './access-control';
import { isAdmin } from './access-control';
import { addKnowledge, correctKnowledge } from './knowledge-manager';
import { answerQuestionEnhanced } from '@/lib/ai/enhanced-answering-engine';
import { getOrCreateSession, saveChatMessage } from '@/lib/ai/answering-engine';
import { formatAnswerResponse } from './commands';

// Keywords that signal "add new knowledge"
const ADD_KEYWORDS = /^(добавь|добавить|запомни|запиши|сохрани|новое правило|добавить правило)/i;

// Keywords that signal "correct/change existing knowledge"
const CORRECT_KEYWORDS = /^(поменяй|поменять|измени|изменить|исправь|исправить|обнови|обновить|замени|заменить|теперь|стоимость .* теперь|цена .* теперь)/i;

/**
 * Handle incoming voice messages.
 * Transcribes via Whisper, then routes the text as a command or question.
 */
export async function handleVoiceMessage(
  message: TelegramMessage,
  user: TelegramUserInfo
): Promise<void> {
  const chatId = message.chat.id;

  if (!message.voice) return;

  await sendTypingIndicator(chatId);

  try {
    // Download voice file from Telegram
    const { buffer } = await downloadFile(message.voice.file_id);

    // Transcribe with OpenAI Whisper
    const blob = new Blob([new Uint8Array(buffer)], { type: 'audio/ogg' });
    const file = new File([blob], 'voice.ogg', { type: 'audio/ogg' });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'ru',
    });

    const text = transcription.text.trim();

    if (!text) {
      await sendMessage(chatId, 'Не удалось распознать речь. Попробуйте ещё раз.');
      return;
    }

    // Notify what was transcribed
    await sendMessage(chatId, `Распознано: "${text}"\n\nОбрабатываю...`);

    if (isAdmin(user.role)) {
      // Check for correction/change keywords first (more specific)
      if (CORRECT_KEYWORDS.test(text)) {
        await sendTypingIndicator(chatId);
        const result = await correctKnowledge(text, user.telegramId);
        await sendMessage(chatId, `Голосовая команда обработана.\n\n${result.summary}`);
        return;
      }

      // Check for add keywords
      if (ADD_KEYWORDS.test(text)) {
        await sendTypingIndicator(chatId);
        const knowledgeText = text.replace(ADD_KEYWORDS, '').trim() || text;
        const result = await addKnowledge(knowledgeText, user.telegramId);
        await sendMessage(chatId, `Голосовая заметка обработана.\n\n${result.summary}`);
        return;
      }
    }

    // Default: treat as a question
    await sendTypingIndicator(chatId);

    const session = await getOrCreateSession('TELEGRAM', user.telegramId);
    await saveChatMessage(session.id, 'USER', text);

    const result = await answerQuestionEnhanced(text, session.id);

    await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
    });

    const response = formatAnswerResponse(result);
    await sendMessage(chatId, response);
  } catch (error) {
    console.error('[voice-handler] Error:', error);
    await sendMessage(chatId, 'Ошибка при обработке голосового сообщения. Попробуйте позже.');
  }
}
