'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  CircleHelp,
  Gauge,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Send,
  Sparkles,
  UserRound,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface Citation {
  ruleCode?: string;
  documentTitle?: string;
  quote: string;
  relevanceScore?: number;
}

interface ClarificationOption {
  id: string;
  label: string;
  targetScenarioKey?: string;
}

interface AnswerResult {
  sessionId: string;
  answer: string;
  confidence: number;
  confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient';
  needsClarification: boolean;
  citations: Citation[];
  domainsUsed: string[];
  scenarioKey?: string;
  scenarioLabel?: string;
  scenarioClarification?: {
    atNodeKey: string;
    prompt: string;
    options: ClarificationOption[];
  };
  clarificationQuestion?: {
    question: string;
    options: string[];
  };
  answerSource?: 'knowledge_base' | 'general_ai' | 'deterministic_guardrail';
  requiresHumanReview?: boolean;
  debug?: {
    chunks: Array<{
      content: string;
      semanticScore?: number;
      keywordScore?: number;
      combinedScore?: number;
      similarity?: number;
    }>;
    intentClassification: string | { intent?: string };
  };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  result?: AnswerResult;
}

interface PendingClarification {
  rootQuestion: string;
  answers: string[];
}

const suggestions = [
  'АПОСТИЛЬ',
  'Какие услуги бюро оказывает по ВНЖ?',
  'Для каких стран нужна консульская легализация?',
  'Как рассчитать стоимость машинного перевода?',
];

const sourceLabels: Record<NonNullable<AnswerResult['answerSource']>, string> = {
  knowledge_base: 'База знаний',
  general_ai: 'Общие знания ИИ',
  deterministic_guardrail: 'Проверенное правило',
};

function messageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={`${part}-${index}`} className="font-semibold text-slate-950">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

function AnswerBody({ content }: { content: string }) {
  return (
    <div className="space-y-2.5 text-[15px] leading-7 text-slate-700">
      {content.split('\n').map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={`space-${index}`} className="h-1" />;
        if (trimmed.startsWith('### ')) {
          return <h4 key={`h4-${index}`} className="pt-2 text-sm font-semibold text-slate-950">{formatInline(trimmed.slice(4))}</h4>;
        }
        if (trimmed.startsWith('## ')) {
          return <h3 key={`h3-${index}`} className="pt-2 text-base font-semibold text-slate-950">{formatInline(trimmed.slice(3))}</h3>;
        }
        if (trimmed.startsWith('# ')) {
          return <h2 key={`h2-${index}`} className="pt-1 text-lg font-semibold text-slate-950">{formatInline(trimmed.slice(2))}</h2>;
        }
        if (/^[-•]\s/.test(trimmed)) {
          return (
            <div key={`bullet-${index}`} className="flex gap-2 pl-1">
              <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-emerald-500" />
              <p>{formatInline(trimmed.replace(/^[-•]\s/, ''))}</p>
            </div>
          );
        }
        return <p key={`p-${index}`}>{formatInline(trimmed)}</p>;
      })}
    </div>
  );
}

function clarificationOptions(result?: AnswerResult): ClarificationOption[] {
  if (result?.scenarioClarification) return result.scenarioClarification.options;
  return (result?.clarificationQuestion?.options ?? []).map((label, index) => ({
    id: `option-${index}`,
    label,
  }));
}

export default function PlaygroundPage() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingClarification, setPendingClarification] = useState<PendingClarification | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const activeResult = useMemo(
    () => [...messages].reverse().find((message) => message.result)?.result,
    [messages]
  );

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  async function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || loading) return;

    const clarificationAtSend = pendingClarification;
    const rootQuestion = clarificationAtSend?.rootQuestion ?? text;
    const clarificationAnswers = clarificationAtSend
      ? [...clarificationAtSend.answers, text]
      : [];

    setMessages((current) => [
      ...current,
      { id: messageId(), role: 'user', content: text },
    ]);
    setDraft('');
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: rootQuestion,
          sessionId: sessionId ?? undefined,
          includeDebug: showDebug,
          useConversationContext: !clarificationAtSend && Boolean(sessionId),
          clarificationAnswer: clarificationAtSend
            ? clarificationAnswers.join(' → ')
            : undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Не удалось получить ответ');
      }

      const result = data as AnswerResult;
      const assistantText =
        result.scenarioClarification?.prompt ??
        result.clarificationQuestion?.question ??
        result.answer;

      setSessionId(result.sessionId);
      setMessages((current) => [
        ...current,
        { id: messageId(), role: 'assistant', content: assistantText, result },
      ]);

      if (result.needsClarification) {
        setPendingClarification({
          rootQuestion,
          answers: clarificationAnswers,
        });
      } else {
        setPendingClarification(null);
      }
    } catch (requestError) {
      console.error('Error asking question:', requestError);
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Не удалось получить ответ. Попробуйте ещё раз.'
      );
    } finally {
      setLoading(false);
      window.setTimeout(() => composerRef.current?.focus(), 0);
    }
  }

  function startNewConversation() {
    setMessages([]);
    setSessionId(null);
    setPendingClarification(null);
    setDraft('');
    setError(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  const confidencePercent = activeResult ? Math.round(activeResult.confidence * 100) : 0;
  const confidenceTone =
    confidencePercent >= 80
      ? 'bg-emerald-500'
      : confidencePercent >= 60
        ? 'bg-amber-500'
        : 'bg-rose-500';

  return (
    <div className="relative min-h-screen overflow-hidden bg-hero">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-25" />
      <div className="relative">
        <header className="border-b border-white/70 bg-white/75 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-slate-950 text-white shadow-elevated">
                <MessageSquareText className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-sm font-semibold text-slate-950 sm:text-base">Диалог с библиотекой</h1>
                  <Badge className="hidden bg-emerald-100 text-emerald-800 sm:inline-flex">Онлайн</Badge>
                </div>
                <p className="truncate text-xs text-slate-500">Уточняет контекст и отвечает по источникам бюро</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={startNewConversation}
                className="rounded-full border-slate-200 bg-white/80"
              >
                <Plus />
                <span className="hidden sm:inline">Новый диалог</span>
              </Button>
              <Button variant="ghost" asChild className="hidden text-slate-600 md:inline-flex">
                <Link href="/">Главная</Link>
              </Button>
              <Button asChild size="sm" className="hidden rounded-full bg-slate-950 text-white hover:bg-slate-800 sm:inline-flex">
                <Link href="/admin">
                  Админ
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto grid max-w-[1440px] gap-5 px-3 py-4 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="glass-panel min-h-[calc(100vh-7.5rem)] overflow-hidden rounded-[28px] border-white/70 py-0 lg:h-[calc(100vh-7.5rem)] lg:min-h-0">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-slate-200/70 bg-white/55 px-5 py-3.5">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Sparkles className="size-3.5 text-emerald-600" />
                  {pendingClarification ? 'Жду вашего уточнения' : 'Можно задавать следующий вопрос'}
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={showDebug}
                    onChange={(event) => setShowDebug(event.target.checked)}
                    className="size-4 rounded border-slate-300 accent-emerald-600"
                  />
                  <span className="hidden sm:inline">Отладка</span>
                  <Wrench className="size-3.5 sm:hidden" />
                </label>
              </div>

              <div
                className="min-h-[420px] flex-1 overflow-y-auto px-4 py-6 sm:px-7 lg:min-h-0"
                aria-live="polite"
                aria-label="История диалога"
              >
                {messages.length === 0 ? (
                  <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center py-10 text-center">
                    <div className="relative mb-6">
                      <div className="absolute inset-0 rounded-full bg-emerald-300/30 blur-2xl" />
                      <div className="relative grid size-16 place-items-center rounded-3xl border border-white bg-white/85 text-emerald-700 shadow-elevated">
                        <Bot className="size-8" />
                      </div>
                    </div>
                    <Badge variant="outline" className="mb-3 border-emerald-200 bg-emerald-50/80 text-emerald-800">
                      Диалоговый режим
                    </Badge>
                    <h2 className="font-display text-3xl font-semibold text-slate-950 sm:text-4xl">
                      Спросите о работе бюро
                    </h2>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-base">
                      Я задам уточняющие вопросы, если контекста не хватает, и сохраню ответы внутри этого диалога.
                    </p>
                    <div className="mt-7 grid w-full gap-2 sm:grid-cols-2">
                      {suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => sendMessage(suggestion)}
                          className="rounded-2xl border border-slate-200/80 bg-white/70 px-4 py-3 text-left text-sm text-slate-700 transition hover:-translate-y-0.5 hover:border-emerald-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mx-auto max-w-3xl space-y-7">
                    {messages.map((message) => {
                      const options = clarificationOptions(message.result);
                      return message.role === 'user' ? (
                        <div key={message.id} className="flex justify-end gap-3 animate-fade-rise motion-reduce:animate-none">
                          <div className="max-w-[85%] rounded-[24px] rounded-br-md bg-slate-950 px-5 py-3.5 text-[15px] leading-6 text-white shadow-elevated sm:max-w-[72%]">
                            {message.content}
                          </div>
                          <div className="mt-1 hidden size-8 shrink-0 place-items-center rounded-full bg-slate-200 text-slate-600 sm:grid">
                            <UserRound className="size-4" />
                          </div>
                        </div>
                      ) : (
                        <div key={message.id} className="flex gap-3 animate-fade-rise motion-reduce:animate-none">
                          <div className="mt-1 grid size-9 shrink-0 place-items-center rounded-2xl bg-emerald-600 text-white shadow-sm">
                            <Bot className="size-4.5" />
                          </div>
                          <div className="min-w-0 max-w-[92%] space-y-3 sm:max-w-[82%]">
                            <div className="rounded-[24px] rounded-tl-md border border-slate-200/80 bg-white/85 px-5 py-4 shadow-sm">
                              {message.result?.needsClarification ? (
                                <div className="mb-3 flex items-center gap-2 text-xs font-medium text-amber-700">
                                  <CircleHelp className="size-4" />
                                  Нужно уточнение
                                </div>
                              ) : null}
                              <AnswerBody content={message.content} />
                              {!message.result?.needsClarification && message.result ? (
                                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
                                  <CheckCircle2 className="size-3.5 text-emerald-600" />
                                  {Math.round(message.result.confidence * 100)}% уверенности
                                  {message.result.answerSource ? (
                                    <>
                                      <span className="text-slate-300">•</span>
                                      {sourceLabels[message.result.answerSource]}
                                    </>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            {options.length > 0 ? (
                              <div className="flex flex-wrap gap-2" aria-label="Варианты ответа">
                                {options.map((option) => (
                                  <Button
                                    key={option.id}
                                    type="button"
                                    variant="outline"
                                    onClick={() => sendMessage(option.label)}
                                    disabled={loading || message !== messages[messages.length - 1]}
                                    className="h-auto min-h-9 whitespace-normal rounded-full border-emerald-200 bg-emerald-50/80 px-4 py-2 text-left text-emerald-900 hover:border-emerald-300 hover:bg-emerald-100"
                                  >
                                    {option.label}
                                  </Button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}

                    {loading ? (
                      <div className="flex gap-3" role="status">
                        <div className="grid size-9 shrink-0 place-items-center rounded-2xl bg-emerald-600 text-white">
                          <Bot className="size-4.5" />
                        </div>
                        <div className="flex items-center gap-2 rounded-[24px] rounded-tl-md border border-slate-200/80 bg-white/85 px-5 py-4 text-sm text-slate-500 shadow-sm">
                          <LoaderCircle className="size-4 animate-spin text-emerald-600" />
                          Ищу в базе знаний и проверяю источники…
                        </div>
                      </div>
                    ) : null}
                    <div ref={conversationEndRef} />
                  </div>
                )}
              </div>

              <div className="border-t border-slate-200/70 bg-white/70 p-3 backdrop-blur sm:p-4">
                {error ? (
                  <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700" role="alert">
                    {error}
                  </div>
                ) : null}
                <div className="mx-auto max-w-3xl">
                  {pendingClarification ? (
                    <div className="mb-2 flex items-center gap-2 px-1 text-xs text-amber-700">
                      <CircleHelp className="size-3.5" />
                      Ответьте вариантом выше или напишите уточнение своими словами
                    </div>
                  ) : null}
                  <div className="flex items-end gap-2 rounded-[24px] border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-emerald-400 focus-within:ring-4 focus-within:ring-emerald-100/70">
                    <Textarea
                      ref={composerRef}
                      aria-label={pendingClarification ? 'Ответ на уточняющий вопрос' : 'Сообщение библиотекарю'}
                      placeholder={pendingClarification ? 'Введите уточнение…' : 'Напишите вопрос…'}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      disabled={loading}
                      rows={1}
                      className="max-h-36 min-h-11 resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] shadow-none focus-visible:ring-0"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void sendMessage(draft);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="icon"
                      onClick={() => sendMessage(draft)}
                      disabled={loading || !draft.trim()}
                      aria-label="Отправить сообщение"
                      className="size-11 shrink-0 rounded-2xl bg-slate-950 text-white hover:bg-emerald-700"
                    >
                      {loading ? <LoaderCircle className="animate-spin" /> : <Send />}
                    </Button>
                  </div>
                  <p className="mt-2 px-2 text-center text-[11px] text-slate-400">
                    Enter — отправить · Shift + Enter — новая строка
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <aside className="space-y-4 lg:h-[calc(100vh-7.5rem)] lg:overflow-y-auto lg:pr-1">
            <Card className="glass-panel rounded-[24px] border-white/70 py-0">
              <CardHeader className="pb-0">
                <div className="flex items-center gap-2">
                  <Gauge className="size-4 text-emerald-600" />
                  <CardTitle className="text-sm text-slate-950">Контекст ответа</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pb-5">
                {activeResult ? (
                  <>
                    <div>
                      <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                        <span>Уверенность</span>
                        <span className="font-mono font-semibold text-slate-800">{confidencePercent}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
                        <div className={`h-full rounded-full transition-all duration-500 ${confidenceTone}`} style={{ width: `${confidencePercent}%` }} />
                      </div>
                    </div>
                    {activeResult.scenarioLabel ? (
                      <div className="rounded-2xl bg-slate-950 p-3 text-xs text-white">
                        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-slate-400">Сценарий</div>
                        {activeResult.scenarioLabel}
                      </div>
                    ) : null}
                    {activeResult.domainsUsed.length > 0 ? (
                      <div>
                        <div className="mb-2 text-xs font-medium text-slate-500">Домены</div>
                        <div className="flex flex-wrap gap-1.5">
                          {activeResult.domainsUsed.map((domain) => (
                            <Badge key={domain} variant="outline" className="border-slate-200 bg-white/80 text-[10px] text-slate-600">{domain}</Badge>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-white/50 p-4 text-sm leading-6 text-slate-500">
                    Здесь появятся уверенность, сценарий и домены после первого ответа.
                  </div>
                )}
              </CardContent>
            </Card>

            {activeResult?.citations?.length ? (
              <Card className="glass-panel rounded-[24px] border-white/70 py-0">
                <CardHeader className="pb-0">
                  <div className="flex items-center gap-2">
                    <BookOpen className="size-4 text-emerald-600" />
                    <CardTitle className="text-sm text-slate-950">Источники</CardTitle>
                    <Badge variant="outline" className="ml-auto bg-white/80 text-[10px]">{activeResult.citations.length}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2.5 pb-5">
                  {activeResult.citations.map((citation, index) => (
                    <div key={`${citation.ruleCode ?? 'source'}-${index}`} className="rounded-2xl border border-slate-200/80 bg-white/75 p-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {citation.ruleCode ? <Badge variant="outline" className="bg-white text-[10px]">{citation.ruleCode}</Badge> : null}
                        {citation.documentTitle ? <span className="line-clamp-1 text-[11px] text-slate-500">{citation.documentTitle}</span> : null}
                      </div>
                      <p className="mt-2 line-clamp-4 text-xs italic leading-5 text-slate-600">“{citation.quote}”</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {showDebug && activeResult?.debug ? (
              <Card className="glass-panel rounded-[24px] border-white/70 py-0">
                <CardHeader className="pb-0">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-4 text-slate-600" />
                    <CardTitle className="text-sm text-slate-950">Отладка</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="pb-5">
                  <Tabs defaultValue="chunks">
                    <TabsList className="w-full bg-white/70">
                      <TabsTrigger value="chunks">Фрагменты</TabsTrigger>
                      <TabsTrigger value="intent">Намерение</TabsTrigger>
                    </TabsList>
                    <TabsContent value="chunks" className="mt-3 space-y-2">
                      {activeResult.debug.chunks.slice(0, 5).map((chunk, index) => {
                        const score = chunk.combinedScore ?? chunk.similarity ?? chunk.semanticScore ?? 0;
                        return (
                          <div key={`chunk-${index}`} className="rounded-xl bg-white/75 p-3 text-xs text-slate-600">
                            <div className="mb-1 font-mono text-[10px] text-emerald-700">{Math.round(score * 100)}% совпадения</div>
                            <p className="line-clamp-4 leading-5">{chunk.content}</p>
                          </div>
                        );
                      })}
                    </TabsContent>
                    <TabsContent value="intent" className="mt-3 rounded-xl bg-white/75 p-3 text-xs text-slate-700">
                      {typeof activeResult.debug.intentClassification === 'string'
                        ? activeResult.debug.intentClassification
                        : activeResult.debug.intentClassification.intent ?? 'Не определено'}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            ) : null}
          </aside>
        </main>
      </div>
    </div>
  );
}
