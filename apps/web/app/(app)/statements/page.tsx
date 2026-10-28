import {
  listWalletTransactions,
  loadEntryFormOptions,
  statementsFilterSchema,
  todayInJapan,
} from "@niho-finance/db";
import { dateParts } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { db } from "@/lib/data";
import { FilterBar } from "./_components/filter-bar";
import { statementsHref, statementsQuery } from "./_components/list-query";
import type { ClientStatementRow } from "./_components/model";
import { StatementsList } from "./_components/statements-list";

export const metadata: Metadata = { title: "明細" };

/**
 * 明細 (15 §3): the imported lines of one state, narrowed by wallet and search, settled in the row
 * (登録・振替・無視) with the mouse or the keyboard. The URL's parameters are the state.
 */
export default async function StatementsPage({ searchParams }: PageProps<"/statements">) {
  const filters = statementsFilterSchema.parse(await searchParams);
  const prisma = await db();
  const page = await listWalletTransactions(prisma, filters);
  // The names of what the chips and results refer to, inactive ones included.
  const referenced = page.rows.flatMap((row) => {
    const suggestion = row.suggestion;
    return [
      suggestion?.accountId,
      suggestion?.taxCategoryCode,
      suggestion?.partnerId,
      suggestion?.segmentId,
      suggestion?.transferToWalletId,
      ...row.candidates.map((candidate) => candidate.walletId),
    ].flatMap((id) => (id ? [id] : []));
  });
  const options = await loadEntryFormOptions(prisma, { includeIds: referenced });
  const narrowed = Boolean(filters.wallet || filters.q || filters.by);
  const listQuery = statementsQuery({ ...filters, page: page.page });

  const rows: ClientStatementRow[] = page.rows.map(
    ({ amount, candidates, settledAt: _settledAt, ...row }) => ({
      ...row,
      amount: String(amount),
      candidates: candidates.map((candidate) => ({
        ...candidate,
        amount: String(candidate.amount),
      })),
    }),
  );

  return (
    <>
      <PageHeader title="明細" meta={`未処理 ${page.pendingTotal.toLocaleString("ja-JP")} 件`} />
      <FilterBar filters={filters} page={page} narrowed={narrowed} />
      <StatementsList
        key={listQuery}
        rows={rows}
        status={filters.status}
        options={{
          accounts: options.accounts,
          taxCategories: options.taxCategories,
          partners: options.partners,
          segments: options.segments,
          wallets: options.wallets,
          fiscalYears: options.fiscalYears,
        }}
        thisYear={dateParts(todayInJapan()).year}
        empty={
          narrowed ? (
            <EmptyState
              title="条件に合う明細がありません"
              description="口座・検索・絞り込みを変えるか、外してください"
              action={
                <ButtonLink href={statementsHref({ status: filters.status })} size="sm">
                  絞り込みを外す
                </ButtonLink>
              }
            />
          ) : filters.status === "pending" ? (
            <EmptyState
              title="未処理の明細はありません"
              description="取り込んだ明細はここに並びます。取込は明細の取込（準備中）から"
            />
          ) : (
            <EmptyState title="この状態の明細はありません" />
          )
        }
      />
      {page.total > 0 ? (
        <Pagination
          page={page.page}
          pageCount={page.pageCount}
          total={page.total}
          href={(target) => statementsHref({ ...filters, page: target })}
        />
      ) : null}
    </>
  );
}
