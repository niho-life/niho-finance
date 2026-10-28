"use client";

import {
  displayDate,
  formatYen,
  isCalendarDate,
  parseYenInput,
  SUGGESTED_FEE_LIMIT,
  type CalendarDate,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { cancelInvoicePaymentAction, recordInvoicePaymentAction } from "../actions";

/** An unhandled deposit that can pay the invoice (amounts as decimal text). */
export interface PaymentCandidate {
  id: string;
  walletId: string;
  walletName: string;
  txnDate: CalendarDate;
  description: string;
  amount: string;
  /** 残高 − 入金額 */
  difference: string;
}

export interface PaymentSheetModel {
  invoiceId: string;
  /** 「請求書 INV-2026-0001」 */
  name: string;
  /** 残高 as decimal text. */
  balance: string;
  issueDate: CalendarDate;
  today: CalendarDate;
  /** Active wallets on an asset account. */
  wallets: { id: string; label: string; isBank: boolean }[];
  candidates: PaymentCandidate[];
}

const MANUAL = "manual";
const FIELDS = new Set(["paidOn", "walletId", "amount", "fee", "walletTransactionId"]);

interface PaymentDraft {
  /** A candidate's id, or `manual`. */
  source: string;
  paidOn: string;
  walletId: string;
  amount: string;
  /** `null`: follow the default (on when the shortfall is up to the suggested fee). */
  feeChecked: boolean | null;
}

function startingDraft(model: PaymentSheetModel): PaymentDraft {
  // The closest deposit is chosen when it plausibly is this payment (a fee's difference at most).
  const [closest] = model.candidates;
  if (closest && BigInt(closest.difference) <= SUGGESTED_FEE_LIMIT) {
    return {
      source: closest.id,
      paidOn: closest.txnDate,
      walletId: closest.walletId,
      amount: formatYen(BigInt(closest.amount)),
      feeChecked: null,
    };
  }
  const wallet = model.wallets.find((item) => item.isBank) ?? model.wallets[0];
  return {
    source: MANUAL,
    paidOn: model.today,
    walletId: wallet?.id ?? "",
    amount: formatYen(BigInt(model.balance)),
    feeChecked: null,
  };
}

/**
 * 入金を登録 (18 §9.4): a sheet with the balance on top, the unhandled deposits closest to it (a
 * chosen one fixes the date, the wallet and the amount) or 手入力, and the shortfall offered as the
 * transfer fee. The applied amount and the balance after are said before sending.
 */
export function RecordPaymentButton({ model }: { model: PaymentSheetModel }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PaymentDraft>(() => startingDraft(model));
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const balance = BigInt(model.balance);
  const fromStatement = draft.source !== MANUAL;
  const amount = parseYenInput(draft.amount);
  const difference = amount !== null && amount > 0n && amount < balance ? balance - amount : 0n;
  const feeOn = difference > 0n && (draft.feeChecked ?? difference <= SUGGESTED_FEE_LIMIT);
  const fee = feeOn ? difference : 0n;
  const applied = amount !== null && amount > 0n ? amount + fee : null;

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
            feeChecked: null,
          }
        : { ...draft, source: MANUAL },
    );
  }

  function submit() {
    startTransition(async () => {
      const result = await recordInvoicePaymentAction(model.invoiceId, {
        paidOn: draft.paidOn,
        walletId: draft.walletId,
        amount: draft.amount,
        fee: fee.toString(),
        walletTransactionId: fromStatement ? draft.source : "",
      });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(
        result.data.status === "paid"
          ? `入金を登録しました。${model.name} は入金済みです`
          : `入金を登録しました（残高 ${formatYen(BigInt(result.data.balance ?? "0"))} 円）`,
      );
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(
    error,
    (field) => FIELDS.has(field) && (field !== "fee" || difference > 0n),
  );
  const paidOnProblem =
    isCalendarDate(draft.paidOn) && draft.paidOn < model.issueDate
      ? `発行日 ${displayDate(model.issueDate)} 以後にしてください`
      : null;

  return (
    <>
      <Button variant="primary" size="sm" onClick={openSheet}>
        入金を登録
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="入金を登録"
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
            <p className="text-[12px] font-bold text-muted">残高</p>
            <p className="num text-[24px] font-extrabold">{formatYen(balance)} 円</p>
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
            <legend className="mb-1 text-[12px] font-bold text-muted">入金のもと</legend>
            {model.candidates.length === 0 ? (
              <p className="text-[13px] text-muted">
                未処理の入金の明細はありません。手入力で登録します
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
                        <span className="num text-[13px] text-muted">
                          {displayDate(candidate.txnDate)} · {candidate.walletName}
                        </span>
                        <span className="num font-bold">{formatYen(BigInt(candidate.amount))}</span>
                      </span>
                      <span className="truncate text-[13px]">{candidate.description}</span>
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
            label="入金日"
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
            label="入金額（円）"
            htmlFor={`${id}-amount`}
            required
            error={fieldError("amount")}
          >
            <MoneyInput
              id={`${id}-amount`}
              value={draft.amount}
              readOnly={fromStatement}
              onValueChange={(text) => setDraft({ ...draft, amount: text })}
            />
          </FormField>

          {difference > 0n ? (
            <div className="flex flex-col gap-1">
              <Checkbox
                id={`${id}-fee`}
                label={`差額 ${formatYen(difference)} 円を振込手数料にする`}
                checked={feeOn}
                onChange={(event) =>
                  setDraft({ ...draft, feeChecked: event.currentTarget.checked })
                }
              />
              <p className="text-[12px] text-muted">
                {feeOn ? "支払手数料として計上します" : "差額は残高に残ります（一部入金）"}
              </p>
              {fieldError("fee") ? (
                <p role="alert" className="text-[12px] font-bold text-danger">
                  {fieldError("fee")}
                </p>
              ) : null}
            </div>
          ) : null}

          {applied !== null ? (
            <p aria-live="polite" className="text-[14px]">
              充当額 <span className="num font-bold">{formatYen(applied)}</span> 円
              {fee > 0n ? (
                <span className="text-muted">
                  （入金額 {formatYen(applied - fee)} 円 ＋ 手数料 {formatYen(fee)} 円）
                </span>
              ) : null}
              。登録後の残高{" "}
              <span className="num font-bold">
                {applied > balance ? "—" : formatYen(balance - applied)}
              </span>{" "}
              円
              {applied > balance ? (
                <span className="block text-[12px] font-bold text-danger">
                  入金額が残高を超えています
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      </Sheet>
    </>
  );
}

/**
 * 入金の取消 (18 §9.4): a danger confirmation with the reason; the payment's entry is reversed and
 * the balance comes back.
 */
export function CancelPaymentButton({
  invoiceId,
  paymentId,
  entryNoValue,
  balanceAfter,
}: {
  invoiceId: string;
  paymentId: string;
  /** The payment's entry (仕訳 No.). */
  entryNoValue: number | null;
  /** The balance once cancelled, formatted. */
  balanceAfter: string;
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
      const result = await cancelInvoicePaymentAction(invoiceId, { paymentId, reason });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      toast("入金を取り消しました");
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
        title="入金を取り消します"
        confirmLabel="取消"
        variant="danger"
        pending={pending}
        error={formLevelErrors(error, (field) => field === "reason").join(" / ") || null}
        onCancel={close}
        onConfirm={confirm}
      >
        <p>
          {entryNoValue !== null ? `仕訳 ${entryNo(entryNoValue)} を反対仕訳で取り消し、` : ""}
          残高を <span className="num font-bold">{balanceAfter}</span> 円に戻します。
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
