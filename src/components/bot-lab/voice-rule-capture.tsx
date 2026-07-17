'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type RuleType = 'capability' | 'procedure' | 'requirement' | 'price' | 'deadline' | 'prohibition' | 'exception' | 'escalation';
type RulePriority = 'PRIMARY' | 'HIGH' | 'NORMAL';

interface CandidateRule {
  clientId: string;
  selected: boolean;
  title: string;
  body: string;
  sourceQuote: string;
  type: RuleType;
  scope: string;
  conditions: string[];
  priority: RulePriority;
  requiresLiveData: boolean;
  extractionConfidence: number;
  tags: string[];
}

interface PublishedRule { id: string; ruleCode: string; title: string; reused: boolean }

interface VoiceRuleCaptureProps {
  question: string;
  caseId?: string | null;
  initialOpen?: boolean;
}

const typeLabels: Record<RuleType, string> = {
  capability: 'Возможность', procedure: 'Процедура', requirement: 'Требование', price: 'Цена',
  deadline: 'Срок', prohibition: 'Запрет', exception: 'Исключение', escalation: 'Эскалация',
};

function duration(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function VoiceRuleCapture({ question, caseId, initialOpen = false }: VoiceRuleCaptureProps) {
  const [open, setOpen] = useState(initialOpen);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [audioHash, setAudioHash] = useState('');
  const [rules, setRules] = useState<CandidateRule[]>([]);
  const [uncertainties, setUncertainties] = useState<string[]>([]);
  const [processing, setProcessing] = useState<'transcribe' | 'extract' | 'approve' | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [published, setPublished] = useState<PublishedRule[]>([]);
  const [extractionContext, setExtractionContext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, [audioUrl]);

  const selectedRules = useMemo(() => rules.filter((rule) => rule.selected), [rules]);
  const currentContext = `${caseId ?? 'custom'}:${question.trim()}`;
  const contextChanged = Boolean(extractionContext && extractionContext !== currentContext);

  function resetReview() {
    setReviewConfirmed(false);
    setPublished([]);
  }

  function resetExtraction() {
    setRules([]);
    setUncertainties([]);
    setExtractionContext('');
    resetReview();
  }

  function acceptAudio(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      setError('Файл превышает 25 МБ');
      return;
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(file);
    setAudioUrl(URL.createObjectURL(file));
    setSourceName(file.name);
    setTranscript('');
    resetExtraction();
    setError(null);
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
        acceptAudio(new File([blob], `bot-lab-rule-${Date.now()}.webm`, { type: blob.type }));
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
      const data = await response.json() as { transcript?: string; sourceName?: string; audioHash?: string; error?: string };
      if (!response.ok || !data.transcript) throw new Error(data.error || 'Не удалось распознать речь');
      setTranscript(data.transcript);
      setSourceName(data.sourceName || audioFile.name);
      setAudioHash(data.audioHash || '');
      resetExtraction();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось распознать речь');
    } finally {
      setProcessing(null);
    }
  }

  async function extract() {
    if (transcript.trim().length < 10 || processing) return;
    setProcessing('extract');
    setError(null);
    try {
      const response = await fetch('/api/admin/voice-training/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcript.trim(), questionContext: question.trim() }),
      });
      const data = await response.json() as { rules?: Omit<CandidateRule, 'clientId' | 'selected'>[]; uncertainties?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error || 'Не удалось извлечь правила');
      setRules((data.rules || []).map((rule, index) => ({ ...rule, clientId: `lab-rule-${Date.now()}-${index}`, selected: true })));
      setUncertainties(data.uncertainties || []);
      setExtractionContext(currentContext);
      resetReview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось извлечь правила');
    } finally {
      setProcessing(null);
    }
  }

  function updateRule(clientId: string, patch: Partial<CandidateRule>) {
    setRules((current) => current.map((rule) => rule.clientId === clientId ? { ...rule, ...patch } : rule));
    resetReview();
  }

  async function approve() {
    if (!selectedRules.length || !reviewConfirmed || processing || contextChanged) return;
    setProcessing('approve');
    setError(null);
    try {
      const response = await fetch('/api/admin/voice-training/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rules: selectedRules,
          sourceName: sourceName || 'Bot Decision Lab',
          audioHash,
          reviewConfirmed,
          acknowledgedUncertainties: uncertainties,
          originQuestion: question.trim(),
          evalCaseId: caseId || undefined,
        }),
      });
      const data = await response.json() as { rules?: PublishedRule[]; error?: string };
      if (!response.ok || !data.rules) throw new Error(data.error || 'Не удалось опубликовать правила');
      setPublished(data.rules);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось опубликовать правила');
    } finally {
      setProcessing(null);
    }
  }

  return (
    <Card className="overflow-hidden rounded-3xl border-violet-200/80 bg-white/85 py-0 shadow-sm">
      <CardHeader className="border-b border-violet-100 bg-gradient-to-r from-slate-950 to-violet-950 px-4 py-4 text-white">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-violet-400/15 text-violet-200"><Mic className="size-4" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><CardTitle className="text-sm text-white">Создать правило из вопроса</CardTitle><Badge className="bg-violet-400/15 text-[9px] text-violet-100">VOICE_AUTHORITY</Badge></div>
            <p className="mt-1 line-clamp-1 text-[11px] text-slate-400">Контекст: {question.trim() || 'сначала введите вопрос клиента'}</p>
          </div>
          {recording ? (
            <Button onClick={stopRecording} size="sm" className="rounded-full bg-rose-600 text-white hover:bg-rose-700"><CircleStop /> Стоп · {duration(seconds)}</Button>
          ) : (
            <Button onClick={startRecording} disabled={!question.trim()} size="sm" className="rounded-full bg-violet-600 text-white hover:bg-violet-500"><Mic /> Надиктовать правило</Button>
          )}
          <Button type="button" variant="ghost" size="icon" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={open ? 'Свернуть форму правила' : 'Развернуть форму правила'} className="rounded-full text-slate-300 hover:bg-white/10 hover:text-white"><ChevronDown className={cn('transition-transform', open && 'rotate-180')} /></Button>
        </div>
      </CardHeader>

      {open ? (
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
            <div>
              <Textarea value={transcript} onChange={(event) => { setTranscript(event.target.value); resetExtraction(); }} placeholder="Надиктуйте или напишите правильное правило для этого вопроса…" className="min-h-24 rounded-2xl bg-slate-50 text-sm leading-6" />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-700 hover:bg-slate-50"><UploadCloud className="size-3.5" /> Загрузить аудио<Input type="file" accept="audio/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm,.flac" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) { acceptAudio(file); setOpen(true); } event.target.value = ''; }} /></label>
                {audioUrl ? <audio controls src={audioUrl} className="h-8 min-w-44 flex-1" /> : null}
              </div>
            </div>
            <div className="grid content-start gap-2">
              <Button onClick={transcribe} disabled={!audioFile || processing !== null} size="sm" variant="outline" className="rounded-xl bg-white">{processing === 'transcribe' ? <LoaderCircle className="animate-spin" /> : <Volume2 />} Расшифровать</Button>
              <Button onClick={extract} disabled={transcript.trim().length < 10 || processing !== null} size="sm" className="rounded-xl bg-violet-700 text-white hover:bg-violet-800">{processing === 'extract' ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Выделить правила</Button>
              <p className="text-[10px] leading-4 text-slate-500">Вопрос задаёт scope. Источником правила остаются только слова оператора.</p>
            </div>
          </div>

          {error ? <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</div> : null}
          {uncertainties.length ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"><AlertTriangle className="mr-1 inline size-3.5" />Нужно проверить: {uncertainties.join(' · ')}</div> : null}
          {contextChanged ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"><AlertTriangle className="mr-1 inline size-3.5" />Вопрос изменился после извлечения. Извлеките правила заново, чтобы не привязать их к неверному контексту.</div> : null}

          {rules.length ? (
            <div className="space-y-2">
              {rules.map((rule, index) => (
                <article key={rule.clientId} className={cn('rounded-2xl border p-3', rule.selected ? 'border-violet-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-60')}>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={rule.selected} onChange={(event) => updateRule(rule.clientId, { selected: event.target.checked })} className="size-4 accent-violet-600" aria-label={`Выбрать правило ${index + 1}`} />
                    <Input value={rule.title} onChange={(event) => updateRule(rule.clientId, { title: event.target.value })} className="h-8 min-w-0 flex-1 border-0 px-1 text-sm font-semibold shadow-none" aria-label={`Заголовок правила ${index + 1}`} />
                    <Badge variant="outline" className="text-[9px]">{typeLabels[rule.type]}</Badge>
                    <Badge className={cn('text-[9px]', rule.priority === 'PRIMARY' ? 'bg-violet-700 text-white' : 'bg-slate-100 text-slate-700')}>{rule.priority}</Badge>
                  </div>
                  <Textarea value={rule.body} onChange={(event) => updateRule(rule.clientId, { body: event.target.value })} className="mt-2 min-h-16 rounded-xl bg-slate-50 text-xs leading-5" aria-label={`Текст правила ${index + 1}`} />
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-[10px] font-medium text-violet-700">Scope, условия и цитата</summary>
                    <div className="mt-2 grid gap-2 border-t border-slate-100 pt-2 sm:grid-cols-2">
                      <Input value={rule.scope} onChange={(event) => updateRule(rule.clientId, { scope: event.target.value })} className="h-8 text-[11px]" aria-label={`Область правила ${index + 1}`} />
                      <select value={rule.priority} onChange={(event) => updateRule(rule.clientId, { priority: event.target.value as RulePriority })} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-[11px]" aria-label={`Приоритет правила ${index + 1}`}><option value="PRIMARY">Первоочередное</option><option value="HIGH">Высокое</option><option value="NORMAL">Обычное</option></select>
                      <Textarea value={rule.conditions.join('\n')} onChange={(event) => updateRule(rule.clientId, { conditions: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} placeholder="Условия — по одному в строке" className="min-h-14 text-[11px] sm:col-span-2" />
                      <Textarea value={rule.sourceQuote} onChange={(event) => updateRule(rule.clientId, { sourceQuote: event.target.value })} placeholder="Дословная цитата оператора" className="min-h-14 bg-slate-950 text-[11px] text-slate-100 sm:col-span-2" />
                    </div>
                  </details>
                </article>
              ))}

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-950 p-3 text-white">
                <label className="flex max-w-xl cursor-pointer items-start gap-2 text-[11px] leading-5 text-slate-300"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} className="mt-1 size-3.5 accent-violet-500" /><span>Я проверил текст, scope, условия, цитаты и спорные места. Выбрано правил: {selectedRules.length}.</span></label>
                <Button onClick={approve} disabled={!selectedRules.length || !reviewConfirmed || processing !== null || published.length > 0 || contextChanged} size="sm" className="rounded-full bg-violet-600 text-white hover:bg-violet-500">{processing === 'approve' ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />} Опубликовать правила</Button>
              </div>
            </div>
          ) : null}

          {published.length ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-950"><div className="mb-1 font-semibold">Правила опубликованы и связаны с вопросом</div>{published.map((rule) => <div key={rule.id}><span className="font-mono text-emerald-700">{rule.ruleCode}</span> · {rule.title}{rule.reused ? ' · использовано существующее' : ''}</div>)}</div> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
