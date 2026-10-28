import { listAcquisitionCandidates, loadEntryFormOptions, todayInJapan } from "@niho-finance/db";
import { displayDate, formatYen, formatYenInput } from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { entryNo } from "@/lib/format";
import {
  FixedAssetForm,
  type AssetSource,
  type CandidateView,
} from "../_components/fixed-asset-form";

export const metadata: Metadata = { title: "固定資産の登録" };

const SOURCE_LABELS: Readonly<Record<AssetSource, string>> = {
  entry: "取得の仕訳から",
  purchase: "仕訳も一緒に登録",
};

/** 取得の仕訳から / 仕訳も一緒に登録 as links: the URL keeps the choice (works without JS). */
function SourceSwitch({ current }: { current: AssetSource }) {
  return (
    <nav aria-label="登録の方法" className="mb-5">
      <ul className="inline-flex flex-wrap gap-1 rounded-[10px] bg-track p-1">
        {(["entry", "purchase"] as const).map((source) => {
          const active = source === current;
          return (
            <li key={source}>
              <Link
                href={`/closing/assets/new?source=${source}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-lg px-4 text-[14px] font-bold ${
                  active ? "bg-surface text-text shadow-raised" : "text-muted hover:text-text"
                }`}
              >
                {SOURCE_LABELS[source]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 固定資産の登録 (16 §5.1). Without a choice: 取得の仕訳から when there are candidates. */
export default async function NewFixedAssetPage({
  searchParams,
}: PageProps<"/closing/assets/new">) {
  const query = await searchParams;
  const prisma = await db();
  const rows = await listAcquisitionCandidates(prisma);
  const options = await loadEntryFormOptions(prisma);
  const source: AssetSource =
    query.source === "entry" || query.source === "purchase"
      ? query.source
      : rows.length > 0
        ? "entry"
        : "purchase";
  const candidates: CandidateView[] = rows.map((row) => ({
    key: `${row.entryId}/${row.accountId}`,
    entryId: row.entryId,
    accountId: row.accountId,
    accountCode: row.accountCode,
    accountLabel: `${row.accountCode} ${row.accountName}`,
    entryDate: row.entryDate,
    description: row.description,
    label: [
      displayDate(row.entryDate),
      entryNo(row.entryNo),
      row.description,
      row.accountName,
      `${formatYen(row.remaining)}円`,
    ].join(" · "),
    remainingInput: formatYenInput(row.remaining),
    remainingText: formatYen(row.remaining),
  }));

  return (
    <>
      <PageHeader
        title="固定資産の登録"
        back={{ href: "/closing/assets", label: "固定資産台帳" }}
      />
      <SourceSwitch current={source} />
      <FixedAssetForm
        key={source}
        source={source}
        candidates={candidates}
        options={options}
        today={todayInJapan()}
      />
    </>
  );
}
