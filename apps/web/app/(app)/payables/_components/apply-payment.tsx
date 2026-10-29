"use client";

import { formatYen } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { payableName, paymentOutcome } from "../_lib/view";
import { payPayableAction } from "../actions";

/** The outflow being applied (amounts as decimal text: bigint stays on the server). */
export interface ApplyPaymentLine {
  id: string;
  walletId: string;
  txnDate: string;
  /** Signed as stored (negative). */
  amount: string;
}

export interface ApplyPaymentPayable {
  documentId: string;
  partnerName: string;
  remaining: string;
}

/**
 * 「この支払に充てる」 (25 §7.3) from a statement line: the payment's date, wallet and amount are the
 * line's; above the rest the difference (up to 1,100 yen) is the transfer fee, below it the payment
 * is partial. The line becomes 登録済み with the payment's entry; then the statements open again.
 */
export function ApplyPaymentButton({
  line,
  payable,
}: {
  line: ApplyPaymentLine;
  payable: ApplyPaymentPayable;
}) {
  const router = useRouter();
  const toast = useToast();
  const amount = -BigInt(line.amount);
  const remaining = BigInt(payable.remaining);
  const outcome = paymentOutcome(amount, remaining);
  const name = payableName(payable.partnerName);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await payPayableAction(payable.documentId, {
        paidOn: line.txnDate,
        walletId: line.walletId,
        amount: amount.toString(),
        walletTransactionId: line.id,
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      toast(`${name} に支払を登録し、明細を片付けました`);
      router.push("/statements");
    });
  }

  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        この支払に充てる
      </Button>
      <ConfirmDialog
        open={open}
        title={`${name} に充てます`}
        confirmLabel="登録"
        pending={pending}
        error={formLevelErrors(error, () => false).join(" / ") || outcome.problem || null}
        onCancel={() => {
          setOpen(false);
          setError(null);
        }}
        onConfirm={confirm}
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[14px]">
          <dt className="text-muted">出金額</dt>
          <dd className="num">{formatYen(amount)} 円</dd>
          <dt className="text-muted">残り</dt>
          <dd className="num">{formatYen(remaining)} 円</dd>
          {outcome.applied !== null ? (
            <>
              <dt className="text-muted">充当額</dt>
              <dd className="num">{formatYen(outcome.applied)} 円</dd>
            </>
          ) : null}
        </dl>
        {outcome.text ? <p className="mt-3 text-[13px]">{outcome.text}</p> : null}
      </ConfirmDialog>
    </>
  );
}
