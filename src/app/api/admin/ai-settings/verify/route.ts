import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
import { decrypt } from '@/lib/crypto';
import OpenAI from 'openai';

// POST - проверить работоспособность API ключа
export async function POST(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    // Get current settings
    const settings = await prisma.aISettings.findFirst({
      where: { isActive: true },
    });

    if (!settings) {
      return NextResponse.json(
        { error: 'Настройки ИИ не найдены. Сначала сохраните API ключ.' },
        { status: 404 }
      );
    }

    // Decrypt the API key
    let apiKey: string;
    try {
      apiKey = decrypt(settings.apiKey);
    } catch {
      return NextResponse.json(
        { error: 'Не удалось расшифровать API ключ. Попробуйте сохранить ключ заново.' },
        { status: 500 }
      );
    }

    // Test the API key by making a simple request
    const openai = new OpenAI({ apiKey });

    try {
      // Make a minimal API call to verify the key works
      await openai.models.list();

      // Update lastVerified
      await prisma.aISettings.update({
        where: { id: settings.id },
        data: {
          lastVerified: new Date(),
          lastError: null,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'API ключ действителен',
        lastVerified: new Date(),
      });
    } catch (openaiError: unknown) {
      const errorMessage =
        openaiError instanceof Error ? openaiError.message : 'Неизвестная ошибка';

      // Update lastError
      await prisma.aISettings.update({
        where: { id: settings.id },
        data: {
          lastError: errorMessage,
        },
      });

      return NextResponse.json(
        {
          success: false,
          error: 'API ключ недействителен или возникла ошибка при проверке',
          details: errorMessage,
        },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Error verifying AI settings:', error);
    return NextResponse.json(
      { error: 'Не удалось проверить настройки' },
      { status: 500 }
    );
  }
}
