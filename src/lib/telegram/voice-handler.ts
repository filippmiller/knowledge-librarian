import { openai } from '@/lib/openai';
import { downloadFile, sendMessage, sendTypingIndicator } from './telegram-api';
import type { TelegramMessage } from './telegram-api';
import type { TelegramUserInfo } from './access-control';
import { isAdmin } from './access-control';
import { addKnowledge } from './knowledge-manager';
import { answerQuestionEnhanced } from '@/lib/ai/enhanced-answering-engine';
import { getOrCreateSession, saveChatMessage } from '@/lib/ai/answering-engine';
import { formatAnswerResponse } from './commands';

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

    // Route based on content
    const lowerText = text.toLowerCase();

    if (isAdmin(user.role)) {
      // If text starts with known command keywords, route to knowledge
      if (lowerText.startsWith('добавь') || lowerText.startsWith('добавить') || lowerText.startsWith('запомни')) {
        const knowledgeText = text.replace(/^(добавь|добавить|запомни)\s*/i, '');
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
