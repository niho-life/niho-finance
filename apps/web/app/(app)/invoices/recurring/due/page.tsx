import { listDueRecurringInvoices, todayInJapan } from "@niho-finance/db";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { DueList } from "../_components/due-list";

export const metadata: Metadata = { title: "定期請求の下書き" };

/**
 * 予定日の作成 (18 §14.5): the due dates of the last 3 months without a draft, oldest first. A draft is
 * made here and issued from its detail after the owner checks it (never automatically).
 */
export default async function DueRecurringInvoicesPage() {
  const prisma = await db();
  const rows = await listDueRecurringInvoices(prisma, { today: todayInJapan() });
  return (
    <>
      <PageHeader
        title="定期請求の下書き"
        back={{ href: "/invoices/recurring", label: "定期請求" }}
      />
      {rows.length === 0 ? (
        <EmptyState
          title="下書きを作る定期請求はありません"
          description="予定日が来ると、こことホームの「やること」に出ます"
          action={
            <ButtonLink href="/invoices/recurring" size="sm">
              定期請求の一覧を開く
            </ButtonLink>
          }
        />
      ) : (
        <DueList
          rows={rows.map((row) => ({
            key: row.key,
            recurringInvoiceId: row.recurringInvoiceId,
            month: row.month,
            name: row.name,
            partnerName: row.partnerName,
            date: row.date,
            title: row.title,
            total: row.total === null ? null : row.total.toString(),
          }))}
        />
      )}
    </>
  );
}
