import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';

export interface PolishedVoiceAnswer {
  polishedAnswer: string;
  note: string | null;
}

const POLISH_PROMPT = `Ты — редактор ответов службы поддержки бюро переводов Аврора.

Оператор надиктовал СУТЬ правильного ответа на вопрос клиента. Твоя задача — превратить эту суть в вежливый, грамотный и законченный ответ на русском языке.

Жёсткие правила:
1. НЕ выдумывай факты, цены, сроки, адреса, телефоны и графики, которых не было в сути оператора.
2. НЕ добавляй Markdown-заголовки (##, **), списки только если они реально улучшают читаемость.
3. Сохрани весь смысл, который дал оператор. Не сокращай важные условия.
4. Отвечай от имени бюро: «мы», «наше бюро», но не используй имена сотрудников.
5. Если суть содержит конкретные числа — оставь их точно такими же.
6. Если вопрос требует уточнения, вежливо попроси нужные детали.
7. Ответ должен звучать как готовое сообщение клиенту, а не как внутренняя инструкция.

Верни строго JSON:
{
  "polishedAnswer": "готовый красивый ответ клиенту",
  "note": "краткая примечание редактора, если есть риск недосказанности или нужно уточнение; иначе null"
}`;

export async function polishVoiceAnswer(
  question: string,
  rawTranscript: string
): Promise<PolishedVoiceAnswer> {
  const normalizedQuestion = question.trim();
  const normalizedTranscript = rawTranscript.trim();

  if (normalizedTranscript.length < 3) {
    throw new Error('Расшифровка слишком короткая');
  }

  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: POLISH_PROMPT },
      {
        role: 'user',
        content: `ВОПРОС КЛИЕНТА:\n${normalizedQuestion}\n\nСУТЬ ОТВЕТА ОПЕРАТОРА:\n${normalizedTranscript}`,
      },
    ],
    responseFormat: 'json_object',
    temperature: 0.2,
    maxTokens: 2048,
  });

  const cleaned = normalizeJsonResponse(raw ?? '{}');
  const parsed = JSON.parse(cleaned) as {
    polishedAnswer?: unknown;
    note?: unknown;
  };

  const polishedAnswer =
    typeof parsed.polishedAnswer === 'string' ? parsed.polishedAnswer.trim() : '';
  const note =
    typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : null;

  if (polishedAnswer.length < 5) {
    throw new Error('ИИ не смог составить ответ из расшифровки');
  }

  return { polishedAnswer, note };
}
