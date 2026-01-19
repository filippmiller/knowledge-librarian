'use client';

import { useState, useCallback, useRef } from 'react';

// Types for SSE events
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'error';

export interface Phase {
  id: string;
  title: string;
  status: PhaseStatus;
  prompt?: {
    humanReadable: string;
    technical: string;
  };
  streamedResponse: string;
  error?: string;
}

export interface ExtractedItem {
  id: string;
  itemType: string;
  phase: string;
  content: unknown;
  isSelected: boolean;
}

export interface ProcessingState {
  isProcessing: boolean;
  isComplete: boolean;
  error: string | null;
  phases: Phase[];
  extractedItems: ExtractedItem[];
}

interface SSEEvent {
  type: 'phase_start' | 'prompt' | 'token' | 'item_extracted' | 'phase_complete' | 'error' | 'complete';
  phase?: string;
  data?: unknown;
}

const initialPhases: Phase[] = [
  {
    id: 'DOMAIN_CLASSIFICATION',
    title: 'Классификация доменов',
    status: 'pending',
    streamedResponse: '',
  },
  {
    id: 'KNOWLEDGE_EXTRACTION',
    title: 'Извлечение знаний',
    status: 'pending',
    streamedResponse: '',
  },
  {
    id: 'CHUNKING',
    title: 'Разбиение на чанки',
    status: 'pending',
    streamedResponse: '',
  },
];

export function useDocumentProcessing(documentId: string) {
  const [state, setState] = useState<ProcessingState>({
    isProcessing: false,
    isComplete: false,
    error: null,
    phases: initialPhases,
    extractedItems: [],
  });

  const eventSourceRef = useRef<EventSource | null>(null);

  const startProcessing = useCallback(async () => {
    // Reset state
    setState({
      isProcessing: true,
      isComplete: false,
      error: null,
      phases: initialPhases.map((p) => ({ ...p, streamedResponse: '', status: 'pending' })),
      extractedItems: [],
    });

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      const eventSource = new EventSource(`/api/documents/${documentId}/process-stream`);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as SSEEvent;

          setState((prev) => {
            const newState = { ...prev };

            switch (data.type) {
              case 'phase_start': {
                const phaseId = data.phase;
                newState.phases = prev.phases.map((p) =>
                  p.id === phaseId ? { ...p, status: 'in_progress' as PhaseStatus } : p
                );
                break;
              }

              case 'prompt': {
                const phaseId = data.phase;
                const promptData = data.data as { humanReadable: string; technical: string };
                newState.phases = prev.phases.map((p) =>
                  p.id === phaseId ? { ...p, prompt: promptData } : p
                );
                break;
              }

              case 'token': {
                const phaseId = data.phase;
                const token = data.data as string;
                newState.phases = prev.phases.map((p) =>
                  p.id === phaseId
                    ? { ...p, streamedResponse: p.streamedResponse + token }
                    : p
                );
                break;
              }

              case 'item_extracted': {
                const itemData = data.data as {
                  id: string;
                  itemType: string;
                  content: unknown;
                };
                const newItem: ExtractedItem = {
                  id: itemData.id,
                  itemType: itemData.itemType,
                  phase: data.phase || '',
                  content: itemData.content,
                  isSelected: true, // By default, select all items
                };
                newState.extractedItems = [...prev.extractedItems, newItem];
                break;
              }

              case 'phase_complete': {
                const phaseId = data.phase;
                newState.phases = prev.phases.map((p) =>
                  p.id === phaseId ? { ...p, status: 'completed' as PhaseStatus } : p
                );
                break;
              }

              case 'error': {
                const errorData = data.data as { message: string };
                newState.error = errorData.message;
                newState.isProcessing = false;
                break;
              }

              case 'complete': {
                newState.isProcessing = false;
                newState.isComplete = true;
                break;
              }
            }

            return newState;
          });
        } catch (err) {
          console.error('Error parsing SSE event:', err);
        }
      };

      eventSource.onerror = () => {
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          error: prev.error || 'Соединение прервано',
        }));
        eventSource.close();
      };
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isProcessing: false,
        error: err instanceof Error ? err.message : 'Неизвестная ошибка',
      }));
    }
  }, [documentId]);

  const stopProcessing = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState((prev) => ({
      ...prev,
      isProcessing: false,
    }));
  }, []);

  const toggleItemSelection = useCallback((itemId: string) => {
    setState((prev) => ({
      ...prev,
      extractedItems: prev.extractedItems.map((item) =>
        item.id === itemId ? { ...item, isSelected: !item.isSelected } : item
      ),
    }));
  }, []);

  const selectAll = useCallback(() => {
    setState((prev) => ({
      ...prev,
      extractedItems: prev.extractedItems.map((item) => ({ ...item, isSelected: true })),
    }));
  }, []);

  const deselectAll = useCallback(() => {
    setState((prev) => ({
      ...prev,
      extractedItems: prev.extractedItems.map((item) => ({ ...item, isSelected: false })),
    }));
  }, []);

  const commitSelected = useCallback(async () => {
    const selectedIds = state.extractedItems
      .filter((item) => item.isSelected)
      .map((item) => item.id);

    if (selectedIds.length === 0) {
      return { success: false, error: 'Не выбрано ни одного элемента' };
    }

    try {
      // First, mark selected items as verified
      const verifyResponse = await fetch(`/api/documents/${documentId}/staged`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedIds, action: 'verify' }),
      });

      if (!verifyResponse.ok) {
        const error = await verifyResponse.json();
        return { success: false, error: error.error || 'Ошибка верификации' };
      }

      // Then, commit verified items
      const commitResponse = await fetch(`/api/documents/${documentId}/commit`, {
        method: 'POST',
      });

      if (!commitResponse.ok) {
        const error = await commitResponse.json();
        return { success: false, error: error.error || 'Ошибка сохранения' };
      }

      const result = await commitResponse.json();
      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Неизвестная ошибка',
      };
    }
  }, [documentId, state.extractedItems]);

  return {
    ...state,
    startProcessing,
    stopProcessing,
    toggleItemSelection,
    selectAll,
    deselectAll,
    commitSelected,
  };
}
