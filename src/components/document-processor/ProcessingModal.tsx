'use client';

import { useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LiveTerminal } from './LiveTerminal';
import { useDocumentProcessing } from '@/hooks/useDocumentProcessing';

interface ProcessingModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string | null;
  documentTitle?: string;
  autoStart?: boolean;
}

export function ProcessingModal({
  isOpen,
  onClose,
  documentId,
  documentTitle,
  autoStart = true,
}: ProcessingModalProps) {
  const {
    isProcessing,
    isComplete,
    isPaused,
    isConnected,
    error,
    phases,
    extractedItems,
    terminalLogs,
    metrics,
    startProcessing,
    stopProcessing,
    clearLogs,
    togglePause,
    selectAll,
    deselectAll,
    commitSelected,
  } = useDocumentProcessing(documentId || '');

  // Auto-start processing when modal opens
  useEffect(() => {
    if (isOpen && documentId && autoStart && !isProcessing && !isComplete) {
      startProcessing();
    }
  }, [isOpen, documentId, autoStart, isProcessing, isComplete, startProcessing]);

  const handleCommit = async () => {
    const result = await commitSelected();
    if (result.success) {
      onClose();
    }
  };

  const completedPhases = phases.filter(p => p.status === 'completed').length;
  const totalPhases = phases.length;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-6xl h-[85vh] flex flex-col p-0 gap-0 bg-[#0a0e14] border-cyan-500/30">
        {/* Header */}
        <DialogHeader className="px-4 py-3 border-b border-cyan-500/20 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <DialogTitle className="text-lg font-mono text-cyan-400">
                Обработка документа
              </DialogTitle>
              {documentTitle && (
                <span className="text-sm text-gray-400 font-mono truncate max-w-md">
                  {documentTitle}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Phase progress */}
              <div className="flex items-center gap-1">
                {phases.map((phase, i) => (
                  <div
                    key={phase.id}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      phase.status === 'completed'
                        ? 'bg-green-500'
                        : phase.status === 'in_progress'
                        ? 'bg-cyan-500 animate-pulse'
                        : phase.status === 'error'
                        ? 'bg-red-500'
                        : 'bg-gray-600'
                    }`}
                    title={phase.title}
                  />
                ))}
              </div>
              <Badge
                className={`font-mono text-xs ${
                  isComplete
                    ? 'bg-green-500/20 text-green-400'
                    : isProcessing
                    ? 'bg-cyan-500/20 text-cyan-400'
                    : error
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {isComplete
                  ? `✓ Готово (${completedPhases}/${totalPhases})`
                  : isProcessing
                  ? `Обработка... (${completedPhases}/${totalPhases})`
                  : error
                  ? 'Ошибка'
                  : 'Ожидание'}
              </Badge>
            </div>
          </div>
        </DialogHeader>

        {/* Terminal */}
        <div className="flex-1 min-h-0">
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

        {/* Footer with actions */}
        <div className="px-4 py-3 border-t border-cyan-500/20 flex items-center justify-between flex-shrink-0 bg-black/30">
          <div className="flex items-center gap-2">
            {isProcessing ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={stopProcessing}
                className="font-mono"
              >
                ■ Остановить
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={startProcessing}
                className="font-mono border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10"
                disabled={isProcessing}
              >
                {isComplete ? '↻ Повторить' : '▶ Запустить'}
              </Button>
            )}

            {extractedItems.length > 0 && (
              <span className="text-xs text-gray-400 font-mono">
                Извлечено: {extractedItems.length} элементов
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isComplete && extractedItems.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectAll}
                  className="text-xs font-mono text-gray-400"
                >
                  Выбрать все
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={deselectAll}
                  className="text-xs font-mono text-gray-400"
                >
                  Снять выбор
                </Button>
                <Button
                  size="sm"
                  onClick={handleCommit}
                  className="font-mono bg-green-600 hover:bg-green-500"
                >
                  ✓ Сохранить ({extractedItems.filter(i => i.isSelected).length})
                </Button>
              </>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-mono text-gray-400"
            >
              {isComplete ? 'Закрыть' : 'Свернуть'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
