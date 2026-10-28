"use client";

import { formatYen, invoiceNumberLabel, SUGGESTED_FEE_LIMIT } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { recordInvoicePaymentAction } from "../actions";

/** The deposit being applied (amounts as decimal text: bigint stays on the server). */
export interface ApplyDepositLine {
  id: string;
  walletId: string;
  txnDate: string;
  amount: string;
}

export interface ApplyDepositInvoice {
  id: string;
  number: string;
  partnerName: string;
  balance: string;
  difference: string;
}

/**
 * 「この請求に充てる」 (18 §9.4) from a statement line: the deposit's date, wallet and amount are the
 * line's; a shortfall up to `SUGGESTED_FEE_LIMIT` is offered as the transfer fee (支払手数料). The
 * line becomes `registered` with the payment's entry; then the statements open again.
 */
export function ApplyDepositButton({
  line,
  invoice,
}: {
  line: ApplyDepositLine;
  invoice: ApplyDepositInvoice;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const amount = BigInt(line.amount);
  const balance = BigInt(invoice.balance);
  const difference = BigInt(invoice.difference);
  const [open, setOpen] = useState(false);
  const [feeChecked, setFeeChecked] = useState(
    difference > 0n && difference <= SUGGESTED_FEE_LIMIT,
  );
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const number = invoiceNumberLabel(invoice.number);
  const fee = difference > 0n && feeChecked ? difference : 0n;
  const after = balance - amount - fee;

  function confirm() {
    startTransition(async () => {
      const result = await recordInvoicePaymentAction(invoice.id, {
        paidOn: line.txnDate,
        walletId: line.walletId,
        amount: line.amount,
        fee: fee > 0n ? fee.toString() : "",
        walletTransactionId: line.id,
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      toast(`${number} に入金を登録し、明細を片付けました`);
      router.push("/statements");
    });
  }

  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        この請求に充てる
      </Button>
      <ConfirmDialog
        open={open}
        title={`${number} に充てます`}
        confirmLabel="登録"
        pending={pending}
        error={formLevelErrors(error, () => false).join(" / ") || null}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={confirm}
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[14px]">
          <dt className="text-muted">取引先</dt>
          <dd className="min-w-0 break-words">{invoice.partnerName}</dd>
          <dt className="text-muted">入金額</dt>
          <dd className="num">{formatYen(amount)} 円</dd>
          <dt className="text-muted">残高</dt>
          <dd className="num">{formatYen(balance)} 円</dd>
        </dl>
        {difference > 0n ? (
          <div className="mt-3">
            <Checkbox
              id={`${id}-fee`}
              label={`差額 ${formatYen(difference)} 円を振込手数料にする`}
              checked={feeChecked}
              onChange={(event) => setFeeChecked(event.currentTarget.checked)}
            />
            <p className="text-[12px] text-muted">
              {feeChecked
                ? "支払手数料として計上します"
                : "一部入金として登録し、差額は残高に残ります"}
            </p>
          </div>
        ) : null}
        <p className="mt-3 text-[13px]">
          充当額 <span className="num font-bold">{formatYen(amount + fee)} 円</span>
          。登録後の残高 <span className="num font-bold">{formatYen(after)} 円</span>
        </p>
      </ConfirmDialog>
    </>
  );
}
