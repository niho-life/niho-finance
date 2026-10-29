"use client";

import type { PayableStatusFilter, PayableView } from "@niho-finance/db";
import Form from "next/form";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button } from "@/components/ui/button";

export interface PayableFilterValues {
  status: PayableStatusFilter;
  partner: string;
  view: PayableView;
  q: string;
}

const STATUS_CHOICES: readonly { value: PayableStatusFilter; label: string }[] = [
  { value: "open", label: "未払（一部支払を含む）" },
  { value: "paid", label: "支払済み" },
  { value: "all", label: "すべて" },
];

const VIEW_CHOICES: readonly { value: PayableView; label: string }[] = [
  { value: "due", label: "期日順" },
  { value: "partner", label: "取引先別" },
];

/**
 * 絞り込み of the list (25 §6): a GET form, so the URL is the truth. The selects send the form when
 * they change; 「絞り込む」 sends the search (and everything without JS).
 */
export function PayablesFilter({
  values,
  partners,
  filtered,
}: {
  values: PayableFilterValues;
  partners: readonly { value: string; label: string }[];
  /** Something other than the default is chosen: offer to clear it. */
  filtered: boolean;
}) {
  const label = "flex min-w-0 flex-col gap-1";
  const caption = "text-[12px] font-bold text-muted";
  return (
    <Form action="/payables" role="search" aria-label="支払の絞り込み" className="mb-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[200px_minmax(0,1fr)_128px_minmax(0,1fr)]">
        <label className={label}>
          <span className={caption}>状態</span>
          <AutoSubmitSelect name="status" defaultValue={values.status}>
            {STATUS_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className={label}>
          <span className={caption}>取引先</span>
          <AutoSubmitSelect name="partner" defaultValue={values.partner}>
            <option value="">すべての取引先</option>
            {partners.map((partner) => (
              <option key={partner.value} value={partner.value}>
                {partner.label}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className={label}>
          <span className={caption}>並び</span>
          <AutoSubmitSelect name="view" defaultValue={values.view}>
            {VIEW_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className={label}>
          <span className={caption}>検索</span>
          <input
            name="q"
            type="search"
            defaultValue={values.q}
            maxLength={100}
            placeholder="取引先名・ファイル名・メモ"
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
            href="/payables"
            className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
          >
            絞り込みを外す
          </Link>
        ) : null}
      </div>
    </Form>
  );
}
