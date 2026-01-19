'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ExtractedItem } from '@/hooks/useDocumentProcessing';

interface ExtractedItemsGridProps {
  items: ExtractedItem[];
  onToggleSelection: (itemId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onCommit: () => Promise<{ success: boolean; error?: string; result?: unknown }>;
}

const itemTypeConfig: Record<string, { label: string; color: string }> = {
  DOMAIN_ASSIGNMENT: { label: 'Домен', color: 'bg-blue-100 text-blue-800' },
  DOMAIN_SUGGESTION: { label: 'Предложение домена', color: 'bg-purple-100 text-purple-800' },
  RULE: { label: 'Правило', color: 'bg-green-100 text-green-800' },
  QA_PAIR: { label: 'Вопрос-Ответ', color: 'bg-yellow-100 text-yellow-800' },
  UNCERTAINTY: { label: 'Неясность', color: 'bg-orange-100 text-orange-800' },
  CHUNK: { label: 'Чанк', color: 'bg-gray-100 text-gray-800' },
};

function ItemCard({
  item,
  onToggle,
}: {
  item: ExtractedItem;
  onToggle: () => void;
}) {
  const config = itemTypeConfig[item.itemType] || {
    label: item.itemType,
    color: 'bg-gray-100 text-gray-800',
  };
  const content = item.content as Record<string, unknown>;

  return (
    <div
      className={`p-3 border rounded-lg cursor-pointer transition-all ${
        item.isSelected
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 hover:border-gray-300'
      }`}
      onClick={onToggle}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={item.isSelected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge className={config.color}>{config.label}</Badge>
            {content.confidence !== undefined && (
              <span
                className={`text-xs ${
                  (content.confidence as number) >= 0.8
                    ? 'text-green-600'
                    : 'text-yellow-600'
                }`}
              >
                {((content.confidence as number) * 100).toFixed(0)}%
              </span>
            )}
          </div>

          {/* Rule display */}
          {item.itemType === 'RULE' && (
            <div>
              <div className="font-medium text-sm">
                {content.ruleCode as string}: {content.title as string}
              </div>
              <div className="text-sm text-gray-600 line-clamp-2">
                {content.body as string}
              </div>
            </div>
          )}

          {/* QA Pair display */}
          {item.itemType === 'QA_PAIR' && (
            <div>
              <div className="font-medium text-sm">
                {content.question as string}
              </div>
              <div className="text-sm text-gray-600 line-clamp-2">
                {content.answer as string}
              </div>
            </div>
          )}

          {/* Domain Assignment display */}
          {item.itemType === 'DOMAIN_ASSIGNMENT' && (
            <div>
              <div className="font-medium text-sm">
                Основной: {content.primaryDomainSlug as string}
              </div>
              {(content.secondaryDomainSlugs as string[])?.length > 0 && (
                <div className="text-sm text-gray-600">
                  Дополнительные:{' '}
                  {(content.secondaryDomainSlugs as string[]).join(', ')}
                </div>
              )}
              <div className="text-xs text-gray-500 mt-1">
                {content.reason as string}
              </div>
            </div>
          )}

          {/* Domain Suggestion display */}
          {item.itemType === 'DOMAIN_SUGGESTION' && (
            <div>
              <div className="font-medium text-sm">
                {content.suggestedSlug as string}: {content.title as string}
              </div>
              <div className="text-sm text-gray-600">
                {content.description as string}
              </div>
            </div>
          )}

          {/* Uncertainty display */}
          {item.itemType === 'UNCERTAINTY' && (
            <div>
              <div className="font-medium text-sm text-orange-700">
                {content.type as string}
              </div>
              <div className="text-sm text-gray-600">
                {content.description as string}
              </div>
              <div className="text-sm text-gray-500 mt-1 italic">
                Вопрос: {content.suggestedQuestion as string}
              </div>
            </div>
          )}

          {/* Chunk display */}
          {item.itemType === 'CHUNK' && (
            <div>
              <div className="text-xs text-gray-500 mb-1">
                Чанк #{(content.index as number) + 1}
              </div>
              <div className="text-sm text-gray-600 line-clamp-2">
                {(content.preview as string) || (content.content as string)?.slice(0, 100)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ITEMS_PER_PAGE = 10;

export function ExtractedItemsGrid({
  items,
  onToggleSelection,
  onSelectAll,
  onDeselectAll,
  onCommit,
}: ExtractedItemsGridProps) {
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [currentPage, setCurrentPage] = useState<Record<string, number>>({
    all: 1,
    DOMAIN_ASSIGNMENT: 1,
    DOMAIN_SUGGESTION: 1,
    RULE: 1,
    QA_PAIR: 1,
    UNCERTAINTY: 1,
    CHUNK: 1,
  });

  const selectedCount = items.filter((i) => i.isSelected).length;

  // Group items by type
  const grouped = {
    all: items,
    DOMAIN_ASSIGNMENT: items.filter((i) => i.itemType === 'DOMAIN_ASSIGNMENT'),
    DOMAIN_SUGGESTION: items.filter((i) => i.itemType === 'DOMAIN_SUGGESTION'),
    RULE: items.filter((i) => i.itemType === 'RULE'),
    QA_PAIR: items.filter((i) => i.itemType === 'QA_PAIR'),
    UNCERTAINTY: items.filter((i) => i.itemType === 'UNCERTAINTY'),
    CHUNK: items.filter((i) => i.itemType === 'CHUNK'),
  };

  // Get paginated items for a group
  const getPaginatedItems = (groupKey: string, groupItems: ExtractedItem[]) => {
    const page = currentPage[groupKey] || 1;
    const start = (page - 1) * ITEMS_PER_PAGE;
    const end = start + ITEMS_PER_PAGE;
    return groupItems.slice(start, end);
  };

  const getTotalPages = (groupItems: ExtractedItem[]) => {
    return Math.ceil(groupItems.length / ITEMS_PER_PAGE);
  };

  const handlePageChange = (groupKey: string, newPage: number) => {
    setCurrentPage((prev) => ({ ...prev, [groupKey]: newPage }));
  };

  async function handleCommit() {
    setIsCommitting(true);
    setCommitResult(null);

    const result = await onCommit();

    if (result.success) {
      setCommitResult({
        type: 'success',
        message: 'Данные успешно сохранены в базу знаний',
      });
    } else {
      setCommitResult({
        type: 'error',
        message: result.error || 'Ошибка сохранения',
      });
    }

    setIsCommitting(false);
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>Извлечённые элементы ({items.length})</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onSelectAll}>
              Выбрать все
            </Button>
            <Button variant="outline" size="sm" onClick={onDeselectAll}>
              Снять выделение
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs defaultValue="all" className="w-full">
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="all">
              Все ({grouped.all.length})
            </TabsTrigger>
            {grouped.DOMAIN_ASSIGNMENT.length > 0 && (
              <TabsTrigger value="DOMAIN_ASSIGNMENT">
                Домены ({grouped.DOMAIN_ASSIGNMENT.length})
              </TabsTrigger>
            )}
            {grouped.RULE.length > 0 && (
              <TabsTrigger value="RULE">
                Правила ({grouped.RULE.length})
              </TabsTrigger>
            )}
            {grouped.QA_PAIR.length > 0 && (
              <TabsTrigger value="QA_PAIR">
                Вопросы ({grouped.QA_PAIR.length})
              </TabsTrigger>
            )}
            {grouped.UNCERTAINTY.length > 0 && (
              <TabsTrigger value="UNCERTAINTY">
                Неясности ({grouped.UNCERTAINTY.length})
              </TabsTrigger>
            )}
            {grouped.CHUNK.length > 0 && (
              <TabsTrigger value="CHUNK">
                Чанки ({grouped.CHUNK.length})
              </TabsTrigger>
            )}
          </TabsList>

          {Object.entries(grouped).map(([key, groupItems]) => {
            const paginatedItems = getPaginatedItems(key, groupItems);
            const totalPages = getTotalPages(groupItems);
            const page = currentPage[key] || 1;

            return (
              <TabsContent key={key} value={key} className="mt-4">
                <div className="grid gap-3 max-h-[500px] overflow-y-auto">
                  {paginatedItems.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      onToggle={() => onToggleSelection(item.id)}
                    />
                  ))}
                </div>

                {/* Pagination controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(key, page - 1)}
                      disabled={page <= 1}
                    >
                      Назад
                    </Button>
                    <span className="text-sm text-gray-600">
                      Страница {page} из {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(key, page + 1)}
                      disabled={page >= totalPages}
                    >
                      Вперёд
                    </Button>
                  </div>
                )}
              </TabsContent>
            );
          })}
        </Tabs>

        {/* Commit section */}
        {commitResult && (
          <div
            className={`p-3 rounded-lg ${
              commitResult.type === 'success'
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {commitResult.message}
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t">
          <div className="text-sm text-gray-600">
            Выбрано: {selectedCount} из {items.length}
          </div>
          <Button
            onClick={handleCommit}
            disabled={isCommitting || selectedCount === 0}
          >
            {isCommitting ? 'Сохранение...' : 'Сохранить выбранные'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
