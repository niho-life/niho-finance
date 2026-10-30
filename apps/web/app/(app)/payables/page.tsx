import {
  listPartners,
  listPayables,
  payablesFilterSchema,
  todayInJapan,
  type PayableTotals,
} from "@niho-finance/db";
import type { Metadata } from "next";
import { BillingSwitch } from "@/components/app-shell/billing-switch";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { db } from "@/lib/data";
import { formatYenDisplay } from "@/lib/format";
import { PayablesFilter } from "./_components/payables-filter";
import { PayablesTable } from "./_components/payables-table";
import { payablesQuery } from "./_lib/view";

export const metadata: Metadata = { title: "支払" };

function Figure({
  label,
  totals,
  warn = false,
}: {
  label: string;
  totals: PayableTotals;
  /** Shown in the warn colour when there is something in it (期限超過). */
  warn?: boolean;
}) {
  const alert = warn && totals.count > 0;
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-card border border-border bg-surface px-4 py-3">
      <span className="text-[12px] font-bold text-muted">{label}</span>
      <span className={`num text-[20px] font-extrabold ${alert ? "text-warn" : ""}`}>
        {formatYenDisplay(totals.amount)}
        <span className="ml-1 text-[13px] font-semibold text-muted">円</span>
      </span>
      <span className={`text-[12px] ${alert ? "font-bold text-warn" : "text-muted"}`}>
        {totals.count} 件
      </span>
    </div>
  );
}

/**
 * 支払 (25 §6): received invoices still to pay, the overdue ones first, narrowed by the URL; above
 * them 未払の合計・7 日以内に支払う・期限超過 (over every open payable).
 */
export default async function PayablesPage({ searchParams }: PageProps<"/payables">) {
  const filters = payablesFilterSchema.parse(await searchParams);
  const prisma = await db();
  const today = todayInJapan();
  const result = await listPayables(prisma, filters, filters.page, { today });
  const partners = (await listPartners(prisma)).filter(
    (partner) => partner.isActive || partner.id === filters.partner,
  );
  const narrowed = Boolean(
    filters.status !== "open" || filters.partner || filters.q || filters.view !== "due",
  );
  const listQuery = payablesQuery({ ...filters, page: result.page });
  const { summary } = result;
  const create = (
    <ButtonLink href="/payables/new" size="sm" variant="primary">
      受領した請求書を登録
    </ButtonLink>
  );

  return (
    <>
      <PageHeader
        title="支払"
        meta={`未払 ${summary.open.count} 件 · ${formatYenDisplay(summary.open.amount)} 円`}
        actions={create}
      />
      <BillingSwitch current="payables" />
      <section aria-label="支払の集計" className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Figure label="未払の合計" totals={summary.open} />
        <Figure label="7 日以内に支払う" totals={summary.dueSoon} />
        <Figure label="期限超過" totals={summary.overdue} warn />
      </section>
      <PayablesFilter
        key={listQuery}
        values={{
          status: filters.status,
          partner: filters.partner ?? "",
          view: filters.view,
          q: filters.q ?? "",
        }}
        partners={partners.map((partner) => ({
          value: partner.id,
          label: partner.isActive ? partner.name : `${partner.name}（無効）`,
        }))}
        filtered={narrowed}
      />
      {result.total === 0 ? (
        filters.status !== "open" || filters.partner || filters.q ? (
          <EmptyState
            title="条件に合う支払はありません"
            description="絞り込みを変えるか、外してください"
            action={
              <ButtonLink href="/payables" size="sm">
                絞り込みを外す
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState
            title="未払の請求書はありません"
            description="受け取った請求書を 証憑 に保存してから登録します"
            action={create}
          />
        )
      ) : (
        <>
          <PayablesTable rows={result.rows} groups={result.groups} listQuery={listQuery} />
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            href={(page) => {
              const search = payablesQuery({ ...filters, page });
              return search ? `/payables?${search}` : "/payables";
            }}
          />
        </>
      )}
    </>
  );
}
