import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
import { encrypt, decrypt, maskApiKey } from '@/lib/crypto';
import OpenAI from 'openai';

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
      });
    }

    // Decrypt and mask the API key
    let maskedApiKey = null;
    try {
      const decryptedKey = decrypt(settings.apiKey);
      maskedApiKey = maskApiKey(decryptedKey);
    } catch {
      maskedApiKey = 'Ошибка расшифровки';
    }

    return NextResponse.json({
      id: settings.id,
      provider: settings.provider,
      hasApiKey: true,
      maskedApiKey,
      model: settings.model,
      embeddingModel: settings.embeddingModel,
      lastVerified: settings.lastVerified,
      lastError: settings.lastError,
      isActive: settings.isActive,
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
    const { apiKey, model, embeddingModel } = body;

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

    if (existing) {
      // Update existing settings
      const updated = await prisma.aISettings.update({
        where: { id: existing.id },
        data: {
          ...(encryptedKey && { apiKey: encryptedKey }),
          ...(model && { model }),
          ...(embeddingModel && { embeddingModel }),
          lastError: null,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Настройки обновлены',
        id: updated.id,
      });
    } else {
      // Create new settings
      if (!apiKey) {
        return NextResponse.json(
          { error: 'API ключ обязателен для создания настроек' },
          { status: 400 }
        );
      }

      const created = await prisma.aISettings.create({
        data: {
          provider: 'openai',
          apiKey: encryptedKey!,
          model: model || 'gpt-4o',
          embeddingModel: embeddingModel || 'text-embedding-3-small',
          isActive: true,
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
