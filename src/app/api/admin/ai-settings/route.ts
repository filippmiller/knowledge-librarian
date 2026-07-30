import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
import { encrypt, decrypt, maskApiKey } from '@/lib/crypto';
import { DEFAULT_MIN_CONFIDENCE } from '@/lib/telegram/constants';

// GET - получить текущие настройки (без полного ключа)
export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const settings = await prisma.aISettings.findFirst({
      where: { isActive: true },
    });

    if (!settings) {
      return NextResponse.json({
        provider: 'openai',
        hasApiKey: false,
        maskedApiKey: null,
        model: 'gpt-4o',
        embeddingModel: 'text-embedding-3-small',
        lastVerified: null,
        lastError: null,
        isActive: false,
        autoAnswerEnabled: false,
        autoAnswerMinConfidence: DEFAULT_MIN_CONFIDENCE,
      });
    }

    // Decrypt and mask the API key
    let maskedApiKey = null;
    if (settings.apiKey) {
      try {
        maskedApiKey = maskApiKey(decrypt(settings.apiKey));
      } catch {
        maskedApiKey = 'Ошибка расшифровки';
      }
    }

    return NextResponse.json({
      id: settings.id,
      provider: settings.provider,
      hasApiKey: Boolean(settings.apiKey),
      maskedApiKey,
      model: settings.model,
      embeddingModel: settings.embeddingModel,
      lastVerified: settings.lastVerified,
      lastError: settings.lastError,
      isActive: settings.isActive,
      autoAnswerEnabled: settings.autoAnswerEnabled,
      autoAnswerMinConfidence: settings.autoAnswerMinConfidence,
    });
  } catch (error) {
    console.error('Error fetching AI settings:', error);
    return NextResponse.json(
      { error: 'Не удалось получить настройки ИИ' },
      { status: 500 }
    );
  }
}

// POST - создать или обновить настройки
export async function POST(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { apiKey, model, embeddingModel, autoAnswerEnabled, autoAnswerMinConfidence } = body;

    // Validate API key format
    if (apiKey && !apiKey.startsWith('sk-')) {
      return NextResponse.json(
        { error: 'Некорректный формат API ключа. Ключ должен начинаться с "sk-"' },
        { status: 400 }
      );
    }

    // Find existing settings
    const existing = await prisma.aISettings.findFirst({
      where: { isActive: true },
    });

    const encryptedKey = apiKey ? encrypt(apiKey) : undefined;

    const autoAnswerData: Record<string, unknown> = {};
    if (typeof autoAnswerEnabled === 'boolean') {
      autoAnswerData.autoAnswerEnabled = autoAnswerEnabled;
    }
    if (typeof autoAnswerMinConfidence === 'number') {
      autoAnswerData.autoAnswerMinConfidence = Math.max(0, Math.min(1, autoAnswerMinConfidence));
    }

    if (existing) {
      // Update existing settings
      const updated = await prisma.aISettings.update({
        where: { id: existing.id },
        data: {
          ...(encryptedKey && { apiKey: encryptedKey }),
          ...(model && { model }),
          ...(embeddingModel && { embeddingModel }),
          ...autoAnswerData,
          lastError: null,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Настройки обновлены',
        id: updated.id,
      });
    } else {
      // Create new settings. The API key is optional here — the runtime reads
      // it from env, and requiring it would make the auto-answer toggle
      // unsaveable until someone pastes a key, silently keeping the bot mute.
      const created = await prisma.aISettings.create({
        data: {
          provider: 'openai',
          apiKey: encryptedKey ?? null,
          model: model || 'gpt-4o',
          embeddingModel: embeddingModel || 'text-embedding-3-small',
          isActive: true,
          ...(typeof autoAnswerEnabled === 'boolean' && { autoAnswerEnabled }),
          ...(typeof autoAnswerMinConfidence === 'number' && {
            autoAnswerMinConfidence: Math.max(0, Math.min(1, autoAnswerMinConfidence)),
          }),
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Настройки созданы',
        id: created.id,
      });
    }
  } catch (error) {
    console.error('Error saving AI settings:', error);
    return NextResponse.json(
      { error: 'Не удалось сохранить настройки' },
      { status: 500 }
    );
  }
}
