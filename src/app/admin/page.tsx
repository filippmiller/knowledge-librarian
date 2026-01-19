'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Stats {
  documents: number;
  domains: number;
  rules: number;
  qaPairs: number;
  pendingSuggestions: number;
  openQuestions: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      try {
        const [docs, domains, rules, qa, suggestions, questions] = await Promise.all([
          fetch('/api/documents').then((r) => r.json()),
          fetch('/api/domains').then((r) => r.json()),
          fetch('/api/rules').then((r) => r.json()),
          fetch('/api/qa').then((r) => r.json()),
          fetch('/api/domain-suggestions').then((r) => r.json()),
          fetch('/api/ai-questions').then((r) => r.json()),
        ]);

        setStats({
          documents: Array.isArray(docs) ? docs.length : 0,
          domains: Array.isArray(domains) ? domains.length : 0,
          rules: Array.isArray(rules) ? rules.length : 0,
          qaPairs: Array.isArray(qa) ? qa.length : 0,
          pendingSuggestions: Array.isArray(suggestions)
            ? suggestions.filter((s: { status: string }) => s.status === 'PENDING').length
            : 0,
          openQuestions: Array.isArray(questions)
            ? questions.filter((q: { status: string }) => q.status === 'OPEN').length
            : 0,
        });
      } catch (error) {
        console.error('Error fetching stats:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, []);

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Панель управления</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              Документы
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.documents || 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              Домены
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.domains || 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              Активные правила
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.rules || 0}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              Пары вопросов-ответов
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.qaPairs || 0}</div>
          </CardContent>
        </Card>

        <Card className={stats?.pendingSuggestions ? 'border-yellow-300 bg-yellow-50' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              Ожидающие предложения доменов
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.pendingSuggestions || 0}</div>
          </CardContent>
        </Card>

        <Card className={stats?.openQuestions ? 'border-orange-300 bg-orange-50' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-500">
              Открытые вопросы ИИ
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.openQuestions || 0}</div>
          </CardContent>
        </Card>
      </div>

      {(stats?.pendingSuggestions || stats?.openQuestions) ? (
        <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h2 className="font-semibold text-blue-900">Требуются действия</h2>
          <p className="text-blue-700 text-sm mt-1">
            Есть элементы, ожидающие вашего внимания. Пожалуйста, проверьте
            предложения доменов и вопросы ИИ.
          </p>
        </div>
      ) : null}
    </div>
  );
}
