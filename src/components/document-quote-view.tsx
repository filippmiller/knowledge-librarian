'use client';

import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { locateQuote, type QuoteMatch } from '@/lib/knowledge/quote-locator';

interface DocumentQuoteViewProps {
  /** Полный текст документа-источника (`Document.rawText`). */
  text: string;
  /** Цитата из `Rule.sourceSpan.quote`, которую нужно подсветить. */
  quote?: string | null;
  className?: string;
  /** Высота области с текстом; в модалке ограничиваем, в мини-аппе — нет. */
  textClassName?: string;
}

interface Status {
  tone: 'ok' | 'warn' | 'error' | 'neutral';
  title: string;
  detail?: string;
}

/**
 * Что именно поиск считает несущественным. Перечислено дословно, потому что
 * оператор по зелёной плашке решает «сверено»: сказать «различия только в
 * пробелах и кавычках», а втихую приравнять ещё и регистр с ё/е — значит
 * назвать ему неверную причину совпадения.
 */
const IGNORED_ON_NORMALIZE =
  'при сверке не учитывались регистр, ё/е, вид кавычек и тире, любое количество пробелов и ' +
  'переносов строк, а также невидимые символы из PDF и Word';

function buildStatus(quote: string | null | undefined, match: QuoteMatch | null): Status {
  if (!quote?.trim()) {
    return {
      tone: 'neutral',
      title: 'В правиле не сохранена цитата',
      detail: 'Подсвечивать нечего — показан весь текст документа, сверяйте вручную.',
    };
  }
  if (!match) {
    return {
      tone: 'error',
      title: 'Фрагмент не найден в тексте документа',
      detail:
        'Подсветки нет. Причины бывают три: правило отредактировали после извлечения и цитата ' +
        'осталась от прежней версии; текст документа изменился; цитата собрана моделью из ' +
        'разрозненных кусков (частая история с таблицами). Сверяйте правило с документом вручную.',
    };
  }

  // Такое же совпадение нашлось ещё где-то: место — догадка, и об этом надо
  // сказать раньше, чем оператор прочитает процент как доказательство.
  const guess = match.ambiguous
    ? ' Точно такой же фрагмент есть в документе ещё раз — подсвечено первое вхождение, место показано наугад.'
    : '';
  const tone: Status['tone'] = match.ambiguous ? 'warn' : 'ok';

  if (match.kind === 'partial') {
    return {
      tone: 'warn',
      title: `Совпало только начало цитаты (${Math.round(match.coverage * 100)}%)`,
      detail:
        'Подсвечена совпавшая часть. Остаток цитаты в документе не найден — это не полная сверка.' +
        guess,
    };
  }
  if (match.kind === 'normalized') {
    return {
      tone,
      title: 'Фрагмент найден, но не дословно',
      detail: `Цитата совпала не буква в букву: ${IGNORED_ON_NORMALIZE}.${guess}`,
    };
  }
  return {
    tone,
    title: 'Фрагмент найден в тексте документа дословно',
    detail: guess.trim() || undefined,
  };
}

const TONE_CLASSES: Record<Status['tone'], string> = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-900',
  warn: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-900',
  error: 'bg-red-50 text-red-800 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-900',
  neutral: 'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700',
};

/**
 * Показ текста документа с подсветкой цитаты правила.
 *
 * Единственная реализация подсветки в проекте: используется и в мини-аппе
 * (просмотр документа из карточки правила), и в админке (модалка источника
 * правила). Молча показать неподсвеченный текст нельзя — оператор решит, что
 * сверил, хотя не сверил, поэтому степень совпадения выводится всегда.
 */
export function DocumentQuoteView({ text, quote, className, textClassName }: DocumentQuoteViewProps) {
  const highlightRef = useRef<HTMLSpanElement | null>(null);
  const match = useMemo(() => locateQuote(text, quote), [text, quote]);
  const status = buildStatus(quote, match);

  useEffect(() => {
    if (!match) return;
    // Таймер — чтобы контейнер (модалка/оверлей) успел смонтироваться и получить размер.
    const timer = setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    return () => clearTimeout(timer);
  }, [match]);

  const StatusIcon = status.tone === 'ok' ? CheckCircle2 : status.tone === 'neutral' ? HelpCircle : AlertTriangle;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className={cn('flex gap-2 rounded-lg border px-3 py-2 text-sm', TONE_CLASSES[status.tone])}>
        <StatusIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">{status.title}</div>
          {status.detail && <div className="mt-0.5 text-xs opacity-90">{status.detail}</div>}
        </div>
      </div>

      <div
        className={cn(
          'whitespace-pre-wrap rounded-xl p-4 font-mono text-sm leading-relaxed',
          'bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200',
          textClassName
        )}
      >
        {match ? (
          <>
            <span>{text.slice(0, match.start)}</span>
            <span
              ref={highlightRef}
              className={cn(
                'rounded px-0.5 text-gray-900 dark:text-white',
                match.kind === 'partial'
                  ? 'bg-amber-200 dark:bg-amber-700'
                  : 'bg-yellow-300 dark:bg-yellow-600'
              )}
            >
              {text.slice(match.start, match.end)}
            </span>
            <span>{text.slice(match.end)}</span>
          </>
        ) : (
          <span>{text}</span>
        )}
      </div>
    </div>
  );
}
