'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { TariffDTO } from '@/lib/tariffs/serialize';
import { TARIFF_TURNAROUNDS, TRANSLATION_DIRECTIONS } from '@/lib/tariffs/validation';
import { DIRECTION_LABEL, TURNAROUND_LABEL, formatDateRu } from '@/lib/tariffs/labels';
import type { TariffFormDefaults } from './tariff-form-dialog';

interface Props {
  languages: string[];
  categories: number[];
  onEdit: (tariff: TariffDTO) => void;
  onCreate: (defaults: TariffFormDefaults) => void;
  onArchive: (tariff: TariffDTO) => void;
  refreshKey: number;
}

/**
 * Матрица перевода — 1560 строк, и списком она бесполезна.
 *
 * Показывается ровно один срез: язык + категория + направление. Внутри среза
 * пять сроков × две колонки заверения — то же, как напечатано в прайсе, и
 * пустая клетка сразу видна как пустая.
 */
export function TranslationMatrix({
  languages,
  categories,
  onEdit,
  onCreate,
  onArchive,
  refreshKey,
}: Props) {
  const [language, setLanguage] = useState('');
  const [category, setCategory] = useState('1');
  const [direction, setDirection] = useState('FROM_FOREIGN');
  const [rows, setRows] = useState<TariffDTO[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!language && languages.length > 0) setLanguage(languages[0]);
  }, [languages, language]);

  const load = useCallback(async () => {
    if (!language) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        section: 'TRANSLATION',
        language,
        category,
        direction,
        active: 'true',
        pageSize: '100',
      });
      const response = await fetch(`/api/tariffs?${params.toString()}`);
      const data = await response.json();
      setRows(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      console.error('Error fetching translation matrix:', error);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [language, category, direction]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  function cell(turnaround: string, includesNotary: boolean): TariffDTO | undefined {
    return rows.find((r) => r.turnaround === turnaround && r.includesNotary === includesNotary);
  }

  function renderCell(turnaround: string, includesNotary: boolean) {
    const tariff = cell(turnaround, includesNotary);
    if (!tariff) {
      return (
        <div className="text-sm text-gray-400">
          <div>нет в прайсе</div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-7 px-2 text-xs"
            onClick={() =>
              onCreate({
                section: 'TRANSLATION',
                language,
                complexityCategory: Number(category),
                direction,
                turnaround,
                includesNotary,
              })
            }
          >
            Добавить
          </Button>
        </div>
      );
    }
    return (
      <div>
        <div className="font-medium">{tariff.priceLabel}</div>
        <div className="mt-0.5 text-xs text-gray-500">
          {tariff.priceText}
          {tariff.effectiveTo ? ` · по ${formatDateRu(tariff.effectiveTo)}` : ''}
        </div>
        <div className="mt-1 flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onEdit(tariff)}
          >
            Изменить
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-red-600"
            onClick={() => onArchive(tariff)}
          >
            В архив
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-sm text-gray-600">Язык</label>
          <Select value={language || undefined} onValueChange={setLanguage}>
            <SelectTrigger className="mt-1 w-56">
              <SelectValue placeholder="Выберите язык" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {languages.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-sm text-gray-600">Категория</label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="mt-1 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(categories.length > 0 ? categories : [1, 2, 3]).map((c) => (
                <SelectItem key={c} value={String(c)}>
                  {c} категория
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-sm text-gray-600">Направление</label>
          <Select value={direction} onValueChange={setDirection}>
            <SelectTrigger className="mt-1 w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSLATION_DIRECTIONS.map((d) => (
                <SelectItem key={d} value={d}>
                  {DIRECTION_LABEL[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-gray-500">Загрузка…</div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            Для этого среза действующих цен нет.
            {direction === 'TO_FOREIGN' && category === '1' && (
              <span className="mt-1 block text-sm">
                Перевод на иностранный язык в 1 категории прайсом не предусмотрен — он считается
                начиная со 2 категории.
              </span>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-lg border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">Срок</TableHead>
                <TableHead>Без заверения</TableHead>
                <TableHead>Включая нотариальное заверение</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TARIFF_TURNAROUNDS.map((t) => (
                <TableRow key={t}>
                  <TableCell className="align-top font-medium">{TURNAROUND_LABEL[t]}</TableCell>
                  <TableCell className="align-top">{renderCell(t, false)}</TableCell>
                  <TableCell className="align-top">{renderCell(t, true)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
