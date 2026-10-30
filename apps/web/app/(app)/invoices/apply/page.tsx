import { loadInvoicesForDeposit, todayInJapan } from "@niho-finance/db";
import { invoiceNumberLabel } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate, formatYenDisplay } from "@/lib/format";
import { ApplyDepositButton } from "../_components/apply-deposit";

export const metadata: Metadata = { title: "明細を請求に充てる" };

const COLUMNS = {
  columns: "128px minmax(0,1fr) minmax(0,1.2fr) 96px 112px 96px 148px",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 明細から「この請求に充てる」 (18 §9.4): one deposit of the statements (S5's row menu) and the
 * issued invoices it can pay, the closest balance first. Choosing one registers the payment with
 * the line (普通預金 / 売掛金, a shortfall as 支払手数料) and the line is settled.
 */
export default async function ApplyDepositPage({ searchParams }: PageProps<"/invoices/apply">) {
  const { statement } = await searchParams;
  const lineId = typeof statement === "string" && statement.length <= 64 ? statement : null;
  if (!lineId) notFound();
  const result = await loadInvoicesForDeposit(await db(), lineId, { today: todayInJapan() });
  if (!result) notFound();
  const { line, problem, invoices } = result;
  const clientLine = {
    id: line.id,
    walletId: line.walletId,
    txnDate: line.txnDate,
    amount: line.amount.toString(),
  };

  return (
    <>
      <PageHeader title="明細を請求に充てる" back={{ href: "/statements", label: "明細" }} />
      <section
        aria-label="充てる明細"
        className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border pb-4"
      >
        <div className="min-w-0">
          <p className="num text-[13px] text-muted">
            {formatDate(line.txnDate)} · {line.walletName}
          </p>
          <p className="font-bold break-words">{line.description}</p>
          {line.counterparty ? (
            <p className="text-[13px] break-words text-muted">{line.counterparty}</p>
          ) : null}
        </div>
        <p className="num text-[24px] font-extrabold">
          {formatYenDisplay(line.amount)}
          <span className="ml-1 text-[14px] font-semibold text-muted">円</span>
        </p>
      </section>

      {problem ? (
        <p className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
          {problem}
          <Link href="/statements" className="ml-2 font-bold underline underline-offset-4">
            明細へ戻る
          </Link>
        </p>
      ) : invoices.length === 0 ? (
        <EmptyState
          title="充てられる請求書がありません"
          description="発行日が入金日以前で、残高が入金額以上の請求書を出します。請求書を発行してから選びます"
          action={
            <ButtonLink href="/invoices" size="sm">
              請求を開く
            </ButtonLink>
          }
        />
      ) : (
        <>
          <p className="mb-2 text-[13px] text-muted">
            残高が入金額に近い順です。差額は振込手数料（支払手数料）か、一部入金として残せます
          </p>
          <Table label="充てられる請求書" minWidth={860}>
            <TableHead {...COLUMNS}>
              <Th>番号</Th>
              <Th>取引先</Th>
              <Th>件名</Th>
              <Th>支払期限</Th>
              <Th align="right">残高（円）</Th>
              <Th align="right">差額（円）</Th>
              <Th />
            </TableHead>
            {invoices.map((invoice) => (
              <TableRow key={invoice.id} {...COLUMNS}>
                <Td sm="hide">
                  <Link
                    href={`/invoices/${invoice.id}`}
                    className="num font-bold underline underline-offset-4"
                  >
                    {invoiceNumberLabel(invoice.number)}
                  </Link>
                </Td>
                <Td sm="full">
                  <span className="num mr-2 text-[12px] text-muted md:hidden">
                    {invoiceNumberLabel(invoice.number)}
                  </span>
                  <span className="font-semibold break-words">{invoice.partnerName}</span>
                </Td>
                <Td sm="hide" className="truncate text-[13px]">
                  {invoice.title ?? "—"}
                </Td>
                <Td sm="hide" className="num text-[13px]">
                  {formatDate(invoice.dueDate)}
                  {invoice.overdue ? (
                    <span className="block text-[11px] font-bold text-warn">期限超過</span>
                  ) : null}
                </Td>
                <Td align="right" label="残高">
                  {formatYenDisplay(invoice.balance)}
                </Td>
                <Td sm="hide" align="right" className="text-muted">
                  {invoice.difference === 0n ? "一致" : formatYenDisplay(invoice.difference)}
                </Td>
                <span role="cell" className="flex justify-end" data-sm="full">
                  <ApplyDepositButton
                    line={clientLine}
                    invoice={{
                      id: invoice.id,
                      number: invoice.number,
                      partnerName: invoice.partnerName,
                      balance: invoice.balance.toString(),
                      difference: invoice.difference.toString(),
                    }}
                  />
                </span>
              </TableRow>
            ))}
          </Table>
        </>
      )}
    </>
  );
}
