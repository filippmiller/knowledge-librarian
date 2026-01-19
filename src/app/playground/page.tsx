'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
        alert(error.error || 'Failed to get answer');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Failed to get answer');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-4xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-xl font-bold">Knowledge Playground</h1>
          <Link href="/admin" className="text-sm text-gray-600 hover:text-gray-900">
            Admin Panel
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Question Input */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <Textarea
              placeholder="Ask a question about the knowledge base..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="min-h-24 text-lg"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  handleAsk();
                }
              }}
            />
            <div className="flex justify-between items-center mt-4">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={showDebug}
                  onChange={(e) => setShowDebug(e.target.checked)}
                  className="rounded"
                />
                Show debug info
              </label>
              <Button onClick={handleAsk} disabled={loading || !question.trim()}>
                {loading ? 'Thinking...' : 'Ask'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Answer */}
        {result && (
          <Card className="mb-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Answer</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant={result.confidence >= 0.8 ? 'default' : 'secondary'}>
                    {(result.confidence * 100).toFixed(0)}% confidence
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm max-w-none">
                <p className="whitespace-pre-wrap">{result.answer}</p>
              </div>

              {result.domainsUsed.length > 0 && (
                <div className="flex items-center gap-2 mt-4">
                  <span className="text-sm text-gray-500">Domains:</span>
                  {result.domainsUsed.map((domain) => (
                    <Badge key={domain} variant="outline">
                      {domain}
                    </Badge>
                  ))}
                </div>
              )}

              {result.citations.length > 0 && (
                <>
                  <Separator className="my-4" />
                  <div>
                    <h4 className="font-medium text-sm mb-2">Citations</h4>
                    <div className="space-y-2">
                      {result.citations.map((citation, i) => (
                        <div key={i} className="text-sm bg-gray-50 rounded p-3">
                          {citation.ruleCode && (
                            <Badge variant="outline" className="mr-2 mb-1">
                              {citation.ruleCode}
                            </Badge>
                          )}
                          {citation.documentTitle && (
                            <span className="text-gray-500 text-xs">
                              {citation.documentTitle}
                            </span>
                          )}
                          <p className="text-gray-700 mt-1 italic">
                            "{citation.quote}"
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {showDebug && result.debug && (
                <>
                  <Separator className="my-4" />
                  <Tabs defaultValue="chunks">
                    <TabsList>
                      <TabsTrigger value="chunks">Retrieved Chunks</TabsTrigger>
                      <TabsTrigger value="intent">Intent</TabsTrigger>
                    </TabsList>
                    <TabsContent value="chunks" className="mt-2">
                      <div className="space-y-2">
                        {result.debug.chunks.map((chunk, i) => (
                          <div key={i} className="text-xs bg-gray-100 rounded p-2">
                            <div className="font-mono text-gray-500 mb-1">
                              Similarity: {(chunk.similarity * 100).toFixed(1)}%
                            </div>
                            <div className="text-gray-700">{chunk.content}</div>
                          </div>
                        ))}
                      </div>
                    </TabsContent>
                    <TabsContent value="intent" className="mt-2">
                      <div className="text-sm">
                        <span className="font-medium">Classified Intent: </span>
                        <code>{result.debug.intentClassification}</code>
                      </div>
                    </TabsContent>
                  </Tabs>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* History */}
        {history.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Questions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {history.map((item, i) => (
                  <div key={i} className="border-b last:border-0 pb-3 last:pb-0">
                    <button
                      className="text-left w-full"
                      onClick={() => {
                        setQuestion(item.question);
                      }}
                    >
                      <div className="font-medium text-sm text-blue-600 hover:underline">
                        {item.question}
                      </div>
                      <div className="text-sm text-gray-500 line-clamp-2 mt-1">
                        {item.answer}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
