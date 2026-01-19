'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface AIQuestion {
  id: string;
  issueType: string;
  question: string;
  context: Record<string, unknown> | null;
  proposedChange: { old: string; new: string } | null;
  status: string;
  response: string | null;
  createdAt: string;
}

export default function AIQuestionsPage() {
  const [questions, setQuestions] = useState<AIQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});

  async function fetchQuestions() {
    try {
      const response = await fetch('/api/ai-questions');
      const data = await response.json();
      setQuestions(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching questions:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchQuestions();
  }, []);

  async function handleAction(id: string, action: 'answer' | 'dismiss') {
    setProcessing(id);
    try {
      const response = await fetch(`/api/ai-questions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          response: action === 'answer' ? responses[id] : undefined,
        }),
      });

      if (response.ok) {
        fetchQuestions();
      } else {
        const error = await response.json();
        alert(error.error || 'Ошибка действия');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Ошибка действия');
    } finally {
      setProcessing(null);
    }
  }

  function getIssueTypeBadge(type: string) {
    const labels: Record<string, string> = {
      ambiguous: 'Неоднозначно',
      outdated: 'Устарело',
      conflicting: 'Конфликт',
      missing_context: 'Нет контекста',
      price_conflict: 'Конфликт цен',
    };
    const colors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      ambiguous: 'secondary',
      outdated: 'destructive',
      conflicting: 'destructive',
      missing_context: 'outline',
      price_conflict: 'destructive',
    };
    return (
      <Badge variant={colors[type] || 'outline'}>
        {labels[type] || type}
      </Badge>
    );
  }

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  const openQuestions = questions.filter((q) => q.status === 'OPEN');
  const closedQuestions = questions.filter((q) => q.status !== 'OPEN');

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Вопросы ИИ</h1>

      {openQuestions.length === 0 && closedQuestions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            Вопросов ИИ пока нет. Вопросы появятся, когда ИИ столкнётся
            с неопределённостями при обработке документов.
          </CardContent>
        </Card>
      ) : (
        <>
          {openQuestions.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-4">
                Открытые вопросы ({openQuestions.length})
              </h2>
              <div className="space-y-4">
                {openQuestions.map((q) => (
                  <Card key={q.id} className="border-orange-200 bg-orange-50">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">{q.question}</CardTitle>
                        {getIssueTypeBadge(q.issueType)}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        {q.context && (
                          <div className="text-sm bg-white rounded p-3 border">
                            <span className="font-medium">Контекст:</span>{' '}
                            {JSON.stringify(q.context)}
                          </div>
                        )}
                        {q.proposedChange && (
                          <div className="text-sm bg-white rounded p-3 border">
                            <span className="font-medium">Предлагаемое изменение:</span>
                            <div className="mt-1 font-mono text-xs">
                              <span className="text-red-600 line-through">
                                {q.proposedChange.old}
                              </span>
                              {' → '}
                              <span className="text-green-600">
                                {q.proposedChange.new}
                              </span>
                            </div>
                          </div>
                        )}
                        <div>
                          <Textarea
                            placeholder="Ваш ответ..."
                            value={responses[q.id] || ''}
                            onChange={(e) =>
                              setResponses((prev) => ({
                                ...prev,
                                [q.id]: e.target.value,
                              }))
                            }
                            className="bg-white"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleAction(q.id, 'answer')}
                            disabled={processing === q.id || !responses[q.id]}
                          >
                            Отправить ответ
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleAction(q.id, 'dismiss')}
                            disabled={processing === q.id}
                          >
                            Отклонить
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {closedQuestions.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-4">
                Закрытые ({closedQuestions.length})
              </h2>
              <div className="space-y-2">
                {closedQuestions.map((q) => (
                  <div
                    key={q.id}
                    className="p-3 bg-white rounded border flex items-center justify-between"
                  >
                    <div className="flex-1">
                      <div className="text-sm">{q.question}</div>
                      {q.response && (
                        <div className="text-xs text-gray-500 mt-1">
                          Ответ: {q.response}
                        </div>
                      )}
                    </div>
                    <Badge variant={q.status === 'ANSWERED' ? 'default' : 'secondary'}>
                      {q.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
