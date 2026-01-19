'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Rule {
  id: string;
  ruleCode: string;
  title: string;
  body: string;
  confidence: number;
  status: string;
  version: number;
  createdAt: string;
  document: { title: string } | null;
  domains: Array<{ domain: { slug: string; title: string } }>;
  supersedesRule: { ruleCode: string; title: string } | null;
  supersededBy: Array<{ ruleCode: string; title: string }>;
}

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('ACTIVE');

  async function fetchRules() {
    try {
      const response = await fetch(`/api/rules?status=${statusFilter}`);
      const data = await response.json();
      setRules(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching rules:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    fetchRules();
  }, [statusFilter]);

  function getStatusBadge(status: string) {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      ACTIVE: 'default',
      SUPERSEDED: 'secondary',
      DEPRECATED: 'destructive',
    };
    return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
  }

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  const statusLabels: Record<string, string> = {
    ACTIVE: 'активных',
    SUPERSEDED: 'замененных',
    DEPRECATED: 'устаревших',
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Правила</h1>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ACTIVE">Активные</SelectItem>
            <SelectItem value="SUPERSEDED">Замененные</SelectItem>
            <SelectItem value="DEPRECATED">Устаревшие</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {rules.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            {statusLabels[statusFilter] || statusFilter.toLowerCase()} правил не найдено.
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Код</TableHead>
                <TableHead>Название</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Уверенность</TableHead>
                <TableHead>Домены</TableHead>
                <TableHead>Версия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <code className="text-sm font-mono">{rule.ruleCode}</code>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{rule.title}</div>
                    <div className="text-sm text-gray-500 line-clamp-2">
                      {rule.body}
                    </div>
                    {rule.supersedesRule && (
                      <div className="text-xs text-gray-400 mt-1">
                        Заменяет: {rule.supersedesRule.ruleCode}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{getStatusBadge(rule.status)}</TableCell>
                  <TableCell>
                    <span className={rule.confidence >= 0.8 ? 'text-green-600' : 'text-yellow-600'}>
                      {(rule.confidence * 100).toFixed(0)}%
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {rule.domains.map((d) => (
                        <Badge key={d.domain.slug} variant="outline" className="text-xs">
                          {d.domain.slug}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>v{rule.version}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
