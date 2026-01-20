'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TerminalLog } from '@/hooks/useDocumentProcessing';

interface LiveTerminalProps {
  logs: TerminalLog[];
  isConnected: boolean;
  isProcessing: boolean;
  metrics?: {
    tokensPerSecond: number;
    totalTokens: number;
    elapsedTime: number;
  };
  onClear?: () => void;
  onPause?: () => void;
  isPaused?: boolean;
}

type LogLevel = 'DEBUG' | 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SYSTEM';
type FilterLevel = LogLevel | 'ALL';

const LOG_LEVEL_CONFIG: Record<LogLevel, { color: string; bgColor: string; icon: string }> = {
  DEBUG: { color: 'text-gray-400', bgColor: 'bg-gray-500/20', icon: '○' },
  INFO: { color: 'text-cyan-400', bgColor: 'bg-cyan-500/20', icon: '●' },
  SUCCESS: { color: 'text-green-400', bgColor: 'bg-green-500/20', icon: '✓' },
  WARNING: { color: 'text-yellow-400', bgColor: 'bg-yellow-500/20', icon: '⚠' },
  ERROR: { color: 'text-red-400', bgColor: 'bg-red-500/20', icon: '✗' },
  SYSTEM: { color: 'text-purple-400', bgColor: 'bg-purple-500/20', icon: '◈' },
};

const PHASE_CONFIG: Record<string, { color: string; label: string }> = {
  DOMAIN_CLASSIFICATION: { color: 'text-blue-400', label: 'DOMAIN' },
  KNOWLEDGE_EXTRACTION: { color: 'text-emerald-400', label: 'EXTRACT' },
  CHUNKING: { color: 'text-orange-400', label: 'CHUNK' },
  SYSTEM: { color: 'text-purple-400', label: 'SYS' },
};

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).replace(',', '.');
}

function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// JSON Syntax Highlighter
function highlightJSON(text: string): React.ReactNode {
  if (!text.includes('{') && !text.includes('[')) {
    return text;
  }

  try {
    // Try to find and highlight JSON portions
    const jsonRegex = /(\{[\s\S]*\}|\[[\s\S]*\])/g;
    const parts = text.split(jsonRegex);

    return parts.map((part, i) => {
      if (part.match(/^\{[\s\S]*\}$/) || part.match(/^\[[\s\S]*\]$/)) {
        try {
          const parsed = JSON.parse(part);
          const formatted = JSON.stringify(parsed, null, 2);
          return (
            <span key={i} className="json-highlight">
              {formatJSONString(formatted)}
            </span>
          );
        } catch {
          return part;
        }
      }
      return part;
    });
  } catch {
    return text;
  }
}

function formatJSONString(json: string): React.ReactNode {
  const lines = json.split('\n');
  return lines.map((line, i) => {
    // Highlight keys
    const keyMatch = line.match(/^(\s*)("[\w\s]+")(:)/);
    if (keyMatch) {
      const [, indent, key, colon] = keyMatch;
      const rest = line.slice(keyMatch[0].length);
      return (
        <span key={i}>
          {indent}
          <span className="text-cyan-400">{key}</span>
          <span className="text-gray-500">{colon}</span>
          {highlightValue(rest)}
          {'\n'}
        </span>
      );
    }
    return <span key={i}>{highlightValue(line)}{'\n'}</span>;
  });
}

function highlightValue(value: string): React.ReactNode {
  // String values
  if (value.includes('"')) {
    return value.replace(/"([^"]*)"/g, (match) => {
      return `<span class="text-green-400">${match}</span>`;
    }).split(/(<span[^>]*>[^<]*<\/span>)/).map((part, i) => {
      if (part.startsWith('<span')) {
        const content = part.match(/>([^<]*)</)?.[1] || '';
        return <span key={i} className="text-green-400">{`"${content}"`}</span>;
      }
      // Numbers
      if (/^\s*[\d.]+/.test(part)) {
        return <span key={i} className="text-yellow-400">{part}</span>;
      }
      // Booleans
      if (/true|false|null/.test(part)) {
        return <span key={i} className="text-purple-400">{part}</span>;
      }
      return part;
    });
  }
  // Numbers
  if (/^\s*[\d.]+/.test(value)) {
    return <span className="text-yellow-400">{value}</span>;
  }
  // Booleans
  if (/true|false|null/.test(value)) {
    return <span className="text-purple-400">{value}</span>;
  }
  return value;
}

function TerminalLogEntry({ log, isLatest }: { log: TerminalLog; isLatest: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const levelConfig = LOG_LEVEL_CONFIG[log.level] || LOG_LEVEL_CONFIG.INFO;
  const phaseConfig = PHASE_CONFIG[log.phase || 'SYSTEM'] || PHASE_CONFIG.SYSTEM;

  const isLongMessage = log.message.length > 200;
  const displayMessage = isExpanded || !isLongMessage
    ? log.message
    : log.message.slice(0, 200) + '...';

  return (
    <div
      className={`terminal-log-entry group flex gap-2 py-0.5 px-2 hover:bg-white/5 font-mono text-xs leading-relaxed transition-colors ${
        isLatest ? 'animate-terminal-flash' : ''
      }`}
    >
      {/* Timestamp */}
      <span className="text-gray-500 shrink-0 tabular-nums">
        {formatTimestamp(log.timestamp)}
      </span>

      {/* Level badge */}
      <span className={`shrink-0 w-5 text-center ${levelConfig.color}`}>
        {levelConfig.icon}
      </span>

      {/* Phase badge */}
      {log.phase && (
        <span className={`shrink-0 px-1.5 py-0 rounded text-[10px] font-semibold uppercase ${phaseConfig.color} bg-current/10`}>
          {phaseConfig.label}
        </span>
      )}

      {/* Message */}
      <span
        className={`flex-1 break-all ${levelConfig.color} ${
          log.level === 'ERROR' ? 'font-semibold' : ''
        }`}
      >
        {log.isJSON ? highlightJSON(displayMessage) : displayMessage}
        {isLongMessage && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="ml-2 text-cyan-500 hover:text-cyan-400 underline"
          >
            {isExpanded ? '[свернуть]' : '[развернуть]'}
          </button>
        )}
        {isLatest && log.isStreaming && (
          <span className="animate-pulse text-cyan-400">▌</span>
        )}
      </span>
    </div>
  );
}

export function LiveTerminal({
  logs,
  isConnected,
  isProcessing,
  metrics,
  onClear,
  onPause,
  isPaused,
}: LiveTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<FilterLevel>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Handle scroll to detect manual scrolling
  const handleScroll = () => {
    if (terminalRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setAutoScroll(isAtBottom);
    }
  };

  // Filter logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (filter !== 'ALL' && log.level !== filter) return false;
      if (searchQuery && !log.message.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [logs, filter, searchQuery]);

  const connectionStatus = isConnected
    ? (isProcessing ? 'STREAMING' : 'CONNECTED')
    : 'DISCONNECTED';

  const statusColor = {
    STREAMING: 'text-green-400 bg-green-500/20',
    CONNECTED: 'text-cyan-400 bg-cyan-500/20',
    DISCONNECTED: 'text-red-400 bg-red-500/20',
  }[connectionStatus];

  return (
    <div className="terminal-container flex flex-col h-full rounded-lg border border-cyan-500/30 bg-[#0a0e14] overflow-hidden shadow-[0_0_30px_rgba(0,255,255,0.1)]">
      {/* Header */}
      <div className="terminal-header flex items-center justify-between px-3 py-2 border-b border-cyan-500/20 bg-gradient-to-r from-cyan-500/10 to-purple-500/10">
        <div className="flex items-center gap-3">
          {/* Window controls */}
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-green-500/80" />
          </div>

          {/* Title */}
          <span className="text-cyan-400 font-mono text-sm font-semibold tracking-wider">
            LIBRARIAN AI TERMINAL
          </span>

          {/* Connection status */}
          <Badge className={`${statusColor} font-mono text-[10px] px-2 py-0`}>
            {connectionStatus}
            {connectionStatus === 'STREAMING' && (
              <span className="ml-1 animate-pulse">●</span>
            )}
          </Badge>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Filter dropdown */}
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterLevel)}
            className="bg-black/50 border border-cyan-500/30 rounded px-2 py-1 text-xs text-cyan-400 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
          >
            <option value="ALL">ALL</option>
            <option value="DEBUG">DEBUG</option>
            <option value="INFO">INFO</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="WARNING">WARNING</option>
            <option value="ERROR">ERROR</option>
            <option value="SYSTEM">SYSTEM</option>
          </select>

          {/* Pause button */}
          {onPause && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onPause}
              className="h-7 px-2 text-xs font-mono text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
            >
              {isPaused ? '▶ RESUME' : '⏸ PAUSE'}
            </Button>
          )}

          {/* Clear button */}
          {onClear && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="h-7 px-2 text-xs font-mono text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
            >
              ✕ CLEAR
            </Button>
          )}

          {/* Auto-scroll indicator */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`text-xs font-mono px-2 py-1 rounded transition-colors ${
              autoScroll
                ? 'text-green-400 bg-green-500/10'
                : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            {autoScroll ? '↓ AUTO' : '↓ MANUAL'}
          </button>
        </div>
      </div>

      {/* Metrics bar */}
      {metrics && (
        <div className="flex items-center gap-4 px-3 py-1.5 border-b border-cyan-500/10 bg-black/30 font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">TOKENS:</span>
            <span className="text-cyan-400 tabular-nums">{metrics.totalTokens.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">SPEED:</span>
            <span className="text-green-400 tabular-nums">{metrics.tokensPerSecond.toFixed(1)}</span>
            <span className="text-gray-500">tok/s</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">TIME:</span>
            <span className="text-yellow-400 tabular-nums">{formatElapsedTime(metrics.elapsedTime)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-gray-500">LOGS:</span>
            <span className="text-purple-400 tabular-nums">{filteredLogs.length}/{logs.length}</span>
          </div>
        </div>
      )}

      {/* Terminal body */}
      <div
        ref={terminalRef}
        onScroll={handleScroll}
        className="terminal-body flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-cyan-500/30 scrollbar-track-transparent"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 font-mono">
            <div className="text-4xl mb-2 opacity-20">◈</div>
            <div className="text-sm">Ожидание данных...</div>
            <div className="text-xs mt-1">Нажмите "Начать обработку" для запуска</div>
          </div>
        ) : (
          <div className="py-1">
            {filteredLogs.map((log, index) => (
              <TerminalLogEntry
                key={log.id}
                log={log}
                isLatest={index === filteredLogs.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer / Input line */}
      <div className="terminal-footer flex items-center gap-2 px-3 py-2 border-t border-cyan-500/20 bg-black/30">
        <span className="text-cyan-500 font-mono text-sm">❯</span>
        <input
          type="text"
          placeholder="Поиск в логах..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 bg-transparent border-none outline-none text-cyan-400 font-mono text-sm placeholder:text-gray-600"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="text-gray-500 hover:text-gray-400 text-xs"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
