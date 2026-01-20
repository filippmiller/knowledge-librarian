'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Document {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  uploadedAt: string;
  parseStatus: string;
  parseError: string | null;
  domains: Array<{
    isPrimary: boolean;
    domain: { slug: string; title: string };
  }>;
  _count: {
    rules: number;
    qaPairs: number;
    chunks: number;
  };
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  async function fetchDocuments() {
    try {
      const response = await fetch('/api/documents');
      const data = await response.json();
      setDocuments(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching documents:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchDocuments();
  }, []);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', file.name);

    try {
      const response = await fetch('/api/documents', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        fetchDocuments();
      } else {
        const error = await response.json();
        alert(error.error || 'Ошибка загрузки');
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Ошибка загрузки');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  function formatProcessingAge(uploadedAt: string) {
    const startedAt = new Date(uploadedAt).getTime();
    if (Number.isNaN(startedAt)) return null;

    const diffMs = Date.now() - startedAt;
    if (diffMs < 0) return null;

    const totalMinutes = Math.floor(diffMs / 60000);
    const totalHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    if (days > 0) return `${days}д ${hours}ч`;
    if (totalHours > 0) return `${totalHours}ч`;
    if (totalMinutes > 0) return `${minutes}м`;
    return 'только что';
  }

  function getStatusBadge(status: string) {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      PENDING: 'secondary',
      PROCESSING: 'outline',
      COMPLETED: 'default',
      FAILED: 'destructive',
    };

    if (status === 'PROCESSING') {
      return (
        <Badge variant={variants[status]} className="gap-2">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          {status}
        </Badge>
      );
    }

    return <Badge variant={variants[status] || 'outline'}>{status}</Badge>;
  }

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Документы</h1>
        <div>
          <Input
            type="file"
            accept=".pdf,.docx,.doc,.txt,.md,.rtf"
            onChange={handleUpload}
            disabled={uploading}
            className="max-w-xs"
          />
        </div>
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            Документы ещё не загружены. Загрузите первый документ, чтобы начать.
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Название</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Домены</TableHead>
                <TableHead>Правила</TableHead>
                <TableHead>Вопросы</TableHead>
                <TableHead>Загружен</TableHead>
                <TableHead>Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.id}>
                  <TableCell>
                    <a
                      href={`/admin/documents/${doc.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      {doc.title}
                    </a>
                    <div className="text-xs text-gray-500">{doc.filename}</div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {getStatusBadge(doc.parseStatus)}
                      {doc.parseStatus === 'PROCESSING' && (
                        <div className="text-xs text-gray-500">
                          В обработке {formatProcessingAge(doc.uploadedAt)}
                        </div>
                      )}
                    </div>
                    {doc.parseError && (
                      <div className="text-xs text-red-500 mt-1">
                        {doc.parseError}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {doc.domains.map((d) => (
                        <Badge
                          key={d.domain.slug}
                          variant={d.isPrimary ? 'default' : 'secondary'}
                        >
                          {d.domain.slug}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>{doc._count.rules}</TableCell>
                  <TableCell>{doc._count.qaPairs}</TableCell>
                  <TableCell className="text-sm text-gray-500">
                    {new Date(doc.uploadedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Link href={`/admin/documents/${doc.id}/process`}>
                      <Button variant="outline" size="sm">
                        Прогресс
                      </Button>
                    </Link>
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
