'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface KnowledgeChange {
  id: string;
  targetType: string;
  targetId: string;
  changeType: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string;
  initiatedBy: string;
  approvedBy: string | null;
  status: string;
  createdAt: string;
}

export default function KnowledgeChangesPage() {
  const [changes, setChanges] = useState<KnowledgeChange[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchChanges() {
      try {
        const response = await fetch('/api/knowledge-changes');
        const data = await response.json();
        setChanges(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error('Error fetching changes:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchChanges();
  }, []);

  function getChangeTypeBadge(type: string) {
    const colors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      CREATE: 'default',
      UPDATE: 'secondary',
      SUPERSEDE: 'outline',
      DEPRECATE: 'destructive',
    };
    return <Badge variant={colors[type] || 'outline'}>{type}</Badge>;
  }

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Журнал изменений</h1>

      {changes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            Изменений пока не записано.
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Дата</TableHead>
                <TableHead>Тип</TableHead>
                <TableHead>Цель</TableHead>
                <TableHead>Изменение</TableHead>
                <TableHead>Причина</TableHead>
                <TableHead>Инициатор</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((change) => (
                <TableRow key={change.id}>
                  <TableCell className="text-sm text-gray-500">
                    {new Date(change.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{getChangeTypeBadge(change.changeType)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{change.targetType}</Badge>
                    <div className="text-xs text-gray-500 mt-1 font-mono">
                      {change.targetId.slice(0, 8)}...
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs">
                    {change.oldValue && change.newValue && (
                      <div className="text-xs">
                        <div className="text-red-600 line-through">
                          {JSON.stringify(change.oldValue).slice(0, 50)}
                        </div>
                        <div className="text-green-600">
                          {JSON.stringify(change.newValue).slice(0, 50)}
                        </div>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm max-w-xs">
                    {change.reason}
                  </TableCell>
                  <TableCell>
                    <Badge variant={change.initiatedBy === 'AI' ? 'secondary' : 'default'}>
                      {change.initiatedBy}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        change.status === 'APPROVED'
                          ? 'default'
                          : change.status === 'REJECTED'
                          ? 'destructive'
                          : 'outline'
                      }
                    >
                      {change.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
