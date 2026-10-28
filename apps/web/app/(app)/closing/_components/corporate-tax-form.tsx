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
import { postCorporateTaxAction } from "../actions";

/**
 * 「法人税等を計上」 (16 §9): 計上額, the default being the estimate less what is already booked. The
 * estimate leaves out the tax adjustments: the accountant's figure or the return's comes first.
 */
export function CorporateTaxForm({
  fiscalYearId,
  endDate,
  estimate,
  booked,
  suggested,
}: {
  fiscalYearId: string;
  /** Formatted. */
  endDate: string;
  /** 年税額の概算 and 計上済み, formatted. */
  estimate: string;
  booked: string;
  /** The default as the input shows it ("" when nothing is left to book). */
  suggested: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(suggested);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function openSheet() {
    setAmount(suggested);
    setError(null);
    setOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await postCorporateTaxAction(fiscalYearId, { amount });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(`法人税等を計上しました（${entryNo(result.data.no)}）`);
      router.refresh();
    });
  }

  const formId = `${id}-form`;
  const formError = error && !error.fieldErrors.amount ? error.error : null;

  return (
    <>
      <Button variant="primary" size="sm" onClick={openSheet}>
        法人税等を計上
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="法人税等の計上"
        description={`期末日 ${endDate} 付の決算整理仕訳`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" form={formId} variant="primary" disabled={pending}>
              {pending ? "計上中…" : "法人税等を計上"}
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
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-[14px]">
            <dt className="text-muted">年税額の概算（円）</dt>
            <dd className="num text-right font-bold">{estimate}</dd>
            <dt className="text-muted">計上済み（円）</dt>
            <dd className="num text-right">{booked}</dd>
          </dl>
          <FormField
            label="計上額（円）"
            htmlFor={`${id}-amount`}
            required
            error={error?.fieldErrors.amount}
            help="概算です。税理士の計算や申告書の額があればその額にしてください"
          >
            <MoneyInput id={`${id}-amount`} value={amount} onValueChange={setAmount} />
          </FormField>
          <p className="text-[12px] text-muted">
            借方 法人税、住民税及び事業税 / 貸方 未払法人税等。取り消すと入れ直せます。
          </p>
        </form>
      </Sheet>
    </>
  );
}
