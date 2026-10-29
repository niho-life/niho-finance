import { loadPayableCandidates, todayInJapan } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { ApplyPaymentButton } from "../_components/apply-payment";
import { differenceText } from "../_lib/view";

export const metadata: Metadata = { title: "明細を支払に充てる" };

const COLUMNS = {
  columns: "104px minmax(0,1fr) minmax(0,1.2fr) 112px 120px 148px",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 明細から「この支払に充てる」 (25 §7.3): one outflow of the statements (S5's row menu) and the open
 * payables it can pay, the partner it names first, then the closest rest. Choosing one registers
 * the payment with the line (未払金 / 口座, an excess up to 1,100 yen as 支払手数料) and the line is
 * settled.
 */
export default async function ApplyPaymentPage({ searchParams }: PageProps<"/payables/apply">) {
  const { statement } = await searchParams;
  const lineId = typeof statement === "string" && statement.length <= 64 ? statement : null;
  if (!lineId) notFound();
  const result = await loadPayableCandidates(await db(), lineId, { today: todayInJapan() });
  if (!result) notFound();
  const { line, problem, payables } = result;
  const clientLine = {
    id: line.id,
    walletId: line.walletId,
    txnDate: line.txnDate,
    amount: line.amount.toString(),
  };
  const amount = line.amount < 0n ? -line.amount : line.amount;

  return (
    <>
      <PageHeader title="明細を支払に充てる" back={{ href: "/statements", label: "明細" }} />
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
          {formatYen(line.amount)}
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
      ) : payables.length === 0 ? (
        <EmptyState
          title="充てられる支払がありません"
          description="請求書の日付が出金日以前で、残りが出金額に近い（出金額 − 1,100 円以上の）未払を出します。受け取った請求書を未払として登録してから選びます"
          action={
            <ButtonLink href="/payables" size="sm">
              支払を開く
            </ButtonLink>
          }
        />
      ) : (
        <>
          <p className="mb-2 text-[13px] text-muted">
            明細の取引先の支払を先に、残りが出金額に近い順に出します。残りを超えた分は 1,100
            円まで振込手数料（支払手数料）にし、足りない分は一部支払として残ります
          </p>
          <Table label="充てられる支払" minWidth={820}>
            <TableHead {...COLUMNS}>
              <Th>支払期日</Th>
              <Th>取引先</Th>
              <Th>内容</Th>
              <Th align="right">残り（円）</Th>
              <Th align="right">差額（円）</Th>
              <Th />
            </TableHead>
            {payables.map((payable) => (
              <TableRow key={payable.documentId} {...COLUMNS}>
                <Td sm="hide" className="num text-[13px]">
                  <Link
                    href={`/payables/${payable.documentId}`}
                    className="underline underline-offset-4"
                  >
                    {payable.dueDate ? formatDate(payable.dueDate) : "期日なし"}
                  </Link>
                  {payable.overdue ? (
                    <span className="block text-[11px] font-bold text-warn">期限超過</span>
                  ) : null}
                </Td>
                <Td sm="full">
                  <span className="num mr-2 text-[12px] text-muted md:hidden">
                    {payable.dueDate ? formatDate(payable.dueDate) : "期日なし"}
                  </span>
                  <span className="font-semibold break-words">{payable.partnerName}</span>
                  {payable.samePartner ? (
                    <span className="ml-1.5 text-[11px] font-bold text-muted">明細の取引先</span>
                  ) : null}
                </Td>
                <Td sm="hide" className="truncate text-[13px]">
                  {payable.title}
                </Td>
                <Td align="right" label="残り">
                  {formatYen(payable.remaining)}
                </Td>
                <Td sm="hide" align="right" className="text-[13px] text-muted">
                  {differenceText(amount, payable.remaining)}
                </Td>
                <span role="cell" className="flex justify-end" data-sm="full">
                  <ApplyPaymentButton
                    line={clientLine}
                    payable={{
                      documentId: payable.documentId,
                      partnerName: payable.partnerName,
                      remaining: payable.remaining.toString(),
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
