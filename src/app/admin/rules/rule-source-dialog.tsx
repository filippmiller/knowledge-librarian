'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileQuestion, FileText, History, Loader2, MicVocal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DocumentQuoteView } from '@/components/document-quote-view';

interface RuleSourceResponse {
  rule: {
    id: string;
    ruleCode: string;
    title: string;
    body: string;
    confidence: number;
    status: string;
    version: number;
  };
  span: { quote: string | null; locationHint: string | null; authorityTag: string | null };
  document: {
    id: string;
    title: string;
    filename: string;
    parseStatus: string;
    rawText: string | null;
  } | null;
}

interface RuleSourceDialogProps {
  /** id открытого правила; null — модалка закрыта. */
  ruleId: string | null;
  onClose: () => void;
  /**
   * Кнопка, с которой модалку открыли: Radix по умолчанию возвращает фокус на
   * элемент, активный в момент открытия, а в таблице это может быть body —
   * тогда клавиатурный пользователь теряет место в списке.
   */
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

export function RuleSourceDialog({ ruleId, onClose, restoreFocusRef }: RuleSourceDialogProps) {
  const [data, setData] = useState<RuleSourceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Документ грузим по клику на конкретное правило: в списке их больше двух
  // тысяч, тянуть тексты документов заранее нельзя.
  useEffect(() => {
    if (!ruleId) return;
    // Запрос обрывается вместе с закрытием модалки: ответ везёт весь текст
    // документа, и дочитывать его для правила, которое оператор уже закрыл,
    // незачем.
    const abort = new AbortController();

    async function load(id: string) {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetch(`/api/rules/${id}/source`, { signal: abort.signal });
        if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
        setData((await res.json()) as RuleSourceResponse);
      } catch (e: unknown) {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Не удалось загрузить источник');
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }

    void load(ruleId);

    return () => abort.abort();
  }, [ruleId]);

  return (
    <Dialog open={ruleId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-4xl"
        onCloseAutoFocus={(event) => {
          const trigger = restoreFocusRef?.current;
          if (!trigger) return;
          event.preventDefault();
          trigger.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-mono">{data?.rule.ruleCode ?? 'Правило'}</DialogTitle>
          <DialogDescription>
            {data ? data.rule.title : 'Сверка извлечённого правила с документом-источником'}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Загружаем документ-источник...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-5">
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  Текст правила
                </span>
                <Badge variant="outline">{data.rule.status}</Badge>
                <Badge variant="outline">v{data.rule.version}</Badge>
                <Badge variant="outline">{Math.round(data.rule.confidence * 100)}%</Badge>
              </div>
              <div className="text-sm whitespace-pre-wrap text-slate-800">{data.rule.body}</div>
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs font-medium tracking-wide text-slate-500 uppercase">
                  Источник
                </span>
                {data.document ? (
                  <>
                    <FileText className="h-4 w-4 text-slate-400" />
                    <span className="font-medium text-slate-800">{data.document.title}</span>
                    <span className="text-slate-400">({data.document.filename})</span>
                    <Link
                      href={`/admin/documents/${data.document.id}/process`}
                      className="text-blue-600 underline underline-offset-2 hover:text-blue-800"
                    >
                      Открыть документ
                    </Link>
                  </>
                ) : (
                  <span className="text-slate-500">не привязан</span>
                )}
              </div>

              {data.span.locationHint && (
                <div className="text-sm text-slate-500">
                  Место в документе по данным извлечения: {data.span.locationHint}
                </div>
              )}

              {/*
                Правку правила сохраняют новой версией, а sourceSpan копируют от
                прежней: текст уже другой, цитата — старая. Без этой оговорки
                зелёное «найдено дословно» ниже относилось бы к тексту, которого
                оператор на экране не видит.
              */}
              {data.rule.version > 1 && (
                <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                  <History className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">
                      Правило редактировали после извлечения (версия {data.rule.version})
                    </div>
                    <div className="mt-0.5 text-xs">
                      Цитата осталась от первой версии. Сверка ниже говорит о ней, а не о текущем
                      тексте правила — текущий текст с документом никто не сверял.
                    </div>
                  </div>
                </div>
              )}

              {data.span.quote && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  <div className="mb-1 text-xs font-medium tracking-wide text-slate-500 uppercase">
                    Цитата из правила
                  </div>
                  <div className="whitespace-pre-wrap">{data.span.quote}</div>
                </div>
              )}

              {!data.document && data.span.authorityTag ? (
                <div className="flex gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-700">
                  <MicVocal className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div>
                    <div className="font-medium">Документа-источника нет по природе правила</div>
                    <div className="mt-0.5 text-xs">
                      Правило заведено оператором, метка происхождения — {data.span.authorityTag}.
                      Сверять не с чем: проверяйте формулировку с автором правила.
                    </div>
                  </div>
                </div>
              ) : !data.document ? (
                <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                  <FileQuestion className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Документ-источник не найден в базе</div>
                    <div className="mt-0.5 text-xs">
                      Откуда правило — неизвестно. У правил, заведённых оператором, стоит метка
                      происхождения, а здесь её нет: похоже, документ был, но его удалили — удаление
                      документа не удаляет извлечённые из него правила. Сверить не с чем, проверяйте
                      формулировку по существу.
                    </div>
                  </div>
                </div>
              ) : !data.document.rawText ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                  <div className="font-medium">Текст документа недоступен</div>
                  <div className="mt-0.5 text-xs">
                    Документ в статусе {data.document.parseStatus} — распознанного текста в базе нет,
                    подсветить фрагмент не получится.
                  </div>
                </div>
              ) : (
                <DocumentQuoteView
                  text={data.document.rawText}
                  quote={data.span.quote}
                  textClassName="max-h-[45vh] overflow-y-auto border border-slate-200"
                />
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
