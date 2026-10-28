"use client";

import type { EntryStatusFilter } from "@niho-finance/db";
import Form from "next/form";
import Link from "next/link";
import { useId, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";

export interface PeriodPresets {
  this_month: { from: string; to: string };
  last_month: { from: string; to: string };
  /** `null` without a fiscal year. */
  this_year: { from: string; to: string } | null;
}

export interface FilterValues {
  from: string;
  to: string;
  account: string;
  partner: string;
  segment: string;
  tag: string;
  status: EntryStatusFilter;
  q: string;
}

type Choice = { value: string; label: string };

const STATUS_CHOICES: readonly { value: EntryStatusFilter; label: string }[] = [
  { value: "posted", label: "登録済み" },
  { value: "voided", label: "取消済み" },
  { value: "all", label: "すべて" },
];

function presetOf(values: FilterValues, presets: PeriodPresets): string {
  for (const key of ["this_month", "last_month", "this_year"] as const) {
    const preset = presets[key];
    if (preset && preset.from === values.from && preset.to === values.to) return key;
  }
  return "custom";
}

/** Submits the GET form when a select changes (11 §3); without JS, 「絞り込む」 sends it. */
function submitOnChange(event: ChangeEvent<HTMLSelectElement>) {
  event.currentTarget.form?.requestSubmit();
}

/**
 * 絞り込み of the journal (11 §3): a GET form, so the URL is the truth and a reload or a shared link
 * shows the same rows. 期間 fills 開始・終了 and sends; 任意 lets the dates be typed.
 */
export function EntriesFilter({
  values,
  presets,
  accounts,
  partners,
  segments,
  tags,
  filtered,
}: {
  values: FilterValues;
  presets: PeriodPresets;
  accounts: readonly Choice[];
  partners: readonly Choice[];
  segments: readonly Choice[];
  tags: readonly Choice[];
  /** Something other than the default is chosen: offer to clear it. */
  filtered: boolean;
}) {
  const id = useId();

  function choosePeriod(event: ChangeEvent<HTMLSelectElement>) {
    const form = event.currentTarget.form;
    const key = event.currentTarget.value as keyof PeriodPresets | "custom";
    if (!form || key === "custom") {
      document.getElementById(`${id}-from`)?.focus();
      return;
    }
    const preset = presets[key];
    if (!preset) return;
    const from = form.elements.namedItem("from");
    const to = form.elements.namedItem("to");
    if (from instanceof HTMLInputElement) from.value = preset.from;
    if (to instanceof HTMLInputElement) to.value = preset.to;
    form.requestSubmit();
  }

  const select = (
    name: keyof FilterValues,
    label: string,
    choices: readonly Choice[],
    empty: string,
  ) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] font-bold text-muted">{label}</span>
      <select name={name} defaultValue={values[name]} onChange={submitOnChange} className="control">
        <option value="">{empty}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Form action="/entries" role="search" aria-label="取引の絞り込み" className="mb-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-[140px_150px_150px_repeat(2,minmax(0,1fr))]">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-bold text-muted">期間</span>
          <select
            defaultValue={presetOf(values, presets)}
            onChange={choosePeriod}
            className="control"
          >
            <option value="this_month">今月</option>
            <option value="last_month">前月</option>
            {presets.this_year ? <option value="this_year">今期</option> : null}
            <option value="custom">任意</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-bold text-muted">開始</span>
          <input
            id={`${id}-from`}
            name="from"
            type="date"
            defaultValue={values.from}
            className="control"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-bold text-muted">終了</span>
          <input name="to" type="date" defaultValue={values.to} className="control" />
        </label>
        {select("account", "科目", accounts, "すべての科目")}
        {select("partner", "取引先", partners, "すべての取引先")}
        {select("segment", "セグメント", segments, "すべて")}
        {tags.length > 0 ? select("tag", "タグ", tags, "すべて") : null}
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[12px] font-bold text-muted">状態</span>
          <select
            name="status"
            defaultValue={values.status}
            onChange={submitOnChange}
            className="control"
          >
            {STATUS_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1 lg:col-span-1">
          <span className="text-[12px] font-bold text-muted">検索</span>
          <input
            name="q"
            type="search"
            defaultValue={values.q}
            placeholder="摘要"
            className="control"
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm">
          絞り込む
        </Button>
        {filtered ? (
          <Link
            href="/entries"
            className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
          >
            絞り込みを外す
          </Link>
        ) : null}
      </div>
    </Form>
  );
}
