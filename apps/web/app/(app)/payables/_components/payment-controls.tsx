"use client";

import {
  displayDate,
  formatYen,
  isCalendarDate,
  PAYABLE_FEE_LIMIT,
  parseYenInput,
  type CalendarDate,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo, formatYenDisplay } from "@/lib/format";
import { differenceText, paymentOutcome } from "../_lib/view";
import { cancelPayablePaymentAction, payPayableAction } from "../actions";

/** A pending outflow that can pay the payable (amounts as decimal text). */
export interface PaymentLineChoice {
  id: string;
  walletId: string;
  walletName: string;
  txnDate: CalendarDate;
  description: string;
  /** 出金額 (positive). */
  amount: string;
}

export interface PaySheetModel {
  documentId: string;
  /** 「<取引先> の請求書」 */
  name: string;
  /** 残り as decimal text. */
  remaining: string;
  invoiceDate: CalendarDate;
  today: CalendarDate;
  /** 支払元の予定: the wallet chosen first for 手入力. */
  plannedWalletId: string | null;
  /** Active wallets (bank, cash, card …). */
  wallets: { id: string; label: string; isBank: boolean }[];
  candidates: PaymentLineChoice[];
}

const MANUAL = "manual";
const FIELDS = new Set(["paidOn", "walletId", "amount", "walletTransactionId"]);

interface PaymentDraft {
  /** A candidate's id, or `manual`. */
  source: string;
  paidOn: string;
  walletId: string;
  amount: string;
}

function startingDraft(model: PaySheetModel): PaymentDraft {
  // The closest outflow is chosen when it plausibly is this payment: the rest exactly, or with a
  // transfer fee of at most 1,100 yen on top.
  const remaining = BigInt(model.remaining);
  const [closest] = model.candidates;
  if (closest) {
    const amount = BigInt(closest.amount);
    if (amount >= remaining && amount - remaining <= PAYABLE_FEE_LIMIT) {
      return {
        source: closest.id,
        paidOn: closest.txnDate,
        walletId: closest.walletId,
        amount: formatYen(amount),
      };
    }
  }
  const wallet =
    model.wallets.find((item) => item.id === model.plannedWalletId) ??
    model.wallets.find((item) => item.isBank) ??
    model.wallets[0];
  return {
    source: MANUAL,
    paidOn: model.today,
    walletId: wallet?.id ?? "",
    amount: formatYen(remaining),
  };
}

/**
 * 支払を登録 (25 §7.2): a sheet with the rest on top, the pending outflows closest to it (a chosen one
 * fixes the date, the wallet and the amount) or 手入力, and what happens to the difference (the
 * transfer fee, or a partial payment) with the rest after the payment, said before sending.
 */
export function PayPayableButton({ model }: { model: PaySheetModel }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PaymentDraft>(() => startingDraft(model));
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const remaining = BigInt(model.remaining);
  const fromStatement = draft.source !== MANUAL;
  const outcome = paymentOutcome(parseYenInput(draft.amount), remaining);

  function openSheet() {
    setDraft(startingDraft(model));
    setError(null);
    setOpen(true);
  }

  function choose(source: string) {
    const candidate = model.candidates.find((item) => item.id === source);
    setError(null);
    setDraft(
      candidate
        ? {
            source,
            paidOn: candidate.txnDate,
            walletId: candidate.walletId,
            amount: formatYen(BigInt(candidate.amount)),
          }
        : { ...draft, source: MANUAL },
    );
  }

  function submit() {
    startTransition(async () => {
      const result = await payPayableAction(model.documentId, {
        paidOn: draft.paidOn,
        walletId: draft.walletId,
        amount: draft.amount,
        walletTransactionId: fromStatement ? draft.source : "",
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(
        result.data.state === "paid"
          ? `支払を登録しました（${entryNo(result.data.entryNo)}）。${model.name} は支払済みです`
          : `支払を登録しました（${entryNo(result.data.entryNo)}・残り ${formatYenDisplay(BigInt(result.data.remaining))} 円）`,
      );
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  const paidOnProblem =
    isCalendarDate(draft.paidOn) && draft.paidOn < model.invoiceDate
      ? `請求書の日付 ${displayDate(model.invoiceDate)} 以後にしてください`
      : null;

  return (
    <>
      <Button variant="primary" size="sm" onClick={openSheet}>
        支払を登録
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="支払を登録"
        description={model.name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending}>
              {pending ? "登録中…" : "登録"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-[12px] font-bold text-muted">残り</p>
            <p className="num text-[24px] font-extrabold">{formatYenDisplay(remaining)} 円</p>
          </div>

          {alerts.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
            >
              {alerts.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[12px] font-bold text-muted">支払のもと</legend>
            {model.candidates.length === 0 ? (
              <p className="text-[13px] text-muted">
                充てられる未処理の出金の明細はありません。手入力で登録します
              </p>
            ) : null}
            <ul className="flex flex-col">
              {model.candidates.map((candidate) => (
                <li key={candidate.id} className="border-b border-border">
                  <label className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2">
                    <input
                      type="radio"
                      name={`${id}-source`}
                      value={candidate.id}
                      checked={draft.source === candidate.id}
                      onChange={() => choose(candidate.id)}
                      className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="num min-w-0 truncate text-[13px] text-muted">
                          {displayDate(candidate.txnDate)} · {candidate.walletName}
                        </span>
                        <span className="num font-bold">
                          {formatYenDisplay(BigInt(candidate.amount))}
                        </span>
                      </span>
                      <span className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="min-w-0 truncate">{candidate.description}</span>
                        <span className="shrink-0 text-[12px] text-muted">
                          {differenceText(BigInt(candidate.amount), remaining)}
                        </span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
              <li>
                <label className="flex min-h-11 cursor-pointer items-center gap-2.5 py-2">
                  <input
                    type="radio"
                    name={`${id}-source`}
                    value={MANUAL}
                    checked={!fromStatement}
                    onChange={() => choose(MANUAL)}
                    className="size-4 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="text-[14px] font-bold">手入力</span>
                </label>
              </li>
            </ul>
            {fieldError("walletTransactionId") ? (
              <p role="alert" className="text-[12px] font-bold text-danger">
                {fieldError("walletTransactionId")}
              </p>
            ) : null}
          </fieldset>

          <FormField
            label="支払日"
            htmlFor={`${id}-paid-on`}
            required
            error={fieldError("paidOn")}
            help={paidOnProblem}
          >
            <Input
              id={`${id}-paid-on`}
              type="date"
              value={draft.paidOn}
              readOnly={fromStatement}
              onChange={(event) => setDraft({ ...draft, paidOn: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="口座" htmlFor={`${id}-wallet`} required error={fieldError("walletId")}>
            <Select
              id={`${id}-wallet`}
              value={draft.walletId}
              disabled={fromStatement}
              onChange={(event) => setDraft({ ...draft, walletId: event.currentTarget.value })}
            >
              <option value="">選んでください</option>
              {model.wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="出金額（円）"
            htmlFor={`${id}-amount`}
            required
            error={fieldError("amount")}
            help="残りを超えた分は 1,100 円まで振込手数料にします"
          >
            <MoneyInput
              id={`${id}-amount`}
              value={draft.amount}
              readOnly={fromStatement}
              onValueChange={(text) => setDraft({ ...draft, amount: text })}
            />
          </FormField>

          {outcome.problem ? (
            <p role="alert" className="text-[13px] font-bold text-danger">
              {outcome.problem}
            </p>
          ) : outcome.text ? (
            <p aria-live="polite" className="text-[14px]">
              充当額{" "}
              <span className="num font-bold">{formatYenDisplay(outcome.applied ?? 0n)}</span> 円。
              {outcome.text}
            </p>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}

/**
 * 支払の取消 (25 §4.3): a danger confirmation with the reason; the payment's entry is reversed (a
 * payment from a statement line puts the line back to 未処理) and the rest comes back.
 */
export function CancelPayablePaymentButton({
  documentId,
  entryId,
  entryNoValue,
  fromStatement,
  remainingAfter,
}: {
  documentId: string;
  entryId: string;
  entryNoValue: number;
  /** Paid from a statement line: the line goes back to 未処理 too. */
  fromStatement: boolean;
  /** The rest once cancelled, formatted. */
  remainingAfter: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) document.getElementById(`${id}-reason`)?.focus();
  }, [open, id]);

  function close() {
    setOpen(false);
    setError(null);
  }

  function confirm() {
    if (reason.trim() === "") {
      const message = "理由を入力してください";
      setError({ ok: false, error: message, fieldErrors: { reason: message } });
      return;
    }
    startTransition(async () => {
      const result = await cancelPayablePaymentAction(documentId, { entryId, reason });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      toast(
        result.data.reopenedCount > 0
          ? "支払を取り消し、明細を未処理に戻しました"
          : "支払を取り消しました",
      );
      router.refresh();
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger! hover:text-danger!"
        onClick={() => setOpen(true)}
      >
        取消
      </Button>
      <ConfirmDialog
        open={open}
        title="支払を取り消します"
        confirmLabel="取消"
        variant="danger"
        pending={pending}
        error={formLevelErrors(error, (field) => field === "reason").join(" / ") || null}
        onCancel={close}
        onConfirm={confirm}
      >
        <p>
          仕訳 {entryNo(entryNoValue)} を反対仕訳で取り消し、残りを{" "}
          <span className="num font-bold">{remainingAfter}</span> 円に戻します。
          {fromStatement ? "明細は未処理に戻ります。" : ""}
        </p>
        <div className="mt-3">
          <FormField
            label="理由"
            htmlFor={`${id}-reason`}
            required
            error={error?.fieldErrors.reason}
          >
            <Textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={500}
              onChange={(event) => {
                setReason(event.currentTarget.value);
                if (error?.fieldErrors.reason) setError(null);
              }}
            />
          </FormField>
        </div>
      </ConfirmDialog>
    </>
  );
}
