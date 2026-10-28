import {
  invoicesFilterSchema,
  listInvoices,
  loadCurrentFiscalYear,
  loadInvoiceFormOptions,
  todayInJapan,
} from "@niho-finance/db";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { db } from "@/lib/data";
import { InvoicesFilter } from "./_components/invoices-filter";
import { InvoicesTable } from "./_components/invoices-table";
import { invoicesQuery } from "./_components/list-query";

export const metadata: Metadata = { title: "請求" };

/** 請求 (18 §7): 見積書・納品書・請求書, the overdue invoices first, narrowed by the URL. */
export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const filters = invoicesFilterSchema.parse(await searchParams);
  const prisma = await db();
  const today = todayInJapan();
  const fiscalYear = await loadCurrentFiscalYear(prisma, today);
  const result = await listInvoices(prisma, filters, filters.page, { today });
  const options = await loadInvoiceFormOptions(prisma, {
    includeIds: filters.partner ? [filters.partner] : [],
  });
  const narrowed = Boolean(
    filters.type !== "invoice" || filters.status !== "open" || filters.partner || filters.q,
  );
  const listQuery = invoicesQuery({ ...filters, page: result.page });
  const create = (
    <>
      <ButtonLink href="/invoices/new?type=invoice" size="sm">
        請求書
      </ButtonLink>
      <ButtonLink href="/invoices/new?type=quote" size="sm">
        見積書
      </ButtonLink>
    </>
  );

  return (
    <>
      <PageHeader
        title="請求"
        meta={fiscalYear ? `第 ${fiscalYear.no} 期` : undefined}
        actions={
          <>
            {create}
            <ButtonLink href="/invoices/new?type=delivery" size="sm">
              納品書
            </ButtonLink>
            <ButtonLink href="/invoices/settings" size="sm" variant="ghost">
              設定
            </ButtonLink>
          </>
        }
      />
      <InvoicesFilter
        key={listQuery}
        values={{
          type: filters.type,
          status: filters.status,
          partner: filters.partner ?? "",
          q: filters.q ?? "",
        }}
        partners={options.partners.map((partner) => ({
          value: partner.id,
          label: partner.isActive ? partner.name : `${partner.name}（無効）`,
        }))}
        filtered={narrowed}
      />
      {result.total === 0 ? (
        narrowed ? (
          <EmptyState
            title="条件に合う書類がありません"
            description="絞り込みを変えるか、外してください"
            action={
              <ButtonLink href="/invoices" size="sm">
                絞り込みを外す
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState title="請求書がありません。見積書か請求書から作ります" action={create} />
        )
      ) : (
        <>
          {result.truncated ? (
            <p className="mb-3 rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] text-warn">
              条件に合う書類が多いため、新しい {result.total.toLocaleString("ja-JP")}{" "}
              件だけを出しています。取引先や状態で絞り込んでください
            </p>
          ) : null}
          <InvoicesTable rows={result.rows} listQuery={listQuery} />
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            href={(page) => {
              const search = invoicesQuery({ ...filters, page });
              return search ? `/invoices?${search}` : "/invoices";
            }}
          />
        </>
      )}
    </>
  );
}
