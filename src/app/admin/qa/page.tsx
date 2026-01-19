'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface QAPair {
  id: string;
  question: string;
  answer: string;
  status: string;
  version: number;
  createdAt: string;
  document: { title: string } | null;
  rule: { ruleCode: string; title: string } | null;
  domains: Array<{ domain: { slug: string; title: string } }>;
}

export default function QAPage() {
  const [qaPairs, setQaPairs] = useState<QAPair[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('ACTIVE');

  async function fetchQAPairs() {
    try {
      const response = await fetch(`/api/qa?status=${statusFilter}`);
      const data = await response.json();
      setQaPairs(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching Q&A pairs:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    fetchQAPairs();
  }, [statusFilter]);

  if (loading) {
    return <div className="text-center py-8">Loading...</div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Q&A Pairs</h1>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="SUPERSEDED">Superseded</SelectItem>
            <SelectItem value="DEPRECATED">Deprecated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {qaPairs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No {statusFilter.toLowerCase()} Q&A pairs found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {qaPairs.map((qa) => (
            <Card key={qa.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-base font-medium">
                      Q: {qa.question}
                    </CardTitle>
                  </div>
                  <div className="flex items-center gap-2">
                    {qa.rule && (
                      <Badge variant="outline" className="text-xs">
                        {qa.rule.ruleCode}
                      </Badge>
                    )}
                    <Badge variant={qa.status === 'ACTIVE' ? 'default' : 'secondary'}>
                      {qa.status}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="bg-gray-50 rounded p-3 text-sm">
                  <span className="font-medium text-gray-700">A:</span> {qa.answer}
                </div>
                <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
                  <div className="flex gap-2">
                    {qa.domains.map((d) => (
                      <span key={d.domain.slug}>{d.domain.slug}</span>
                    ))}
                  </div>
                  <div>v{qa.version}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
