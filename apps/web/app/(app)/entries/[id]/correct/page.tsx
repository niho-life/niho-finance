import {
  CORRECTION_KINDS,
  getJournalEntryDetail,
  loadEntryFormOptions,
  todayInJapan,
  VOUCHER_KINDS,
} from "@niho-finance/db";
import { displayDate, formatYen, type EntryKind } from "@niho-finance/ledger";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { entryNo } from "@/lib/format";
import { VoucherForm, type VoucherDraft } from "../../_components/voucher-form";

export const metadata: Metadata = { title: "取引の訂正" };

function isCorrectionKind(kind: EntryKind): kind is (typeof CORRECTION_KINDS)[number] {
  return (CORRECTION_KINDS as readonly string[]).includes(kind);
}

/**
 * 訂正 (11 §6): the 伝票 form filled with the original. Registering voids the original (a reversal)
 * and posts the new entry in one transaction. Not for voided entries, reversals or closed years.
 */
export default async function CorrectEntryPage({ params }: PageProps<"/entries/[id]/correct">) {
  const { id } = await params;
  const prisma = await db();
  const detail = await getJournalEntryDetail(prisma, id);
  if (!detail) notFound();
  if (detail.blockedReason !== null || detail.reversalDate === null) {
    redirect(`/entries/${detail.id}?blocked=correct`);
  }

  const includeIds = detail.lines.flatMap((line) => [
    line.accountId,
    line.taxCategoryCode,
    ...(line.subAccountId ? [line.subAccountId] : []),
    ...(line.segmentId ? [line.segmentId] : []),
    ...(line.partnerId ? [line.partnerId] : []),
    ...line.memoTags.map((tag) => tag.id),
  ]);
  const options = await loadEntryFormOptions(prisma, { includeIds });
  const kind: EntryKind = isCorrectionKind(detail.kind) ? detail.kind : "normal";
  const kinds = [...new Set<EntryKind>([...VOUCHER_KINDS, kind])];
  // A closed date cannot take the new entry: it starts on the first open day (11 §6).
  const entryDate =
    detail.isLocked && detail.firstOpenDate ? detail.firstOpenDate : detail.entryDate;
  const initial: VoucherDraft = {
    kind,
    entryDate,
    description: detail.description,
    partnerId: "",
    memoTagIds: [...new Set(detail.lines.flatMap((line) => line.memoTags.map((tag) => tag.id)))],
    lines: detail.lines.map((line) => ({
      key: `line-${line.lineNo}`,
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId ?? "",
      amount: formatYen(line.amount),
      taxCategoryCode: line.taxCategoryCode,
      segmentId: line.segmentId ?? "",
      partnerId: line.partnerId ?? "",
      description: line.description ?? "",
      edited: { taxCategoryCode: false, segmentId: false },
    })),
  };

  return (
    <>
      <PageHeader
        title={`${entryNo(detail.no)} の訂正`}
        meta={detail.description}
        back={{ href: `/entries/${detail.id}`, label: entryNo(detail.no) }}
      />
      <VoucherForm
        options={options}
        today={todayInJapan()}
        initial={initial}
        kinds={kinds}
        mode={{
          kind: "correct",
          entryId: detail.id,
          no: detail.no,
          notice: `${entryNo(detail.no)} を取り消して、新しい仕訳を登録します。反対仕訳は ${displayDate(detail.reversalDate)} 付です`,
          dateHelp: detail.isLocked
            ? `${entryNo(detail.no)} の日付（${displayDate(detail.entryDate)}）は締めているため、開いている最初の日付にしています`
            : null,
        }}
      />
    </>
  );
}
