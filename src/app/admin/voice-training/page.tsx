'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  Mic,
  ShieldCheck,
  Sparkles,
  Trash2,
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

interface PublishedRule {
  id: string;
  ruleCode: string;
  title: string;
  reused: boolean;
}

const typeLabels: Record<RuleType, string> = {
  capability: 'Возможность',
  procedure: 'Процедура',
  requirement: 'Требование',
  price: 'Цена',
  deadline: 'Срок',
  prohibition: 'Запрет',
  exception: 'Исключение',
  escalation: 'Эскалация',
};

const priorityLabels: Record<RulePriority, string> = {
  PRIMARY: 'Первоочередное',
  HIGH: 'Высокое',
  NORMAL: 'Обычное',
};

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function VoiceTrainingPage() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [audioHash, setAudioHash] = useState('');
  const [summary, setSummary] = useState('');
  const [uncertainties, setUncertainties] = useState<string[]>([]);
  const [rules, setRules] = useState<CandidateRule[]>([]);
  const [processing, setProcessing] = useState<'transcribe' | 'extract' | 'approve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishedRule[]>([]);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
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
  const primaryCount = selectedRules.filter((rule) => rule.priority === 'PRIMARY').length;
  const liveDataCount = selectedRules.filter((rule) => rule.requiresLiveData).length;

  function resetReview() {
    setPublished([]);
    setReviewConfirmed(false);
  }

  function resetAnalysis() {
    setRules([]);
    setSummary('');
    setUncertainties([]);
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
    resetAnalysis();
    setError(null);
  }

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Запись с микрофона не поддерживается этим браузером');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const preferred = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        acceptAudio(new File([blob], `voice-rule-${Date.now()}.webm`, { type: blob.type }));
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start(500);
      setRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
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

  function removeAudio() {
    if (recording) stopRecording();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(null);
    setAudioUrl(null);
    setTranscript('');
    setAudioHash('');
    resetAnalysis();
    setError(null);
  }

  async function transcribeAudio() {
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
      resetAnalysis();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось распознать речь');
    } finally {
      setProcessing(null);
    }
  }

  async function extractRules() {
    if (transcript.trim().length < 10 || processing) return;
    setProcessing('extract');
    setError(null);
    try {
      const response = await fetch('/api/admin/voice-training/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcript.trim() }),
      });
      const data = await response.json() as { rules?: Omit<CandidateRule, 'clientId' | 'selected'>[]; uncertainties?: string[]; summary?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Не удалось извлечь правила');
      setRules((data.rules || []).map((rule, index) => ({ ...rule, clientId: `voice-rule-${index}-${Date.now()}`, selected: true })));
      setUncertainties(data.uncertainties || []);
      setSummary(data.summary || '');
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

  async function approveRules() {
    if (selectedRules.length === 0 || processing) return;
    setProcessing('approve');
    setError(null);
    try {
      const response = await fetch('/api/admin/voice-training/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rules: selectedRules,
          sourceName,
          audioHash,
          reviewConfirmed,
          acknowledgedUncertainties: uncertainties,
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
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-950 text-violet-300"><Mic className="size-5" /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h1 className="truncate font-display text-xl font-semibold text-slate-950">Voice Rule Studio</h1><Badge className="hidden bg-violet-100 text-[9px] text-violet-900 sm:inline-flex">VOICE_AUTHORITY</Badge></div>
            <p className="text-xs text-slate-500">Аудио → расшифровка → правила → подтверждение</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500"><ShieldCheck className="size-3.5 text-violet-600" /> Ничего не публикуется автоматически</div>
      </header>

      <Card className="overflow-hidden rounded-2xl border-slate-200 bg-slate-950 py-0 text-white shadow-sm">
        <CardContent className="grid gap-3 p-3 lg:grid-cols-[250px_minmax(0,1fr)_180px] lg:items-stretch">
          <div className="space-y-2">
            <div className={cn('flex h-10 items-center gap-3 rounded-xl border px-3', recording ? 'border-rose-400/60 bg-rose-500/10' : 'border-white/10 bg-white/5')}>
              <AudioLines className={cn('size-4', recording ? 'text-rose-300' : 'text-violet-300')} />
              <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">{recording ? `Запись ${formatDuration(recordingSeconds)}` : audioFile ? audioFile.name : 'Нет аудио'}</div><div className="text-[9px] text-slate-500">{audioFile ? `${(audioFile.size / 1024 / 1024).toFixed(2)} МБ · локально` : 'Файл не сохраняется'}</div></div>
              {audioFile ? <Button size="icon" variant="ghost" onClick={removeAudio} className="size-7 text-slate-400 hover:text-rose-300"><Trash2 className="size-3.5" /></Button> : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {recording ? <Button onClick={stopRecording} size="sm" className="col-span-2 h-8 rounded-lg bg-rose-600 text-xs text-white"><CircleStop className="size-3.5" /> Стоп</Button> : <Button onClick={startRecording} size="sm" className="h-8 rounded-lg bg-violet-600 text-xs text-white"><Mic className="size-3.5" /> Диктовать</Button>}
              <label className={cn('flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-white/15 px-2 text-[11px] text-slate-200 hover:bg-white/10', recording && 'pointer-events-none opacity-40')}><UploadCloud className="size-3.5" /> Файл<Input type="file" accept="audio/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm,.flac" className="sr-only" disabled={recording} onChange={(event) => { const file = event.target.files?.[0]; if (file) acceptAudio(file); event.target.value = ''; }} /></label>
            </div>
            {audioUrl ? <audio controls src={audioUrl} className="h-7 w-full" /> : null}
          </div>

          <div className="min-w-0">
            <Textarea value={transcript} onChange={(event) => { setTranscript(event.target.value); resetAnalysis(); }} placeholder="Расшифровка появится здесь. Можно вставить текст вручную…" className="h-full min-h-24 resize-none rounded-xl border-white/10 bg-white/5 text-xs leading-5 text-white placeholder:text-slate-500" />
            <div className="mt-1 flex justify-between text-[9px] text-slate-500"><span>{transcript.length} символов</span><span><AlertTriangle className="mr-1 inline size-2.5 text-amber-400" />Без ФИО и данных заказов</span></div>
          </div>

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
            <Button onClick={transcribeAudio} disabled={!audioFile || processing !== null} size="sm" className="h-9 rounded-lg bg-white text-xs text-slate-950 hover:bg-violet-100">{processing === 'transcribe' ? <LoaderCircle className="animate-spin" /> : <Volume2 />} Расшифровать</Button>
            <Button onClick={extractRules} disabled={transcript.trim().length < 10 || processing !== null} size="sm" className="h-9 rounded-lg bg-violet-600 text-xs text-white hover:bg-violet-700">{processing === 'extract' ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Извлечь правила</Button>
            <div className="col-span-2 hidden rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[9px] leading-4 text-slate-400 lg:block lg:col-span-1">Проверьте расшифровку до извлечения. Правки сбрасывают старые кандидаты.</div>
          </div>
        </CardContent>
      </Card>

      {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800" role="alert">{error}</div> : null}
      {uncertainties.length ? <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950"><summary className="cursor-pointer font-medium">Нужно уточнить перед публикацией · {uncertainties.length}</summary><div className="mt-2 grid gap-1 md:grid-cols-2">{uncertainties.map((item, index) => <div key={`${item}-${index}`} className="flex gap-1.5 leading-5"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{item}</div>)}</div></details> : null}

      <section className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_270px]">
        <Card className="rounded-2xl border-slate-200 py-0 shadow-sm">
          <CardHeader className="flex-row items-center justify-between border-b border-slate-100 px-4 py-3"><div><CardTitle className="text-sm">Правила <span className="font-normal text-slate-400">{rules.length ? `· ${rules.length}` : ''}</span></CardTitle>{summary ? <p className="mt-0.5 line-clamp-1 text-[10px] text-slate-500">{summary}</p> : null}</div><Badge variant="outline" className="bg-slate-50 text-[9px]">Rule Workbench</Badge></CardHeader>
          <CardContent className="space-y-2 p-3">
            {rules.length === 0 ? <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center"><div><Sparkles className="mx-auto size-5 text-violet-400" /><p className="mt-2 text-xs font-medium text-slate-700">Добавьте аудио или вставьте расшифровку</p></div></div> : rules.map((rule, index) => (
              <article key={rule.clientId} className={cn('rounded-xl border p-3 transition', rule.selected ? 'border-violet-200 bg-white' : 'border-slate-200 bg-slate-50 opacity-55')}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={rule.selected} onChange={(event) => updateRule(rule.clientId, { selected: event.target.checked })} className="size-4 shrink-0 accent-violet-600" aria-label={`Выбрать правило ${index + 1}`} />
                  <Input value={rule.title} onChange={(event) => updateRule(rule.clientId, { title: event.target.value })} aria-label={`Заголовок правила ${index + 1}`} className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm font-medium shadow-none focus-visible:ring-1" />
                  <Badge className={cn('shrink-0 text-[8px]', rule.priority === 'PRIMARY' ? 'bg-violet-700 text-white' : rule.priority === 'HIGH' ? 'bg-cyan-100 text-cyan-900' : 'bg-slate-100 text-slate-700')}>{rule.priority}</Badge>
                  {rule.requiresLiveData ? <Badge className="hidden shrink-0 bg-amber-100 text-[8px] text-amber-900 sm:inline-flex">LIVE</Badge> : null}
                  <span className="hidden font-mono text-[8px] text-slate-400 md:inline">{Math.round(rule.extractionConfidence * 100)}%</span>
                </div>
                <Textarea value={rule.body} onChange={(event) => updateRule(rule.clientId, { body: event.target.value })} aria-label={`Текст правила ${index + 1}`} className="mt-1 min-h-16 resize-y rounded-lg border-slate-100 bg-slate-50/70 text-xs leading-5" />
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer select-none text-[10px] font-medium text-violet-700">Детали · {typeLabels[rule.type]} · {rule.scope}</summary>
                  <div className="mt-2 grid gap-2 border-t border-slate-100 pt-2 sm:grid-cols-3">
                    <select aria-label={`Тип правила ${index + 1}`} value={rule.type} onChange={(event) => updateRule(rule.clientId, { type: event.target.value as RuleType })} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-[11px]">{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                    <select aria-label={`Приоритет правила ${index + 1}`} value={rule.priority} onChange={(event) => updateRule(rule.clientId, { priority: event.target.value as RulePriority })} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-[11px]">{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                    <Input value={rule.scope} onChange={(event) => updateRule(rule.clientId, { scope: event.target.value })} aria-label={`Область действия правила ${index + 1}`} placeholder="Область действия" className="h-8 rounded-lg text-[11px]" />
                    <label className="flex items-center gap-2 text-[10px] text-slate-600 sm:col-span-3"><input type="checkbox" checked={rule.requiresLiveData} onChange={(event) => updateRule(rule.clientId, { requiresLiveData: event.target.checked })} className="size-3.5 accent-amber-600" /> Требует актуальных цены/срока</label>
                    <Textarea value={rule.conditions.join('\n')} onChange={(event) => updateRule(rule.clientId, { conditions: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} aria-label={`Условия правила ${index + 1}`} placeholder="Условия — по одному в строке" className="min-h-14 text-[11px] sm:col-span-3" />
                    <Textarea value={rule.sourceQuote} onChange={(event) => updateRule(rule.clientId, { sourceQuote: event.target.value })} aria-label={`Цитата правила ${index + 1}`} placeholder="Дословная цитата" className="min-h-14 border-slate-800 bg-slate-950 text-[11px] text-slate-200 sm:col-span-3" />
                  </div>
                </details>
              </article>
            ))}
          </CardContent>
        </Card>

        <aside className="sticky top-3 space-y-3">
          <Card className="rounded-2xl border-slate-800 bg-slate-950 py-0 text-white shadow-sm"><CardContent className="space-y-3 p-3"><div className="flex items-center justify-between"><div><div className="text-[9px] font-semibold uppercase tracking-widest text-violet-300">Authority & Publish</div><div className="mt-1 text-lg font-semibold">{selectedRules.length} выбрано</div></div><div className="flex gap-1"><Badge className="bg-violet-500/15 text-[8px] text-violet-200">{primaryCount} PRIMARY</Badge><Badge className="bg-amber-500/15 text-[8px] text-amber-200">{liveDataCount} LIVE</Badge></div></div><p className="text-[10px] leading-4 text-slate-400">VOICE_AUTHORITY повышает приоритет только релевантных правил. Scope и live-data сохраняются.</p><label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/5 p-2 text-[10px] leading-4 text-slate-300"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} className="mt-0.5 size-3.5 shrink-0 accent-violet-500" /><span>Проверены текст, цитаты, scope, условия и вопросы.</span></label><Button onClick={approveRules} disabled={selectedRules.length === 0 || !reviewConfirmed || processing !== null || published.length > 0} size="sm" className="h-9 w-full rounded-lg bg-violet-600 text-xs text-white hover:bg-violet-700">{processing === 'approve' ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />} Опубликовать</Button><p className="text-center text-[8px] text-slate-500">Изменяет production-базу знаний</p></CardContent></Card>
          {published.length ? <Card className="rounded-2xl border-emerald-200 bg-emerald-50 py-0"><CardContent className="space-y-1 p-3"><div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-950"><CheckCircle2 className="size-3.5" /> Опубликовано</div>{published.map((rule) => <div key={rule.id} className="text-[10px] text-slate-700"><span className="font-mono font-semibold text-emerald-700">{rule.ruleCode}</span> · {rule.title}</div>)}</CardContent></Card> : null}
        </aside>
      </section>
    </div>
  );
}
