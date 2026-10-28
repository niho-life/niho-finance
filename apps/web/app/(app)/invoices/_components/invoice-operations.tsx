"use client";

import {
  displayDate,
  INVOICE_DOC_TYPE_LABELS,
  invoiceNumberLabel,
  type CalendarDate,
  type InvoiceDocType,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, FormField, Input, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import {
  discardInvoiceDraftAction,
  issueInvoiceAction,
  markInvoiceSentAction,
  voidInvoiceAction,
  type IssuedInvoice,
} from "../actions";

/** What the operations of the detail need (no bigint: amounts come formatted). */
export interface InvoiceOperationsModel {
  id: string;
  docType: InvoiceDocType;
  /** 「請求書 INV-2026-0001」 / 「請求書（下書き）」. */
  name: string;
  partnerName: string;
  /** The partner's email: the default destination of 送付済みにする. */
  partnerEmail: string | null;
  sentTo: string | null;
  /** 合計, formatted (`138,622`). */
  totalText: string;
  issueDate: CalendarDate;
  /** The number the issue would give now (drafts). */
  plannedNumber: string | null;
  qualified: boolean;
  /** The 売掛金 entry an invoice's void reverses. */
  receivableNo: number | null;
  canEdit: boolean;
  canIssue: boolean;
  /** A draft: 発行 is shown, disabled while `canIssue` is false. */
  isDraft: boolean;
  canDiscard: boolean;
  canSend: boolean;
  canVoid: boolean;
  canCopy: boolean;
  convertTo: InvoiceDocType[];
}

/** A dialog's state: open, its pending call and the last error. */
function useDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  return {
    open,
    error,
    pending,
    setError,
    show: () => setOpen(true),
    close: () => {
      setOpen(false);
      setError(null);
    },
    run<T>(call: () => Promise<ActionResult<T>>, onDone: (data: T) => void) {
      startTransition(async () => {
        const result = await call();
        if (!result.ok) {
          setError(result);
          return;
        }
        setError(null);
        setOpen(false);
        onDone(result.data);
      });
    },
  };
}

const REASON_REQUIRED = "理由を入力してください";

function Facts({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[14px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="num min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 発行 (18 §9.3): the confirmation tells the planned number, the form and the 売掛金 entry. */
function IssueButton({ model }: { model: InvoiceOperationsModel }) {
  const router = useRouter();
  const toast = useToast();
  const dialog = useDialog();
  const typeLabel = INVOICE_DOC_TYPE_LABELS[model.docType];
  return (
    <>
      <Button variant="primary" size="sm" disabled={!model.canIssue} onClick={dialog.show}>
        発行
      </Button>
      <ConfirmDialog
        open={dialog.open}
        title={`${typeLabel}を発行します`}
        confirmLabel="発行"
        pending={dialog.pending}
        error={formLevelErrors(dialog.error, () => false).join(" / ") || null}
        onCancel={dialog.close}
        onConfirm={() =>
          dialog.run(
            () => issueInvoiceAction(model.id),
            (data: IssuedInvoice) => {
              if (data.pdfDocumentId) {
                toast(`${invoiceNumberLabel(data.number)} を発行し、PDF を証憑に保存しました`);
              } else {
                toast(
                  `${invoiceNumberLabel(data.number)} を発行しました。PDF は証憑に保存できませんでした。詳細の「PDF を証憑に保存」から保存し直します`,
                  { tone: "error" },
                );
              }
              router.refresh();
            },
          )
        }
      >
        <Facts
          rows={[
            ["取引先", model.partnerName],
            ["合計", `${model.totalText} 円`],
            [
              "番号",
              model.plannedNumber
                ? `${model.plannedNumber}（予定。発行の時点で確定します）`
                : "発行の時点で付きます",
            ],
            ["様式", model.qualified ? "適格請求書" : "区分記載請求書"],
          ]}
        />
        {model.docType === "invoice" ? (
          <p className="mt-3">
            <span className="num font-bold">{displayDate(model.issueDate)}</span> 付で 売掛金{" "}
            <span className="num font-bold">{model.totalText}</span> 円 / 売上 を計上します。
          </p>
        ) : null}
        <p className="mt-2 text-[13px] text-muted">発行した書類は書き換えられません。</p>
      </ConfirmDialog>
    </>
  );
}

/** 送付済みにする (18 §9.3): the destination is optional (the partner's email first). */
function SendButton({ model }: { model: InvoiceOperationsModel }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const dialog = useDialog();
  const [sentTo, setSentTo] = useState(model.partnerEmail ?? model.sentTo ?? "");
  return (
    <>
      <Button size="sm" onClick={dialog.show}>
        送付済みにする
      </Button>
      <ConfirmDialog
        open={dialog.open}
        title={`${model.name} を送付済みにします`}
        confirmLabel="送付済みにする"
        pending={dialog.pending}
        error={formLevelErrors(dialog.error, (field) => field === "sentTo").join(" / ") || null}
        onCancel={dialog.close}
        onConfirm={() =>
          dialog.run(
            () => markInvoiceSentAction(model.id, { sentTo }),
            () => {
              toast(`${model.name} を送付済みにしました`);
              router.refresh();
            },
          )
        }
      >
        <p>送付した日時と宛先を記録します。</p>
        <div className="mt-3">
          <FormField
            label="宛先"
            htmlFor={`${id}-sent-to`}
            help="メールアドレスや送付の方法（任意）"
            error={dialog.error?.fieldErrors.sentTo}
          >
            <Input
              id={`${id}-sent-to`}
              value={sentTo}
              maxLength={200}
              onChange={(event) => setSentTo(event.currentTarget.value)}
            />
          </FormField>
        </div>
      </ConfirmDialog>
    </>
  );
}

/**
 * 無効にする (18 §9.3): the reason is required; an invoice's 売掛金 entry is reversed. With 「複製して
 * 新しい下書きを作る」 the new form opens on a copy.
 */
function VoidButton({ model }: { model: InvoiceOperationsModel }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const dialog = useDialog();
  const [reason, setReason] = useState("");
  const [copy, setCopy] = useState(false);

  useEffect(() => {
    if (dialog.open) document.getElementById(`${id}-reason`)?.focus();
  }, [dialog.open, id]);

  function confirm() {
    if (reason.trim() === "") {
      dialog.setError({
        ok: false,
        error: REASON_REQUIRED,
        fieldErrors: { reason: REASON_REQUIRED },
      });
      return;
    }
    dialog.run(
      () => voidInvoiceAction(model.id, { reason }),
      () => {
        toast(`${model.name} を無効にしました`);
        if (copy) router.push(`/invoices/new?copy=${model.id}`);
        else router.refresh();
      },
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger! hover:text-danger!"
        onClick={dialog.show}
      >
        無効にする
      </Button>
      <ConfirmDialog
        open={dialog.open}
        title={`${model.name} を無効にします`}
        confirmLabel="無効にする"
        variant="danger"
        pending={dialog.pending}
        error={formLevelErrors(dialog.error, (field) => field === "reason").join(" / ") || null}
        onCancel={dialog.close}
        onConfirm={confirm}
      >
        {model.receivableNo !== null ? (
          <p>
            売掛金の仕訳 {entryNo(model.receivableNo)} を反対仕訳で取り消します（
            <span className="num">{displayDate(model.issueDate)}</span>{" "}
            付。締め済みなら開いている最初の日付）。
          </p>
        ) : null}
        <p className={model.receivableNo !== null ? "mt-2" : ""}>
          番号は残り、書類は無効として一覧に残ります。直すときは複製して発行し直します。
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <FormField
            label="理由"
            htmlFor={`${id}-reason`}
            required
            error={dialog.error?.fieldErrors.reason}
          >
            <Textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={500}
              onChange={(event) => {
                setReason(event.currentTarget.value);
                if (dialog.error?.fieldErrors.reason) dialog.setError(null);
              }}
            />
          </FormField>
          <Checkbox
            id={`${id}-copy`}
            label="複製して新しい下書きを作る"
            checked={copy}
            onChange={(event) => setCopy(event.currentTarget.checked)}
          />
        </div>
      </ConfirmDialog>
    </>
  );
}

/** 破棄 of a draft (18 §9.3): it leaves the list; back to the list after. */
function DiscardButton({ model }: { model: InvoiceOperationsModel }) {
  const router = useRouter();
  const toast = useToast();
  const dialog = useDialog();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger! hover:text-danger!"
        onClick={dialog.show}
      >
        破棄
      </Button>
      <ConfirmDialog
        open={dialog.open}
        title="下書きを破棄します"
        confirmLabel="破棄"
        variant="danger"
        pending={dialog.pending}
        error={formLevelErrors(dialog.error, () => false).join(" / ") || null}
        onCancel={dialog.close}
        onConfirm={() =>
          dialog.run(
            () => discardInvoiceDraftAction(model.id),
            () => {
              toast("下書きを破棄しました");
              router.push("/invoices");
            },
          )
        }
      >
        <p>{model.name} は一覧から消え、元に戻せません。</p>
      </ConfirmDialog>
    </>
  );
}

/**
 * The operations of the detail (18 §9.3), by state: a draft 編集 / 発行 / 破棄; an issued document
 * its conversions, 送付済みにする, 複製 and 無効にする; a void one 複製. The page shows 入金を登録
 * (the sheet) before these for an invoice.
 */
export function InvoiceOperations({ model }: { model: InvoiceOperationsModel }) {
  return (
    <>
      {model.canEdit ? (
        <ButtonLink href={`/invoices/${model.id}/edit`} size="sm">
          編集
        </ButtonLink>
      ) : null}
      {model.isDraft ? <IssueButton model={model} /> : null}
      {model.convertTo.map((type) => (
        <ButtonLink key={type} href={`/invoices/new?type=${type}&from=${model.id}`} size="sm">
          {INVOICE_DOC_TYPE_LABELS[type]}を作る
        </ButtonLink>
      ))}
      {model.canSend ? <SendButton model={model} /> : null}
      {model.canCopy ? (
        <ButtonLink href={`/invoices/new?copy=${model.id}`} size="sm" variant="ghost">
          複製
        </ButtonLink>
      ) : null}
      {model.canVoid ? <VoidButton model={model} /> : null}
      {model.canDiscard ? <DiscardButton model={model} /> : null}
    </>
  );
}
