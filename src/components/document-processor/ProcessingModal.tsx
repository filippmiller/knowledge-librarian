'use client';

import { useEffect } from 'react';
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
    isStopped,
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
    getLogsAsText,
  } = useDocumentProcessing(documentId || '');

  // Auto-start processing when modal opens
  useEffect(() => {
    if (isOpen && documentId && autoStart && !isProcessing && !isComplete && !isStopped) {
      startProcessing();
    }
  }, [isOpen, documentId, autoStart, isProcessing, isComplete, isStopped, startProcessing]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  const handleCommit = async (): Promise<void> => {
    const result = await commitSelected();
    if (result.success) {
      onClose();
    }
  };

  const completedPhases = phases.filter(p => p.status === 'completed').length;
  const totalPhases = phases.length;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal - fullscreen with padding */}
      <div className="relative w-[95vw] h-[95vh] flex flex-col bg-[#0a0e14] border border-cyan-500/30 rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-cyan-500/20 flex-shrink-0 bg-gradient-to-r from-cyan-500/10 to-purple-500/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-mono text-cyan-400">
                Обработка документа
              </h2>
              {documentTitle && (
                <span className="text-sm text-gray-400 font-mono truncate max-w-md">
                  {documentTitle}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Phase progress */}
              <div className="flex items-center gap-1">
                {phases.map((phase) => (
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
                    : isStopped
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : isProcessing
                    ? 'bg-cyan-500/20 text-cyan-400'
                    : error
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {isComplete
                  ? `✓ Готово (${completedPhases}/${totalPhases})`
                  : isStopped
                  ? `⏹ Остановлено (${completedPhases}/${totalPhases})`
                  : isProcessing
                  ? `Обработка... (${completedPhases}/${totalPhases})`
                  : error
                  ? 'Ошибка'
                  : 'Ожидание'}
              </Badge>

              {/* Close button */}
              <button
                onClick={onClose}
                className="ml-2 text-gray-500 hover:text-gray-300 transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        {/* Terminal - takes all available space */}
        <div className="flex-1 min-h-0 p-2">
          <LiveTerminal
            logs={terminalLogs}
            isConnected={isConnected}
            isProcessing={isProcessing}
            metrics={metrics}
            onClear={clearLogs}
            onPause={togglePause}
            onCopy={getLogsAsText}
            isPaused={isPaused}
            isStopped={isStopped}
            isComplete={isComplete}
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
                {isComplete ? '↻ Повторить' : isStopped ? '▶ Продолжить' : '▶ Запустить'}
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
      </div>
    </div>
  );
}
