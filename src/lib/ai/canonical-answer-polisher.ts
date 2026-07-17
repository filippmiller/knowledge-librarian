import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';

export interface PolishedCanonicalAnswer {
  polishedAnswer: string;
}

const POLISH_PROMPT = `Ты — вежливый сотрудник бюро переводов Аврора.

Тебе дали проверенный канонический ответ на вопрос клиента. Переформулируй его в профессиональное, клиентское сообщение:

- Начни с приветствия, например: "Здравствуйте!" или "Добрый день!"
- Сохрани ВЕСЬ смысл и все факты из исходного ответа. НЕ выдумывай новые данные.
- Перефразируй сухой текст в дружелюбную, но деловую речь.
- Используй короткие абзацы, читабельные предложения.
- В конце добавь доброжелательную фразу, например: "Будем рады помочь!", "Обращайтесь, если потребуется уточнение." или "Готовы ответить на дополнительные вопросы."
- НЕ используй Markdown-заголовки (#, ##), списки только если они реально улучшают читаемость.
- НЕ ссылайся на "базу знаний", "правила", "документы" или "Q&A".

Верни строго JSON:
{
  "polishedAnswer": "готовый профессиональный ответ клиенту"
}`;

export async function polishCanonicalAnswer(
  question: string,
  rawAnswer: string
): Promise<PolishedCanonicalAnswer> {
  const normalizedQuestion = question.trim();
  const normalizedAnswer = rawAnswer.trim();

  if (normalizedAnswer.length < 3) {
    throw new Error('Канонический ответ слишком короткий');
  }

  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: POLISH_PROMPT },
      {
        role: 'user',
        content: `ВОПРОС КЛИЕНТА:\n${normalizedQuestion}\n\nПРОВЕРЕННЫЙ ОТВЕТ:\n${normalizedAnswer}`,
      },
    ],
    responseFormat: 'json_object',
    temperature: 0.25,
    maxTokens: 2048,
  });

  const cleaned = normalizeJsonResponse(raw ?? '{}');
  const parsed = JSON.parse(cleaned) as { polishedAnswer?: unknown };

  const polishedAnswer =
    typeof parsed.polishedAnswer === 'string' ? parsed.polishedAnswer.trim() : '';

  if (polishedAnswer.length < 5) {
    throw new Error('ИИ не смог оформить ответ');
  }

  return { polishedAnswer };
}
