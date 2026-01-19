'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDocumentProcessing } from '@/hooks/useDocumentProcessing';
import {
  PhaseCard,
  ExtractedItemsGrid,
  OpenAIStatusIndicator,
} from '@/components/document-processor';

interface Document {
  id: string;
  title: string;
  filename: string;
  parseStatus: string;
  rawText: string | null;
}

export default function DocumentProcessPage() {
  const params = useParams();
  const router = useRouter();
  const documentId = params.id as string;

  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const {
    isProcessing,
    isComplete,
    error: processingError,
    phases,
    extractedItems,
    startProcessing,
    stopProcessing,
    toggleItemSelection,
    selectAll,
    deselectAll,
    commitSelected,
  } = useDocumentProcessing(documentId);

  useEffect(() => {
    async function fetchDocument() {
      try {
        const response = await fetch(`/api/documents/${documentId}`);
        if (!response.ok) {
          throw new Error('Документ не найден');
        }
        const data = await response.json();
        setDocument(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        setLoading(false);
      }
    }

    fetchDocument();
  }, [documentId]);

  if (loading) {
    return <div className="text-center py-8">Загрузка...</div>;
  }

  if (error || !document) {
    return (
      <div className="text-center py-8">
        <p className="text-red-600 mb-4">{error || 'Документ не найден'}</p>
        <Button variant="outline" onClick={() => router.push('/admin/documents')}>
          Вернуться к списку
        </Button>
      </div>
    );
  }

  if (!document.rawText) {
    return (
      <div className="text-center py-8">
        <p className="text-yellow-600 mb-4">
          Документ ещё не обработан. Текст не извлечён.
        </p>
        <Button variant="outline" onClick={() => router.push('/admin/documents')}>
          Вернуться к списку
        </Button>
      </div>
    );
  }

  const isStreaming = phases.some((p) => p.status === 'in_progress');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link href="/admin/documents" className="hover:text-gray-700">
              Документы
            </Link>
            <span>/</span>
            <span>Обработка</span>
          </div>
          <h1 className="text-2xl font-bold">{document.title}</h1>
        </div>
        <OpenAIStatusIndicator
          isConnected={isProcessing}
          isStreaming={isStreaming}
        />
      </div>

      {/* Error message */}
      {processingError && (
        <div className="p-4 bg-red-50 text-red-800 rounded-lg border border-red-200">
          {processingError}
        </div>
      )}

      {/* Success message */}
      {isComplete && !processingError && (
        <div className="p-4 bg-green-50 text-green-800 rounded-lg border border-green-200">
          Обработка завершена успешно. Выберите элементы для сохранения в базу знаний.
        </div>
      )}

      {/* Control buttons */}
      <div className="flex gap-4">
        {!isProcessing && !isComplete && (
          <Button onClick={startProcessing}>Начать обработку</Button>
        )}
        {isProcessing && (
          <Button variant="destructive" onClick={stopProcessing}>
            Остановить
          </Button>
        )}
        {isComplete && (
          <Button variant="outline" onClick={startProcessing}>
            Обработать заново
          </Button>
        )}
      </div>

      {/* Phases */}
      <div className="grid gap-4 md:grid-cols-3">
        {phases.map((phase, index) => (
          <PhaseCard key={phase.id} phase={phase} index={index} />
        ))}
      </div>

      {/* Extracted Items */}
      {extractedItems.length > 0 && (
        <ExtractedItemsGrid
          items={extractedItems}
          onToggleSelection={toggleItemSelection}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onCommit={commitSelected}
        />
      )}

      {/* Document preview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Исходный текст документа</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-gray-50 p-4 rounded overflow-auto max-h-60 whitespace-pre-wrap">
            {document.rawText.slice(0, 2000)}
            {document.rawText.length > 2000 && '...'}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
