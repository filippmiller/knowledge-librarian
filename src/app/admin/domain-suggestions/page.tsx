'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface DomainSuggestion {
  id: string;
  suggestedSlug: string;
  title: string;
  description: string | null;
  parentSlug: string | null;
  confidence: number;
  reason: string;
  status: string;
  createdAt: string;
  document: { title: string; filename: string } | null;
}

export default function DomainSuggestionsPage() {
  const [suggestions, setSuggestions] = useState<DomainSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  async function fetchSuggestions() {
    try {
      const response = await fetch('/api/domain-suggestions');
      const data = await response.json();
      setSuggestions(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching suggestions:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSuggestions();
  }, []);

  async function handleAction(id: string, action: 'approve' | 'reject') {
    setProcessing(id);
    try {
      const response = await fetch(`/api/domain-suggestions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (response.ok) {
        fetchSuggestions();
      } else {
        const error = await response.json();
        alert(error.error || 'Action failed');
      }
    } catch (error) {
      console.error('Error:', error);
      alert('Action failed');
    } finally {
      setProcessing(null);
    }
  }

  function getStatusBadge(status: string) {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      PENDING: 'outline',
      APPROVED: 'default',
      REJECTED: 'destructive',
    };
    return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
  }

  if (loading) {
    return <div className="text-center py-8">Loading...</div>;
  }

  const pendingSuggestions = suggestions.filter((s) => s.status === 'PENDING');
  const processedSuggestions = suggestions.filter((s) => s.status !== 'PENDING');

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Domain Suggestions</h1>

      {pendingSuggestions.length === 0 && processedSuggestions.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No domain suggestions yet. Upload documents to generate suggestions.
          </CardContent>
        </Card>
      ) : (
        <>
          {pendingSuggestions.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-4">
                Pending Review ({pendingSuggestions.length})
              </h2>
              <div className="space-y-4">
                {pendingSuggestions.map((suggestion) => (
                  <Card key={suggestion.id} className="border-yellow-200 bg-yellow-50">
                    <CardHeader>
                      <div className="flex justify-between items-start">
                        <div>
                          <CardTitle className="text-lg">
                            <code className="font-mono">{suggestion.suggestedSlug}</code>
                          </CardTitle>
                          <p className="text-sm text-gray-600 mt-1">
                            {suggestion.title}
                          </p>
                        </div>
                        <Badge variant="outline">
                          {(suggestion.confidence * 100).toFixed(0)}% confidence
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {suggestion.description && (
                          <p className="text-sm">{suggestion.description}</p>
                        )}
                        {suggestion.parentSlug && (
                          <p className="text-sm text-gray-600">
                            Parent: <code>{suggestion.parentSlug}</code>
                          </p>
                        )}
                        <div className="p-3 bg-white rounded border">
                          <p className="text-sm font-medium text-gray-700">
                            AI Reasoning:
                          </p>
                          <p className="text-sm mt-1">{suggestion.reason}</p>
                        </div>
                        {suggestion.document && (
                          <p className="text-xs text-gray-500">
                            From: {suggestion.document.title}
                          </p>
                        )}
                        <div className="flex gap-2 pt-2">
                          <Button
                            size="sm"
                            onClick={() => handleAction(suggestion.id, 'approve')}
                            disabled={processing === suggestion.id}
                          >
                            Approve & Create Domain
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleAction(suggestion.id, 'reject')}
                            disabled={processing === suggestion.id}
                          >
                            Reject
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {processedSuggestions.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold mb-4">
                Processed ({processedSuggestions.length})
              </h2>
              <div className="space-y-2">
                {processedSuggestions.map((suggestion) => (
                  <div
                    key={suggestion.id}
                    className="flex items-center justify-between p-3 bg-white rounded border"
                  >
                    <div>
                      <code className="font-mono text-sm">
                        {suggestion.suggestedSlug}
                      </code>
                      <span className="text-gray-500 text-sm ml-2">
                        {suggestion.title}
                      </span>
                    </div>
                    {getStatusBadge(suggestion.status)}
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
