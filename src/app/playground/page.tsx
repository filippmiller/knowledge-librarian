'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BookOpen,
  History,
  MessageSquareText,
  Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface Citation {
  ruleCode?: string;
  documentTitle?: string;
  quote: string;
}

interface AnswerResult {
  answer: string;
  confidence: number;
  citations: Citation[];
  domainsUsed: string[];
  debug?: {
    chunks: { content: string; similarity: number }[];
    intentClassification: string;
  };
}

export default function PlaygroundPage() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [history, setHistory] = useState<{ question: string; answer: string }[]>([]);
  const suggestions = [
    'Как переводить SLA в B2B контракте?',
    'Какие термины использовать для UI элементов?',
    'Как оформлять единицы измерения в документации?',
    'Где хранится словарь терминов проекта?',
  ];
  const confidencePercent = result ? Math.round(result.confidence * 100) : 0;
  const confidenceTone =
    result && result.confidence >= 0.8
      ? 'bg-emerald-500'
      : result && result.confidence >= 0.6
        ? 'bg-amber-500'
        : 'bg-rose-500';

  async function handleAsk() {
    if (!question.trim()) return;

    setLoading(true);
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, includeDebug: showDebug }),
      });

      if (response.ok) {
        const data = await response.json();
        setResult(data);
        setHistory((prev) => [
          { question, answer: data.answer },
          ...prev.slice(0, 9),
        ]);
      } else {
        const error = await response.json();
        alert(error.error || 'Не удалось получить ответ');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Не удалось получить ответ');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-hero">
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-30" />
      <div className="relative">
        <header className="border-b border-white/70 bg-white/70 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
            <div className="flex items-center gap-3">
              <Badge
                variant="outline"
                className="border-emerald-200/80 bg-white/80 text-slate-700"
              >
                <Sparkles className="text-emerald-500" />
                Песочница знаний
              </Badge>
              <span className="hidden text-sm text-slate-500 md:inline">
                Ответы с контекстом и источниками
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="ghost" asChild className="text-slate-600">
                <Link href="/">Главная</Link>
              </Button>
              <Button
                asChild
                className="rounded-full bg-slate-900 px-5 text-white hover:bg-slate-800"
              >
                <Link href="/admin">
                  Панель администратора
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
          <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="space-y-6 animate-fade-rise motion-reduce:animate-none [animation-delay:120ms]">
              <Card className="glass-panel rounded-3xl border-white/60 py-0">
                <CardHeader className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <MessageSquareText className="size-4 text-emerald-600" />
                    Задайте вопрос
                  </div>
                  <p className="text-sm text-slate-600">
                    Поддерживаются свободные формулировки. Добавьте контекст, чтобы получить точные
                    ответы и релевантные источники.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  <Textarea
                    placeholder="Задайте вопрос по базе знаний..."
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    className="min-h-28 rounded-2xl border-slate-200/70 bg-white/80 text-base shadow-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.ctrlKey) {
                        handleAsk();
                      }
                    }}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <label className="flex items-center gap-3 text-sm text-slate-600">
                      <span className="relative inline-flex h-6 w-11 items-center">
                        <input
                          type="checkbox"
                          checked={showDebug}
                          onChange={(e) => setShowDebug(e.target.checked)}
                          className="peer sr-only"
                        />
                        <span className="absolute inset-0 rounded-full bg-slate-200 transition peer-checked:bg-emerald-500" />
                        <span className="absolute left-1 h-4 w-4 rounded-full bg-white transition peer-checked:translate-x-5" />
                      </span>
                      Показать отладочную информацию
                    </label>
                    <Button
                      onClick={handleAsk}
                      disabled={loading || !question.trim()}
                      className="rounded-full bg-slate-900 px-6 text-white hover:bg-slate-800"
                    >
                      {loading ? 'Думаю...' : 'Спросить'}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    <span className="rounded-full border border-slate-200/70 bg-white/70 px-3 py-1">
                      Ctrl + Enter
                    </span>
                    <span className="rounded-full border border-slate-200/70 bg-white/70 px-3 py-1">
                      Ответы с источниками
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card className="glass-panel rounded-3xl border-white/60 py-0">
                <CardContent className="space-y-4 p-6">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-slate-900">Подсказки</div>
                    <Badge variant="outline" className="border-slate-200/70 bg-white/80 text-slate-700">
                      Частые запросы
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((prompt) => (
                      <Button
                        key={prompt}
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="rounded-full bg-white/80 text-slate-700 hover:bg-white"
                        onClick={() => setQuestion(prompt)}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </section>

            <section className="space-y-6 animate-fade-rise motion-reduce:animate-none [animation-delay:200ms]">
              <Card className="glass-panel rounded-3xl border-white/60 py-0">
                <CardHeader className="space-y-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base text-slate-900">Ответ</CardTitle>
                    {result ? (
                      <Badge className="bg-slate-900 text-white">
                        {confidencePercent}% уверенности
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-slate-200/70 bg-white/80 text-slate-600">
                        Ожидание запроса
                      </Badge>
                    )}
                  </div>
                  {result ? (
                    <div className="h-2 w-full rounded-full bg-slate-200/70">
                      <div
                        className={`h-full rounded-full ${confidenceTone}`}
                        style={{ width: `${confidencePercent}%` }}
                      />
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  {result ? (
                    <>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                        {result.answer}
                      </p>
                      {result.domainsUsed.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                          <span>Домены:</span>
                          {result.domainsUsed.map((domain) => (
                            <Badge
                              key={domain}
                              variant="outline"
                              className="border-slate-200/70 bg-white/80 text-slate-700"
                            >
                              {domain}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200/80 bg-white/70 p-6 text-sm text-slate-500">
                      {loading
                        ? 'Формируем ответ, проверяем источники и уверенность...'
                        : 'Здесь появится ответ после запроса.'}
                    </div>
                  )}
                </CardContent>
              </Card>

              {result && result.citations.length > 0 && (
                <Card className="glass-panel rounded-3xl border-white/60 py-0">
                  <CardHeader className="flex items-center gap-2 space-y-0">
                    <BookOpen className="size-4 text-emerald-600" />
                    <CardTitle className="text-base text-slate-900">Источники</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-0">
                    {result.citations.map((citation, i) => (
                      <div
                        key={i}
                        className="rounded-2xl border border-slate-200/70 bg-white/80 p-4 text-sm text-slate-700"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          {citation.ruleCode && (
                            <Badge variant="outline" className="border-slate-200/70 bg-white/90 text-slate-700">
                              {citation.ruleCode}
                            </Badge>
                          )}
                          {citation.documentTitle && (
                            <span className="text-xs text-slate-500">
                              {citation.documentTitle}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 italic text-slate-600">"{citation.quote}"</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {showDebug && result?.debug && (
                <Card className="glass-panel rounded-3xl border-white/60 py-0">
                  <CardHeader>
                    <CardTitle className="text-base text-slate-900">Отладка</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Tabs defaultValue="chunks">
                      <TabsList className="bg-white/70">
                        <TabsTrigger value="chunks">Полученные фрагменты</TabsTrigger>
                        <TabsTrigger value="intent">Намерение</TabsTrigger>
                      </TabsList>
                      <TabsContent value="chunks" className="mt-3">
                        <div className="space-y-2">
                          {result.debug.chunks.map((chunk, i) => (
                            <div key={i} className="rounded-2xl bg-white/80 p-3 text-xs text-slate-600">
                              <div className="font-mono text-slate-500">
                                Сходство: {(chunk.similarity * 100).toFixed(1)}%
                              </div>
                              <div className="mt-1 text-slate-700">{chunk.content}</div>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                      <TabsContent value="intent" className="mt-3">
                        <div className="rounded-2xl bg-white/80 p-4 text-sm text-slate-700">
                          <span className="font-semibold">Распознанное намерение: </span>
                          <code>{result.debug.intentClassification}</code>
                        </div>
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
              )}
            </section>
          </div>

          {history.length > 0 && (
            <Card className="glass-panel rounded-3xl border-white/60 py-0 animate-fade-rise motion-reduce:animate-none [animation-delay:280ms]">
              <CardHeader className="flex items-center gap-2 space-y-0">
                <History className="size-4 text-emerald-600" />
                <CardTitle className="text-base text-slate-900">Недавние вопросы</CardTitle>
              </CardHeader>
              <CardContent className="pt-2">
                <ScrollArea className="max-h-64 pr-4">
                  <div className="space-y-4">
                    {history.map((item, i) => (
                      <div key={i} className="border-b border-slate-200/60 pb-4 last:border-0 last:pb-0">
                        <button
                          className="w-full text-left"
                          onClick={() => {
                            setQuestion(item.question);
                          }}
                        >
                          <div className="text-sm font-semibold text-slate-900 hover:text-emerald-700">
                            {item.question}
                          </div>
                          <div className="mt-1 line-clamp-2 text-sm text-slate-500">
                            {item.answer}
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}
