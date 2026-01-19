'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Phase, PhaseStatus } from '@/hooks/useDocumentProcessing';

interface PhaseCardProps {
  phase: Phase;
  index: number;
}

const statusConfig: Record<
  PhaseStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: string }
> = {
  pending: { label: 'Ожидание', variant: 'outline', icon: '○' },
  in_progress: { label: 'Обработка', variant: 'default', icon: '⏳' },
  completed: { label: 'Готово', variant: 'secondary', icon: '✓' },
  error: { label: 'Ошибка', variant: 'destructive', icon: '✗' },
};

export function PhaseCard({ phase, index }: PhaseCardProps) {
  const [showTechnical, setShowTechnical] = useState(false);
  const config = statusConfig[phase.status];

  return (
    <Card
      className={`transition-all ${
        phase.status === 'in_progress' ? 'ring-2 ring-blue-500' : ''
      }`}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">
            {index + 1}. {phase.title}
          </CardTitle>
          <Badge variant={config.variant}>
            {config.icon} {config.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Prompt Section */}
        {phase.prompt && (
          <div className="space-y-2">
            <div className="text-sm text-gray-600">{phase.prompt.humanReadable}</div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => setShowTechnical(!showTechnical)}
            >
              {showTechnical ? 'Скрыть технический промпт' : 'Показать технический промпт'}
            </Button>
            {showTechnical && (
              <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-40">
                {phase.prompt.technical}
              </pre>
            )}
          </div>
        )}

        {/* Streamed Response */}
        {phase.streamedResponse && (
          <div className="space-y-1">
            <div className="text-xs text-gray-500">Ответ:</div>
            <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-60 font-mono whitespace-pre-wrap">
              {phase.streamedResponse}
              {phase.status === 'in_progress' && (
                <span className="animate-pulse">▌</span>
              )}
            </pre>
          </div>
        )}

        {/* Error */}
        {phase.error && (
          <div className="text-sm text-red-600 bg-red-50 p-2 rounded">
            {phase.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
