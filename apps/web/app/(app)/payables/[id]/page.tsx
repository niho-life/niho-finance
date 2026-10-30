import {
  getPayableDetail,
  loadPayableFormOptions,
  loadPayableHistory,
  loadPaymentCandidates,
  todayInJapan,
  type PayableDetail,
} from "@niho-finance/db";
import { describePaymentTerms, PAYABLE_STATE_LABELS } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatDate, formatYenDisplay, walletLabel } from "@/lib/format";
import { PayableHistory } from "../_components/payable-history";
import { CancelPayableButton, ChangeScheduleButton } from "../_components/payable-operations";
import {
  CancelPayablePaymentButton,
  PayPayableButton,
  type PaySheetModel,
} from "../_components/payment-controls";
import { payableName, payablesListHref } from "../_lib/view";

export const metadata: Metadata = { title: "支払の詳細" };

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

function EntryLink({ entry }: { entry: { id: string; no: number } }) {
  return (
    <Link href={`/entries/${entry.id}`} className="font-bold underline underline-offset-4">
      {entryNo(entry.no)}
    </Link>
  );
}

/** The bands of the detail (25 §7.2), only the ones that apply. */
function Bands({ detail }: { detail: PayableDetail }) {
  const bands: ReactNode[] = [];
  const reregister = detail.actions.reregister ? (
    <Link
      href={`/payables/new?document=${detail.documentId}`}
      className="ml-2 font-bold underline underline-offset-4"
    >
      登録し直す
    </Link>
  ) : null;
  if (detail.document.status === "voided") {
    bands.push(
      <Band key="voided" tone="warn">
        証憑が無効です（理由: {detail.document.voidReason ?? "—"}）。
        {detail.document.replacedById ? (
          <Link
            href={`/payables/${detail.document.replacedById}`}
            className="ml-1 font-bold underline underline-offset-4"
          >
            差し替え後の支払を開く
          </Link>
        ) : (
          "一覧には出しません"
        )}
      </Band>,
    );
  }
  if (detail.overdue && detail.dueDate) {
    bands.push(
      <Band key="overdue" tone="warn">
        支払期日 {formatDate(detail.dueDate)} を {detail.overdueDays} 日過ぎています
      </Band>,
    );
  }
  if (detail.state === "partial") {
    bands.push(
      <Band key="partial">
        一部支払（支払済み {formatYenDisplay(detail.paid)} 円 / 残り{" "}
        {formatYenDisplay(detail.remaining)} 円）
      </Band>,
    );
  }
  if (detail.state === "paid") {
    const last = detail.payments.at(-1);
    bands.push(
      <Band key="paid">支払済み{last ? `（${formatDate(last.paidOn)} に支払）` : ""}</Band>,
    );
  }
  if (detail.state === "cancelled") {
    bands.push(
      <Band key="cancelled" tone="warn">
        取消（計上の仕訳 <EntryLink entry={detail.registration} /> は取消済みです
        {detail.registration.voidReason ? `。理由: ${detail.registration.voidReason}` : ""}）
        {reregister}
      </Band>,
    );
  }
  if (detail.actions.cancelBlocked) {
    bands.push(
      <Band key="cancel-blocked">
        {detail.actions.cancelBlocked}
        {detail.payments.length > 0 ? "（登録を取り消すには、支払の表の「取消」から）" : ""}
      </Band>,
    );
  }
  if (bands.length === 0) return null;
  return <div className="mb-4 flex flex-col gap-2">{bands}</div>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[12px] font-bold text-muted md:pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** 事実の表 (25 §7.2). */
function Facts({ detail }: { detail: PayableDetail }) {
  const terms = detail.partner?.paymentTerms ?? null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-card border border-border bg-surface px-4 py-4 text-[14px] md:grid-cols-[136px_minmax(0,1fr)] md:gap-y-2.5">
      <Fact label="取引先">
        {detail.partnerName || "—"}
        {terms ? (
          <span className="ml-2 text-[12px] text-muted">{describePaymentTerms(terms)}</span>
        ) : null}
      </Fact>
      <Fact label="請求書の日付">
        <span className="num">{formatDate(detail.invoiceDate)}</span>
      </Fact>
      <Fact label="支払期日">
        <span className="num">{detail.dueDate ? formatDate(detail.dueDate) : "期日なし"}</span>
      </Fact>
      <Fact label="金額（計上額）">
        <span className="num">{formatYenDisplay(detail.amount)} 円</span>
      </Fact>
      <Fact label="残り">
        <span className="num text-[20px] font-extrabold">
          {formatYenDisplay(detail.remaining > 0n ? detail.remaining : 0n)}
        </span>{" "}
        円
      </Fact>
      <Fact label="科目">
        {detail.expenses.length === 0
          ? "—"
          : detail.expenses.map((line) => (
              <span key={`${line.accountId}-${line.taxCategoryCode}`} className="block">
                {line.accountCode} {line.accountName}
                <span className="ml-2 text-[12px] text-muted">
                  {line.taxCategoryName}
                  {line.segmentName ? ` · ${line.segmentName}` : ""}
                </span>
              </span>
            ))}
      </Fact>
      <Fact label="支払元の予定">{detail.plannedWallet?.name ?? "—"}</Fact>
      <Fact label="計上の仕訳">
        <EntryLink entry={detail.registration} />
        {detail.registration.status === "voided" ? (
          <span className="ml-2 text-[12px] text-muted">取消済み</span>
        ) : null}
      </Fact>
      <Fact label="証憑">
        <span className="mr-2">{detail.document.originalName ?? "ファイル名なし"}</span>
        <a
          href={`/api/documents/${detail.document.id}/file`}
          target="_blank"
          rel="noopener"
          className="mr-3 font-bold underline underline-offset-4"
        >
          証憑を開く
        </a>
        <Link
          href={`/documents/${detail.document.id}`}
          className="text-[13px] text-muted underline underline-offset-4"
        >
          証憑の詳細を開く
        </Link>
      </Fact>
    </dl>
  );
}

const PAYMENT_COLUMNS = {
  columns: "96px minmax(0,1fr) 104px 104px 88px 80px 88px",
  mobileColumns: "minmax(0,1fr) auto",
};

/** 支払の表 (25 §7.2): the payments in force (cancelled ones no longer count, so they leave). */
function Payments({ detail }: { detail: PayableDetail }) {
  // A replacement carries the payable now: its payments are cancelled there.
  const cancellable = detail.document.replacedById === null;
  return (
    <section aria-labelledby="payable-payments" className="mt-8">
      <h2 id="payable-payments" className="mb-3 text-[15px] font-extrabold">
        支払
      </h2>
      {detail.payments.length === 0 ? (
        <p className="text-[13px] text-muted">
          支払はまだありません。「支払を登録」から明細か手入力で登録します
        </p>
      ) : (
        <Table label="支払" minWidth={680}>
          <TableHead {...PAYMENT_COLUMNS}>
            <Th>日付</Th>
            <Th>口座</Th>
            <Th align="right">出金額（円）</Th>
            <Th align="right">充当額（円）</Th>
            <Th align="right">手数料（円）</Th>
            <Th>仕訳</Th>
            <Th>操作</Th>
          </TableHead>
          {detail.payments.map((payment) => (
            <TableRow key={payment.entryId} {...PAYMENT_COLUMNS}>
              <Td sm="full">
                <span className="num">{formatDate(payment.paidOn)}</span>
                <span className="ml-2 md:hidden">{payment.wallet?.name ?? "—"}</span>
              </Td>
              <Td sm="hide" className="truncate">
                {payment.wallet?.name ?? "—"}
                {payment.walletTransactionId ? (
                  <span className="ml-1.5 text-[12px] text-muted">明細から</span>
                ) : null}
              </Td>
              <Td sm="hide" align="right">
                {formatYenDisplay(payment.amount)}
              </Td>
              <span role="cell" className="min-w-0 text-[12px] md:hidden">
                <EntryLink entry={{ id: payment.entryId, no: payment.no }} />
                {payment.fee > 0n ? (
                  <span className="ml-2 text-muted">手数料 {formatYenDisplay(payment.fee)}</span>
                ) : null}
              </span>
              <Td align="right" className="font-bold">
                {formatYenDisplay(payment.applied)}
              </Td>
              <Td sm="hide" align="right">
                {payment.fee === 0n ? "—" : formatYenDisplay(payment.fee)}
              </Td>
              <Td sm="hide" className="text-[13px]">
                <EntryLink entry={{ id: payment.entryId, no: payment.no }} />
              </Td>
              <Td sm="full" className={`text-[13px] ${cancellable ? "" : "hidden md:block"}`}>
                {cancellable ? (
                  <CancelPayablePaymentButton
                    documentId={detail.documentId}
                    entryId={payment.entryId}
                    entryNoValue={payment.no}
                    fromStatement={payment.walletTransactionId !== null}
                    remainingAfter={formatYenDisplay(
                      (detail.remaining > 0n ? detail.remaining : 0n) + payment.applied,
                    )}
                  />
                ) : null}
              </Td>
            </TableRow>
          ))}
        </Table>
      )}
    </section>
  );
}

/** 支払の詳細 (25 §7.2): the bands, the facts, the operations, the payments and the history. */
export default async function PayableDetailPage({
  params,
  searchParams,
}: PageProps<"/payables/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const prisma = await db();
  const today = todayInJapan();
  const detail = await getPayableDetail(prisma, id, { today });
  if (!detail) notFound();
  const history = await loadPayableHistory(prisma, id);
  const { actions } = detail;
  const name = payableName(detail.partnerName);

  const needsWallets = actions.pay || actions.update;
  const options = needsWallets ? await loadPayableFormOptions(prisma) : null;
  const wallets = (options?.wallets ?? []).map((wallet) => ({
    id: wallet.id,
    label: walletLabel(wallet),
    isBank: wallet.kind === "bank",
  }));
  let payModel: PaySheetModel | null = null;
  if (actions.pay) {
    const candidates = await loadPaymentCandidates(prisma, id);
    payModel = {
      documentId: id,
      name,
      remaining: detail.remaining.toString(),
      invoiceDate: detail.invoiceDate,
      today,
      plannedWalletId: detail.plannedWallet?.isActive ? detail.plannedWallet.id : null,
      wallets,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        walletId: candidate.walletId,
        walletName: candidate.walletName,
        txnDate: candidate.txnDate,
        description: candidate.description,
        amount: candidate.amount.toString(),
      })),
    };
  }

  const meta = [
    detail.overdue ? `期限超過（${detail.overdueDays} 日）` : PAYABLE_STATE_LABELS[detail.state],
    detail.dueDate ? `期日 ${formatDate(detail.dueDate)}` : "期日なし",
    `残り ${formatYenDisplay(detail.remaining > 0n ? detail.remaining : 0n)} 円`,
  ].join(" · ");

  return (
    <>
      <PageHeader
        title={<span className="wrap-anywhere">{name}</span>}
        meta={meta}
        back={{ href: payablesListHref(query.list), label: "支払" }}
        actions={
          <>
            {payModel ? <PayPayableButton model={payModel} /> : null}
            {actions.update ? (
              <ChangeScheduleButton
                documentId={id}
                name={name}
                invoiceDate={detail.invoiceDate}
                dueDate={detail.dueDate}
                walletId={detail.plannedWallet?.id ?? null}
                wallets={wallets}
              />
            ) : null}
            {actions.cancel ? (
              <CancelPayableButton
                documentId={id}
                name={name}
                registrationNo={detail.registration.no}
              />
            ) : null}
            {actions.reregister ? (
              <ButtonLink href={`/payables/new?document=${id}`} size="sm" variant="primary">
                登録し直す
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <Bands detail={detail} />
      <Facts detail={detail} />
      <Payments detail={detail} />
      <PayableHistory rows={history} />
    </>
  );
}
