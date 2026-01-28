import { NextRequest, NextResponse } from 'next/server';
import { createChatCompletion } from '@/lib/ai/chat-provider';
import { generateEmbedding } from '@/lib/openai';

export const dynamic = 'force-dynamic';

/**
 * Health check endpoint for AI providers
 * Tests both Anthropic (chat) and OpenAI (embeddings)
 */
export async function GET(request: NextRequest) {
  const results: {
    anthropic?: { status: string; error?: string; model?: string };
    openai?: { status: string; error?: string; model?: string };
    overall: string;
  } = {
    overall: 'unhealthy',
  };

  // Test Anthropic/OpenAI chat completion
  try {
    const provider = process.env.AI_PROVIDER || 'openai';
    const model =
      provider === 'anthropic'
        ? process.env.ANTHROPIC_MODEL || 'claude-3-opus-20240229'
        : process.env.OPENAI_CHAT_MODEL || 'gpt-4o';

    const response = await createChatCompletion({
      messages: [
        { role: 'user', content: 'Respond with only the word: OK' },
      ],
      temperature: 0,
      maxTokens: 10,
    });

    if (response && response.trim().length > 0) {
      if (provider === 'anthropic') {
        results.anthropic = {
          status: 'healthy',
          model: model,
        };
      } else {
        results.openai = {
          status: 'healthy',
          model: model,
        };
      }
    } else {
      if (provider === 'anthropic') {
        results.anthropic = {
          status: 'unhealthy',
          error: 'Empty response from provider',
          model: model,
        };
      } else {
        results.openai = {
          status: 'unhealthy',
          error: 'Empty response from provider',
          model: model,
        };
      }
    }
  } catch (error) {
    const provider = process.env.AI_PROVIDER || 'openai';
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (provider === 'anthropic') {
      results.anthropic = {
        status: 'unhealthy',
        error: errorMessage,
        model: process.env.ANTHROPIC_MODEL,
      };
    } else {
      results.openai = {
        status: 'unhealthy',
        error: errorMessage,
        model: process.env.OPENAI_CHAT_MODEL,
      };
    }
  }

  // Test OpenAI embeddings (always uses OpenAI)
  try {
    const embedding = await generateEmbedding('test');
    if (embedding && embedding.length > 0) {
      results.openai = {
        ...results.openai,
        status: 'healthy',
        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      };
    } else {
      results.openai = {
        ...results.openai,
        status: 'unhealthy',
        error: 'Empty embedding response',
        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    results.openai = {
      ...results.openai,
      status: 'unhealthy',
      error: errorMessage,
      model: process.env.OPENAI_EMBEDDING_MODEL,
    };
  }

  // Determine overall health
  const allHealthy =
    (!results.anthropic || results.anthropic.status === 'healthy') &&
    (!results.openai || results.openai.status === 'healthy');

  results.overall = allHealthy ? 'healthy' : 'unhealthy';

  const statusCode = results.overall === 'healthy' ? 200 : 503;

  return NextResponse.json(results, { status: statusCode });
}
