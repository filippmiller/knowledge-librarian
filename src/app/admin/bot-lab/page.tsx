'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  BarChart3,
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  FlaskConical,
  GitBranch,
  LoaderCircle,
  MessageSquareText,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
  ThumbsUp,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { VoiceRuleCapture } from '@/components/bot-lab/voice-rule-capture';
import { VoiceAnswerCapture } from '@/components/bot-lab/voice-answer-capture';

interface BotCase {
  id: string;
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
  confidence: number;
}

interface DatasetSummary {
  title: string;
  description: string;
  sourceThreads: number;
  cases: number;
  totalFrequency: number;
  priceDependent: number;
  averageConfidence: number;
  categoryCounts: Record<string, number>;
}

interface BotResult {
  sessionId: string;
  answer: string;
  confidence: number;
  confidenceLevel: string;
  needsClarification: boolean;
  suggestedClarification?: string;
  answerSource?: 'knowledge_base' | 'general_ai' | 'deterministic_guardrail';
  requiresHumanReview?: boolean;
  consistency?: {
    allSupported: boolean;
    unsupportedCount: number;
    verificationFailed: boolean;
    regenerated: boolean;
  };
  scenarioKey?: string;
  scenarioLabel?: string;
  domainsUsed: string[];
  citations: Array<{
    ruleCode?: string;
    documentTitle?: string;
    quote: string;
    relevanceScore?: number;
  }>;
  queryAnalysis?: {
    originalQuery?: string;
    expandedQueries?: string[];
    extractedEntities?: Record<string, unknown>;
    isAmbiguous?: boolean;
  };
  debug?: {
    intentClassification?: string | {
      intent?: string;
      domains?: string[];
      confidence?: number;
      reasoning?: string;
    };
    chunks?: Array<{
      content: string;
      semanticScore?: number;
      keywordScore?: number;
      combinedScore?: number;
      similarity?: number;
    }>;
    searchStats?: {
      totalChunksSearched?: number;
      avgSimilarity?: number;
      maxSimilarity?: number;
    };
  };
}

type FeedbackRating = 'HELPFUL' | 'PARTIALLY' | 'INCORRECT';

const categoryLabels: Record<string, string> = {
  capability: 'Возможности',
  process: 'Процесс',
  policy: 'Политика',
  requirement: 'Требования',
  pricing_policy: 'Расчёт цены',
  location: 'Офисы и график',
};

const sourceLabels: Record<string, string> = {
  knowledge_base: 'База знаний',
  general_ai: 'Общие знания ИИ',
  deterministic_guardrail: 'Детерминированное правило',
};

function deriveDecision(result: BotResult | null, selectedCase: BotCase | null) {
  if (!result) {
    return {
      code: 'NOT_RUN',
      title: 'Запуск не выполнен',
      description: 'Выберите кейс и запустите анализ.',
      tone: 'slate',
      icon: Activity,
    };
  }
  if (
    result.requiresHumanReview ||
    result.consistency?.verificationFailed ||
    (result.consistency?.unsupportedCount ?? 0) > 0
  ) {
    return {
      code: 'REVIEW_REQUIRED',
      title: 'Требуется проверка оператором',
      description: result.consistency?.verificationFailed
        ? 'Автоматическая проверка доказательств не завершилась. Ответ нельзя считать подтверждённым.'
        : 'Одно или несколько утверждений ответа не подтверждены источниками.',
      tone: 'rose',
      icon: ShieldAlert,
    };
  }
  if (selectedCase?.price_dependent) {
    return {
      code: 'LIVE_DATA_REQUIRED',
      title: 'Нужен живой расчёт',
      description: 'Можно использовать только политику расчёта. Сумму и срок должен подтвердить оператор или калькулятор.',
      tone: 'amber',
      icon: CircleDollarSign,
    };
  }
  if (result.needsClarification) {
    return {
      code: 'CLARIFY',
      title: 'Уточнить у клиента',
      description: result.suggestedClarification || 'Контекста недостаточно для безопасного ответа.',
      tone: 'sky',
      icon: MessageSquareText,
    };
  }
  if (result.confidence < 0.5) {
    return {
      code: 'ESCALATE',
      title: 'Передать оператору',
      description: 'Уверенность ниже безопасного порога или движок запросил ручную проверку.',
      tone: 'rose',
      icon: ShieldAlert,
    };
  }
  if (result.confidence < 0.7 || (result.citations.length === 0 && result.answerSource !== 'deterministic_guardrail')) {
    return {
      code: 'DRAFT_WITH_WARNING',
      title: 'Черновик — проверить факты',
      description: 'Ответ можно использовать как основу, но его источники или уверенность недостаточны для отправки без проверки.',
      tone: 'amber',
      icon: TriangleAlert,
    };
  }
  return {
    code: 'DRAFT_READY',
    title: 'Черновик готов к проверке',
    description: 'Уверенность достаточная, ответ поддержан источниками. Auto-send в песочнице отключён.',
    tone: 'emerald',
    icon: CheckCircle2,
  };
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^---+$/gm, '')
    .trim();
}

function entitySummary(entities?: Record<string, unknown>) {
  if (!entities) return [];
  return Object.entries(entities)
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) return value.map((item) => `${key}: ${String(item)}`);
      if (value === null || value === undefined || value === '') return [];
      return [`${key}: ${String(value)}`];
    })
    .slice(0, 12);
}

export default function BotLabPage() {
  const [cases, setCases] = useState<BotCase[]>([]);
  const [dataset, setDataset] = useState<DatasetSummary | null>(null);
  const [loadingCases, setLoadingCases] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [risk, setRisk] = useState('all');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<BotResult | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [comment, setComment] = useState('');
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [canonicalAnswer, setCanonicalAnswer] = useState('');
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [historicalSaved, setHistoricalSaved] = useState<{ qaPairId: string; reused: boolean } | null>(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const [historicalError, setHistoricalError] = useState<string | null>(null);

  useEffect(() => {
    async function loadCases() {
      try {
        const response = await fetch('/api/admin/bot-lab/cases', { cache: 'no-store' });
        if (!response.ok) throw new Error(response.status === 401 ? 'Нужна авторизация администратора' : 'Не удалось загрузить набор кейсов');
        const data = await response.json() as { dataset: DatasetSummary; cases: BotCase[] };
        setDataset(data.dataset);
        setCases(data.cases);
        if (data.cases[0]) {
          setSelectedId(data.cases[0].id);
          setQuestion(data.cases[0].question);
          setCanonicalAnswer(data.cases[0].answer);
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить данные');
      } finally {
        setLoadingCases(false);
      }
    }
    void loadCases();
  }, []);

  const selectedCase = useMemo(
    () => cases.find((item) => item.id === selectedId) ?? null,
    [cases, selectedId]
  );

  const evaluationCase = selectedCase && question.trim() === selectedCase.question.trim()
    ? selectedCase
    : null;

  const filteredCases = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return cases.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (risk === 'price' && !item.price_dependent) return false;
      if (risk === 'frequent' && item.freq < 4) return false;
      if (risk === 'low-confidence' && item.confidence >= 0.75) return false;
      if (normalizedSearch && !`${item.question} ${item.answer}`.toLowerCase().includes(normalizedSearch)) return false;
      return true;
    });
  }, [cases, category, risk, search]);

  const decision = deriveDecision(result, evaluationCase);
  const DecisionIcon = decision.icon;
  const intent = typeof result?.debug?.intentClassification === 'string'
    ? result.debug.intentClassification
    : result?.debug?.intentClassification?.intent;
  const intentReasoning = typeof result?.debug?.intentClassification === 'object'
    ? result.debug.intentClassification.reasoning
    : undefined;
  const entities = entitySummary(result?.queryAnalysis?.extractedEntities);
  const chunks = result?.debug?.chunks ?? [];

  function selectCase(item: BotCase) {
    setSelectedId(item.id);
    setQuestion(item.question);
    setResult(null);
    setRunError(null);
    setLatencyMs(null);
    setRating(null);
    setComment('');
    setFeedbackSaved(false);
    setCanonicalAnswer(item.answer);
    setCandidateId(null);
    setCandidateError(null);
    setHistoricalSaved(null);
    setHistoricalError(null);
  }

  function updateQuestion(value: string) {
    setQuestion(value);
    setResult(null);
    setRunError(null);
    setLatencyMs(null);
    setRating(null);
    setComment('');
    setFeedbackSaved(false);
  }

  async function runAnalysis() {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || runLoading) return;
    setRunLoading(true);
    setRunError(null);
    setResult(null);
    setFeedbackSaved(false);
    const startedAt = performance.now();
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmedQuestion, includeDebug: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось получить ответ');
      setResult(data as BotResult);
      setLatencyMs(Math.round(performance.now() - startedAt));
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Не удалось запустить анализ');
    } finally {
      setRunLoading(false);
    }
  }

  async function saveFeedback() {
    if (!result || !rating || feedbackLoading) return;
    setFeedbackLoading(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          answer: result.answer,
          rating,
          feedbackType: rating === 'HELPFUL' ? 'GREAT' : rating === 'PARTIALLY' ? 'MISSING_INFO' : 'WRONG_INFO',
          comment: comment.trim() || undefined,
          suggestedAnswer: rating !== 'HELPFUL' && evaluationCase ? evaluationCase.answer : undefined,
          confidence: result.confidence,
          domainsUsed: result.domainsUsed,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось сохранить оценку');
      setFeedbackSaved(true);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Не удалось сохранить оценку');
    } finally {
      setFeedbackLoading(false);
    }
  }

  async function createKnowledgeCandidate() {
    if (!selectedCase || candidateLoading || canonicalAnswer.trim().length < 10) return;
    setCandidateLoading(true);
    setCandidateError(null);
    try {
      const response = await fetch('/api/admin/bot-lab/knowledge-candidates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId: selectedCase.id,
          answer: canonicalAnswer.trim(),
          note: comment.trim() || undefined,
        }),
      });
      const data = await response.json() as { candidateId?: string; error?: string };
      if (!response.ok || !data.candidateId) throw new Error(data.error || 'Не удалось создать кандидат знания');
      setCandidateId(data.candidateId);
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : 'Не удалось создать кандидат знания');
    } finally {
      setCandidateLoading(false);
    }
  }

  async function saveHistoricalAsCanonical() {
    if (!selectedCase || historicalLoading) return;
    setHistoricalLoading(true);
    setHistoricalError(null);
    try {
      const response = await fetch('/api/admin/bot-lab/historical-answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: selectedCase.id }),
      });
      const data = await response.json() as { qaPairId?: string; reused?: boolean; error?: string };
      if (!response.ok || !data.qaPairId) throw new Error(data.error || 'Не удалось сохранить эталон');
      setHistoricalSaved({ qaPairId: data.qaPairId, reused: Boolean(data.reused) });
    } catch (error) {
      setHistoricalError(error instanceof Error ? error.message : 'Не удалось сохранить эталон');
    } finally {
      setHistoricalLoading(false);
    }
  }

  if (loadingCases) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="flex items-center gap-3 text-sm text-slate-600"><LoaderCircle className="size-5 animate-spin text-cyan-600" /> Загружаю Bitrix-кейсы…</div>
      </div>
    );
  }

  if (loadError || !dataset) {
    return <Card className="border-rose-200 bg-rose-50"><CardContent className="py-8 text-center text-rose-700">{loadError || 'Набор данных недоступен'}</CardContent></Card>;
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge className="bg-cyan-100 text-cyan-900"><FlaskConical className="size-3" /> Песочница · обучение</Badge>
            <Badge variant="outline" className="bg-white/70 text-slate-600">Никаких отправок в Bitrix</Badge>
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-950">Bot Decision Lab</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Проверяйте реальные обезличенные вопросы, сравнивайте ответ бота с эталоном оператора и разбирайте каждый шаг решения.</p>
        </div>
        <div className="flex items-center gap-2 rounded-2xl border border-white/80 bg-white/70 px-4 py-3 text-xs text-slate-500 shadow-sm backdrop-blur">
          <Database className="size-4 text-cyan-700" />
          <div><div className="font-semibold text-slate-800">{dataset.title}</div><div>{dataset.description}</div></div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Безопасных кейсов', value: dataset.cases, note: `${dataset.sourceThreads} тредов`, icon: Database },
          { label: 'Реальных упоминаний', value: dataset.totalFrequency, note: 'после дедупликации', icon: BarChart3 },
          { label: 'Нужен живой расчёт', value: dataset.priceDependent, note: `${Math.round(dataset.priceDependent / dataset.cases * 100)}% кейсов`, icon: CircleDollarSign },
          { label: 'Mining confidence', value: `${Math.round(dataset.averageConfidence * 100)}%`, note: 'среднее по набору', icon: Target },
        ].map((stat) => (
          <Card key={stat.label} className="glass-panel gap-3 rounded-2xl border-white/70 py-4">
            <CardContent className="flex items-center gap-4 px-4">
              <div className="grid size-10 place-items-center rounded-xl bg-slate-950 text-cyan-300"><stat.icon className="size-5" /></div>
              <div><div className="text-2xl font-semibold text-slate-950">{stat.value}</div><div className="text-xs font-medium text-slate-600">{stat.label}</div><div className="text-[10px] text-slate-400">{stat.note}</div></div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="grid min-h-[780px] gap-4 xl:grid-cols-[320px_minmax(0,1fr)_350px]">
        <Card className="glass-panel min-h-0 gap-0 overflow-hidden rounded-3xl border-white/70 py-0">
          <CardHeader className="border-b border-slate-200/70 px-4 py-4">
            <div className="flex items-center justify-between"><CardTitle className="text-sm">Кейсы клиентов</CardTitle><Badge variant="outline" className="bg-white text-[10px]">{filteredCases.length}</Badge></div>
            <div className="relative mt-2"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Вопрос или ответ…" className="rounded-xl bg-white/80 pl-9" /></div>
            <div className="grid grid-cols-2 gap-2">
              <select value={category} onChange={(event) => setCategory(event.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white/80 px-2 text-xs text-slate-700 outline-none focus:border-cyan-500">
                <option value="all">Все категории</option>
                {Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select value={risk} onChange={(event) => setRisk(event.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white/80 px-2 text-xs text-slate-700 outline-none focus:border-cyan-500">
                <option value="all">Все риски</option><option value="price">Живой расчёт</option><option value="frequent">Частые (4+)</option><option value="low-confidence">Mining &lt;75%</option>
              </select>
            </div>
          </CardHeader>
          <div className="max-h-[680px] space-y-1.5 overflow-y-auto p-2">
            {filteredCases.map((item) => (
              <button key={item.id} type="button" onClick={() => selectCase(item)} className={cn('w-full rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500', selectedId === item.id ? 'border-cyan-300 bg-cyan-50 shadow-sm' : 'border-transparent bg-white/45 hover:border-slate-200 hover:bg-white/80')}>
                <div className="mb-1.5 flex items-center gap-1.5"><Badge variant="outline" className="bg-white/80 text-[9px]">{categoryLabels[item.category] ?? item.category}</Badge>{item.price_dependent ? <CircleDollarSign className="size-3.5 text-amber-600" /> : null}<span className="ml-auto text-[10px] text-slate-400">×{item.freq}</span></div>
                <p className="line-clamp-3 text-xs font-medium leading-5 text-slate-800">{item.question}</p>
              </button>
            ))}
            {filteredCases.length === 0 ? <div className="px-4 py-10 text-center text-xs text-slate-500">Кейсы не найдены</div> : null}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card className="glass-panel rounded-3xl border-white/70 py-0">
            <CardHeader className="border-b border-slate-200/70 pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700">Контекст клиента</div><CardTitle className="mt-1 text-base">{selectedCase ? selectedCase.question : 'Собственный вопрос'}</CardTitle></div>{selectedCase ? <div className="flex gap-2"><Badge variant="outline" className="bg-white">{categoryLabels[selectedCase.category] ?? selectedCase.category}</Badge>{selectedCase.price_dependent ? <Badge className="bg-amber-100 text-amber-900">Живой расчёт</Badge> : null}</div> : null}</div>
            </CardHeader>
            <CardContent className="space-y-4 pb-5 pt-5">
              <div><label htmlFor="bot-lab-question" className="mb-2 block text-xs font-medium text-slate-500">Вопрос для live-run</label><Textarea id="bot-lab-question" value={question} onChange={(event) => updateQuestion(event.target.value)} className="min-h-24 rounded-2xl border-slate-200 bg-white/80 text-sm leading-6" /></div>
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-slate-400">Запрос выполняется с <code>includeDebug: true</code></div><Button onClick={runAnalysis} disabled={runLoading || !question.trim()} className="rounded-full bg-slate-950 px-5 text-white hover:bg-cyan-800">{runLoading ? <LoaderCircle className="animate-spin" /> : <Sparkles />} {runLoading ? 'Анализирую…' : 'Запустить бота'}</Button></div>
              {runError ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700" role="alert">{runError}</div> : null}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="rounded-3xl border-slate-200/80 bg-white/80 py-0 shadow-sm">
              <CardHeader className="border-b border-slate-100 pb-4"><div className="flex items-center gap-2"><ThumbsUp className="size-4 text-emerald-600" /><CardTitle className="text-sm">Исторический ответ сотрудника</CardTitle></div></CardHeader>
              <CardContent className="max-h-[430px] overflow-y-auto space-y-3 pb-5 pt-5">
                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{selectedCase?.answer ?? 'Для собственного вопроса эталон отсутствует.'}</p>
                {selectedCase ? (
                  <div className="space-y-2">
                    {historicalError ? <p className="text-xs text-rose-700" role="alert">{historicalError}</p> : null}
                    {historicalSaved ? (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                        <div className="font-semibold">Сохранено как эталонный ответ</div>
                        <div className="font-mono text-emerald-700">{historicalSaved.qaPairId}{historicalSaved.reused ? ' (уже существовала)' : ''}</div>
                      </div>
                    ) : (
                      <Button size="sm" onClick={saveHistoricalAsCanonical} disabled={historicalLoading} className="rounded-full bg-emerald-700 text-white hover:bg-emerald-800">
                        {historicalLoading ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />} Сделать эталонным ответом
                      </Button>
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
            <Card className="rounded-3xl border-slate-800 bg-slate-950 py-0 text-white shadow-elevated">
              <CardHeader className="border-b border-white/10 pb-4"><div className="flex items-center gap-2"><Bot className="size-4 text-cyan-300" /><CardTitle className="text-sm text-white">Текущий ответ бота</CardTitle>{latencyMs !== null ? <span className="ml-auto flex items-center gap-1 text-[10px] text-slate-400"><Clock3 className="size-3" /> {(latencyMs / 1000).toFixed(1)}с</span> : null}</div></CardHeader>
              <CardContent className="max-h-[430px] overflow-y-auto pb-5 pt-5">{runLoading ? <div className="flex items-center gap-2 text-sm text-slate-400"><LoaderCircle className="size-4 animate-spin text-cyan-300" /> Строю решение и проверяю источники…</div> : result ? <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">{cleanMarkdown(result.answer)}</p> : <div className="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-500">Здесь появится текущий ответ production engine.</div>}</CardContent>
            </Card>
          </div>

          {selectedCase ? (
            <Card className="glass-panel rounded-3xl border-cyan-200/70 py-0">
              <CardHeader className="border-b border-slate-200/70 pb-4">
                <CardTitle className="text-sm">Обучение через проверку человеком</CardTitle>
                <p className="text-xs leading-5 text-slate-500">Исправьте исторический ответ. Он попадёт в очередь редактора и станет активным знанием только после отдельного утверждения.</p>
              </CardHeader>
              <CardContent className="space-y-3 pb-5 pt-5">
                <Textarea value={canonicalAnswer} onChange={(event) => { setCanonicalAnswer(event.target.value); setCandidateId(null); }} className="min-h-32 rounded-2xl bg-white/85 text-sm leading-6" aria-label="Канонический ответ для базы знаний" />
                {candidateError ? <p className="text-xs text-rose-700" role="alert">{candidateError}</p> : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-500">Эталон не передаётся боту во время live-run — это защищает качество проверки.</p>
                  {candidateId ? <Button asChild size="sm" variant="outline" className="rounded-full bg-white"><Link href="/admin/ai-questions">Открыть очередь и утвердить</Link></Button> : <Button size="sm" onClick={createKnowledgeCandidate} disabled={candidateLoading || canonicalAnswer.trim().length < 10} className="rounded-full bg-cyan-800 text-white hover:bg-cyan-900">{candidateLoading ? <LoaderCircle className="animate-spin" /> : null}Отправить на проверку</Button>}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {selectedCase ? (
            <VoiceAnswerCapture question={question} caseId={evaluationCase?.id ?? null} />
          ) : null}

          <VoiceRuleCapture question={question} caseId={evaluationCase?.id ?? null} />

          {result ? (
            <Card className="glass-panel rounded-3xl border-white/70 py-0">
              <CardHeader className="border-b border-slate-200/70 pb-4"><CardTitle className="text-sm">Оценка оператора</CardTitle></CardHeader>
              <CardContent className="space-y-3 pb-5 pt-5">
                <div className="grid gap-2 sm:grid-cols-3">
                  {[
                    { value: 'HELPFUL' as const, label: 'Готов без правок', icon: CheckCircle2, active: 'border-emerald-400 bg-emerald-50 text-emerald-800' },
                    { value: 'PARTIALLY' as const, label: 'Нужна правка', icon: TriangleAlert, active: 'border-amber-400 bg-amber-50 text-amber-800' },
                    { value: 'INCORRECT' as const, label: 'Неверный ответ', icon: XCircle, active: 'border-rose-400 bg-rose-50 text-rose-800' },
                  ].map((option) => <button key={option.value} type="button" onClick={() => { setRating(option.value); setFeedbackSaved(false); }} className={cn('flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition', rating === option.value ? option.active : 'border-slate-200 bg-white/75 text-slate-600 hover:bg-white')}><option.icon className="size-4" />{option.label}</button>)}
                </div>
                <Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Комментарий: что потеряно, что неверно, чего не хватило…" className="min-h-20 rounded-2xl bg-white/80 text-sm" />
                <div className="flex items-center justify-between gap-3"><p className="text-[11px] text-slate-400">«Неверный ответ» создаст вопрос для редактора знаний.</p><Button size="sm" variant="outline" onClick={saveFeedback} disabled={!rating || feedbackLoading || feedbackSaved} className="rounded-full bg-white">{feedbackLoading ? <LoaderCircle className="animate-spin" /> : feedbackSaved ? <CheckCircle2 className="text-emerald-600" /> : null}{feedbackSaved ? 'Сохранено' : 'Сохранить оценку'}</Button></div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <aside className="min-w-0 space-y-4">
          <Card className="gap-0 overflow-hidden rounded-3xl border-slate-800 bg-slate-950 py-0 text-white shadow-elevated">
            <CardHeader className="border-b border-white/10 pb-5">
              <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300"><BrainCircuit className="size-4" /> Решение</div><Badge variant="outline" className="border-white/15 bg-white/5 font-mono text-[9px] text-slate-400">UI-DERIVED</Badge></div>
              <div className={cn('grid size-11 place-items-center rounded-2xl', decision.tone === 'emerald' && 'bg-emerald-500/15 text-emerald-300', decision.tone === 'amber' && 'bg-amber-500/15 text-amber-300', decision.tone === 'rose' && 'bg-rose-500/15 text-rose-300', decision.tone === 'sky' && 'bg-sky-500/15 text-sky-300', decision.tone === 'slate' && 'bg-white/10 text-slate-300')}><DecisionIcon className="size-5" /></div>
              <CardTitle className="mt-4 text-xl leading-7 text-white">{decision.title}</CardTitle>
              <p className="text-xs leading-5 text-slate-400">{decision.description}</p>
            </CardHeader>
            <CardContent className="space-y-5 pb-5 pt-5">
              <div><div className="mb-2 flex justify-between text-xs text-slate-400"><span>Confidence движка</span><span className="font-mono text-white">{result ? `${Math.round(result.confidence * 100)}%` : '—'}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all" style={{ width: result ? `${Math.max(2, result.confidence * 100)}%` : '0%' }} /></div></div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">Источник</div><div className="mt-1 text-slate-200">{result?.answerSource ? sourceLabels[result.answerSource] : '—'}</div></div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-3"><div className="text-[9px] uppercase tracking-wider text-slate-500">Сценарий</div><div className="mt-1 line-clamp-2 text-slate-200">{result?.scenarioLabel || result?.scenarioKey || 'Не выбран'}</div></div>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-panel rounded-3xl border-white/70 py-0">
            <CardHeader className="border-b border-slate-200/70 pb-4"><div className="flex items-center gap-2"><GitBranch className="size-4 text-cyan-700" /><CardTitle className="text-sm">Как бот принял решение</CardTitle></div></CardHeader>
            <CardContent className="space-y-1 pb-5 pt-5">
              {[
                { label: 'Входной вопрос', value: result?.queryAnalysis?.originalQuery || (result ? question : 'Не запущено'), actual: Boolean(result) },
                { label: 'Intent', value: intent || 'Не инструментировано', actual: Boolean(intent) },
                { label: 'Сущности', value: entities.length ? entities.join(' · ') : 'Не найдены', actual: Boolean(result?.queryAnalysis) },
                { label: 'Scenario gate', value: result?.scenarioLabel || result?.scenarioKey || (result?.needsClarification ? 'Нужно уточнение' : 'Без сценария'), actual: Boolean(result) },
                { label: 'Query expansion', value: result?.queryAnalysis?.expandedQueries?.length ? `${result.queryAnalysis.expandedQueries.length} вариантов` : 'Нет вариантов', actual: Boolean(result?.queryAnalysis) },
                { label: 'Retrieval', value: result ? `${chunks.length} показано · ${result.debug?.searchStats?.totalChunksSearched ?? '—'} просмотрено` : 'Не запущено', actual: Boolean(result?.debug) },
                { label: 'Evidence', value: result ? `${result.citations.length} цитат` : 'Не запущено', actual: Boolean(result) },
                { label: 'Final action', value: decision.code, actual: Boolean(result), derived: true },
              ].map((step, index) => (
                <div key={step.label} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
                  <div className="flex flex-col items-center"><div className={cn('grid size-5 place-items-center rounded-full border text-[9px]', step.actual ? 'border-cyan-300 bg-cyan-50 text-cyan-800' : 'border-slate-200 bg-white text-slate-400')}>{index + 1}</div>{index < 7 ? <div className="min-h-7 w-px flex-1 bg-slate-200" /> : null}</div>
                  <div className="pb-3"><div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{step.label}{step.derived ? <Badge variant="outline" className="h-4 bg-white px-1 text-[7px]">UI</Badge> : null}</div><div className="mt-0.5 line-clamp-3 text-xs leading-5 text-slate-700">{step.value}</div></div>
                </div>
              ))}
              {intentReasoning ? <div className="rounded-2xl bg-cyan-50 p-3 text-xs leading-5 text-cyan-900"><span className="font-semibold">Почему intent:</span> {intentReasoning}</div> : null}
            </CardContent>
          </Card>

          {result?.citations.length ? (
            <Card className="glass-panel rounded-3xl border-white/70 py-0"><CardHeader className="border-b border-slate-200/70 pb-4"><CardTitle className="text-sm">Источники ответа · {result.citations.length}</CardTitle></CardHeader><CardContent className="max-h-80 space-y-2 overflow-y-auto pb-5 pt-5">{result.citations.map((citation, index) => <div key={`${citation.ruleCode ?? 'citation'}-${index}`} className="rounded-2xl border border-slate-200 bg-white/75 p-3"><div className="flex items-center gap-2">{citation.ruleCode ? <Badge variant="outline" className="bg-white text-[9px]">{citation.ruleCode}</Badge> : null}<span className="line-clamp-1 text-[10px] text-slate-400">{citation.documentTitle}</span></div><p className="mt-2 line-clamp-5 text-xs italic leading-5 text-slate-600">“{citation.quote}”</p></div>)}</CardContent></Card>
          ) : null}

          {chunks.length ? (
            <Card className="glass-panel rounded-3xl border-white/70 py-0"><CardHeader className="border-b border-slate-200/70 pb-4"><CardTitle className="text-sm">Найденные фрагменты базы знаний</CardTitle></CardHeader><CardContent className="max-h-80 space-y-2 overflow-y-auto pb-5 pt-5">{chunks.slice(0, 6).map((chunk, index) => <div key={`chunk-${index}`} className="rounded-2xl bg-slate-950 p-3 text-white"><div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[9px] text-cyan-300"><span>ФРАГМЕНТ {index + 1}</span><span>semantic {Math.round((chunk.semanticScore ?? chunk.similarity ?? 0) * 100)}% · keyword {Math.round((chunk.keywordScore ?? 0) * 100)}% · RRF {(chunk.combinedScore ?? 0).toFixed(4)}</span></div><p className="line-clamp-5 text-xs leading-5 text-slate-300">{chunk.content}</p></div>)}</CardContent></Card>
          ) : null}
        </aside>
      </section>
    </div>
  );
}
