"use client";

import type { InvoiceFormOptions } from "@niho-finance/db";
import {
  formatYen,
  invoiceRateLabel,
  lineAmount,
  type InvoiceLineAmountInput,
  type InvoiceTotals,
} from "@niho-finance/ledger";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";

/**
 * The parts the form of a document (18 §8) and the form of a 定期請求 (18 §14.5) share: the lines
 * (a template's have no date), the totals per rate and the 会計 fields of an invoice.
 */

/** A line as the forms hold it; `date` only on a document's lines. */
export interface EditorLine {
  key: string;
  date?: string;
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxCategoryCode: string;
}

/** The most lines a document takes (the schema's limit). */
export const MAX_LINES = 100;

export function blankEditorLine(key: string, taxCategoryCode = "sales_10"): EditorLine {
  return { key, date: "", name: "", quantity: "1", unit: "", unitPrice: "", taxCategoryCode };
}

const DATED_GRID = "lg:grid-cols-[132px_minmax(0,1fr)_76px_68px_120px_156px_104px_40px]";
const UNDATED_GRID = "lg:grid-cols-[minmax(0,1fr)_76px_68px_120px_156px_104px_40px]";

/**
 * 行の表 (18 §8): 日付 ・ 品名 ・ 数量 ・ 単位 ・ 単価 ・ 税区分 ・ 金額（自動）・ ×, folded into two
 * rows below 1024px. 「行を追加」 and 「値引きを追加」 (品名「値引き」, a negative price) focus the new
 * line. Errors come as `lines.<n>.<field>`.
 */
export function InvoiceLinesEditor({
  idPrefix,
  lines,
  onLinesChange,
  parsed,
  taxCategories,
  pricesIncludeTax,
  withDate,
  fieldError,
  ruleProblems,
}: {
  idPrefix: string;
  lines: readonly EditorLine[];
  onLinesChange: (lines: EditorLine[]) => void;
  /** The amount input of each line (`draftLineTotals`). */
  parsed: readonly (InvoiceLineAmountInput | null)[];
  taxCategories: InvoiceFormOptions["taxCategories"];
  pricesIncludeTax: boolean;
  /** A document's lines have a date (取引年月日); a template's do not. */
  withDate: boolean;
  fieldError: (field: string) => string | undefined;
  ruleProblems: ReadonlyMap<number, string>;
}) {
  const nextKey = useRef(0);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  function changeLine(key: string, patch: Partial<EditorLine>) {
    onLinesChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  function addLine(discount: boolean) {
    if (lines.length >= MAX_LINES) return;
    nextKey.current += 1;
    const key = `added-${nextKey.current}`;
    const line = blankEditorLine(key, lines[0]?.taxCategoryCode ?? "sales_10");
    if (discount) {
      line.name = "値引き";
      line.unitPrice = "-";
    }
    onLinesChange([...lines, line]);
    setFocusId(`${idPrefix}-line-${key}-${discount ? "price" : "name"}`);
  }

  function removeLine(key: string) {
    onLinesChange(lines.filter((line) => line.key !== key));
  }

  const grid = withDate ? DATED_GRID : UNDATED_GRID;
  return (
    <section aria-labelledby={`${idPrefix}-lines`} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id={`${idPrefix}-lines`} className="text-[15px] font-extrabold">
          行
        </h2>
        <p className="text-[12px] text-muted">
          {pricesIncludeTax ? "単価は税込で入れます" : "単価は税抜で入れます"}
          。値引きは単価をマイナスにします
        </p>
      </div>
      <div
        aria-hidden="true"
        className={`hidden rounded-t-lg bg-surface-2 px-3 py-2 text-[11px] font-bold text-muted-2 lg:grid ${grid} lg:gap-x-2.5`}
      >
        {withDate ? <span>日付</span> : null}
        <span>品名</span>
        <span className="text-right">数量</span>
        <span>単位</span>
        <span className="text-right">単価（円）</span>
        <span>税区分</span>
        <span className="text-right">金額（円）</span>
        <span />
      </div>
      <ol className="flex flex-col">
        {lines.map((line, index) => {
          const at = `${idPrefix}-line-${line.key}`;
          const row = index + 1;
          const input = parsed[index];
          const amount = input ? lineAmount(input.quantity, input.unitPrice) : null;
          const lineError = (name: string) => fieldError(`lines.${index}.${name}`);
          const taxProblem = lineError("taxCategoryCode") ?? ruleProblems.get(index);
          const label = (text: string, htmlFor: string) => (
            <label htmlFor={htmlFor} className="text-[11px] font-bold text-muted lg:sr-only">
              {row} 行目の{text}
            </label>
          );
          const errorText = (message: string | undefined) =>
            message ? (
              <p role="alert" className="text-[12px] font-bold text-danger">
                {message}
              </p>
            ) : null;
          return (
            <li
              key={line.key}
              className={`grid grid-cols-2 gap-x-2.5 gap-y-2 border-b border-border px-3 py-3 md:grid-cols-6 ${grid} lg:items-start`}
            >
              <div
                className={`col-span-2 flex min-w-0 flex-col gap-1 ${
                  withDate ? "md:col-span-4" : "md:col-span-6"
                } lg:col-span-1`}
              >
                {label("品名", `${at}-name`)}
                <input
                  id={`${at}-name`}
                  className="control"
                  value={line.name}
                  maxLength={200}
                  aria-invalid={lineError("name") ? true : undefined}
                  onChange={(event) => changeLine(line.key, { name: event.currentTarget.value })}
                />
                {errorText(lineError("name"))}
              </div>
              {withDate ? (
                <div className="flex min-w-0 flex-col gap-1 md:col-span-2 lg:order-first lg:col-span-1">
                  {label("日付（任意）", `${at}-date`)}
                  <input
                    id={`${at}-date`}
                    type="date"
                    className="control"
                    value={line.date ?? ""}
                    aria-invalid={lineError("date") ? true : undefined}
                    onChange={(event) => changeLine(line.key, { date: event.currentTarget.value })}
                  />
                  {errorText(lineError("date"))}
                </div>
              ) : null}
              <div className="flex min-w-0 flex-col gap-1">
                {label("数量", `${at}-quantity`)}
                <input
                  id={`${at}-quantity`}
                  className="control num text-right"
                  inputMode="decimal"
                  autoComplete="off"
                  value={line.quantity}
                  aria-invalid={lineError("quantity") ? true : undefined}
                  onChange={(event) =>
                    changeLine(line.key, { quantity: event.currentTarget.value })
                  }
                />
                {errorText(lineError("quantity"))}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {label("単位", `${at}-unit`)}
                <input
                  id={`${at}-unit`}
                  className="control"
                  value={line.unit}
                  maxLength={20}
                  placeholder="式"
                  aria-invalid={lineError("unit") ? true : undefined}
                  onChange={(event) => changeLine(line.key, { unit: event.currentTarget.value })}
                />
                {errorText(lineError("unit"))}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {label("単価（円）", `${at}-price`)}
                <MoneyInput
                  id={`${at}-price`}
                  allowNegative
                  value={line.unitPrice}
                  aria-invalid={lineError("unitPrice") ? true : undefined}
                  onValueChange={(text) => changeLine(line.key, { unitPrice: text })}
                />
                {errorText(lineError("unitPrice"))}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                {label("税区分", `${at}-tax`)}
                <select
                  id={`${at}-tax`}
                  className="control"
                  value={line.taxCategoryCode}
                  aria-invalid={taxProblem ? true : undefined}
                  onChange={(event) =>
                    changeLine(line.key, { taxCategoryCode: event.currentTarget.value })
                  }
                >
                  {taxCategories.map((category) => (
                    <option key={category.code} value={category.code}>
                      {category.isActive ? category.name : `${category.name}（無効）`}
                    </option>
                  ))}
                </select>
                {errorText(taxProblem)}
              </div>
              <div className="flex min-w-0 flex-col gap-1 lg:justify-center">
                <span className="text-[11px] font-bold text-muted lg:sr-only">
                  {row} 行目の金額（円）
                </span>
                <span className="num min-h-10 content-center text-right text-[14px] font-bold">
                  {amount === null ? "—" : formatYen(amount)}
                </span>
              </div>
              <div className="flex items-start justify-end">
                <button
                  type="button"
                  onClick={() => removeLine(line.key)}
                  disabled={lines.length <= 1}
                  aria-label={`${row} 行目を消す`}
                  className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-[18px] text-muted hover:bg-black/5 hover:text-text disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => addLine(false)} disabled={lines.length >= MAX_LINES}>
          ＋ 行を追加
        </Button>
        <Button variant="ghost" onClick={() => addLine(true)} disabled={lines.length >= MAX_LINES}>
          ＋ 値引きを追加
        </Button>
        {lines.length >= MAX_LINES ? (
          <span className="text-[12px] text-muted">行は {MAX_LINES} 行までです</span>
        ) : null}
      </div>
    </section>
  );
}

/** 集計 (18 §8): per rate 「10% 対象 125,005 円 / 消費税 12,500 円」, then 合計. */
export function InvoiceTotalsSummary({
  totals,
  pricesIncludeTax,
  hasDate,
  incomplete,
  noDateText,
}: {
  totals: InvoiceTotals | null;
  pricesIncludeTax: boolean;
  /** The date the rates are taken on is set. */
  hasDate: boolean;
  incomplete: boolean;
  /** Said while there is no date. */
  noDateText: string;
}) {
  return (
    <section
      aria-label="集計"
      aria-live="polite"
      className="flex flex-col gap-1.5 border-t border-border pt-3 text-[14px] md:ml-auto md:w-[min(460px,100%)]"
    >
      {!hasDate ? (
        <p className="text-[13px] text-muted">{noDateText}</p>
      ) : totals === null ? (
        <p className="text-[13px] font-bold text-danger">
          税率の規則がない税区分があるため集計できません。行の税区分か 設定 › 税区分
          を確かめてください
        </p>
      ) : (
        <>
          {totals.rates.map((rate) => (
            <div
              key={rate.taxCategoryCode}
              className="flex flex-wrap items-baseline justify-between gap-x-4"
            >
              <span>
                {invoiceRateLabel(rate)}
                {rate.taxable ? ` 対象${pricesIncludeTax ? "（税込）" : ""}` : ""}
              </span>
              <span className="num">
                {formatYen(pricesIncludeTax ? rate.amountInclusive : rate.amountExclusive)} 円
                {rate.taxable ? (
                  <span className="ml-3 text-muted">消費税 {formatYen(rate.taxAmount)} 円</span>
                ) : null}
              </span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
            <span className="font-bold">合計</span>
            <span className="num text-[20px] font-extrabold">{formatYen(totals.total)} 円</span>
          </div>
        </>
      )}
      {incomplete ? (
        <p className="text-[12px] text-muted">数量か単価のない行は集計に入っていません</p>
      ) : null}
    </section>
  );
}

/** 会計 of an invoice (18 §8): 売上の科目 (収益の科目) and セグメント. */
export function RevenueFieldset({
  idPrefix,
  options,
  revenueAccountId,
  segmentId,
  onAccountChange,
  onSegmentChange,
  fieldError,
}: {
  idPrefix: string;
  options: InvoiceFormOptions;
  revenueAccountId: string;
  segmentId: string;
  onAccountChange: (revenueAccountId: string) => void;
  onSegmentChange: (segmentId: string) => void;
  fieldError: (field: string) => string | undefined;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[15px] font-extrabold">会計</legend>
      <div className="grid gap-4 md:grid-cols-2 lg:max-w-[720px]">
        <FormField
          label="売上の科目"
          htmlFor={`${idPrefix}-account`}
          error={fieldError("revenueAccountId")}
        >
          <Select
            id={`${idPrefix}-account`}
            value={revenueAccountId}
            aria-invalid={fieldError("revenueAccountId") ? true : undefined}
            onChange={(event) => onAccountChange(event.currentTarget.value)}
          >
            {options.revenueAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
                {account.isActive ? "" : "（無効）"}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="セグメント"
          htmlFor={`${idPrefix}-segment`}
          error={fieldError("segmentId")}
        >
          <Select
            id={`${idPrefix}-segment`}
            value={segmentId}
            aria-invalid={fieldError("segmentId") ? true : undefined}
            onChange={(event) => onSegmentChange(event.currentTarget.value)}
          >
            {options.segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.isActive ? segment.name : `${segment.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
    </fieldset>
  );
}
