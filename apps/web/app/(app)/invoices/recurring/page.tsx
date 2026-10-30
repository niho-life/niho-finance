import { listRecurringInvoices, todayInJapan } from "@niho-finance/db";
import type { Metadata } from "next";
import Link from "next/link";
import { BillingSwitch } from "@/components/app-shell/billing-switch";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatAmountDisplay, formatDate, formatYenDisplay } from "@/lib/format";

export const metadata: Metadata = { title: "定期請求" };

const COLUMNS = {
  columns: "minmax(0,1.2fr) minmax(0,1fr) 132px 112px 112px 72px",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 定期請求の一覧 (18 §14.5): 名前 ・ 取引先 ・ 周期 ・ 金額（税込）・ 次回の予定日 ・ 状態, the paused ones
 * muted; on phones 名前・次回の予定日 / 取引先・金額. Due dates without a draft are offered on top.
 */
export default async function RecurringInvoicesPage() {
  const prisma = await db();
  const list = await listRecurringInvoices(prisma, { today: todayInJapan() });
  const add = (
    <ButtonLink href="/invoices/recurring/new" size="sm" variant="primary">
      定期請求を追加
    </ButtonLink>
  );

  return (
    <>
      <PageHeader title="定期請求" meta={`有効 ${list.activeCount} 件`} actions={add} />
      <BillingSwitch current="recurring" />
      {list.dueCount > 0 ? (
        <p className="mb-4 rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
          予定日が来た定期請求があります。
          <Link
            href="/invoices/recurring/due"
            className="ml-1 font-bold underline underline-offset-4"
          >
            下書きを作る {list.dueCount} 件
          </Link>
        </p>
      ) : null}
      {list.rows.length === 0 ? (
        <EmptyState
          title="定期請求はありません"
          description="毎月同じ請求書を出すときに登録します。予定日に請求書の下書きを作ります。発行は下書きを確かめてから手で行います"
          action={add}
        />
      ) : (
        <Table label="定期請求の一覧" minWidth={720}>
          <TableHead {...COLUMNS}>
            <Th>名前</Th>
            <Th>取引先</Th>
            <Th>周期</Th>
            <Th align="right">金額（円）</Th>
            <Th>次回の予定日</Th>
            <Th>状態</Th>
          </TableHead>
          {list.rows.map((row) => (
            <TableRow
              key={row.id}
              {...COLUMNS}
              muted={!row.isActive}
              className="relative hover:bg-black/[0.02]"
            >
              <Td className="min-w-0">
                <Link
                  href={`/invoices/recurring/${row.id}`}
                  className="block truncate font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
                >
                  {row.name}
                </Link>
                <span className="block truncate text-[12px] text-muted md:hidden">
                  {row.partnerName}
                </span>
              </Td>
              <Td sm="hide" className="truncate">
                {row.partnerName}
              </Td>
              <Td sm="hide" className="text-[13px]">
                {row.scheduleLabel}
              </Td>
              <Td sm="hide" align="right" className="font-bold">
                {formatAmountDisplay(row.total)}
              </Td>
              <Td className="num text-right text-[13px] md:text-left">
                {row.isActive ? (
                  formatDate(row.nextDate)
                ) : (
                  <>
                    <span className="md:hidden">停止</span>
                    <span className="hidden md:inline">—</span>
                  </>
                )}
                <span className="block font-bold md:hidden">
                  {row.total === null ? "—" : `${formatYenDisplay(row.total)} 円`}
                </span>
              </Td>
              <Td sm="hide" className="text-[13px]">
                {row.isActive ? "有効" : "停止"}
                {row.dueCount > 0 ? (
                  <span className="block text-[11px] font-bold text-warn">
                    未作成 {row.dueCount} 件
                  </span>
                ) : null}
              </Td>
            </TableRow>
          ))}
        </Table>
      )}
    </>
  );
}
