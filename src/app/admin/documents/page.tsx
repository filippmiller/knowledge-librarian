'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProcessingModal } from '@/components/document-processor';

interface Document {
  id: string;
  title: string;
  filename: string;
  mimeType: string;
  uploadedAt: string;
  parseStatus: string;
  parseError: string | null;
  domains: Array<{
    isPrimary: boolean;
    domain: { slug: string; title: string };
  }>;
  _count: {
    rules: number;
    qaPairs: number;
    chunks: number;
  };
}

// Toast component
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error' | 'info'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const colors = {
    success: 'bg-green-500/20 border-green-500/50 text-green-400',
    error: 'bg-red-500/20 border-red-500/50 text-red-400',
    info: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400',
  }[type];

  return (
    <div className={`fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg border ${colors} shadow-lg font-mono text-sm`}>
      <div className="flex items-center gap-2">
        <span>{message}</span>
        <button onClick={onClose} className="ml-2 opacity-60 hover:opacity-100">✕</button>
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // Modal state
  const [processingModal, setProcessingModal] = useState<{
    isOpen: boolean;
    documentId: string | null;
    documentTitle: string;
    autoStart: boolean;
  }>({ isOpen: false, documentId: null, documentTitle: '', autoStart: true });

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    setToast({ message, type });
  }, []);

  async function fetchDocuments() {
    try {
      const response = await fetch('/api/documents');
      const data = await response.json();
      setDocuments(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching documents:', error);
      showToast('Ошибка загрузки документов', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchDocuments();
    // Refresh every 30 seconds to update statuses
    const interval = setInterval(fetchDocuments, 30000);
    return () => clearInterval(interval);
  }, []);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', file.name);

    try {
      const response = await fetch('/api/documents', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        showToast('Документ загружен, начинаю обработку...', 'success');

        // Open processing modal
        setProcessingModal({
          isOpen: true,
          documentId: data.id,
          documentTitle: file.name,
          autoStart: true,
        });

        fetchDocuments();
      } else if (response.status === 409) {
        // Duplicate document
        const data = await response.json();
        showToast(data.error || 'Документ уже существует', 'error');
        fetchDocuments();
      } else {
        const error = await response.json();
        showToast(error.error || 'Ошибка загрузки', 'error');
      }
    } catch (error) {
      console.error('Upload error:', error);
      showToast('Ошибка загрузки', 'error');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  // Document actions
  async function handleDocumentAction(docId: string, action: 'delete' | 'reset' | 'cancel' | 'retry') {
    try {
      if (action === 'delete') {
        if (!confirm('Удалить документ и все связанные данные?')) return;

        const response = await fetch(`/api/documents/${docId}`, { method: 'DELETE' });
        if (response.ok) {
          showToast('Документ удален', 'success');
          fetchDocuments();
        } else {
          throw new Error('Failed to delete');
        }
      } else {
        const response = await fetch(`/api/documents/${docId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });

        if (response.ok) {
          const messages = {
            reset: 'Документ сброшен',
            cancel: 'Обработка отменена',
            retry: 'Готов к повторной обработке',
          };
          showToast(messages[action], 'success');
          fetchDocuments();
        } else {
          throw new Error('Failed to perform action');
        }
      }
    } catch (error) {
      showToast('Ошибка выполнения действия', 'error');
    }
  }

  // Bulk actions
  async function handleBulkAction(action: 'reset-stuck' | 'cancel-all-processing') {
    try {
      const response = await fetch('/api/documents', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (response.ok) {
        const data = await response.json();
        showToast(data.message, 'success');
        fetchDocuments();
      } else {
        throw new Error('Failed to perform bulk action');
      }
    } catch (error) {
      showToast('Ошибка выполнения действия', 'error');
    }
  }

  // Open processing modal for a document
  function openProcessingModal(doc: Document) {
    setProcessingModal({
      isOpen: true,
      documentId: doc.id,
      documentTitle: doc.title,
      autoStart: doc.parseStatus !== 'COMPLETED',
    });
  }

  function formatProcessingAge(uploadedAt: string) {
    const startedAt = new Date(uploadedAt).getTime();
    if (Number.isNaN(startedAt)) return null;

    const diffMs = Date.now() - startedAt;
    if (diffMs < 0) return null;

    const totalMinutes = Math.floor(diffMs / 60000);
    const totalHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(totalHours / 24);

    if (days > 0) return `${days}д`;
    if (totalHours > 0) return `${totalHours}ч`;
    if (totalMinutes > 0) return `${totalMinutes}м`;
    return 'сейчас';
  }

  function getStatusBadge(status: string) {
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className: string }> = {
      PENDING: { variant: 'secondary', className: 'bg-yellow-500/20 text-yellow-400' },
      PROCESSING: { variant: 'outline', className: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50' },
      EXTRACTED: { variant: 'outline', className: 'bg-orange-500/20 text-orange-400 border-orange-500/50' },
      COMPLETED: { variant: 'default', className: 'bg-green-500/20 text-green-400' },
      FAILED: { variant: 'destructive', className: 'bg-red-500/20 text-red-400' },
    };

    const c = config[status] || config.PENDING;

    if (status === 'PROCESSING') {
      return (
        <Badge variant={c.variant} className={`gap-1.5 font-mono ${c.className}`}>
          <span className="inline-block h-2 w-2 rounded-full border-2 border-current border-t-transparent animate-spin" />
          PROCESSING
        </Badge>
      );
    }

    return (
      <Badge variant={c.variant} className={`font-mono ${c.className}`}>
        {status === 'COMPLETED' && '✓ '}
        {status === 'FAILED' && '✗ '}
        {status === 'PENDING' && '◌ '}
        {status === 'EXTRACTED' && '⬡ '}
        {status}
      </Badge>
    );
  }

  const processingCount = documents.filter(d => d.parseStatus === 'PROCESSING').length;
  const extractedCount = documents.filter(d => d.parseStatus === 'EXTRACTED').length;
  const stuckCount = documents.filter(d => {
    if (d.parseStatus !== 'PROCESSING') return false;
    const age = Date.now() - new Date(d.uploadedAt).getTime();
    return age > 30 * 60 * 1000; // 30 minutes
  }).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-cyan-400 font-mono animate-pulse">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Документы</h1>
          <p className="text-sm text-gray-500 mt-1">
            Всего: {documents.length}
            {processingCount > 0 && ` | В обработке: ${processingCount}`}
            {extractedCount > 0 && <span className="text-orange-500"> | Ожидают проверки: {extractedCount}</span>}
            {stuckCount > 0 && <span className="text-yellow-500"> | Зависших: {stuckCount}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Bulk actions */}
          {(processingCount > 0 || stuckCount > 0) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="font-mono">
                  Массовые действия
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {stuckCount > 0 && (
                  <DropdownMenuItem onClick={() => handleBulkAction('reset-stuck')}>
                    Сбросить зависшие ({stuckCount})
                  </DropdownMenuItem>
                )}
                {processingCount > 0 && (
                  <DropdownMenuItem onClick={() => handleBulkAction('cancel-all-processing')}>
                    Отменить все ({processingCount})
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Upload */}
          <div className="relative">
            <Input
              type="file"
              accept=".pdf,.docx,.doc,.txt,.md,.rtf"
              onChange={handleUpload}
              disabled={uploading}
              className="max-w-xs cursor-pointer"
            />
            {uploading && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded">
                <span className="text-cyan-400 font-mono text-sm animate-pulse">Загрузка...</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Documents table */}
      {documents.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <div className="text-4xl mb-4 opacity-20">📄</div>
            <p className="text-gray-500">Документы ещё не загружены.</p>
            <p className="text-sm text-gray-400 mt-1">Загрузите первый документ, чтобы начать.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-gray-50">
                <TableHead className="font-semibold">Название</TableHead>
                <TableHead className="font-semibold">Статус</TableHead>
                <TableHead className="font-semibold">Домены</TableHead>
                <TableHead className="font-semibold text-center">Правила</TableHead>
                <TableHead className="font-semibold text-center">Q&A</TableHead>
                <TableHead className="font-semibold">Загружен</TableHead>
                <TableHead className="font-semibold text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((doc) => (
                <TableRow key={doc.id} className="hover:bg-gray-50">
                  <TableCell>
                    <button
                      onClick={() => openProcessingModal(doc)}
                      className="text-blue-600 hover:underline text-left"
                    >
                      {doc.title}
                    </button>
                    <div className="text-xs text-gray-400">{doc.filename}</div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {getStatusBadge(doc.parseStatus)}
                      {doc.parseStatus === 'PROCESSING' && (
                        <div className="text-xs text-gray-500">
                          {formatProcessingAge(doc.uploadedAt)}
                        </div>
                      )}
                    </div>
                    {doc.parseError && (
                      <div className="text-xs text-red-500 mt-1 max-w-xs truncate" title={doc.parseError}>
                        {doc.parseError}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {doc.domains.slice(0, 3).map((d) => (
                        <Badge
                          key={d.domain.slug}
                          variant={d.isPrimary ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {d.domain.slug}
                        </Badge>
                      ))}
                      {doc.domains.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{doc.domains.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-center font-mono">{doc._count.rules}</TableCell>
                  <TableCell className="text-center font-mono">{doc._count.qaPairs}</TableCell>
                  <TableCell className="text-sm text-gray-500">
                    {new Date(doc.uploadedAt).toLocaleDateString('ru-RU')}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openProcessingModal(doc)}
                        className="font-mono text-xs"
                      >
                        {doc.parseStatus === 'COMPLETED' ? 'Просмотр' : doc.parseStatus === 'EXTRACTED' ? 'Проверить' : doc.parseStatus === 'PENDING' ? 'Обработать' : 'Терминал'}
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="px-2">
                            ⋮
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {doc.parseStatus === 'PENDING' && (
                            <DropdownMenuItem onClick={() => openProcessingModal(doc)}>
                              ▶ Начать обработку
                            </DropdownMenuItem>
                          )}
                          {doc.parseStatus === 'PROCESSING' && (
                            <DropdownMenuItem onClick={() => handleDocumentAction(doc.id, 'cancel')}>
                              ✗ Отменить обработку
                            </DropdownMenuItem>
                          )}
                          {doc.parseStatus === 'EXTRACTED' && (
                            <>
                              <DropdownMenuItem onClick={() => openProcessingModal(doc)}>
                                ⬡ Проверить и сохранить
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleDocumentAction(doc.id, 'reset')}>
                                ↻ Сбросить и переобработать
                              </DropdownMenuItem>
                            </>
                          )}
                          {doc.parseStatus === 'FAILED' && (
                            <DropdownMenuItem onClick={() => handleDocumentAction(doc.id, 'retry')}>
                              ↻ Повторить обработку
                            </DropdownMenuItem>
                          )}
                          {doc.parseStatus === 'COMPLETED' && (
                            <DropdownMenuItem onClick={() => handleDocumentAction(doc.id, 'reset')}>
                              ↻ Сбросить и переобработать
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleDocumentAction(doc.id, 'delete')}
                            className="text-red-600"
                          >
                            🗑 Удалить документ
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Processing Modal */}
      <ProcessingModal
        key={processingModal.documentId || 'none'}
        isOpen={processingModal.isOpen}
        onClose={() => {
          setProcessingModal({ isOpen: false, documentId: null, documentTitle: '', autoStart: true });
          fetchDocuments(); // Refresh list after closing
        }}
        documentId={processingModal.documentId}
        documentTitle={processingModal.documentTitle}
        autoStart={processingModal.autoStart}
      />

      {/* Toast */}
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
