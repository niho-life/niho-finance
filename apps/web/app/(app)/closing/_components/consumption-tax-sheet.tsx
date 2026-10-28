"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import type { ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { postConsumptionTaxSettlementAction } from "../actions";

/**
 * 「精算を計上」 (16 §8): 納付税額 (the return's amount; negative for a refund), the suggestion being
 * 仮受 − 仮払 truncated to 100 yen.
 */
export function ConsumptionTaxSheet({
  fiscalYearId,
  endDate,
  exclusive,
  outputTax,
  inputTax,
  suggested,
}: {
  fiscalYearId: string;
  /** Formatted. */
  endDate: string;
  /** 税抜経理. */
  exclusive: boolean;
  /** 仮受消費税 / 仮払消費税 at the year end, formatted. */
  outputTax: string;
  inputTax: string;
  /** The default of 納付税額 as the input shows it ("" for none). */
  suggested: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [payable, setPayable] = useState(suggested);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function openSheet() {
    setPayable(suggested);
    setError(null);
    setOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await postConsumptionTaxSettlementAction(fiscalYearId, { payable });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(`消費税の精算を計上しました（${entryNo(result.data.no)}）`);
      router.refresh();
    });
  }

  const formId = `${id}-form`;
  const formError = error && !error.fieldErrors.payable ? error.error : null;

  return (
    <>
      <Button variant="primary" size="sm" onClick={openSheet}>
        精算を計上
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="消費税の精算"
        description={`期末日 ${endDate} 付の決算整理仕訳`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" form={formId} variant="primary" disabled={pending}>
              {pending ? "計上中…" : "精算を計上"}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
          {formError ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {formError}
            </p>
          ) : null}
          {exclusive ? (
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-[14px]">
              <dt className="text-muted">仮受消費税（円）</dt>
              <dd className="num text-right">{outputTax}</dd>
              <dt className="text-muted">仮払消費税（円）</dt>
              <dd className="num text-right">{inputTax}</dd>
            </dl>
          ) : null}
          <FormField
            label="納付税額（円）"
            htmlFor={`${id}-payable`}
            required
            error={error?.fieldErrors.payable}
            help={
              exclusive
                ? "申告書の額を入れます（既定は 仮受 − 仮払 を 100 円未満切り捨て）。還付はマイナスで入れます"
                : "申告書の額を入れます。還付はマイナスで入れます"
            }
          >
            <MoneyInput
              id={`${id}-payable`}
              value={payable}
              allowNegative
              onValueChange={setPayable}
            />
          </FormField>
          <p className="text-[12px] text-muted">
            {exclusive
              ? "借方 仮受消費税 / 貸方 仮払消費税 / 貸方 未払消費税等（還付は借方 未収入金）。差額は雑収入か雑損失にします。"
              : "借方 租税公課 / 貸方 未払消費税等。"}
          </p>
        </form>
      </Sheet>
    </>
  );
}
