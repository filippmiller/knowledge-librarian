'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  Mic,
  Sparkles,
  UploadCloud,
  Volume2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface VoiceAnswerCaptureProps {
  question: string;
  caseId?: string | null;
  onSaved?: (qaPairId: string) => void;
}

function duration(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function VoiceAnswerCapture({ question, caseId, onSaved }: VoiceAnswerCaptureProps) {
  const [open, setOpen] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [rawTranscript, setRawTranscript] = useState('');
  const [polishedAnswer, setPolishedAnswer] = useState('');
  const [processing, setProcessing] = useState<'transcribe' | 'polish' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ qaPairId: string; reused: boolean } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, [audioUrl]);

  const currentContext = `${caseId ?? 'custom'}:${question.trim()}`;
  const [extractionContext, setExtractionContext] = useState('');
  const contextChanged = Boolean(extractionContext && extractionContext !== currentContext);

  function reset() {
    setSaved(null);
    setError(null);
    setRawTranscript('');
    setPolishedAnswer('');
    setExtractionContext('');
  }

  function acceptAudio(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      setError('Файл превышает 25 МБ');
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(file);
    setAudioUrl(URL.createObjectURL(file));
    reset();
  }

  async function startRecording() {
    setError(null);
    setOpen(true);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Запись с микрофона не поддерживается этим браузером');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        acceptAudio(new File([blob], `bot-answer-${Date.now()}.webm`, { type: blob.type }));
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start(500);
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    } catch {
      setError('Не удалось получить доступ к микрофону');
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  async function transcribe() {
    if (!audioFile || processing) return;
    setProcessing('transcribe');
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', audioFile);
      const response = await fetch('/api/admin/voice-training/transcribe', { method: 'POST', body: formData });
      const data = await response.json() as { transcript?: string; error?: string };
      if (!response.ok || !data.transcript) throw new Error(data.error || 'Не удалось распознать речь');
      setRawTranscript(data.transcript);
      setPolishedAnswer('');
      setExtractionContext('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось распознать речь');
    } finally {
      setProcessing(null);
    }
  }

  async function polish() {
    if (rawTranscript.trim().length < 5 || processing) return;
    setProcessing('polish');
    setError(null);
    try {
      const response = await fetch('/api/admin/bot-lab/voice-answers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), rawTranscript: rawTranscript.trim() }),
      });
      const data = await response.json() as { polishedAnswer?: string; note?: string; error?: string };
      if (!response.ok || !data.polishedAnswer) throw new Error(data.error || 'Не удалось отполировать ответ');
      setPolishedAnswer(data.polishedAnswer);
      setExtractionContext(currentContext);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отполировать ответ');
    } finally {
      setProcessing(null);
    }
  }

  async function save() {
    if (!question.trim() || !rawTranscript.trim() || !polishedAnswer.trim() || processing || contextChanged) return;
    setProcessing('save');
    setError(null);
    try {
      const response = await fetch('/api/admin/bot-lab/voice-answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: caseId || undefined,
          question: question.trim(),
          rawTranscript: rawTranscript.trim(),
          polishedAnswer: polishedAnswer.trim(),
        }),
      });
      const data = await response.json() as { qaPairId?: string; reused?: boolean; error?: string };
      if (!response.ok || !data.qaPairId) throw new Error(data.error || 'Не удалось сохранить ответ');
      setSaved({ qaPairId: data.qaPairId, reused: Boolean(data.reused) });
      onSaved?.(data.qaPairId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить ответ');
    } finally {
      setProcessing(null);
    }
  }

  const canSave = Boolean(
    question.trim() && rawTranscript.trim().length >= 5 && polishedAnswer.trim().length >= 10 && !contextChanged
  );

  return (
    <Card className="overflow-hidden rounded-3xl border-emerald-200/80 bg-white/85 py-0 shadow-sm">
      <CardHeader className="border-b border-emerald-100 bg-gradient-to-r from-slate-950 to-emerald-950 px-4 py-4 text-white">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-emerald-400/15 text-emerald-200"><Mic className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><CardTitle className="text-sm text-white">Надиктовать правильный ответ</CardTitle><Badge className="bg-emerald-400/15 text-[9px] text-emerald-100">CANONICAL</Badge></div>
            <p className="mt-1 line-clamp-1 text-[11px] text-slate-400">Контекст: {question.trim() || 'сначала введите вопрос клиента'}</p>
          </div>
          {recording ? (
            <Button onClick={stopRecording} size="sm" className="rounded-full bg-rose-600 text-white hover:bg-rose-700"><CircleStop /> Стоп · {duration(seconds)}</Button>
          ) : (
            <Button onClick={startRecording} disabled={!question.trim()} size="sm" className="rounded-full bg-emerald-600 text-white hover:bg-emerald-500"><Mic /> Надиктовать</Button>
          )}
          <Button type="button" variant="ghost" size="icon" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={open ? 'Свернуть форму' : 'Развернуть форму'} className="rounded-full text-slate-300 hover:bg-white/10 hover:text-white">
            <span className={cn('transition-transform inline-block', open && 'rotate-180')}>▼</span>
          </Button>
        </div>
      </CardHeader>

      {open ? (
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
            <div className="space-y-2">
              <Textarea
                value={rawTranscript}
                onChange={(event) => { setRawTranscript(event.target.value); setSaved(null); }}
                placeholder="Надиктуйте или напишите суть правильного ответа…"
                className="min-h-24 rounded-2xl bg-slate-50 text-sm leading-6"
                aria-label="Сырой ответ оператора"
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
                  <UploadCloud className="size-3.5" /> Загрузить аудио
                  <input type="file" accept="audio/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm,.flac" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) { acceptAudio(file); setOpen(true); } event.target.value = ''; }} />
                </label>
                {audioUrl ? <audio controls src={audioUrl} className="h-8 min-w-44 flex-1" /> : null}
              </div>
            </div>
            <div className="grid content-start gap-2">
              <Button onClick={transcribe} disabled={!audioFile || processing !== null} size="sm" variant="outline" className="rounded-xl bg-white">{processing === 'transcribe' ? <LoaderCircle className="animate-spin" /> : <Volume2 />} Расшифровать</Button>
              <Button onClick={polish} disabled={rawTranscript.trim().length < 5 || processing !== null} size="sm" className="rounded-xl bg-emerald-700 text-white hover:bg-emerald-800">{processing === 'polish' ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Отполировать ИИ</Button>
              <p className="text-[10px] leading-4 text-slate-500">ИИ превратит суть в готовый ответ клиенту. Вы сможете его отредактировать.</p>
            </div>
          </div>

          {polishedAnswer ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">Отполированный ответ (можно редактировать)</label>
              <Textarea
                value={polishedAnswer}
                onChange={(event) => { setPolishedAnswer(event.target.value); setSaved(null); }}
                className="min-h-32 rounded-2xl bg-white text-sm leading-6"
                aria-label="Отполированный ответ"
              />
            </div>
          ) : null}

          {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div> : null}
          {contextChanged ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"><AlertTriangle className="mr-1 inline size-3.5" />Вопрос изменился после полировки. Отполируйте заново, чтобы не привязать ответ к неверному контексту.</div> : null}

          {saved ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-950">
              <div className="mb-1 flex items-center gap-1.5 font-semibold"><CheckCircle2 className="size-3.5" /> Сохранено как канонический ответ</div>
              <div>ID пары: <span className="font-mono text-emerald-700">{saved.qaPairId}</span>{saved.reused ? ' (уже существовала)' : ''}</div>
            </div>
          ) : (
            <Button onClick={save} disabled={!canSave || processing === 'save'} size="sm" className="rounded-full bg-slate-950 text-white hover:bg-slate-800">
              {processing === 'save' ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />} Сохранить эталонный ответ
            </Button>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
