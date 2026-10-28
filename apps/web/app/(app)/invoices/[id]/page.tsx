import {
  getInvoiceDetail,
  loadDepositCandidates,
  loadInvoiceFormOptions,
  loadInvoiceHistory,
  todayInJapan,
  type InvoiceDetail,
  type InvoiceRef,
} from "@niho-finance/db";
import { formatYen, INVOICE_STATUS_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { entryNo, formatDate } from "@/lib/format";
import { InvoiceChecklistView } from "../_components/invoice-checklist";
import { InvoiceDocument } from "../_components/invoice-document";
import { InvoiceHistory } from "../_components/invoice-history";
import { InvoiceOperations, type InvoiceOperationsModel } from "../_components/invoice-operations";
import { documentName, listHref } from "../_components/list-query";
import { RecordPaymentButton, type PaymentSheetModel } from "../_components/payment-controls";
import { PaymentsSection } from "../_components/payments-section";
import { SavePdfButton } from "../_components/save-pdf-button";

export const metadata: Metadata = { title: "請求の詳細" };

function Band({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p
      className={`rounded-lg px-3.5 py-2.5 text-[14px] ${
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-text"
      }`}
    >
      {children}
    </p>
  );
}

function DocumentLink({ document }: { document: InvoiceRef }) {
  return (
    <Link href={`/invoices/${document.id}`} className="font-bold underline underline-offset-4">
      {documentName(document)}
    </Link>
  );
}

function EntryLink({ entry }: { entry: { id: string; no: number } }) {
  return (
    <Link href={`/entries/${entry.id}`} className="font-bold underline underline-offset-4">
      {entryNo(entry.no)}
    </Link>
  );
}

/** The bands of the detail (18 §9.1), only the ones that apply. */
function Bands({ detail, blockedEdit }: { detail: InvoiceDetail; blockedEdit: boolean }) {
  const bands: ReactNode[] = [];
  const { actions } = detail;
  if (blockedEdit && actions.blocked.edit) {
    bands.push(
      <Band key="blocked-edit" tone="warn">
        {actions.blocked.edit}
      </Band>,
    );
  }
  if (detail.status === "draft") {
    bands.push(
      <Band key="draft">
        {detail.docType === "invoice"
          ? "発行すると番号が確定し、請求書は売掛金を計上します"
          : "発行すると番号が確定します"}
      </Band>,
    );
    if (actions.blocked.issue) {
      bands.push(
        <Band key="issue" tone="warn">
          発行できません。{actions.blocked.issue}
        </Band>,
      );
    }
  }
  if (detail.status === "void") {
    const discarded = detail.issuedAt === null;
    bands.push(
      <Band key="void">
        {discarded ? "破棄した下書きです" : `無効（理由: ${detail.voidReason ?? "—"}）。`}
        {!discarded && detail.journalEntry?.reversal ? (
          <>
            反対仕訳 <EntryLink entry={detail.journalEntry.reversal} />
          </>
        ) : null}
      </Band>,
    );
  }
  // 発行した PDF の写し (18 §11): kept as a 証憑, or offered again when saving it failed.
  if (detail.pdfDocumentId) {
    bands.push(
      <Band key="pdf">
        発行した PDF を証憑に保存しました（
        <Link
          href={`/documents/${detail.pdfDocumentId}`}
          className="font-bold underline underline-offset-4"
        >
          証憑を開く
        </Link>
        ）
      </Band>,
    );
  } else if (detail.status === "issued" || detail.status === "sent" || detail.status === "paid") {
    bands.push(
      <Band key="pdf" tone="warn">
        <span className="mr-3">発行した PDF がまだ証憑に保存されていません</span>
        <SavePdfButton invoiceId={detail.id} />
      </Band>,
    );
  }
  if (detail.overdue && detail.dueDate) {
    bands.push(
      <Band key="overdue" tone="warn">
        支払期限 {formatDate(detail.dueDate)} を {detail.overdueDays} 日過ぎています
      </Band>,
    );
  }
  if (detail.status === "paid" && detail.paidOn) {
    bands.push(<Band key="paid">{formatDate(detail.paidOn)} に入金済み</Band>);
  }
  if (detail.source) {
    bands.push(
      <Band key="source">
        <DocumentLink document={detail.source} /> から作成
      </Band>,
    );
  }
  for (const converted of detail.convertedTo) {
    bands.push(
      <Band key={`converted-${converted.id}`}>
        → <DocumentLink document={converted} />
        {converted.status === "void" ? "（無効）" : ""}
      </Band>,
    );
  }
  if (detail.journalEntry && detail.status !== "void") {
    bands.push(
      detail.journalEntry.voided ? (
        <Band key="entry" tone="warn">
          売掛金の仕訳 <EntryLink entry={detail.journalEntry} />{" "}
          は取消済みです。書類を無効にして、必要なら複製して発行し直してください
        </Band>
      ) : (
        <Band key="entry">
          売掛金の仕訳 <EntryLink entry={detail.journalEntry} />
        </Band>
      ),
    );
  }
  const paymentsInForce = detail.payments.some((payment) => !payment.cancelled);
  if ((detail.status === "issued" || detail.status === "sent") && paymentsInForce) {
    bands.push(
      <Band key="void-blocked">
        入金が残っているため無効にできません。無効にするには、先に入金を取り消します
      </Band>,
    );
  }
  if (detail.status !== "void") {
    bands.push(
      <Band key="form">
        {detail.qualified
          ? "適格請求書"
          : detail.issuer.invoiceRegistrationNumber
            ? "区分記載請求書"
            : "区分記載請求書（登録番号なし）"}
      </Band>,
    );
  }
  if (bands.length === 0) return null;
  return <div className="mb-4 flex flex-col gap-2">{bands}</div>;
}

/** 請求の詳細 (18 §9): the bands, the document, the operations, the payments and the history. */
export default async function InvoiceDetailPage({
  params,
  searchParams,
}: PageProps<"/invoices/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const prisma = await db();
  const today = todayInJapan();
  const detail = await getInvoiceDetail(prisma, id, { today });
  if (!detail) notFound();
  const history = await loadInvoiceHistory(prisma, id);
  const { actions } = detail;
  const name = documentName(detail);
  const issued = detail.issuedAt !== null;

  let paymentModel: PaymentSheetModel | null = null;
  if (actions.canPay) {
    const options = await loadInvoiceFormOptions(prisma);
    const candidates = await loadDepositCandidates(prisma, id);
    paymentModel = {
      invoiceId: id,
      name,
      balance: (detail.balance ?? 0n).toString(),
      issueDate: detail.issueDate,
      today,
      wallets: options.wallets.map((wallet) => ({
        id: wallet.id,
        label: `${wallet.name}（${
          wallet.subAccountName
            ? `${wallet.accountName} / ${wallet.subAccountName}`
            : wallet.accountName
        }）`,
        isBank: wallet.kind === "bank",
      })),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        walletId: candidate.walletId,
        walletName: candidate.walletName,
        txnDate: candidate.txnDate,
        description: candidate.description,
        amount: candidate.amount.toString(),
        difference: candidate.difference.toString(),
      })),
    };
  }

  const operations: InvoiceOperationsModel = {
    id: detail.id,
    docType: detail.docType,
    name,
    partnerName: detail.recipient.name,
    partnerEmail: detail.recipient.email,
    sentTo: detail.sentTo,
    totalText: formatYen(detail.total),
    issueDate: detail.issueDate,
    plannedNumber: detail.plannedNumber,
    qualified: detail.qualified,
    receivableNo:
      detail.journalEntry && !detail.journalEntry.voided ? detail.journalEntry.no : null,
    canEdit: actions.canEdit,
    canIssue: actions.canIssue,
    isDraft: detail.status === "draft",
    canDiscard: actions.canDiscard,
    canSend: actions.canSend,
    canVoid: actions.canVoid,
    canCopy: detail.status !== "draft",
    convertTo: actions.convertTo,
  };

  const meta = [
    INVOICE_STATUS_LABELS[detail.status],
    issued ? `${formatDate(detail.issueDate)} 発行` : `発行日 ${formatDate(detail.issueDate)}`,
    detail.recipient.name,
  ].join(" · ");

  return (
    <>
      <PageHeader
        title={name}
        meta={meta}
        back={{ href: listHref(query.list), label: "請求" }}
        actions={
          <>
            {paymentModel ? <RecordPaymentButton model={paymentModel} /> : null}
            <InvoiceOperations model={operations} />
            {/* プレビューは PDF そのもの (18 §11): drawn from the stored document, in a new tab. */}
            <a
              href={`/invoices/${detail.id}/pdf`}
              target="_blank"
              rel="noopener"
              className={buttonClass({ size: "sm", variant: "ghost" })}
            >
              PDF
            </a>
          </>
        }
      />
      <Bands detail={detail} blockedEdit={query.blocked === "edit"} />
      <InvoiceDocument detail={detail} />
      {detail.checklist ? (
        <div className="mt-6">
          <InvoiceChecklistView
            checklist={detail.checklist}
            note="不備があるうちは発行できません。編集で直してください"
          />
        </div>
      ) : null}
      {detail.docType === "invoice" && issued ? <PaymentsSection detail={detail} /> : null}
      <InvoiceHistory rows={history} />
    </>
  );
}
