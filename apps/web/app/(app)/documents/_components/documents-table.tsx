import type { DocumentLinkCounts, DocumentListRow, ReadingState } from "@niho-finance/db";
import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_STATUS_LABELS,
  formatYen,
  type DocumentStatus,
} from "@niho-finance/ledger";
import Link from "next/link";
import type { ReactNode } from "react";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { documentTitle } from "./list-query";

const COLUMNS = {
  columns:
    "92px minmax(0,0.9fr) minmax(0,1.1fr) 104px minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/** An empty search item (取引年月日・取引先・金額). */
function Unsorted() {
  return <span className="font-normal text-muted">未整理</span>;
}

/** 「仕訳 1 · 明細 2」 (kinds without links left out), or 「—」. */
export function linkSummary(counts: DocumentLinkCounts): string {
  const parts: string[] = [];
  if (counts.journalEntries > 0) parts.push(`仕訳 ${counts.journalEntries}`);
  if (counts.walletTransactions > 0) parts.push(`明細 ${counts.walletTransactions}`);
  if (counts.invoices > 0) parts.push(`請求書 ${counts.invoices}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** 未紐づけ / 紐づけ済み / 無効（理由）. */
export function statusText(document: {
  status: DocumentStatus;
  voidReason: string | null;
}): string {
  if (document.status !== "voided") return DOCUMENT_STATUS_LABELS[document.status];
  return document.voidReason ? `無効（${document.voidReason}）` : DOCUMENT_STATUS_LABELS.voided;
}

/** The reading after the state (20-reader §10.2); a saved proposal says nothing. */
const READING_STATE_LABELS: Readonly<Record<ReadingState, string | null>> = {
  proposed: "提案あり",
  needs_review: "要確認",
  failed: "読み取れず",
  saved: null,
};

function orUnsorted(value: ReactNode | null): ReactNode {
  return value === null ? <Unsorted /> : value;
}

/**
 * The documents (13 §3.3): 取引年月日 ・ 種別 ・ 取引先 ・ 金額 ・ ファイル ・ 紐づけ ・ 状態 on PC, two
 * lines on phones (ファイル名・取引年月日 / 取引先・金額). Each row is one link to the detail.
 */
export function DocumentsTable({
  rows,
  readingStates,
}: {
  rows: readonly DocumentListRow[];
  /** 提案あり / 要確認 / 読み取れず after 状態 (muted like the state: no red in the list). */
  readingStates?: ReadonlyMap<string, ReadingState>;
}) {
  return (
    <Table label="証憑" minWidth={880}>
      <TableHead {...COLUMNS}>
        <Th>取引年月日</Th>
        <Th>種別</Th>
        <Th>取引先</Th>
        <Th align="right">金額（円）</Th>
        <Th>ファイル</Th>
        <Th>紐づけ</Th>
        <Th>状態</Th>
      </TableHead>
      {rows.map((row) => {
        const voided = row.status === "voided";
        const date = orUnsorted(row.txnDate ? formatDate(row.txnDate) : null);
        const partner = orUnsorted(row.partnerName);
        const amount = orUnsorted(row.amount === null ? null : formatYen(row.amount));
        const readingState = readingStates?.get(row.id);
        const reading = readingState === undefined ? null : READING_STATE_LABELS[readingState];
        const phoneStatus = [voided ? statusText(row) : null, reading].filter(Boolean).join(" · ");
        return (
          <TableRow
            key={row.id}
            {...COLUMNS}
            muted={voided}
            className="relative hover:bg-black/[0.02]"
          >
            <Td sm="hide" className="num">
              {date}
            </Td>
            <Td sm="hide" className="truncate text-[13px]">
              {DOCUMENT_KIND_LABELS[row.kind]}
            </Td>
            <Td sm="hide" className="truncate">
              {partner}
            </Td>
            <Td sm="hide" align="right" className="font-bold">
              {amount}
            </Td>
            <Td>
              <Link
                href={`/documents/${row.id}`}
                className="block truncate font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
              >
                {documentTitle(row)}
              </Link>
              {phoneStatus ? (
                <span className="block truncate text-[11px] text-muted md:hidden">
                  {phoneStatus}
                </span>
              ) : null}
            </Td>
            <Td sm="hide" className="truncate text-[13px] text-muted">
              {linkSummary(row.linkCounts)}
            </Td>
            <Td sm="hide" className="text-[12px] text-muted">
              {/* The clamp sets `display`: keep it off the cell, which phones hide. */}
              <span className="line-clamp-2">
                {statusText(row)}
                {reading ? ` · ${reading}` : null}
              </span>
            </Td>
            {/* Phones: 取引年月日 beside the file name, then 取引先・金額. */}
            <span role="cell" className="num text-[12px] text-muted md:hidden">
              {date}
            </span>
            <span role="cell" className="min-w-0 truncate text-[13px] md:hidden">
              {partner}
            </span>
            <span role="cell" className="num text-right font-bold md:hidden">
              {amount}
            </span>
          </TableRow>
        );
      })}
    </Table>
  );
}
