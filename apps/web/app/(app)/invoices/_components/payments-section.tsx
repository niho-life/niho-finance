import type { InvoiceDetail } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import Link from "next/link";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { entryNo, formatDate } from "@/lib/format";
import { CancelPaymentButton } from "./payment-controls";

const COLUMNS = {
  columns: "88px minmax(0,1fr) 104px 88px 104px 84px minmax(88px,0.8fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 入金 of an invoice (18 §9.4): the balance, then each payment (日付 ・ 口座 ・ 入金額 ・ 手数料 ・
 * 充当額 ・ 仕訳 No. ・ 取消). A cancelled payment stays, muted, with its reason.
 */
export function PaymentsSection({ detail }: { detail: InvoiceDetail }) {
  const balance = detail.balance ?? 0n;
  const cancellable = detail.status !== "void";
  return (
    <section aria-labelledby="invoice-payments" className="mt-8">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id="invoice-payments" className="text-[15px] font-extrabold">
          入金
        </h2>
        <p className="text-[13px] text-muted">
          残高{" "}
          <span className="num text-[24px] font-extrabold text-text">{formatYen(balance)}</span> 円
        </p>
      </div>
      {detail.payments.length === 0 ? (
        <p className="text-[13px] text-muted">
          入金はまだありません。「入金を登録」から明細か手入力で登録します
        </p>
      ) : (
        <Table label="入金" minWidth={720}>
          <TableHead {...COLUMNS}>
            <Th>日付</Th>
            <Th>口座</Th>
            <Th align="right">入金額（円）</Th>
            <Th align="right">手数料（円）</Th>
            <Th align="right">充当額（円）</Th>
            <Th>仕訳</Th>
            <Th>操作</Th>
          </TableHead>
          {detail.payments.map((payment) => (
            <TableRow key={payment.id} {...COLUMNS} muted={payment.cancelled}>
              <Td sm="full">
                <span className="num">{formatDate(payment.paidOn)}</span>
                <span className="ml-2 md:hidden">{payment.walletName}</span>
              </Td>
              <Td sm="hide" className="truncate">
                {payment.walletName}
              </Td>
              <Td sm="hide" align="right">
                {formatYen(payment.amount)}
              </Td>
              <Td sm="hide" align="right">
                {payment.fee === 0n ? "—" : formatYen(payment.fee)}
              </Td>
              <span role="cell" className="min-w-0 text-[12px] md:hidden">
                {payment.journalEntry ? (
                  <Link
                    href={`/entries/${payment.journalEntry.id}`}
                    className="font-bold underline underline-offset-4"
                  >
                    {entryNo(payment.journalEntry.no)}
                  </Link>
                ) : null}
                {payment.fee > 0n ? (
                  <span className="ml-2 text-muted">手数料 {formatYen(payment.fee)}</span>
                ) : null}
                {payment.cancelled ? (
                  <span className="block text-muted">
                    取消済み（{payment.cancelReason ?? "—"}）
                  </span>
                ) : null}
              </span>
              <Td align="right" className="font-bold">
                {formatYen(payment.applied)}
              </Td>
              <Td sm="hide" className="text-[13px]">
                {payment.journalEntry ? (
                  <Link
                    href={`/entries/${payment.journalEntry.id}`}
                    className="font-bold underline underline-offset-4"
                  >
                    {entryNo(payment.journalEntry.no)}
                  </Link>
                ) : (
                  "—"
                )}
              </Td>
              <Td
                sm="full"
                className={`text-[13px] ${payment.cancelled || !cancellable ? "hidden md:block" : ""}`}
              >
                {payment.cancelled ? (
                  <>取消済み（{payment.cancelReason ?? "—"}）</>
                ) : cancellable ? (
                  <CancelPaymentButton
                    invoiceId={detail.id}
                    paymentId={payment.id}
                    entryNoValue={payment.journalEntry?.no ?? null}
                    balanceAfter={formatYen(balance + payment.applied)}
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
