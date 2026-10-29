import {
  chainedEntryIds,
  describeRecurringSource,
  getJournalEntryDetail,
  loadEntryHistory,
  type JournalEntryDetail,
} from "@niho-finance/db";
import {
  displayDate,
  ENTRY_KIND_LABELS,
  recurringMonthLabel,
  SOURCE_KIND_LABELS,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { entryNo, formatDate, formatDateTime } from "@/lib/format";
import { EntryDocuments } from "../../documents/_components/entry-documents";
import { EntryHistory } from "../_components/entry-history";
import { EntryLinesTable } from "../_components/entry-lines-table";
import { listHref } from "../_components/list-query";
import { VoidEntryButton } from "../_components/void-entry-button";

export const metadata: Metadata = { title: "取引の詳細" };

function Band({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p
      className={`rounded-lg px-3.5 py-2.5 text-[14px] ${
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-text"
      }`}
    >
      {children}
    </p>
  );
}

function EntryLink({ entry }: { entry: { id: string; no: number } }) {
  return (
    <Link href={`/entries/${entry.id}`} className="font-bold underline underline-offset-4">
      {entryNo(entry.no)}
    </Link>
  );
}

/** The state bands of the detail (11 §5): 取消済み / 反対仕訳 / 訂正 / 締め済み. */
function Bands({ detail, blocked }: { detail: JournalEntryDetail; blocked: boolean }) {
  const bands: ReactNode[] = [];
  if (detail.status === "voided") {
    bands.push(
      <Band key="voided">
        取消済み（理由: {detail.voidReason ?? "—"}）。
        {detail.reversal ? (
          <>
            反対仕訳 <EntryLink entry={detail.reversal} />
          </>
        ) : null}
      </Band>,
    );
  }
  if (detail.reversalOf) {
    bands.push(
      <Band key="reversal">
        <EntryLink entry={detail.reversalOf} /> を取り消す反対仕訳
      </Band>,
    );
  }
  if (detail.replacedBy) {
    bands.push(
      <Band key="replaced">
        <EntryLink entry={detail.replacedBy} /> に訂正しました
      </Band>,
    );
  }
  for (const original of detail.replaces) {
    bands.push(
      <Band key={`replaces-${original.id}`}>
        <EntryLink entry={original} /> の訂正
      </Band>,
    );
  }
  const lockedThrough = detail.fiscalYear.lockedThrough;
  if (detail.isLocked && lockedThrough) {
    bands.push(
      <Band key="locked">
        {displayDate(lockedThrough)} までは締めています。
        {detail.reversalDate
          ? `訂正と取消は ${displayDate(detail.reversalDate)} 付で登録します`
          : null}
      </Band>,
    );
  }
  // Reasons the bands above do not already tell (決算済み, 決算整理中, no open day left).
  const told = detail.status === "voided" || detail.kind === "reversal";
  if (detail.blockedReason && (blocked || !told)) {
    bands.push(
      <Band key="blocked" tone="warn">
        {blocked ? `訂正できません。${detail.blockedReason}` : detail.blockedReason}
        {/* An entry of 請求 is voided on its document (decision 2026-10-29). */}
        {detail.sourceKind === "invoice" && detail.sourceId ? (
          <Link
            href={`/invoices/${detail.sourceId}`}
            className="ml-2 font-bold underline underline-offset-4"
          >
            請求書を開く
          </Link>
        ) : null}
        {/* An entry of 立替精算 is voided there (23-users-and-expenses §5.2). */}
        {detail.sourceKind === "expense" ? (
          <Link href="/expenses" className="ml-2 font-bold underline underline-offset-4">
            立替精算を開く
          </Link>
        ) : null}
      </Band>,
    );
  }
  if (bands.length === 0) return null;
  return <div className="mb-4 flex flex-col gap-2">{bands}</div>;
}

/** 取引の詳細 (11 §5): the state, the lines, 訂正・取消 and the history. */
export default async function EntryDetailPage({
  params,
  searchParams,
}: PageProps<"/entries/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const prisma = await db();
  const detail = await getJournalEntryDetail(prisma, id);
  if (!detail) notFound();
  const history = await loadEntryHistory(prisma, chainedEntryIds(detail));
  // 生成元 of an entry registered from a recurring item (21-cashflow §10.8).
  const recurring =
    detail.sourceKind === "recurring"
      ? await describeRecurringSource(prisma, detail.sourceId)
      : null;
  const canChange = detail.blockedReason === null && detail.reversalDate !== null;
  const meta = [
    formatDate(detail.entryDate),
    ENTRY_KIND_LABELS[detail.kind],
    SOURCE_KIND_LABELS[detail.sourceKind],
    `${detail.createdBy} が ${formatDateTime(detail.createdAt)} に登録`,
  ].join(" · ");

  return (
    <>
      <PageHeader
        title={entryNo(detail.no)}
        meta={meta}
        back={{ href: listHref(query.list), label: "取引" }}
        actions={
          canChange && detail.reversalDate ? (
            <>
              <ButtonLink href={`/entries/${detail.id}/correct`} size="sm">
                訂正
              </ButtonLink>
              <VoidEntryButton
                entryId={detail.id}
                no={detail.no}
                reversalDate={detail.reversalDate}
                lockedThrough={detail.isLocked ? detail.fiscalYear.lockedThrough : null}
              />
            </>
          ) : undefined
        }
      />
      <h2 className="mb-3 text-[17px] font-bold break-words">{detail.description}</h2>
      <Bands detail={detail} blocked={query.blocked === "correct"} />
      <EntryLinesTable detail={detail} />
      <EntryDocuments entryId={detail.id} />
      <p className="mt-2 text-[12px] text-muted">
        第 {detail.fiscalYear.no} 期 · 生成元{" "}
        {recurring?.name ? (
          <Link href="/settings/recurring" className="underline underline-offset-4 hover:text-text">
            {SOURCE_KIND_LABELS.recurring} {recurring.name}（{recurringMonthLabel(recurring.month)}
            分）
          </Link>
        ) : (
          SOURCE_KIND_LABELS[detail.sourceKind]
        )}
      </p>
      <EntryHistory rows={history} />
    </>
  );
}
