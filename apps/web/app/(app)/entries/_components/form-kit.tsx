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
import { Button } from "@/components/ui/button";
import { Checkbox, FormField, Input } from "@/components/ui/form";

/*
 * Pieces shared by the transaction forms (11 §4): the date with the state of its fiscal year, the
 * tags, the grouped tax categories, the recent choices and the messages above the form.
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
  periodHint = true,
}: {
  id: string;
  value: string;
  onChange: (value: CalendarDate | "") => void;
  fiscalYears: readonly EntryFormFiscalYear[];
  error?: string | undefined;
  help?: ReactNode;
  /**
   * Whether to tell the problem of the date's fiscal year before sending. The new-entry forms only
   * tell it once the date is changed: they open on a date that can take the entry, or else the
   * server says why when the entry is sent (11 §4).
   */
  periodHint?: boolean;
}) {
  const problem = error || !periodHint ? null : dateProblem(value, fiscalYears);
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

export function partnerLabel(partner: { name: string; isActive: boolean }): string {
  return partner.isActive ? partner.name : `${partner.name}（無効）`;
}

export interface Choice {
  value: string;
  label: string;
}

/**
 * The options of a select with its recent choices (11 §4): 「最近」 (those still offered, most recent
 * first) above 「すべて」, or the plain list when nothing was used yet.
 */
export function ChoiceOptions({
  choices,
  recent = [],
}: {
  choices: readonly Choice[];
  recent?: readonly string[];
}) {
  const byValue = new Map(choices.map((choice) => [choice.value, choice]));
  const recentChoices = recent.flatMap((value) => {
    const choice = byValue.get(value);
    return choice ? [choice] : [];
  });
  const options = (list: readonly Choice[]) =>
    list.map((choice) => (
      <option key={choice.value} value={choice.value}>
        {choice.label}
      </option>
    ));
  if (recentChoices.length === 0) return <>{options(choices)}</>;
  return (
    <>
      <optgroup label="最近">{options(recentChoices)}</optgroup>
      <optgroup label="すべて">{options(choices)}</optgroup>
    </>
  );
}

/**
 * 「登録して開く」 and 「続けて登録」 of a new entry (11 §4.5). Both register. 続けて登録 is the
 * form's submit, marked for `entryFormKeyDown` (Cmd+Enter, Enter in the last field), and stays on
 * the form; 登録して開く opens the entry.
 */
export function EntryFormActions({
  pending,
  disabled = false,
  divider = true,
  onOpen,
}: {
  pending: boolean;
  /** Both buttons off (a 伝票 whose totals differ). */
  disabled?: boolean;
  divider?: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`flex flex-wrap justify-end gap-2 ${divider ? "border-t border-border pt-4" : ""}`}
    >
      <Button onClick={onOpen} disabled={pending || disabled}>
        登録して開く
      </Button>
      {/* `data-entry-continue`: CONTINUE_ATTRIBUTE of entry-keys.ts. */}
      <Button type="submit" variant="primary" disabled={pending || disabled} data-entry-continue="">
        {pending ? "登録中…" : "続けて登録"}
      </Button>
    </div>
  );
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
