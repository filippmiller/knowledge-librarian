import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { openai } from '@/lib/openai';

export const runtime = 'nodejs';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm']);

export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();
  if (actor.role === 'VIEWER') {
    return NextResponse.json({ error: 'Недостаточно прав для обработки аудио' }, { status: 403 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: 'Сервис транскрипции не настроен' }, { status: 503 });
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Аудиофайл не передан' }, { status: 400 });
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return NextResponse.json({ error: 'Неподдерживаемый формат аудио' }, { status: 415 });
  }
  if (file.size === 0 || file.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'Размер аудио должен быть от 1 байта до 25 МБ' }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const safeFile = new File([bytes], file.name.slice(0, 180), { type: file.type || 'application/octet-stream' });
  const transcription = await openai.audio.transcriptions.create({
    file: safeFile,
    model: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    language: 'ru',
  });
  const transcript = transcription.text.trim();
  if (!transcript) {
    return NextResponse.json({ error: 'Речь не распознана' }, { status: 422 });
  }

  return NextResponse.json({
    transcript,
    sourceName: file.name.slice(0, 180),
    audioHash: createHash('sha256').update(bytes).digest('hex'),
    bytes: file.size,
    audioStored: false,
  });
}
