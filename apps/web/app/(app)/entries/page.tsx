import {
  entriesFilterSchema,
  listJournalEntries,
  loadCurrentFiscalYear,
  loadEntryFormOptions,
  todayInJapan,
} from "@niho-finance/db";
import { addDays, dateParts, lastDayOfMonth, type CalendarDate } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { db } from "@/lib/data";
import { EntriesFilter, type PeriodPresets } from "./_components/entries-filter";
import { EntriesTable } from "./_components/entries-table";
import { entriesQuery } from "./_components/list-query";

export const metadata: Metadata = { title: "取引" };

function monthOf(date: CalendarDate): { from: CalendarDate; to: CalendarDate } {
  const { year, month } = dateParts(date);
  const to = lastDayOfMonth(year, month);
  return { from: `${to.slice(0, 8)}01` as CalendarDate, to };
}

/** 取引 (11 §3): the journal of the period, narrowed by the URL's parameters, 50 per page. */
export default async function EntriesPage({ searchParams }: PageProps<"/entries">) {
  const filters = entriesFilterSchema.parse(await searchParams);
  const prisma = await db();
  const today = todayInJapan();
  const fiscalYear = await loadCurrentFiscalYear(prisma, today);
  const thisMonth = monthOf(today);
  const thisYear = fiscalYear ? { from: fiscalYear.startDate, to: fiscalYear.endDate } : null;
  const presets: PeriodPresets = {
    this_month: thisMonth,
    last_month: monthOf(addDays(thisMonth.from, -1)),
    this_year: thisYear,
  };
  // Without dates the list shows 今期 (the fiscal year of today).
  const noDates = filters.from === null && filters.to === null;
  const period: { from: CalendarDate | null; to: CalendarDate | null } = noDates
    ? { from: thisYear?.from ?? null, to: thisYear?.to ?? null }
    : { from: filters.from, to: filters.to };
  const query = { ...filters, ...period };
  const result = await listJournalEntries(prisma, query, filters.page);
  const options = await loadEntryFormOptions(prisma, {
    includeIds: [filters.account, filters.partner, filters.segment, filters.tag].flatMap((id) =>
      id ? [id] : [],
    ),
  });
  // Anything but the default view (今期, 登録済み) counts as narrowed, dates included: an empty
  // narrowed list says 「条件に合う取引がありません」, not that there are no entries at all.
  const narrowed = Boolean(
    !noDates ||
    filters.account ||
    filters.partner ||
    filters.segment ||
    filters.tag ||
    filters.q ||
    filters.status !== "posted",
  );
  const listQuery = entriesQuery({ ...query, page: result.page });
  const newEntry = (
    <>
      <ButtonLink href="/entries/new?type=income" size="sm">
        収入を登録
      </ButtonLink>
      <ButtonLink href="/entries/new?type=expense" size="sm">
        支出を登録
      </ButtonLink>
      <ButtonLink href="/entries/new?type=transfer" size="sm">
        振替を登録
      </ButtonLink>
    </>
  );

  return (
    <>
      <PageHeader
        title="取引"
        meta={fiscalYear ? `第 ${fiscalYear.no} 期` : undefined}
        actions={
          <>
            {newEntry}
            <ButtonLink href="/entries/new?type=voucher" size="sm" variant="ghost">
              伝票を登録
            </ButtonLink>
          </>
        }
      />
      <EntriesFilter
        key={listQuery}
        values={{
          from: period.from ?? "",
          to: period.to ?? "",
          account: filters.account ?? "",
          partner: filters.partner ?? "",
          segment: filters.segment ?? "",
          tag: filters.tag ?? "",
          status: filters.status,
          q: filters.q ?? "",
        }}
        presets={presets}
        accounts={options.accounts.map((account) => ({
          value: account.id,
          label: `${account.code} ${account.name}`,
        }))}
        partners={options.partners.map((partner) => ({ value: partner.id, label: partner.name }))}
        segments={options.segments.map((segment) => ({ value: segment.id, label: segment.name }))}
        tags={options.memoTags.map((tag) => ({ value: tag.id, label: tag.name }))}
        filtered={narrowed}
      />
      {result.total === 0 ? (
        narrowed ? (
          <EmptyState
            title="条件に合う取引がありません"
            description="絞り込みを変えるか、外してください"
            action={
              <ButtonLink href="/entries" size="sm">
                絞り込みを外す
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState
            title="取引がありません"
            description="収入・支出・振替から登録します"
            action={newEntry}
          />
        )
      ) : (
        <>
          <EntriesTable rows={result.rows} listQuery={listQuery} />
          <Pagination
            page={result.page}
            pageCount={result.pageCount}
            total={result.total}
            href={(page) => {
              const search = entriesQuery({ ...query, page });
              return search ? `/entries?${search}` : "/entries";
            }}
          />
        </>
      )}
    </>
  );
}
