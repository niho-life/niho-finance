"use client";

import type { InvoiceStatusFilter, InvoiceTypeFilter } from "@niho-finance/db";
import Form from "next/form";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/ui/auto-submit-select";
import { Button } from "@/components/ui/button";

export interface InvoiceFilterValues {
  type: InvoiceTypeFilter;
  status: InvoiceStatusFilter;
  partner: string;
  q: string;
}

const TYPE_CHOICES: readonly { value: InvoiceTypeFilter; label: string }[] = [
  { value: "invoice", label: "請求書" },
  { value: "quote", label: "見積書" },
  { value: "delivery", label: "納品書" },
  { value: "all", label: "すべて" },
];

const STATUS_CHOICES: readonly { value: InvoiceStatusFilter; label: string }[] = [
  { value: "open", label: "未完了" },
  { value: "draft", label: "下書き" },
  { value: "issued", label: "発行済み（送付済みを含む）" },
  { value: "paid", label: "入金済み" },
  { value: "void", label: "無効" },
  { value: "all", label: "すべて" },
];

/**
 * 絞り込み of the list (18 §7): a GET form, so the URL is the truth. The selects send the form when
 * they change; 「絞り込む」 sends the search (and everything without JS).
 */
export function InvoicesFilter({
  values,
  partners,
  filtered,
}: {
  values: InvoiceFilterValues;
  partners: readonly { value: string; label: string }[];
  /** Something other than the default is chosen: offer to clear it. */
  filtered: boolean;
}) {
  const label = "flex min-w-0 flex-col gap-1";
  const caption = "text-[12px] font-bold text-muted";
  return (
    <Form action="/invoices" role="search" aria-label="請求の絞り込み" className="mb-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[140px_200px_minmax(0,1fr)_minmax(0,1fr)]">
        <label className={label}>
          <span className={caption}>種別</span>
          <AutoSubmitSelect name="type" defaultValue={values.type}>
            {TYPE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
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
          <span className={caption}>検索</span>
          <input
            name="q"
            type="search"
            defaultValue={values.q}
            maxLength={100}
            placeholder="番号・件名"
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
            href="/invoices"
            className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
          >
            絞り込みを外す
          </Link>
        ) : null}
      </div>
    </Form>
  );
}
