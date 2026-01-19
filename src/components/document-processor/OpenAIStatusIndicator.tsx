'use client';

import { Badge } from '@/components/ui/badge';

interface OpenAIStatusIndicatorProps {
  isConnected: boolean;
  isStreaming: boolean;
}

export function OpenAIStatusIndicator({
  isConnected,
  isStreaming,
}: OpenAIStatusIndicatorProps) {
  if (isStreaming) {
    return (
      <Badge variant="default" className="animate-pulse">
        <span className="w-2 h-2 bg-green-400 rounded-full mr-2 inline-block" />
        Потоковая передача...
      </Badge>
    );
  }

  if (isConnected) {
    return (
      <Badge variant="secondary">
        <span className="w-2 h-2 bg-green-500 rounded-full mr-2 inline-block" />
        Подключено к OpenAI
      </Badge>
    );
  }

  return (
    <Badge variant="outline">
      <span className="w-2 h-2 bg-gray-400 rounded-full mr-2 inline-block" />
      Ожидание
    </Badge>
  );
}
