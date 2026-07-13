'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  CircleStop,
  FileAudio,
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
    setRules([]);
    setPublished([]);
    setReviewConfirmed(false);
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
    setRules([]);
    setPublished([]);
    setReviewConfirmed(false);
    setAudioHash('');
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
      setRules([]);
      setReviewConfirmed(false);
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
      setPublished([]);
      setReviewConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось извлечь правила');
    } finally {
      setProcessing(null);
    }
  }

  function updateRule(clientId: string, patch: Partial<CandidateRule>) {
    setRules((current) => current.map((rule) => rule.clientId === clientId ? { ...rule, ...patch } : rule));
    setPublished([]);
    setReviewConfirmed(false);
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
    <div className="space-y-5">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex flex-wrap gap-2"><Badge className="bg-violet-100 text-violet-900"><Mic className="size-3" /> Voice Rule Studio</Badge><Badge variant="outline" className="bg-white/75">Human approval required</Badge></div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-950">Надиктуйте правило — система подготовит знания</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Аудио превращается в редактируемые атомарные правила. Ничего не публикуется до явного подтверждения администратора.</p>
        </div>
        <div className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-xs leading-5 text-violet-900"><div className="font-semibold">VOICE_AUTHORITY</div><div>Утверждённые правила получают повышенный приоритет поиска и полный audit trail.</div></div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[350px_minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card className="overflow-hidden rounded-3xl border-slate-800 bg-slate-950 py-0 text-white shadow-elevated">
            <CardHeader className="border-b border-white/10 pb-4"><CardTitle className="flex items-center gap-2 text-sm text-white"><AudioLines className="size-4 text-violet-300" /> Запись и загрузка</CardTitle></CardHeader>
            <CardContent className="space-y-4 pb-5 pt-5">
              <div className={cn('relative grid min-h-44 place-items-center overflow-hidden rounded-3xl border', recording ? 'border-rose-400/60 bg-rose-500/10' : 'border-white/10 bg-white/5')}>
                {recording ? <div className="absolute inset-0 flex items-center justify-center gap-2 opacity-30">{Array.from({ length: 13 }, (_, index) => <span key={index} className="w-1 animate-pulse rounded-full bg-rose-300" style={{ height: `${18 + (index % 5) * 9}px`, animationDelay: `${index * 80}ms` }} />)}</div> : null}
                <div className="relative z-10 text-center"><div className={cn('mx-auto grid size-16 place-items-center rounded-full', recording ? 'bg-rose-500 text-white' : 'bg-violet-400/15 text-violet-300')}><Mic className="size-7" /></div><div className="mt-3 font-mono text-lg">{recording ? formatDuration(recordingSeconds) : audioFile ? 'Запись готова' : 'Готов к диктовке'}</div><div className="mt-1 text-xs text-slate-400">{recording ? 'Говорите спокойно и разделяйте правила паузами' : 'Аудио не сохраняется после обработки'}</div></div>
              </div>
              <div className="grid grid-cols-2 gap-2">{recording ? <Button onClick={stopRecording} className="col-span-2 rounded-full bg-rose-600 text-white hover:bg-rose-700"><CircleStop /> Остановить запись</Button> : <Button onClick={startRecording} className="rounded-full bg-violet-600 text-white hover:bg-violet-700"><Mic /> Начать диктовку</Button>}<label className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-full border border-white/15 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/10', recording && 'pointer-events-none opacity-40')}><UploadCloud className="size-4" /> Загрузить файл<Input type="file" accept="audio/*,.mp3,.mp4,.mpeg,.mpga,.m4a,.ogg,.wav,.webm,.flac" className="sr-only" disabled={recording} onChange={(event) => { const file = event.target.files?.[0]; if (file) acceptAudio(file); event.target.value = ''; }} /></label></div>
              {audioFile ? <div className="rounded-2xl border border-white/10 bg-white/5 p-3"><div className="flex items-center gap-2"><FileAudio className="size-4 text-violet-300" /><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">{audioFile.name}</div><div className="text-[10px] text-slate-500">{(audioFile.size / 1024 / 1024).toFixed(2)} МБ</div></div><Button size="icon" variant="ghost" onClick={removeAudio} className="text-slate-400 hover:text-rose-300"><Trash2 /></Button></div>{audioUrl ? <audio controls src={audioUrl} className="mt-3 h-8 w-full" /> : null}</div> : null}
              <Button onClick={transcribeAudio} disabled={!audioFile || processing !== null} className="w-full rounded-full bg-white text-slate-950 hover:bg-violet-100">{processing === 'transcribe' ? <LoaderCircle className="animate-spin" /> : <Volume2 />} Расшифровать аудио</Button>
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3 text-[11px] leading-5 text-amber-100"><AlertTriangle className="mr-1 inline size-3" /> Не называйте телефоны, паспортные данные, номера заказов и ФИО клиентов.</div>
            </CardContent>
          </Card>

          <Card className="glass-panel rounded-3xl border-white/70 py-0"><CardHeader className="border-b border-slate-200/70 pb-4"><CardTitle className="text-sm">Расшифровка</CardTitle></CardHeader><CardContent className="space-y-3 pb-5 pt-5"><Textarea value={transcript} onChange={(event) => { setTranscript(event.target.value); setRules([]); setPublished([]); }} placeholder="После распознавания здесь появится текст. Исправьте ошибки перед извлечением правил." className="min-h-56 rounded-2xl bg-white/85 text-sm leading-6" /><div className="flex items-center justify-between text-[10px] text-slate-400"><span>{transcript.length} символов</span><span>Редактирование не меняет аудиофайл</span></div><Button onClick={extractRules} disabled={transcript.trim().length < 10 || processing !== null} className="w-full rounded-full bg-slate-950 text-white hover:bg-violet-900">{processing === 'extract' ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Извлечь правила</Button></CardContent></Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="glass-panel rounded-3xl border-white/70 py-0"><CardHeader className="border-b border-slate-200/70 pb-4"><div className="flex items-center justify-between"><div><div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-700">Rule Workbench</div><CardTitle className="mt-1 text-base">Извлечённые правила</CardTitle></div><Badge variant="outline" className="bg-white">{rules.length}</Badge></div>{summary ? <p className="text-xs leading-5 text-slate-500">{summary}</p> : null}</CardHeader><CardContent className="space-y-3 pb-5 pt-5">
            {rules.length === 0 ? <div className="grid min-h-56 place-items-center rounded-3xl border border-dashed border-slate-200 bg-white/40 p-8 text-center"><div><Sparkles className="mx-auto size-7 text-violet-300" /><p className="mt-3 text-sm font-medium text-slate-700">Правила появятся после анализа расшифровки</p><p className="mt-1 text-xs leading-5 text-slate-400">Система разделит инструкцию на атомарные утверждения и сохранит дословные цитаты.</p></div></div> : rules.map((rule, index) => <div key={rule.clientId} className={cn('rounded-3xl border p-4 transition', rule.selected ? 'border-violet-200 bg-white/85 shadow-sm' : 'border-slate-200 bg-slate-50/60 opacity-60')}><div className="mb-3 flex items-start gap-3"><input type="checkbox" checked={rule.selected} onChange={(event) => updateRule(rule.clientId, { selected: event.target.checked })} className="mt-1 size-4 accent-violet-600" aria-label={`Выбрать правило ${index + 1}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><Badge className={cn('text-[9px]', rule.priority === 'PRIMARY' ? 'bg-violet-700 text-white' : rule.priority === 'HIGH' ? 'bg-cyan-100 text-cyan-900' : 'bg-slate-100 text-slate-700')}>{priorityLabels[rule.priority]}</Badge><Badge variant="outline" className="bg-white text-[9px]">{typeLabels[rule.type]}</Badge>{rule.requiresLiveData ? <Badge className="bg-amber-100 text-[9px] text-amber-900">LIVE DATA</Badge> : null}<span className="ml-auto font-mono text-[9px] text-slate-400">extract {Math.round(rule.extractionConfidence * 100)}%</span></div></div></div><div className="space-y-3"><Input value={rule.title} onChange={(event) => updateRule(rule.clientId, { title: event.target.value })} aria-label={`Заголовок правила ${index + 1}`} className="rounded-xl bg-white font-medium" /><Textarea value={rule.body} onChange={(event) => updateRule(rule.clientId, { body: event.target.value })} aria-label={`Текст правила ${index + 1}`} className="min-h-24 rounded-2xl bg-white text-sm leading-6" /><div className="grid gap-2 sm:grid-cols-3"><select value={rule.type} onChange={(event) => updateRule(rule.clientId, { type: event.target.value as RuleType })} className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs">{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={rule.priority} onChange={(event) => updateRule(rule.clientId, { priority: event.target.value as RulePriority })} className="h-9 rounded-xl border border-slate-200 bg-white px-2 text-xs">{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Input value={rule.scope} onChange={(event) => updateRule(rule.clientId, { scope: event.target.value })} aria-label={`Область действия правила ${index + 1}`} placeholder="Область действия" className="h-9 rounded-xl bg-white text-xs" /></div><label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={rule.requiresLiveData} onChange={(event) => updateRule(rule.clientId, { requiresLiveData: event.target.checked })} className="size-4 accent-amber-600" /> Цена или срок требуют живых данных</label><div className="rounded-2xl bg-slate-950 p-3 text-xs leading-5 text-slate-300"><div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-violet-300">Дословная цитата</div><Textarea value={rule.sourceQuote} onChange={(event) => updateRule(rule.clientId, { sourceQuote: event.target.value })} aria-label={`Цитата правила ${index + 1}`} className="min-h-16 border-white/10 bg-white/5 text-xs text-slate-200" /></div></div></div>)}
          </CardContent></Card>
          {uncertainties.length ? <Card className="rounded-3xl border-amber-200 bg-amber-50 py-0"><CardHeader className="pb-3"><CardTitle className="text-sm text-amber-950">Нужно уточнить перед публикацией</CardTitle></CardHeader><CardContent className="space-y-2 pb-5">{uncertainties.map((item, index) => <div key={`${item}-${index}`} className="flex gap-2 text-xs leading-5 text-amber-900"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{item}</div>)}</CardContent></Card> : null}
        </div>

        <aside className="space-y-4">
          <Card className="overflow-hidden rounded-3xl border-slate-800 bg-slate-950 py-0 text-white shadow-elevated"><CardHeader className="border-b border-white/10 pb-5"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-violet-300"><ShieldCheck className="size-4" /> Authority & Publish</div><CardTitle className="mt-3 text-xl text-white">{selectedRules.length} правил выбрано</CardTitle><p className="text-xs leading-5 text-slate-400">Публикация создаёт активные версионируемые правила и audit-запись. Отменить её можно только новой версией или deprecate.</p></CardHeader><CardContent className="space-y-4 pb-5 pt-5"><div className="grid grid-cols-2 gap-2"><div className="rounded-2xl border border-violet-400/20 bg-violet-400/10 p-3"><div className="text-2xl font-semibold text-violet-200">{primaryCount}</div><div className="text-[10px] text-violet-300">PRIMARY</div></div><div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-3"><div className="text-2xl font-semibold text-amber-200">{liveDataCount}</div><div className="text-[10px] text-amber-300">LIVE DATA</div></div></div><div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-300"><div className="mb-1 font-semibold text-violet-300">VOICE_AUTHORITY</div>Повышает retrieval priority только для релевантных запросов. Не отменяет проверку конфликтов, scope и динамических данных.</div><label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-xs leading-5 text-slate-300"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-violet-500" /><span>Я проверил текст, дословные цитаты, область действия, live-data и все вопросы экстрактора.</span></label>{error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 p-3 text-xs leading-5 text-rose-200" role="alert">{error}</div> : null}<Button onClick={approveRules} disabled={selectedRules.length === 0 || !reviewConfirmed || processing !== null || published.length > 0} className="w-full rounded-full bg-violet-600 text-white hover:bg-violet-700">{processing === 'approve' ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />} Подтвердить и опубликовать</Button><p className="text-center text-[10px] leading-4 text-slate-500">Это действие изменяет production-базу знаний.</p></CardContent></Card>
          {published.length ? <Card className="rounded-3xl border-emerald-200 bg-emerald-50 py-0"><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-sm text-emerald-950"><CheckCircle2 className="size-4" /> Правила опубликованы</CardTitle></CardHeader><CardContent className="space-y-2 pb-5">{published.map((rule) => <div key={rule.id} className="rounded-xl bg-white/80 p-3 text-xs"><div className="font-mono font-semibold text-emerald-700">{rule.ruleCode}{rule.reused ? ' · уже существовало' : ''}</div><div className="mt-1 text-slate-700">{rule.title}</div></div>)}</CardContent></Card> : null}
          <Card className="glass-panel rounded-3xl border-white/70 py-0"><CardHeader className="pb-3"><CardTitle className="text-sm">Правильная последовательность</CardTitle></CardHeader><CardContent className="space-y-2 pb-5 text-xs text-slate-600">{['1. Записать или загрузить', '2. Проверить расшифровку', '3. Отредактировать атомарные правила', '4. Проверить scope и live data', '5. Явно подтвердить публикацию', '6. Прогнать регрессионные кейсы'].map((item) => <div key={item} className="rounded-xl bg-white/70 px-3 py-2">{item}</div>)}</CardContent></Card>
        </aside>
      </section>
    </div>
  );
}
