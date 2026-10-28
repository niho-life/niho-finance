"use client";

import type { EntryFormFiscalYear, EntryFormOptions } from "@niho-finance/db";
import {
  displayDate,
  isCalendarDate,
  TAX_DIRECTION_LABELS,
  type CalendarDate,
  type TaxDirection,
} from "@niho-finance/ledger";
import type { ReactNode } from "react";
import { Checkbox, FormField, Input } from "@/components/ui/form";

/*
 * Pieces shared by the transaction forms (11 §4): the date with the state of its fiscal year, the
 * tags, the grouped tax categories and the messages above the form.
 */

export function fiscalYearOn(
  date: string,
  years: readonly EntryFormFiscalYear[],
): EntryFormFiscalYear | null {
  if (!isCalendarDate(date)) return null;
  return years.find((year) => year.startDate <= date && year.endDate >= date) ?? null;
}

/**
 * What the server will say about the date, shown before sending (the server still decides): outside
 * every fiscal year, closed (決算済み) or on or before the close.
 */
export function dateProblem(date: string, years: readonly EntryFormFiscalYear[]): string | null {
  if (!isCalendarDate(date)) return null;
  const year = fiscalYearOn(date, years);
  if (!year) return `${displayDate(date)} を含む会計期間がありません`;
  if (year.status === "closed") return `第 ${year.no} 期は決算済みです`;
  if (year.lockedThrough && date <= year.lockedThrough) {
    return `${displayDate(year.lockedThrough)} までは締めています。設定 › 会計期間 で締めを戻すと登録できます`;
  }
  return null;
}

export function DateField({
  id,
  value,
  onChange,
  fiscalYears,
  error,
  help,
}: {
  id: string;
  value: string;
  onChange: (value: CalendarDate | "") => void;
  fiscalYears: readonly EntryFormFiscalYear[];
  error?: string | undefined;
  help?: ReactNode;
}) {
  const problem = error ? null : dateProblem(value, fiscalYears);
  return (
    <FormField label="日付" htmlFor={id} required error={error} help={problem ?? help}>
      <Input
        id={id}
        type="date"
        required
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as CalendarDate | "")}
      />
    </FormField>
  );
}

/** A row of checkboxes; nothing when there are no tags (11 §4). */
export function TagsField({
  idPrefix,
  tags,
  value,
  onChange,
  error,
}: {
  idPrefix: string;
  tags: EntryFormOptions["memoTags"];
  value: readonly string[];
  onChange: (value: string[]) => void;
  error?: string | undefined;
}) {
  if (tags.length === 0) return null;
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-[12px] font-bold text-muted">タグ</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {tags.map((tag) => (
          <Checkbox
            key={tag.id}
            id={`${idPrefix}-tag-${tag.id}`}
            label={tag.isActive ? tag.name : `${tag.name}（無効）`}
            checked={value.includes(tag.id)}
            onChange={(event) =>
              onChange(
                event.currentTarget.checked
                  ? [...value, tag.id]
                  : value.filter((tagId) => tagId !== tag.id),
              )
            }
          />
        ))}
      </div>
      {error ? <p className="text-[12px] font-bold text-danger">{error}</p> : null}
    </fieldset>
  );
}

const DIRECTION_ORDER: readonly TaxDirection[] = ["sales", "purchase", "none"];

/** The tax categories as `<option>`s grouped 売上 / 仕入 / 対象外; `first` comes first. */
export function TaxCategoryOptions({
  categories,
  first,
}: {
  categories: EntryFormOptions["taxCategories"];
  first?: TaxDirection;
}) {
  const order = first
    ? [first, ...DIRECTION_ORDER.filter((direction) => direction !== first)]
    : DIRECTION_ORDER;
  return (
    <>
      {order.map((direction) => {
        const inGroup = categories.filter((category) => category.direction === direction);
        if (inGroup.length === 0) return null;
        return (
          <optgroup key={direction} label={TAX_DIRECTION_LABELS[direction]}>
            {inGroup.map((category) => (
              <option key={category.code} value={category.code}>
                {category.isActive ? category.name : `${category.name}（無効）`}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

export function accountLabel(account: { code: string; name: string; isActive: boolean }): string {
  return `${account.code} ${account.name}${account.isActive ? "" : "（無効）"}`;
}

/** The messages above the form (problems without a field of their own). */
export function FormAlerts({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}
