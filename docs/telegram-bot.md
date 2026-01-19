# Telegram Bot Integration

This document describes how to set up and configure a Telegram bot for the AI Knowledge Librarian.

## Overview

The Telegram bot allows users to query the knowledge base directly from Telegram.
Messages are forwarded to the `/api/ask` endpoint, and answers are returned to the user.

## Setup Instructions

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow the prompts:
   - Choose a name for your bot (e.g., "Translation Bureau Assistant")
   - Choose a username (must end with `bot`, e.g., `translation_bureau_bot`)
4. BotFather will give you a token like: `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`
5. Save this token securely

### 2. Configure Environment Variables

Add these variables to your Railway project:

```
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
NEXT_PUBLIC_APP_URL=https://your-app.up.railway.app
```

### 3. Set Up Webhook

After deployment, set the webhook URL by visiting:

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://your-app.up.railway.app/api/telegram
```

Or using curl:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
     -d "url=https://your-app.up.railway.app/api/telegram"
```

## API Implementation

Create the file `src/app/api/telegram/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { answerQuestion } from '@/lib/ai/answering-engine';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name: string; id: number };
  };
}

async function sendMessage(chatId: number, text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
}

export async function POST(request: NextRequest) {
  try {
    const update: TelegramUpdate = await request.json();

    if (!update.message?.text) {
      return NextResponse.json({ ok: true });
    }

    const chatId = update.message.chat.id;
    const question = update.message.text;

    // Handle /start command
    if (question === '/start') {
      await sendMessage(
        chatId,
        'Welcome to the Knowledge Librarian Bot!\n\n' +
        'Ask me any question about translation bureau operations, ' +
        'pricing, notary services, and more.\n\n' +
        'Just type your question and I will answer based on our knowledge base.'
      );
      return NextResponse.json({ ok: true });
    }

    // Process the question
    const result = await answerQuestion(question);

    // Format response
    let response = result.answer;

    if (result.citations.length > 0) {
      response += '\n\n*Sources:*';
      for (const citation of result.citations.slice(0, 3)) {
        if (citation.ruleCode) {
          response += `\n- ${citation.ruleCode}`;
        }
      }
    }

    response += `\n\n_Confidence: ${(result.confidence * 100).toFixed(0)}%_`;

    await sendMessage(chatId, response);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram
  }
}
```

## Message Flow

```
User Message → Telegram Servers → Webhook → /api/telegram
                                              ↓
                                         answerQuestion()
                                              ↓
                                         sendMessage()
                                              ↓
                                    Telegram Servers → User
```

## Admin Commands (Optional)

You can extend the bot to support admin commands:

- `/stats` - Show knowledge base statistics
- `/domains` - List available domains
- `/recent` - Show recent Q&A activity

To implement, add command handlers in the webhook route:

```typescript
if (question.startsWith('/stats')) {
  // Fetch and return stats
}
```

## Security Considerations

1. **Webhook Validation**: Telegram sends a secret token in the header.
   You can verify this for additional security.

2. **Rate Limiting**: Consider implementing rate limiting to prevent abuse.

3. **User Whitelist**: For internal use, maintain a list of allowed Telegram user IDs.

## Testing

1. Find your bot in Telegram by searching for its username
2. Send `/start` to begin
3. Ask a question like "Сколько стоит НЗП?"
4. Verify you receive a proper answer with citations

## Troubleshooting

### Bot not responding

1. Check webhook is set:
   ```
   https://api.telegram.org/bot<TOKEN>/getWebhookInfo
   ```

2. Check Railway logs for errors

3. Verify environment variables are set correctly

### Slow responses

- The AI takes a few seconds to process questions
- Consider sending a "typing" indicator:
  ```typescript
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
    method: 'POST',
    body: JSON.stringify({ chat_id: chatId, action: 'typing' })
  });
  ```

## Example Payloads

### Incoming webhook (from Telegram):

```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 1,
    "from": {
      "id": 123456789,
      "first_name": "John",
      "username": "johndoe"
    },
    "chat": {
      "id": 123456789,
      "first_name": "John",
      "type": "private"
    },
    "date": 1234567890,
    "text": "Сколько стоит НЗП?"
  }
}
```

### Response to user:

```
НЗП стоит 750 рублей за документ.

*Sources:*
- R-1

_Confidence: 88%_
```
