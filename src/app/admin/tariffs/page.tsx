'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TariffDTO } from '@/lib/tariffs/serialize';
import { TARIFF_AUDIENCES, TARIFF_SECTIONS } from '@/lib/tariffs/validation';
import { AUDIENCE_LABEL, SECTION_LABEL, UNIT_LABEL, formatDateRu } from '@/lib/tariffs/labels';
import { TariffFormDialog, type TariffFormDefaults } from './tariff-form-dialog';
import { TranslationMatrix } from './translation-matrix';

const ALL = '__all__';
const PAGE_SIZE = 50;

interface Facets {
  languages: string[];
  categories: number[];
  sections: Array<{ section: string; active: number; archived: number }>;
}

interface ListResponse {
  items: TariffDTO[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export default function TariffsPage() {
  const [facets, setFacets] = useState<Facets>({ languages: [], categories: [], sections: [] });
  const [data, setData] = useState<ListResponse>({
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    pageCount: 1,
  });
  const [loading, setLoading] = useState(true);

  const [section, setSection] = useState(ALL);
  const [audience, setAudience] = useState(ALL);
  const [active, setActive] = useState('true');
  const [onlyCurrent, setOnlyCurrent] = useState(true);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);

  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TariffDTO | null>(null);
  const [formDefaults, setFormDefaults] = useState<TariffFormDefaults | undefined>(undefined);
  const [archiving, setArchiving] = useState<TariffDTO | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    fetch('/api/tariffs/facets')
      .then((r) => r.json())
      .then((d) => {
        if (d && Array.isArray(d.languages)) setFacets(d);
      })
      .catch((e) => console.error('Error fetching facets:', e));
  }, [refreshKey]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        active,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (section !== ALL) params.set('section', section);
      if (audience !== ALL) params.set('audience', audience);
      if (onlyCurrent) params.set('current', '1');
      if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());

      const response = await fetch(`/api/tariffs?${params.toString()}`);
      const payload = await response.json();
      if (Array.isArray(payload?.items)) setData(payload);
      else setData({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE, pageCount: 1 });
    } catch (error) {
      console.error('Error fetching tariffs:', error);
    } finally {
      setLoading(false);
    }
  }, [section, audience, active, onlyCurrent, debouncedQuery, page]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  function openCreate(defaults?: TariffFormDefaults) {
    setEditing(null);
    setFormDefaults(defaults);
    setFormOpen(true);
  }

  function openEdit(tariff: TariffDTO) {
    setEditing(tariff);
    setFormDefaults(undefined);
    setFormOpen(true);
  }

  async function confirmArchive() {
    if (!archiving) return;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const response = await fetch(`/api/tariffs/${archiving.id}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setArchiveError(payload?.error ?? 'Не удалось архивировать тариф');
        return;
      }
      setArchiving(null);
      setRefreshKey((k) => k + 1);
    } catch (error) {
      console.error('Error archiving tariff:', error);
      setArchiveError('Сеть недоступна или сервер не ответил');
    } finally {
      setArchiveBusy(false);
    }
  }

  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Тарифы</h1>
          <p className="text-sm text-gray-500">
            Цены бюро. Строки не удаляются — снятая цена уходит в архив и остаётся историей.
          </p>
        </div>
        <Button onClick={() => openCreate()}>Добавить тариф</Button>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">Прайс</TabsTrigger>
          <TabsTrigger value="matrix">Матрица перевода</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-sm text-gray-600">Раздел</label>
              <Select
                value={section}
                onValueChange={(v) => {
                  setSection(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="mt-1 w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={ALL}>Все разделы</SelectItem>
                  {TARIFF_SECTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SECTION_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm text-gray-600">Контур</label>
              <Select
                value={audience}
                onValueChange={(v) => {
                  setAudience(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="mt-1 w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Любой</SelectItem>
                  {TARIFF_AUDIENCES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {AUDIENCE_LABEL[a]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm text-gray-600">Активность</label>
              <Select
                value={active}
                onValueChange={(v) => {
                  setActive(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="mt-1 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Действующие</SelectItem>
                  <SelectItem value="false">Архив</SelectItem>
                  <SelectItem value="all">Все</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-64 flex-1">
              <label className="text-sm text-gray-600">Поиск по услуге, органу и языку</label>
              <Input
                className="mt-1"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="апостиль, ЗАГС, английский"
              />
            </div>

            <label className="flex h-9 items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={onlyCurrent}
                onChange={(e) => {
                  setOnlyCurrent(e.target.checked);
                  setPage(1);
                }}
              />
              Только действующие на сегодня
            </label>
          </div>

          {loading ? (
            <div className="py-8 text-center text-gray-500">Загрузка…</div>
          ) : data.items.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-gray-500">
                Тарифов по этим условиям не найдено.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border bg-white">
                <Table>
                  <TableHeader>
                    {/* Цена — вторая колонка. В таблице цен цена обязана читаться
                        с первого взгляда; раньше она была шестой из одиннадцати и
                        уезжала за правый край вместе с горизонтальной прокруткой. */}
                    <TableRow>
                      <TableHead>Услуга</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Цена</TableHead>
                      <TableHead>Срок</TableHead>
                      <TableHead>Орган</TableHead>
                      <TableHead>Условия</TableHead>
                      <TableHead>Раздел</TableHead>
                      <TableHead>Контур</TableHead>
                      <TableHead>Период</TableHead>
                      <TableHead>Активность</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="align-top">
                          <div className="max-w-[26rem] font-medium">{t.serviceName}</div>
                          <div
                            className="mt-0.5 text-xs text-gray-400"
                            title={`Источник: ${t.sourceFile}`}
                          >
                            {formatDateRu(t.updatedAt)}
                            {t.updatedBy ? `, ${t.updatedBy}` : ''}
                          </div>
                        </TableCell>
                        <TableCell className="align-top text-right whitespace-nowrap">
                          <div className="text-base font-semibold text-gray-900">{t.priceLabel}</div>
                          <div className="text-xs text-gray-500">{UNIT_LABEL[t.unit]}</div>
                        </TableCell>
                        <TableCell className="align-top text-sm">{t.termText ?? '—'}</TableCell>
                        <TableCell className="align-top text-sm">{t.authority ?? '—'}</TableCell>
                        <TableCell className="align-top max-w-56 text-xs text-gray-600">
                          {t.conditions ?? '—'}
                        </TableCell>
                        <TableCell className="align-top text-sm text-gray-600">
                          {SECTION_LABEL[t.section]}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant={t.audience === 'CLIENT_SAFE' ? 'default' : 'secondary'}>
                            {AUDIENCE_LABEL[t.audience]}
                          </Badge>
                        </TableCell>
                        <TableCell className="align-top text-sm whitespace-nowrap">
                          с {formatDateRu(t.effectiveFrom)}
                          <br />
                          {t.effectiveTo ? `по ${formatDateRu(t.effectiveTo)}` : 'бессрочно'}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge variant={t.isActive ? 'default' : 'outline'}>
                            {t.isActive ? 'Действует' : 'Архив'}
                          </Badge>
                        </TableCell>
                        <TableCell className="align-top whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => openEdit(t)}
                          >
                            Изменить
                          </Button>
                          {t.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-red-600"
                              onClick={() => {
                                setArchiveError(null);
                                setArchiving(t);
                              }}
                            >
                              В архив
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between text-sm text-gray-600">
                <div>
                  Показано {from}–{to} из {data.total}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={data.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Назад
                  </Button>
                  <span>
                    Страница {data.page} из {data.pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={data.page >= data.pageCount}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Вперёд
                  </Button>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="matrix" className="mt-4">
          <TranslationMatrix
            languages={facets.languages}
            categories={facets.categories}
            onEdit={openEdit}
            onCreate={openCreate}
            onArchive={(t) => {
              setArchiveError(null);
              setArchiving(t);
            }}
            refreshKey={refreshKey}
          />
        </TabsContent>
      </Tabs>

      <TariffFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        tariff={editing}
        defaults={formDefaults}
        languages={facets.languages}
        onSaved={() => setRefreshKey((k) => k + 1)}
      />

      <Dialog open={archiving !== null} onOpenChange={(open) => !open && setArchiving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Архивировать тариф</DialogTitle>
            <DialogDescription>
              Строка не удаляется: она перестаёт действовать с сегодняшнего дня и остаётся в
              истории. Вернуть её можно, снова включив «Строка действует».
            </DialogDescription>
          </DialogHeader>
          {archiving && (
            <div className="rounded-md border bg-gray-50 p-3 text-sm">
              <div className="font-medium">{archiving.serviceName}</div>
              <div className="text-gray-600">{archiving.priceLabel}</div>
              <div className="text-xs text-gray-500">
                Действует с {formatDateRu(archiving.effectiveFrom)}
              </div>
            </div>
          )}
          {archiveError && <p className="text-sm text-red-600">{archiveError}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiving(null)} disabled={archiveBusy}>
              Отмена
            </Button>
            <Button variant="destructive" onClick={confirmArchive} disabled={archiveBusy}>
              {archiveBusy ? 'Архивирование…' : 'Архивировать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
