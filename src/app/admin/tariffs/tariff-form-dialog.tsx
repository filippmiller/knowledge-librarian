'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TariffConflictDTO, TariffDTO } from '@/lib/tariffs/serialize';
import {
  TARIFF_AMOUNT_KINDS,
  TARIFF_AUDIENCES,
  TARIFF_SECTIONS,
  TARIFF_TURNAROUNDS,
  TARIFF_UNITS,
  TRANSLATION_DIRECTIONS,
  type ValidationIssue,
} from '@/lib/tariffs/validation';
import {
  AMOUNT_KIND_LABEL,
  AUDIENCE_LABEL,
  DIRECTION_LABEL,
  SECTION_LABEL,
  TURNAROUND_LABEL,
  UNIT_LABEL,
  formatDateRu,
  toDateInputValue,
} from '@/lib/tariffs/labels';

export interface TariffFormDefaults {
  section?: string;
  language?: string;
  complexityCategory?: number;
  direction?: string;
  turnaround?: string;
  includesNotary?: boolean;
}

interface FormState {
  section: string;
  sectionTitle: string;
  serviceName: string;
  authority: string;
  termText: string;
  conditions: string;
  amountKind: string;
  amount: string;
  percent: string;
  percentBase: string;
  baseFeeAmount: string;
  unit: string;
  currency: string;
  priceText: string;
  audience: string;
  effectiveFrom: string;
  effectiveTo: string;
  footnote: string;
  language: string;
  complexityCategory: string;
  direction: string;
  turnaround: string;
  includesNotary: boolean;
  isActive: boolean;
}

const EMPTY: FormState = {
  section: 'CERTIFICATION',
  sectionTitle: '',
  serviceName: '',
  authority: '',
  termText: '',
  conditions: '',
  amountKind: 'FIXED',
  amount: '',
  percent: '',
  percentBase: '',
  baseFeeAmount: '',
  unit: 'DOCUMENT',
  currency: 'RUB',
  priceText: '',
  audience: 'INTERNAL_ONLY',
  effectiveFrom: toDateInputValue(new Date()),
  effectiveTo: '',
  footnote: '',
  language: '',
  complexityCategory: '',
  direction: '',
  turnaround: '',
  includesNotary: false,
  isActive: true,
};

function fromTariff(t: TariffDTO): FormState {
  return {
    section: t.section,
    sectionTitle: t.sectionTitle ?? '',
    serviceName: t.serviceName,
    authority: t.authority ?? '',
    termText: t.termText ?? '',
    conditions: t.conditions ?? '',
    amountKind: t.amountKind,
    amount: t.amount === null ? '' : String(t.amount),
    percent: t.percent === null ? '' : String(t.percent),
    percentBase: t.percentBase ?? '',
    baseFeeAmount: t.baseFeeAmount === null ? '' : String(t.baseFeeAmount),
    unit: t.unit,
    currency: t.currency,
    priceText: t.priceText,
    audience: t.audience,
    effectiveFrom: toDateInputValue(t.effectiveFrom),
    effectiveTo: toDateInputValue(t.effectiveTo),
    footnote: t.footnote ?? '',
    language: t.language ?? '',
    complexityCategory: t.complexityCategory === null ? '' : String(t.complexityCategory),
    direction: t.direction ?? '',
    turnaround: t.turnaround ?? '',
    includesNotary: t.includesNotary,
    isActive: t.isActive,
  };
}

const UNIT_SUFFIX: Record<string, string> = {
  DOCUMENT: 'руб./док.',
  PAGE: 'руб. за страницу',
  CONDITIONAL_PAGE: 'руб. за 1 у.с.',
  MARK: 'руб. за отметку',
  VISA: 'руб. за визу',
  PERCENT: '%',
};

/** Подсказка для «цены текстом» — той формулировки, которая уходит клиенту.
 *  Поле остаётся обязательным и редактируемым: в прайсе есть строки вроде
 *  «150 руб./док. + НЗ», которые из суммы и единицы не собираются. */
function suggestPriceText(state: FormState): string {
  if (state.amountKind === 'PERCENT_OF_BASE') {
    return state.percent ? `${state.percent}% от ${state.percentBase || 'стоимости'}` : '';
  }
  if (state.amountKind === 'PERCENT_SURCHARGE') {
    return state.percent ? `+${state.percent}% от ${state.percentBase || 'стоимости'}` : '';
  }
  if (!state.amount) return '';
  const prefix = state.amountKind === 'FROM' ? 'от ' : '';
  const base = `${prefix}${state.amount} ${UNIT_SUFFIX[state.unit] ?? ''}`.trim();
  return state.baseFeeAmount ? `${state.baseFeeAmount} руб. тариф + ${base}` : base;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tariff: TariffDTO | null;
  defaults?: TariffFormDefaults;
  languages: string[];
  onSaved: () => void;
}

export function TariffFormDialog({
  open,
  onOpenChange,
  tariff,
  defaults,
  languages,
  onSaved,
}: Props) {
  const [state, setState] = useState<FormState>(EMPTY);
  const [priceTextTouched, setPriceTextTouched] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [conflicts, setConflicts] = useState<TariffConflictDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIssues([]);
    setConflicts([]);
    setError(null);
    if (tariff) {
      setState(fromTariff(tariff));
      setPriceTextTouched(true);
      return;
    }
    setPriceTextTouched(false);
    setState({
      ...EMPTY,
      ...(defaults?.section ? { section: defaults.section } : {}),
      ...(defaults?.language ? { language: defaults.language } : {}),
      ...(defaults?.complexityCategory
        ? { complexityCategory: String(defaults.complexityCategory) }
        : {}),
      ...(defaults?.direction ? { direction: defaults.direction } : {}),
      ...(defaults?.turnaround ? { turnaround: defaults.turnaround } : {}),
      ...(defaults?.includesNotary !== undefined
        ? { includesNotary: defaults.includesNotary }
        : {}),
      ...(defaults?.section === 'TRANSLATION' ? { unit: 'CONDITIONAL_PAGE' } : {}),
    });
  }, [open, tariff, defaults]);

  const isTranslation = state.section === 'TRANSLATION';
  const isPercent =
    state.amountKind === 'PERCENT_OF_BASE' || state.amountKind === 'PERCENT_SURCHARGE';

  const issueByField = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) if (!map.has(issue.field)) map.set(issue.field, issue.message);
    return map;
  }, [issues]);

  function update(patch: Partial<FormState>) {
    setState((prev) => {
      const next = { ...prev, ...patch };
      if (!priceTextTouched && patch.priceText === undefined) {
        const suggestion = suggestPriceText(next);
        if (suggestion) next.priceText = suggestion;
      }
      return next;
    });
  }

  async function save(force: boolean) {
    setSaving(true);
    setIssues([]);
    setError(null);
    try {
      const payload = {
        section: state.section,
        sectionTitle: state.sectionTitle || null,
        serviceName: state.serviceName,
        authority: isTranslation ? null : state.authority || null,
        termText: state.termText || null,
        conditions: state.conditions || null,
        amountKind: state.amountKind,
        amount: isPercent ? null : state.amount || null,
        percent: isPercent ? state.percent || null : null,
        percentBase: isPercent ? state.percentBase || null : null,
        baseFeeAmount: state.baseFeeAmount || null,
        unit: state.unit,
        currency: state.currency,
        priceText: state.priceText,
        audience: state.audience,
        effectiveFrom: state.effectiveFrom || null,
        effectiveTo: state.effectiveTo || null,
        footnote: state.footnote || null,
        language: isTranslation ? state.language || null : null,
        complexityCategory: isTranslation ? state.complexityCategory || null : null,
        direction: isTranslation ? state.direction || null : null,
        turnaround: isTranslation ? state.turnaround || null : null,
        includesNotary: isTranslation ? state.includesNotary : false,
        isActive: state.isActive,
      };

      const url = tariff
        ? `/api/tariffs/${tariff.id}${force ? '?force=1' : ''}`
        : `/api/tariffs${force ? '?force=1' : ''}`;
      const response = await fetch(url, {
        method: tariff ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      if (response.ok) {
        onOpenChange(false);
        onSaved();
        return;
      }
      if (response.status === 409 && data?.code === 'OVERLAP') {
        setConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
        setError(typeof data.error === 'string' ? data.error : 'Пересечение периодов');
        return;
      }
      setIssues(Array.isArray(data?.issues) ? data.issues : []);
      setError(typeof data?.error === 'string' ? data.error : 'Не удалось сохранить');
    } catch (e) {
      console.error('Error saving tariff:', e);
      setError('Сеть недоступна или сервер не ответил');
    } finally {
      setSaving(false);
    }
  }

  function fieldError(field: string) {
    const message = issueByField.get(field);
    if (!message) return null;
    return <p className="mt-1 text-xs text-red-600">{message}</p>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{tariff ? 'Изменить тариф' : 'Добавить тариф'}</DialogTitle>
          <DialogDescription>
            {tariff
              ? `Источник: ${tariff.sourceFile}. Изменён: ${formatDateRu(tariff.updatedAt)}${
                  tariff.updatedBy ? `, ${tariff.updatedBy}` : ''
                }`
              : 'Цена уходит клиенту дословно из поля «Цена текстом».'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Раздел</label>
            <Select value={state.section} onValueChange={(v) => update({ section: v })}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARIFF_SECTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SECTION_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldError('section')}
          </div>

          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Название услуги</label>
            <Input
              className="mt-1"
              value={state.serviceName}
              onChange={(e) => update({ serviceName: e.target.value })}
              placeholder="Например: Апостиль Министерство юстиции СПб"
            />
            {fieldError('serviceName')}
          </div>

          {isTranslation ? (
            <>
              <div>
                <label className="text-sm font-medium">Язык</label>
                <Input
                  className="mt-1"
                  list="tariff-languages"
                  value={state.language}
                  onChange={(e) => update({ language: e.target.value })}
                />
                <datalist id="tariff-languages">
                  {languages.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
                {fieldError('language')}
              </div>
              <div>
                <label className="text-sm font-medium">Категория сложности</label>
                <Select
                  value={state.complexityCategory || undefined}
                  onValueChange={(v) => update({ complexityCategory: v })}
                >
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue placeholder="Выберите" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 категория</SelectItem>
                    <SelectItem value="2">2 категория</SelectItem>
                    <SelectItem value="3">3 категория</SelectItem>
                  </SelectContent>
                </Select>
                {fieldError('complexityCategory')}
              </div>
              <div>
                <label className="text-sm font-medium">Направление</label>
                <Select
                  value={state.direction || undefined}
                  onValueChange={(v) => update({ direction: v })}
                >
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue placeholder="Выберите" />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSLATION_DIRECTIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {DIRECTION_LABEL[d]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldError('direction')}
              </div>
              <div>
                <label className="text-sm font-medium">Срок</label>
                <Select
                  value={state.turnaround || undefined}
                  onValueChange={(v) => update({ turnaround: v })}
                >
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue placeholder="Выберите" />
                  </SelectTrigger>
                  <SelectContent>
                    {TARIFF_TURNAROUNDS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {TURNAROUND_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fieldError('turnaround')}
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={state.includesNotary}
                  onChange={(e) => update({ includesNotary: e.target.checked })}
                />
                Цена включает нотариальное заверение
              </label>
            </>
          ) : (
            <div className="sm:col-span-2">
              <label className="text-sm font-medium">Орган или место подачи</label>
              <Input
                className="mt-1"
                value={state.authority}
                onChange={(e) => update({ authority: e.target.value })}
                placeholder="МЮ СПб, ЗАГС МО, МЮ + МИД + Посольство"
              />
            </div>
          )}

          <div>
            <label className="text-sm font-medium">Срок текстом</label>
            <Input
              className="mt-1"
              value={state.termText}
              onChange={(e) => update({ termText: e.target.value })}
              placeholder="1 – 1,5 недели"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Условия</label>
            <Input
              className="mt-1"
              value={state.conditions}
              onChange={(e) => update({ conditions: e.target.value })}
              placeholder="По доверенности, пропускная способность 7 у.с./день"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Вид цены</label>
            <Select value={state.amountKind} onValueChange={(v) => update({ amountKind: v })}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARIFF_AMOUNT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {AMOUNT_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldError('amountKind')}
          </div>
          <div>
            <label className="text-sm font-medium">Единица</label>
            <Select value={state.unit} onValueChange={(v) => update({ unit: v })}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARIFF_UNITS.map((u) => (
                  <SelectItem key={u} value={u}>
                    {UNIT_LABEL[u]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldError('unit')}
          </div>

          {isPercent ? (
            <>
              <div>
                <label className="text-sm font-medium">Процент</label>
                <Input
                  className="mt-1"
                  value={state.percent}
                  onChange={(e) => update({ percent: e.target.value })}
                  placeholder="70"
                />
                {fieldError('percent')}
              </div>
              <div>
                <label className="text-sm font-medium">От чего считается</label>
                <Input
                  className="mt-1"
                  value={state.percentBase}
                  onChange={(e) => update({ percentBase: e.target.value })}
                  placeholder="стоимости 1 у.с."
                />
                {fieldError('percentBase')}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-sm font-medium">Сумма, ₽</label>
                <Input
                  className="mt-1"
                  value={state.amount}
                  onChange={(e) => update({ amount: e.target.value })}
                  placeholder="5000"
                />
                {fieldError('amount')}
              </div>
              <div>
                <label className="text-sm font-medium">Разовый тариф, ₽ (необязательно)</label>
                <Input
                  className="mt-1"
                  value={state.baseFeeAmount}
                  onChange={(e) => update({ baseFeeAmount: e.target.value })}
                  placeholder="1000"
                />
                {fieldError('baseFeeAmount')}
              </div>
            </>
          )}

          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Цена текстом (уходит клиенту дословно)</label>
            <Input
              className="mt-1"
              value={state.priceText}
              onChange={(e) => {
                setPriceTextTouched(true);
                update({ priceText: e.target.value });
              }}
              placeholder="5000 руб./док."
            />
            {fieldError('priceText')}
          </div>

          <div>
            <label className="text-sm font-medium">Контур</label>
            <Select value={state.audience} onValueChange={(v) => update({ audience: v })}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARIFF_AUDIENCES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {AUDIENCE_LABEL[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldError('audience')}
          </div>
          <div>
            <label className="text-sm font-medium">Валюта</label>
            <Input
              className="mt-1"
              value={state.currency}
              onChange={(e) => update({ currency: e.target.value })}
            />
            {fieldError('currency')}
          </div>

          <div>
            <label className="text-sm font-medium">Действует с</label>
            <Input
              type="date"
              className="mt-1"
              value={state.effectiveFrom}
              onChange={(e) => update({ effectiveFrom: e.target.value })}
            />
            {fieldError('effectiveFrom')}
          </div>
          <div>
            <label className="text-sm font-medium">Действует по (необязательно)</label>
            <Input
              type="date"
              className="mt-1"
              value={state.effectiveTo}
              onChange={(e) => update({ effectiveTo: e.target.value })}
            />
            {fieldError('effectiveTo')}
          </div>

          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Оговорка</label>
            <Textarea
              className="mt-1"
              rows={2}
              value={state.footnote}
              onChange={(e) => update({ footnote: e.target.value })}
              placeholder="Цены не включают перевод, пересылку, доверенности"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Заголовок раздела в прайсе</label>
            <Input
              className="mt-1"
              value={state.sectionTitle}
              onChange={(e) => update({ sectionTitle: e.target.value })}
            />
          </div>

          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={state.isActive}
              onChange={(e) => update({ isActive: e.target.checked })}
            />
            Строка действует
          </label>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <p>{error}</p>
            {conflicts.length > 0 && (
              <ul className="mt-2 space-y-1">
                {conflicts.map((c) => (
                  <li key={c.id}>
                    «{c.serviceName}» — {c.priceText}, с {formatDateRu(c.effectiveFrom)} по{' '}
                    {c.effectiveTo ? formatDateRu(c.effectiveTo) : 'бессрочно'}
                  </li>
                ))}
              </ul>
            )}
            {issues.length > 0 && (
              <ul className="mt-2 space-y-1">
                {issues.map((i, index) => (
                  <li key={`${i.field}-${index}`}>{i.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          {conflicts.length > 0 && (
            <Button variant="destructive" onClick={() => save(true)} disabled={saving}>
              Всё равно сохранить
            </Button>
          )}
          <Button onClick={() => save(false)} disabled={saving}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
