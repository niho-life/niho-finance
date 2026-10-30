"use client";

import {
  displayDate,
  isCalendarDate,
  RECEIPT_PROVISO_MAX,
  receiptDateProblem,
  type CalendarDate,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Textarea } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { issueReceiptAction, saveReceiptPdfAction, voidReceiptAction } from "../actions";

/** A receipt as the section shows it (amounts formatted). */
export interface ReceiptRowModel {
  id: string;
  number: string;
  issueDate: CalendarDate;
  /** 領収金額, formatted (`138,622`). */
  amountText: string;
  proviso: string;
  pdfDocumentId: string | null;
  voidReason: string | null;
}

export interface ReceiptSectionModel {
  invoiceId: string;
  /** 「請求書 INV-2026-0001」 */
  invoiceName: string;
  current: ReceiptRowModel | null;
  /** Void receipts, the newest first. */
  voided: ReceiptRowModel[];
  canIssue: boolean;
  /** Why it cannot be issued now (e.g. a payment dated later), when none is in force. */
  blocked: string | null;
  today: CalendarDate;
  defaults: {
    proviso: string;
    receivedOn: CalendarDate | null;
    amountText: string;
    /** 宛名 without 「様」. */
    recipientName: string;
    stampHelp: string | null;
  };
}

const FIELDS = new Set(["issueDate", "proviso"]);

function pdfHref(invoiceId: string, receipt: ReceiptRowModel, voided: boolean): string {
  const base = `/invoices/${invoiceId}/receipt/pdf`;
  return voided ? `${base}?receipt=${receipt.id}` : base;
}

/**
 * 領収書を発行 (18 §15.1, §15.4): a sheet with 発行日 (on or after the last payment, not after
 * today), 但し書き, the stamp duty's help and the 見本 of the recipient and the amount.
 */
function IssueReceiptButton({ model }: { model: ReceiptSectionModel }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [issueDate, setIssueDate] = useState<string>(model.today);
  const [proviso, setProviso] = useState(model.defaults.proviso);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function openSheet() {
    setIssueDate(model.today);
    setProviso(model.defaults.proviso);
    setError(null);
    setOpen(true);
  }

  function submit() {
    startTransition(async () => {
      const result = await issueReceiptAction(model.invoiceId, { issueDate, proviso });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast(
        result.data.pdfDocumentId
          ? `領収書 ${result.data.number} を発行しました`
          : `領収書 ${result.data.number} を発行しました。PDF は証憑に保存できませんでした`,
        result.data.pdfDocumentId ? undefined : { tone: "error" },
      );
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  const dateProblem =
    isCalendarDate(issueDate) && model.defaults.receivedOn
      ? receiptDateProblem(issueDate, model.defaults.receivedOn, model.today)
      : null;

  return (
    <>
      <Button variant="primary" size="sm" onClick={openSheet}>
        領収書を発行
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="領収書を発行"
        description={model.invoiceName}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending || dateProblem !== null}>
              {pending ? "発行中…" : "発行"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
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
          <FormField
            label="発行日"
            htmlFor={`${id}-issue-date`}
            required
            error={fieldError("issueDate") ?? dateProblem ?? undefined}
            help={
              model.defaults.receivedOn
                ? `入金日 ${displayDate(model.defaults.receivedOn)} から今日までの日付`
                : null
            }
          >
            <Input
              id={`${id}-issue-date`}
              type="date"
              value={issueDate}
              min={model.defaults.receivedOn ?? undefined}
              max={model.today}
              aria-invalid={fieldError("issueDate") || dateProblem ? true : undefined}
              onChange={(event) => setIssueDate(event.currentTarget.value)}
            />
          </FormField>
          <FormField
            label="但し書き"
            htmlFor={`${id}-proviso`}
            error={fieldError("proviso")}
            help={`${RECEIPT_PROVISO_MAX} 字まで。空なら「${model.defaults.proviso}」`}
          >
            <Input
              id={`${id}-proviso`}
              value={proviso}
              maxLength={RECEIPT_PROVISO_MAX}
              aria-invalid={fieldError("proviso") ? true : undefined}
              onChange={(event) => setProviso(event.currentTarget.value)}
            />
          </FormField>
          {model.defaults.stampHelp ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
              {model.defaults.stampHelp}。PDF には「電子領収書につき収入印紙は不要です」と入ります
            </p>
          ) : null}
          <div aria-live="polite" className="rounded-lg border border-border px-3 py-2.5">
            <p className="text-[12px] font-bold text-muted">見本</p>
            <p className="text-[15px] font-bold break-words">{model.defaults.recipientName} 様</p>
            <p className="num text-[18px] font-extrabold">¥ {model.defaults.amountText} -</p>
            <p className="text-[13px] break-words">
              但し {proviso.trim() === "" ? model.defaults.proviso : proviso.trim()}
            </p>
          </div>
        </div>
      </Sheet>
    </>
  );
}

/** 無効にする (18 §15.1): a danger confirmation with the reason; the number stays. */
function VoidReceiptButton({ receipt }: { receipt: ReceiptRowModel }) {
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
      const result = await voidReceiptAction(receipt.id, { reason });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      toast(`領収書 ${receipt.number} を無効にしました`);
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
        無効にする
      </Button>
      <ConfirmDialog
        open={open}
        title={`領収書 ${receipt.number} を無効にします`}
        confirmLabel="無効にする"
        variant="danger"
        pending={pending}
        error={formLevelErrors(error, (field) => field === "reason").join(" / ") || null}
        onCancel={close}
        onConfirm={confirm}
      >
        <p>
          番号は残ります。発行し直すと新しい番号になります。無効にすると、入金の取消と書類の無効ができるようになります。
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

/** PDF を証憑に保存 (18 §15.3): for a receipt whose PDF was not saved on issue. */
function SaveReceiptPdfButton({ invoiceId, receiptId }: { invoiceId: string; receiptId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await saveReceiptPdfAction(invoiceId, receiptId);
          if (!result.ok) {
            toast(result.error, { tone: "error" });
            return;
          }
          toast("PDF を証憑に保存しました");
          router.refresh();
        })
      }
    >
      {pending ? "保存中…" : "PDF を証憑に保存"}
    </Button>
  );
}

/**
 * 領収書 of a paid invoice (18 §15.4): 「領収書を発行」 while none is in force; once issued its
 * number ・ 発行日 ・ 金額 ・ PDF ・ 無効にする and whether its PDF is kept as a 証憑; the void ones below,
 * small (番号・無効の理由).
 */
export function ReceiptSection({ model }: { model: ReceiptSectionModel }) {
  const { current } = model;
  return (
    <section aria-labelledby="invoice-receipt" className="mt-8">
      <h2 id="invoice-receipt" className="mb-3 text-[15px] font-extrabold">
        領収書
      </h2>
      {current ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-border px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="num font-bold">{current.number}</span>
              <span className="text-[13px] text-muted">
                {displayDate(current.issueDate)} 発行 ·{" "}
                <span className="num font-bold text-text">{current.amountText}</span> 円
              </span>
              <span className="text-[12px] break-words text-muted">但し {current.proviso}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={pdfHref(model.invoiceId, current, false)}
                target="_blank"
                rel="noopener"
                className={buttonClass({ size: "sm" })}
              >
                PDF を開く
              </a>
              <VoidReceiptButton receipt={current} />
            </div>
          </div>
          {current.pdfDocumentId ? (
            <p className="text-[13px] text-muted">
              控えを証憑に保存しました（
              <Link
                href={`/documents/${current.pdfDocumentId}`}
                className="font-bold underline underline-offset-4"
              >
                証憑を開く
              </Link>
              ）
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
              <span>領収書の PDF がまだ証憑に保存されていません</span>
              <SaveReceiptPdfButton invoiceId={model.invoiceId} receiptId={current.id} />
            </p>
          )}
        </div>
      ) : model.canIssue ? (
        <div className="flex flex-wrap items-center gap-3">
          <IssueReceiptButton model={model} />
          <span className="text-[13px] text-muted">
            入金済みの請求書の領収書を PDF で発行し、控えを証憑に残します
          </span>
        </div>
      ) : model.blocked ? (
        <p className="text-[13px] text-muted">{model.blocked}</p>
      ) : null}
      {model.voided.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-[12px] text-muted">
          {model.voided.map((receipt) => (
            <li key={receipt.id} className="break-words">
              <a
                href={pdfHref(model.invoiceId, receipt, true)}
                target="_blank"
                rel="noopener"
                className="num underline underline-offset-4"
              >
                {receipt.number}
              </a>{" "}
              無効（理由: {receipt.voidReason ?? "—"}）
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
