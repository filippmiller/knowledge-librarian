'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useDocumentProcessing } from '@/hooks/useDocumentProcessing';
import {
  ExtractedItemsGrid,
  LiveTerminal,
} from '@/components/document-processor';

interface Document {
  id: string;
  title: string;
  filename: string;
  parseStatus: string;
  rawText: string | null;
}

// Phase progress indicator component
function PhaseProgress({ phases }: { phases: { id: string; title: string; status: string }[] }) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-500';
      case 'in_progress': return 'bg-cyan-500 animate-pulse';
      case 'error': return 'bg-red-500';
      default: return 'bg-gray-600';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '●';
      case 'error': return '✗';
      default: return '○';
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-black/20 rounded-lg border border-cyan-500/20">
      {phases.map((phase, index) => (
        <div key={phase.id} className="flex items-center">
          {index > 0 && (
            <div className={`w-8 h-0.5 mx-1 ${
              phases[index - 1].status === 'completed' ? 'bg-green-500' : 'bg-gray-600'
            }`} />
          )}
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono ${
              phase.status === 'in_progress'
                ? 'bg-cyan-500/20 text-cyan-400 ring-1 ring-cyan-500/50'
                : phase.status === 'completed'
                ? 'bg-green-500/20 text-green-400'
                : phase.status === 'error'
                ? 'bg-red-500/20 text-red-400'
                : 'bg-gray-500/20 text-gray-400'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${getStatusColor(phase.status)}`} />
            <span>{phase.title}</span>
            <span>{getStatusIcon(phase.status)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Toast notification component (simple built-in version)
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error' | 'info'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColor = {
    success: 'bg-green-500/20 border-green-500/50 text-green-400',
    error: 'bg-red-500/20 border-red-500/50 text-red-400',
    info: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400',
  }[type];

  return (
    <div className={`fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg border ${bgColor} shadow-lg font-mono text-sm animate-in slide-in-from-bottom-2`}>
      <div className="flex items-center gap-2">
        <span>{message}</span>
        <button onClick={onClose} className="ml-2 opacity-60 hover:opacity-100">✕</button>
      </div>
    </div>
  );
}

export default function DocumentProcessPage() {
  const params = useParams();
  const router = useRouter();
  const documentId = params.id as string;

  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [showRawText, setShowRawText] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(60); // percentage
  const [isResizing, setIsResizing] = useState(false);

  const {
    isProcessing,
    isComplete,
    isPaused,
    isConnected,
    error: processingError,
    phases,
    extractedItems,
    terminalLogs,
    metrics,
    startProcessing,
    stopProcessing,
    toggleItemSelection,
    selectAll,
    deselectAll,
    commitSelected,
    clearLogs,
    togglePause,
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

  // Handle toast notifications
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    setToast({ message, type });
  }, []);

  // Handle commit - returns result for ExtractedItemsGrid, also shows toast
  const handleCommit = useCallback(async (): Promise<{ success: boolean; error?: string; result?: unknown }> => {
    const result = await commitSelected();
    if (result.success) {
      showToast('Данные успешно сохранены в базу знаний', 'success');
    } else {
      showToast(result.error || 'Ошибка сохранения', 'error');
    }
    return result;
  }, [commitSelected, showToast]);

  // Handle resize
  const handleMouseDown = useCallback(() => {
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = window.document.getElementById('split-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newWidth = ((e.clientX - rect.left) / rect.width) * 100;
      setTerminalWidth(Math.min(Math.max(newWidth, 30), 70));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-cyan-400 font-mono animate-pulse">Загрузка...</div>
      </div>
    );
  }

  if (error || !document) {
    return (
      <div className="text-center py-8">
        <p className="text-red-400 mb-4 font-mono">{error || 'Документ не найден'}</p>
        <Button variant="outline" onClick={() => router.push('/admin/documents')}>
          Вернуться к списку
        </Button>
      </div>
    );
  }

  if (!document.rawText) {
    return (
      <div className="text-center py-8">
        <p className="text-yellow-400 mb-4 font-mono">
          Документ ещё не обработан. Текст не извлечён.
        </p>
        <Button variant="outline" onClick={() => router.push('/admin/documents')}>
          Вернуться к списку
        </Button>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link href="/admin/documents" className="hover:text-cyan-400 transition-colors">
              Документы
            </Link>
            <span className="text-gray-600">/</span>
            <span className="text-cyan-400">Обработка</span>
          </div>
          <h1 className="text-2xl font-bold text-white">{document.title}</h1>
        </div>

        {/* Control buttons */}
        <div className="flex items-center gap-3">
          {!isProcessing && !isComplete && (
            <Button
              onClick={startProcessing}
              className="bg-cyan-600 hover:bg-cyan-500 text-white font-mono"
            >
              ▶ Начать обработку
            </Button>
          )}
          {isProcessing && (
            <Button
              variant="destructive"
              onClick={stopProcessing}
              className="font-mono"
            >
              ■ Остановить
            </Button>
          )}
          {isComplete && (
            <Button
              variant="outline"
              onClick={startProcessing}
              className="font-mono border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10"
            >
              ↻ Обработать заново
            </Button>
          )}
        </div>
      </div>

      {/* Phase progress */}
      <PhaseProgress phases={phases} />

      {/* Error message */}
      {processingError && (
        <div className="p-4 bg-red-500/20 text-red-400 rounded-lg border border-red-500/30 font-mono">
          ✗ {processingError}
        </div>
      )}

      {/* Main content - Split View */}
      <div
        id="split-container"
        className="flex-1 flex gap-0 min-h-0 rounded-lg overflow-hidden border border-cyan-500/20"
        style={{ userSelect: isResizing ? 'none' : 'auto' }}
      >
        {/* Terminal Panel */}
        <div
          className="h-full overflow-hidden"
          style={{ width: `${terminalWidth}%` }}
        >
          <LiveTerminal
            logs={terminalLogs}
            isConnected={isConnected}
            isProcessing={isProcessing}
            metrics={metrics}
            onClear={clearLogs}
            onPause={togglePause}
            isPaused={isPaused}
          />
        </div>

        {/* Resizer */}
        <div
          className="w-1 split-resizer flex-shrink-0 cursor-col-resize hover:bg-cyan-500/40 transition-colors"
          onMouseDown={handleMouseDown}
        />

        {/* Right Panel - Extracted Items */}
        <div
          className="h-full overflow-auto bg-[#0d1117] p-4"
          style={{ width: `${100 - terminalWidth}%` }}
        >
          {extractedItems.length > 0 ? (
            <div className="space-y-4">
              {/* Summary */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400 font-mono text-sm">
                    Извлечено: {extractedItems.length} элементов
                  </span>
                  <Badge className="bg-green-500/20 text-green-400 font-mono text-xs">
                    {extractedItems.filter(i => i.isSelected).length} выбрано
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={selectAll}
                    className="text-xs font-mono text-cyan-400 hover:text-cyan-300"
                  >
                    Выбрать все
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={deselectAll}
                    className="text-xs font-mono text-gray-400 hover:text-gray-300"
                  >
                    Снять выбор
                  </Button>
                </div>
              </div>

              {/* Items grid */}
              <ExtractedItemsGrid
                items={extractedItems}
                onToggleSelection={toggleItemSelection}
                onSelectAll={selectAll}
                onDeselectAll={deselectAll}
                onCommit={handleCommit}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 font-mono">
              <div className="text-4xl mb-2 opacity-20">◇</div>
              <div className="text-sm">Извлеченные данные</div>
              <div className="text-xs mt-1 text-gray-600">
                {isProcessing
                  ? 'Ожидание результатов...'
                  : 'Запустите обработку для извлечения данных'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom bar with document preview toggle */}
      <div className="flex-shrink-0 flex items-center justify-between py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRawText(!showRawText)}
          className="text-xs font-mono text-gray-400 hover:text-cyan-400"
        >
          {showRawText ? '▼ Скрыть исходный текст' : '▶ Показать исходный текст'}
        </Button>

        {isComplete && extractedItems.length > 0 && (
          <Button
            onClick={handleCommit}
            className="bg-green-600 hover:bg-green-500 text-white font-mono"
          >
            ✓ Сохранить в базу знаний ({extractedItems.filter(i => i.isSelected).length})
          </Button>
        )}
      </div>

      {/* Collapsible document preview */}
      {showRawText && (
        <Card className="flex-shrink-0 border-cyan-500/20 bg-[#0d1117]">
          <CardHeader className="py-2">
            <CardTitle className="text-sm text-cyan-400 font-mono">Исходный текст документа</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-gray-400 bg-black/30 p-4 rounded overflow-auto max-h-40 whitespace-pre-wrap font-mono">
              {document.rawText.slice(0, 2000)}
              {document.rawText.length > 2000 && (
                <span className="text-gray-600">... [{document.rawText.length - 2000} символов скрыто]</span>
              )}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
