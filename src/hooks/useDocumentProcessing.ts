'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

// Types for SSE events
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'error';
export type LogLevel = 'DEBUG' | 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SYSTEM';

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
  startTime?: number;
  endTime?: number;
}

export interface ExtractedItem {
  id: string;
  itemType: string;
  phase: string;
  content: unknown;
  isSelected: boolean;
}

export interface TerminalLog {
  id: string;
  timestamp: Date;
  level: LogLevel;
  phase?: string;
  message: string;
  isJSON?: boolean;
  isStreaming?: boolean;
}

export interface ProcessingMetrics {
  tokensPerSecond: number;
  totalTokens: number;
  elapsedTime: number;
  startTime: number;
}

export interface ProcessingState {
  isProcessing: boolean;
  isComplete: boolean;
  isPaused: boolean;
  isConnected: boolean;
  isStopped: boolean; // User explicitly stopped
  error: string | null;
  phases: Phase[];
  extractedItems: ExtractedItem[];
  terminalLogs: TerminalLog[];
  metrics: ProcessingMetrics;
}

interface SSEEvent {
  type: 'phase_start' | 'prompt' | 'token' | 'item_extracted' | 'phase_complete' | 'error' | 'fatal_error' | 'complete' | 'log' | 'metric';
  phase?: string;
  data?: unknown;
  timestamp?: string;
  level?: LogLevel;
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

const initialMetrics: ProcessingMetrics = {
  tokensPerSecond: 0,
  totalTokens: 0,
  elapsedTime: 0,
  startTime: 0,
};

// Helper to generate unique IDs
let logIdCounter = 0;
function generateLogId(): string {
  return `log-${Date.now()}-${++logIdCounter}`;
}

// LocalStorage key for persistent logs
const LOGS_STORAGE_KEY = 'librarian_terminal_logs';
const MAX_STORED_LOGS = 500;

// Save logs to localStorage
function saveLogs(documentId: string, logs: TerminalLog[]) {
  try {
    const stored = JSON.parse(localStorage.getItem(LOGS_STORAGE_KEY) || '{}');
    stored[documentId] = logs.slice(-MAX_STORED_LOGS).map(log => ({
      ...log,
      timestamp: log.timestamp.toISOString(),
    }));
    localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(stored));
  } catch (e) {
    console.warn('Failed to save logs to localStorage:', e);
  }
}

// Load logs from localStorage
function loadLogs(documentId: string): TerminalLog[] {
  try {
    const stored = JSON.parse(localStorage.getItem(LOGS_STORAGE_KEY) || '{}');
    const logs = stored[documentId] || [];
    return logs.map((log: TerminalLog & { timestamp: string }) => ({
      ...log,
      timestamp: new Date(log.timestamp),
    }));
  } catch (e) {
    console.warn('Failed to load logs from localStorage:', e);
    return [];
  }
}

export function useDocumentProcessing(documentId: string) {
  // Load initial logs from localStorage
  const [state, setState] = useState<ProcessingState>(() => ({
    isProcessing: false,
    isComplete: false,
    isPaused: false,
    isConnected: false,
    isStopped: false,
    error: null,
    phases: initialPhases,
    extractedItems: [],
    terminalLogs: documentId ? loadLogs(documentId) : [],
    metrics: initialMetrics,
  }));

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const metricsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const tokenCountRef = useRef(0);
  const tokensInLastSecondRef = useRef<number[]>([]);

  // Refs to track completion/error state for reconnection logic (avoid stale closures)
  const isCompleteRef = useRef(false);
  const hasErrorRef = useRef(false);
  const isStoppedRef = useRef(false);

  // Sync refs with state
  useEffect(() => {
    isCompleteRef.current = state.isComplete;
    hasErrorRef.current = !!state.error;
    isStoppedRef.current = state.isStopped;
  }, [state.isComplete, state.error, state.isStopped]);

  // Save logs to localStorage when they change
  useEffect(() => {
    if (documentId && state.terminalLogs.length > 0) {
      saveLogs(documentId, state.terminalLogs);
    }
  }, [documentId, state.terminalLogs]);

  // Add a log entry
  const addLog = useCallback((level: LogLevel, message: string, phase?: string, options?: { isJSON?: boolean; isStreaming?: boolean }) => {
    setState(prev => ({
      ...prev,
      terminalLogs: [
        ...prev.terminalLogs,
        {
          id: generateLogId(),
          timestamp: new Date(),
          level,
          phase,
          message,
          isJSON: options?.isJSON,
          isStreaming: options?.isStreaming,
        },
      ],
    }));
  }, []);

  // Update metrics
  const updateMetrics = useCallback(() => {
    setState(prev => {
      if (!prev.isProcessing || prev.metrics.startTime === 0) return prev;

      const now = Date.now();
      const elapsedTime = now - prev.metrics.startTime;

      // Calculate tokens per second (rolling average over last second)
      const oneSecondAgo = now - 1000;
      tokensInLastSecondRef.current = tokensInLastSecondRef.current.filter(t => t > oneSecondAgo);
      const tokensPerSecond = tokensInLastSecondRef.current.length;

      return {
        ...prev,
        metrics: {
          ...prev.metrics,
          elapsedTime,
          tokensPerSecond,
        },
      };
    });
  }, []);

  // Start metrics interval
  useEffect(() => {
    if (state.isProcessing) {
      metricsIntervalRef.current = setInterval(updateMetrics, 100);
    } else if (metricsIntervalRef.current) {
      clearInterval(metricsIntervalRef.current);
    }

    return () => {
      if (metricsIntervalRef.current) {
        clearInterval(metricsIntervalRef.current);
      }
    };
  }, [state.isProcessing, updateMetrics]);

  // Clear logs
  const clearLogs = useCallback(() => {
    setState(prev => ({
      ...prev,
      terminalLogs: [],
    }));
    // Also clear from localStorage
    try {
      const stored = JSON.parse(localStorage.getItem(LOGS_STORAGE_KEY) || '{}');
      delete stored[documentId];
      localStorage.setItem(LOGS_STORAGE_KEY, JSON.stringify(stored));
    } catch (e) {
      console.warn('Failed to clear logs from localStorage:', e);
    }
  }, [documentId]);

  // Get all logs as text for copying
  const getLogsAsText = useCallback(() => {
    return state.terminalLogs.map(log => {
      const time = log.timestamp.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const phase = log.phase ? `[${log.phase}]` : '';
      return `${time} [${log.level}] ${phase} ${log.message}`;
    }).join('\n');
  }, [state.terminalLogs]);

  // Pause/resume processing display (doesn't stop the stream)
  const togglePause = useCallback(() => {
    setState(prev => ({ ...prev, isPaused: !prev.isPaused }));
  }, []);

  // Store token for reconnections
  const tokenRef = useRef<string | null>(null);

  const fetchProcessingToken = useCallback(async (): Promise<string | null> => {
    try {
      addLog('DEBUG', 'Получаю токен для SSE соединения...');
      const response = await fetch(`/api/documents/${documentId}/token`, {
        method: 'POST',
        credentials: 'include', // Include Basic Auth credentials
      });
      
      if (!response.ok) {
        addLog('ERROR', `Не удалось получить токен: ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      tokenRef.current = data.token;
      addLog('DEBUG', 'Токен получен успешно');
      return data.token;
    } catch (error) {
      addLog('ERROR', `Ошибка получения токена: ${error}`);
      return null;
    }
  }, [documentId, addLog]);

  const connectEventSource = useCallback(async (isReconnection = false) => {
    // Don't reconnect if stopped by user
    if (isStoppedRef.current) {
      addLog('INFO', 'Не переподключаюсь - обработка остановлена пользователем');
      return;
    }

    addLog('SYSTEM', 'Устанавливаю соединение с сервером...');

    // Get token for SSE auth (reuse existing token for reconnections)
    let token = tokenRef.current;
    if (!token || !isReconnection) {
      token = await fetchProcessingToken();
      if (!token) {
        addLog('ERROR', 'Не удалось установить соединение: ошибка авторизации');
        setState(prev => ({ 
          ...prev, 
          error: 'Ошибка авторизации. Обновите страницу и попробуйте снова.',
          isProcessing: false 
        }));
        hasErrorRef.current = true;
        return;
      }
    }

    // Build URL with token and resume flag
    const params = new URLSearchParams();
    params.set('token', token);
    if (isReconnection) {
      params.set('resume', 'true');
    }
    const url = `/api/documents/${documentId}/process-stream?${params.toString()}`;
    
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setState(prev => ({ ...prev, isConnected: true }));
      addLog('SUCCESS', 'Соединение установлено');
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SSEEvent;

        setState((prev) => {
          if (prev.isPaused && data.type === 'token') {
            // Still process tokens but don't update UI text
            tokenCountRef.current++;
            tokensInLastSecondRef.current.push(Date.now());
            return {
              ...prev,
              metrics: { ...prev.metrics, totalTokens: tokenCountRef.current },
            };
          }

          const newState = { ...prev };

          switch (data.type) {
            case 'phase_start': {
              const phaseId = data.phase;
              const phaseTitle = (data.data as { title?: string })?.title || phaseId;
              newState.phases = prev.phases.map((p) =>
                p.id === phaseId
                  ? { ...p, status: 'in_progress' as PhaseStatus, startTime: Date.now() }
                  : p
              );
              addLog('INFO', `Начинаю фазу: ${phaseTitle}`, phaseId);
              break;
            }

            case 'prompt': {
              const phaseId = data.phase;
              const promptData = data.data as { humanReadable: string; technical: string };
              newState.phases = prev.phases.map((p) =>
                p.id === phaseId ? { ...p, prompt: promptData } : p
              );
              addLog('DEBUG', `Промпт: ${promptData.humanReadable}`, phaseId);
              addLog('DEBUG', promptData.technical.slice(0, 500) + '...', phaseId, { isJSON: true });
              break;
            }

            case 'token': {
              const phaseId = data.phase;
              const token = data.data as string;

              // Track token metrics
              tokenCountRef.current++;
              tokensInLastSecondRef.current.push(Date.now());

              newState.phases = prev.phases.map((p) =>
                p.id === phaseId
                  ? { ...p, streamedResponse: p.streamedResponse + token }
                  : p
              );
              newState.metrics = {
                ...prev.metrics,
                totalTokens: tokenCountRef.current,
              };
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
                isSelected: true,
              };
              newState.extractedItems = [...prev.extractedItems, newItem];

              // Log the extraction
              const contentPreview = JSON.stringify(itemData.content).slice(0, 100);
              addLog('SUCCESS', `Извлечен ${itemData.itemType}: ${contentPreview}...`, data.phase, { isJSON: true });
              break;
            }

            case 'phase_complete': {
              const phaseId = data.phase;
              const phaseData = data.data as { success: boolean; chunkCount?: number };
              newState.phases = prev.phases.map((p) =>
                p.id === phaseId
                  ? { ...p, status: 'completed' as PhaseStatus, endTime: Date.now() }
                  : p
              );

              const phase = prev.phases.find(p => p.id === phaseId);
              const duration = phase?.startTime
                ? ((Date.now() - phase.startTime) / 1000).toFixed(1)
                : '?';

              let message = `Фаза завершена за ${duration}с`;
              if (phaseData.chunkCount) {
                message += ` (${phaseData.chunkCount} чанков)`;
              }
              addLog('SUCCESS', message, phaseId);
              break;
            }

            case 'error': {
              const errorData = data.data as { message: string };
              newState.error = errorData.message;
              newState.isProcessing = false;
              hasErrorRef.current = true;
              addLog('ERROR', `ОШИБКА: ${errorData.message}`, data.phase);
              addLog('ERROR', 'Обработка остановлена. Нажмите "Запустить" для повторной попытки.');

              // Close the connection on error - NO reconnection
              eventSource.close();
              break;
            }

            case 'fatal_error': {
              const errorData = data.data as { message: string; fatal: boolean };
              newState.error = errorData.message;
              newState.isProcessing = false;
              hasErrorRef.current = true;
              addLog('ERROR', '════════════════════════════════════════════════════════════');
              addLog('ERROR', `  КРИТИЧЕСКАЯ ОШИБКА (НЕ ПОВТОРЯТЬ)`);
              addLog('ERROR', `  ${errorData.message}`);
              addLog('ERROR', '════════════════════════════════════════════════════════════');
              addLog('ERROR', 'Эта ошибка не может быть исправлена автоматически.');
              addLog('ERROR', 'Проверьте квоту AI API или настройки провайдера.');

              // Close the connection - NEVER reconnect for fatal errors
              eventSource.close();
              break;
            }

            case 'complete': {
              newState.isProcessing = false;
              newState.isComplete = true;
              isCompleteRef.current = true;

              const totalTime = ((Date.now() - prev.metrics.startTime) / 1000).toFixed(1);
              addLog('SUCCESS', '════════════════════════════════════════════════════════════');
              addLog('SUCCESS', `✓ ОБРАБОТКА ЗАВЕРШЕНА`);
              addLog('SUCCESS', `  Время: ${totalTime}с | Токены: ${tokenCountRef.current}`);
              addLog('SUCCESS', '════════════════════════════════════════════════════════════');

              // Close the connection on complete
              eventSource.close();
              break;
            }

            case 'log': {
              // Direct log messages from server
              const logData = data.data as { message: string; level?: LogLevel };
              addLog(logData.level || 'INFO', logData.message, data.phase);
              break;
            }
          }

          return newState;
        });
      } catch (err) {
        console.error('Error parsing SSE event:', err);
        addLog('ERROR', `Ошибка парсинга события: ${err}`);
      }
    };

    eventSource.onerror = () => {
      setState((prev) => ({ ...prev, isConnected: false }));

      // CRITICAL: Check if we should NOT reconnect
      // Never reconnect if:
      // 1. We received an error from the server (hasErrorRef)
      // 2. Processing completed successfully (isCompleteRef)
      // 3. User explicitly stopped (isStoppedRef)
      if (isCompleteRef.current || hasErrorRef.current || isStoppedRef.current) {
        const reason = isCompleteRef.current ? 'завершено'
          : hasErrorRef.current ? 'ошибка сервера'
          : 'остановлено пользователем';
        addLog('INFO', `Соединение закрыто (${reason}) - переподключение отключено`);
        eventSource.close();
        return;
      }

      // Only reconnect for pure connection drops (no error message received)
      // Limited to 3 attempts maximum
      const maxAttempts = 3;
      if (reconnectAttemptsRef.current < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 5000);
        reconnectAttemptsRef.current++;

        addLog('WARNING', `Соединение потеряно. Попытка ${reconnectAttemptsRef.current}/${maxAttempts} через ${delay/1000}с...`);

        reconnectTimeoutRef.current = setTimeout(async () => {
          // Double-check before reconnecting
          if (!isCompleteRef.current && !hasErrorRef.current && !isStoppedRef.current) {
            addLog('INFO', 'Переподключение (продолжение с сохранённого прогресса)...');
            await connectEventSource(true); // isReconnection = true to use resume mode
          } else {
            addLog('INFO', 'Переподключение отменено - статус изменился');
          }
        }, delay);
      } else {
        // Max attempts reached - stop completely
        setState((prev) => ({
          ...prev,
          isProcessing: false,
          error: prev.error || 'Соединение прервано. Нажмите "Запустить" для повторной попытки.',
        }));
        hasErrorRef.current = true; // Prevent further reconnection attempts
        addLog('ERROR', 'Превышено максимальное количество попыток переподключения (3)');
        addLog('ERROR', 'Нажмите "Запустить" для повторной попытки.');
      }

      eventSource.close();
    };
  }, [documentId, addLog]);

  const startProcessing = useCallback(async () => {
    // Reset counters but keep logs (add separator)
    tokenCountRef.current = 0;
    tokensInLastSecondRef.current = [];
    reconnectAttemptsRef.current = 0;
    isCompleteRef.current = false;
    hasErrorRef.current = false;
    isStoppedRef.current = false;

    setState(prev => ({
      isProcessing: true,
      isComplete: false,
      isPaused: false,
      isConnected: false,
      isStopped: false,
      error: null,
      phases: initialPhases.map((p) => ({
        ...p,
        streamedResponse: '',
        status: 'pending',
        startTime: undefined,
        endTime: undefined,
      })),
      extractedItems: [],
      // KEEP existing logs and add a separator
      terminalLogs: prev.terminalLogs.length > 0
        ? [
            ...prev.terminalLogs,
            {
              id: generateLogId(),
              timestamp: new Date(),
              level: 'SYSTEM' as LogLevel,
              message: '',
            },
            {
              id: generateLogId(),
              timestamp: new Date(),
              level: 'SYSTEM' as LogLevel,
              message: '═══════════════════════════════════════════════════════════════',
            },
            {
              id: generateLogId(),
              timestamp: new Date(),
              level: 'SYSTEM' as LogLevel,
              message: '  НОВАЯ СЕССИЯ ОБРАБОТКИ',
            },
            {
              id: generateLogId(),
              timestamp: new Date(),
              level: 'SYSTEM' as LogLevel,
              message: '═══════════════════════════════════════════════════════════════',
            },
          ]
        : [],
      metrics: {
        ...initialMetrics,
        startTime: Date.now(),
      },
    }));

    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    addLog('SYSTEM', '═══════════════════════════════════════════════════════════════');
    addLog('SYSTEM', '  LIBRARIAN AI - Document Processing System v2.0');
    addLog('SYSTEM', `  Document ID: ${documentId}`);
    addLog('SYSTEM', `  Started: ${new Date().toLocaleString('ru-RU')}`);
    addLog('SYSTEM', '═══════════════════════════════════════════════════════════════');

    // Connect EventSource (async)
    connectEventSource().catch((err) => {
      setState((prev) => ({
        ...prev,
        isProcessing: false,
        error: err instanceof Error ? err.message : 'Неизвестная ошибка',
      }));
      addLog('ERROR', `Критическая ошибка: ${err}`);
    });
  }, [documentId, addLog, connectEventSource]);

  const stopProcessing = useCallback(async () => {
    // Mark as stopped to prevent reconnection
    isStoppedRef.current = true;

    // Close the EventSource
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    // Clear any pending reconnection
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Update state
    setState((prev) => ({
      ...prev,
      isProcessing: false,
      isConnected: false,
      isStopped: true,
    }));

    addLog('WARNING', '════════════════════════════════════════════════════════════');
    addLog('WARNING', '  ОБРАБОТКА ОСТАНОВЛЕНА ПОЛЬЗОВАТЕЛЕМ');
    addLog('WARNING', '════════════════════════════════════════════════════════════');

    // Also notify server to cancel (fire and forget)
    try {
      await fetch(`/api/documents/${documentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
    } catch (e) {
      // Ignore errors - this is best effort
      console.warn('Failed to notify server of cancellation:', e);
    }
  }, [documentId, addLog]);

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
      addLog('WARNING', 'Не выбрано ни одного элемента для сохранения');
      return { success: false, error: 'Не выбрано ни одного элемента' };
    }

    addLog('INFO', `Сохраняю ${selectedIds.length} элементов в базу знаний...`);

    try {
      // First, mark selected items as verified
      const verifyResponse = await fetch(`/api/documents/${documentId}/staged`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: selectedIds, action: 'verify' }),
      });

      if (!verifyResponse.ok) {
        const error = await verifyResponse.json();
        addLog('ERROR', `Ошибка верификации: ${error.error || 'Unknown'}`);
        return { success: false, error: error.error || 'Ошибка верификации' };
      }

      addLog('SUCCESS', 'Верификация пройдена');

      // Then, commit verified items
      const commitResponse = await fetch(`/api/documents/${documentId}/commit`, {
        method: 'POST',
      });

      if (!commitResponse.ok) {
        const error = await commitResponse.json();
        addLog('ERROR', `Ошибка сохранения: ${error.error || 'Unknown'}`);
        return { success: false, error: error.error || 'Ошибка сохранения' };
      }

      const result = await commitResponse.json();
      addLog('SUCCESS', `✓ Успешно сохранено ${selectedIds.length} элементов в базу знаний`);

      // Remove committed items from state to prevent re-saving
      setState(prev => ({
        ...prev,
        extractedItems: prev.extractedItems.filter(
          item => !selectedIds.includes(item.id)
        ),
      }));

      return { success: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
      addLog('ERROR', `Критическая ошибка: ${message}`);
      return { success: false, error: message };
    }
  }, [documentId, state.extractedItems, addLog]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (metricsIntervalRef.current) {
        clearInterval(metricsIntervalRef.current);
      }
    };
  }, []);

  return {
    ...state,
    startProcessing,
    stopProcessing,
    toggleItemSelection,
    selectAll,
    deselectAll,
    commitSelected,
    clearLogs,
    togglePause,
    getLogsAsText,
  };
}
