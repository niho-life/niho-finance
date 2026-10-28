"use client";

import {
  ACCOUNTING_METHOD_LABELS,
  ACCOUNTING_METHODS,
  CONSUMPTION_TAX_METHOD_LABELS,
  CONSUMPTION_TAX_METHODS,
  defaultAccountingMethod,
  type AccountingMethod,
  type ConsumptionTaxMethod,
} from "@niho-finance/ledger";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { describedBy, FormField, Input } from "@/components/ui/form";
import type { ActionError } from "@/lib/action-types";
import { formatDate, formatPeriod } from "@/lib/format";
import { createFirstFiscalYearAction } from "../actions";

const CONSUMPTION_TAX_HELP: Record<ConsumptionTaxMethod, string> = {
  exempt: "設立 1 期目の多くはこれ。インボイスに登録したら変えます",
  general: "課税事業者で、仕入の消費税を実額で差し引く",
  simplified: "課税事業者で、みなし仕入率で計算する（届出が必要）",
};

/** Step 2: 第 1 期 from the founding date. Only the end date can be changed (10 §3). */
export function FiscalYearStep({
  startDate,
  proposedEndDate,
  fiscalYearEndMonth,
}: {
  startDate: string;
  proposedEndDate: string;
  fiscalYearEndMonth: number;
}) {
  const id = useId();
  const [endDate, setEndDate] = useState(proposedEndDate);
  const [consumptionTax, setConsumptionTax] = useState<ConsumptionTaxMethod>("exempt");
  const [accountingMethod, setAccountingMethod] = useState<AccountingMethod>("tax_inclusive");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const exempt = consumptionTax === "exempt";
  const method = exempt ? "tax_inclusive" : accountingMethod;
  const period = endDate ? formatPeriod(startDate, endDate) : "—";

  function create() {
    startTransition(async () => {
      const result = await createFirstFiscalYearAction({
        endDate,
        consumptionTax,
        accountingMethod: method,
      });
      if (result && !result.ok) setError(result);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid gap-4 md:grid-cols-2">
        <div>
          <dt className="text-[12px] font-bold text-muted">開始日（設立日）</dt>
          <dd className="num mt-1 text-[16px] font-bold">{formatDate(startDate)}</dd>
        </div>
        <FormField
          label="終了日"
          htmlFor={`${id}-end`}
          help={`決算月（${fiscalYearEndMonth} 月）の末日を提案しています`}
          error={error?.fieldErrors.endDate}
        >
          <Input
            id={`${id}-end`}
            type="date"
            value={endDate}
            min={startDate}
            onChange={(event) => setEndDate(event.currentTarget.value)}
            {...describedBy(`${id}-end`, { help: true, error: error?.fieldErrors.endDate })}
          />
        </FormField>
      </dl>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] font-bold text-muted">消費税の区分</legend>
        {CONSUMPTION_TAX_METHODS.map((value) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3.5 py-3 ${
              consumptionTax === value
                ? "border-primary bg-primary-soft"
                : "border-border bg-surface"
            }`}
          >
            <input
              type="radio"
              name="consumptionTax"
              value={value}
              checked={consumptionTax === value}
              onChange={() => {
                setConsumptionTax(value);
                setAccountingMethod(defaultAccountingMethod(value));
              }}
              className="mt-1 accent-[var(--primary)]"
            />
            <span>
              <span className="block font-bold">{CONSUMPTION_TAX_METHOD_LABELS[value]}</span>
              <span className="block text-[12px] text-muted">{CONSUMPTION_TAX_HELP[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-2" disabled={exempt}>
        <legend className="mb-1 text-[12px] font-bold text-muted">経理方式</legend>
        <div className="flex flex-wrap gap-2">
          {ACCOUNTING_METHODS.map((value) => (
            <label
              key={value}
              className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-[10px] border px-3.5 ${
                method === value ? "border-primary bg-primary-soft" : "border-border bg-surface"
              } ${exempt ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <input
                type="radio"
                name="accountingMethod"
                value={value}
                checked={method === value}
                onChange={() => setAccountingMethod(value)}
                className="accent-[var(--primary)]"
              />
              {ACCOUNTING_METHOD_LABELS[value]}
            </label>
          ))}
        </div>
        {exempt ? (
          <p className="text-[12px] text-muted-2">免税の期は税込経理に決まっています</p>
        ) : null}
      </fieldset>

      {error && !error.fieldErrors.endDate ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error.error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setConfirming(true)} disabled={!endDate}>
          次へ
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="第 1 期を作ります"
        confirmLabel="作成"
        pending={pending}
        error={error?.error ?? null}
        onCancel={() => setConfirming(false)}
        onConfirm={create}
      >
        <p className="num font-bold">{period}</p>
        <p className="mt-1 text-muted">
          {CONSUMPTION_TAX_METHOD_LABELS[consumptionTax]} · {ACCOUNTING_METHOD_LABELS[method]}
        </p>
        <p className="mt-3 text-[13px] text-muted">
          期間はあとから変えられません。消費税の区分と経理方式は 設定 › 会計期間 で変えられます。
        </p>
      </ConfirmDialog>
    </div>
  );
}
