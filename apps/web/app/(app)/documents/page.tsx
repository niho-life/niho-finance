import {
  countDocuments,
  countUnreadInboxDocuments,
  documentSearchSchema,
  listPartners,
  listUnreadInboxDocuments,
  loadReadingStates,
  searchDocuments,
  summarizeApiUsage,
  todayInJapan,
} from "@niho-finance/db";
import {
  DOCUMENT_TAB_LABELS,
  DOCUMENT_TABS,
  formatYenInput,
  type DocumentTab,
} from "@niho-finance/ledger";
import { estimatedCostPerDocumentNanoUsd, formatUsd } from "@niho-finance/reader";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { readerStatus } from "@/lib/reader/config";
import { japanMonthRange } from "@/lib/reader/month";
import { BulkReader } from "./_components/bulk-reader";
import { DocumentsSearch, type SearchValues } from "./_components/documents-search";
import { DocumentsTable } from "./_components/documents-table";
import {
  documentsHref,
  documentsQuery,
  hasConditions,
  isDocumentTab,
} from "./_components/list-query";
import { Pager } from "./_components/pager";
import { Uploader } from "./_components/uploader";

export const metadata: Metadata = { title: "証憑" };

const SEARCH_KEYS = [
  "tab",
  "from",
  "to",
  "amountMin",
  "amountMax",
  "partner",
  "kind",
  "q",
  "page",
] as const;

type SearchKey = (typeof SEARCH_KEYS)[number];

/** The list's own parameters, first value each (a repeated key keeps its first value). */
function searchValuesOf(
  params: Record<string, string | string[] | undefined>,
): Partial<Record<SearchKey, string>> {
  const values: Partial<Record<SearchKey, string>> = {};
  for (const key of SEARCH_KEYS) {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") values[key] = first;
  }
  return values;
}

/** まとめて読み取る reads at most this many documents at a time (cost and waiting, 20-reader §10.2). */
const BULK_READ_LIMIT = 20;

/** The empty tab: what is missing and what to do next (05-ui-ux §3.1). */
const EMPTY_STATES: Readonly<Record<DocumentTab, { title: string; description: string }>> = {
  inbox: { title: "受信箱は空です", description: "保存した証憑は「すべて」のタブで検索できます" },
  all: {
    title: "証憑がありません",
    description: "領収書や請求書を保存するか、スマホで撮影します",
  },
  voided: {
    title: "無効にした証憑はありません",
    description: "証憑の詳細で無効にすると、ここに並びます",
  },
};

function chipClass(active: boolean): string {
  return `inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold ${
    active
      ? "border-text text-text"
      : "border-border text-muted hover:border-border-2 hover:text-text"
  }`;
}

/**
 * 証憑 (13 §3): 保存 (drop zone / camera), the tabs 受信箱・すべて・無効, the search (the URL's
 * parameters are the truth) and the list, 50 per page. Conditions that do not parse are shown
 * above the form while the list shows the tab without conditions.
 */
export default async function DocumentsPage({ searchParams }: PageProps<"/documents">) {
  const raw = searchValuesOf(await searchParams);
  const parsed = documentSearchSchema.safeParse(raw);
  const filters = parsed.success
    ? parsed.data
    : documentSearchSchema.parse({ tab: isDocumentTab(raw.tab) ? raw.tab : undefined });
  const searchError = parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "検索の条件が正しくありません");
  const tab: DocumentTab = filters.tab ?? "inbox";

  const prisma = await db();
  const counts = await countDocuments(prisma);
  let result = await searchDocuments(prisma, filters);
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (result.page > lastPage) result = await searchDocuments(prisma, filters, { page: lastPage });
  const partners = await listPartners(prisma);
  const partnerNames = [
    ...new Set(partners.filter((partner) => partner.isActive).map((partner) => partner.name)),
  ];

  const narrowed = hasConditions(filters);
  const values: SearchValues = parsed.success
    ? {
        tab,
        from: filters.from ?? "",
        to: filters.to ?? "",
        amountMin: formatYenInput(filters.amountMin),
        amountMax: formatYenInput(filters.amountMax),
        partner: filters.partner ?? "",
        kind: filters.kind ?? "",
        q: filters.q ?? "",
      }
    : {
        tab,
        from: raw.from ?? "",
        to: raw.to ?? "",
        amountMin: raw.amountMin ?? "",
        amountMax: raw.amountMax ?? "",
        partner: raw.partner ?? "",
        kind: raw.kind ?? "",
        q: raw.q ?? "",
      };
  const typed = (["from", "to", "amountMin", "amountMax", "partner", "kind", "q"] as const).some(
    (key) => (raw[key] ?? "").trim() !== "",
  );
  const clearHref = documentsHref({ tab });
  const conditions = { ...filters, page: 1 };

  // 読み取り (20-reader §10.2): the inbox's まとめて読み取る and this month's readings, and the
  // reading state of each listed document.
  const readingStates = await loadReadingStates(
    prisma,
    result.rows.map((row) => row.id),
  );
  const reader = readerStatus();
  let bulk: { ids: string[]; total: number; costPerDocument: string } | null = null;
  let readingUsage: string | null = null;
  if (tab === "inbox") {
    if (reader.model !== null) {
      const total = await countUnreadInboxDocuments(prisma);
      const unread =
        total > 0 ? await listUnreadInboxDocuments(prisma, { limit: BULK_READ_LIMIT }) : [];
      bulk = {
        ids: unread.map((document) => document.id),
        total,
        costPerDocument: formatUsd(estimatedCostPerDocumentNanoUsd(reader.model)),
      };
    }
    const usage = await summarizeApiUsage(prisma, {
      service: "reader",
      ...japanMonthRange(todayInJapan()),
    });
    if (usage.count > 0) {
      readingUsage = `今月の読み取り ${usage.count.toLocaleString("ja-JP")} 件 · 約 ${formatUsd(usage.costNanoUsd)}`;
    }
  }

  return (
    <>
      <PageHeader title="証憑" />
      <Uploader />
      {bulk ? (
        <BulkReader ids={bulk.ids} total={bulk.total} costPerDocument={bulk.costPerDocument} />
      ) : null}
      {readingUsage ? <p className="num mb-3 text-[12px] text-muted">{readingUsage}</p> : null}
      <nav aria-label="証憑のタブ" className="mb-3 flex flex-wrap gap-1.5">
        {DOCUMENT_TABS.map((item) => {
          const active = item === tab;
          return (
            <Link
              key={item}
              href={documentsHref({ ...conditions, tab: item })}
              aria-current={active ? "page" : undefined}
              className={chipClass(active)}
            >
              {DOCUMENT_TAB_LABELS[item]}
              <span className="num font-bold text-muted">
                {counts[item].toLocaleString("ja-JP")}
              </span>
            </Link>
          );
        })}
      </nav>
      <DocumentsSearch
        key={new URLSearchParams(raw).toString()}
        values={values}
        partnerNames={partnerNames}
        narrowed={narrowed || typed}
        clearHref={clearHref}
        error={searchError}
      />
      {result.total === 0 ? (
        narrowed ? (
          <EmptyState
            title="条件に合う証憑がありません"
            description="条件を変えるか、消してください"
            action={
              <ButtonLink href={clearHref} size="sm">
                条件を消す
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState title={EMPTY_STATES[tab].title} description={EMPTY_STATES[tab].description} />
        )
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="num text-[13px] text-muted">{result.total.toLocaleString("ja-JP")} 件</p>
            <a
              href={`/api/documents/index.csv?${documentsQuery(conditions, { explicitTab: true })}`}
              download
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              索引簿を書き出す
            </a>
          </div>
          <DocumentsTable rows={result.rows} readingStates={readingStates} />
          <Pager
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            href={(page) => documentsHref({ ...filters, page })}
          />
        </>
      )}
    </>
  );
}
