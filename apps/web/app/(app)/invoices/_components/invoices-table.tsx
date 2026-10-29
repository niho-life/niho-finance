import type { InvoiceListRow } from "@niho-finance/db";
import {
  formatYen,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_STATUS_LABELS,
  invoiceNumberLabel,
} from "@niho-finance/ledger";
import Link from "next/link";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { detailHref, documentName } from "./list-query";

const COLUMNS = {
  columns: "112px 56px minmax(0,1fr) minmax(0,1.2fr) 84px 84px 104px 104px minmax(104px,0.9fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 下書き / 発行済み …, 期限超過（n 日）in the warn colour, 「→ 請求書 INV-…」 when converted; a small
 * muted 「定期」 before the state when made from a 定期請求 (18 §14.5).
 */
function StatusText({ row }: { row: InvoiceListRow }) {
  return (
    <>
      {row.recurring ? (
        <span
          title={`定期請求 ${row.recurring.name}`}
          className="mr-1.5 inline-block rounded border border-border px-1 text-[11px] leading-4 text-muted"
        >
          定期
        </span>
      ) : null}
      <span>{INVOICE_STATUS_LABELS[row.status]}</span>
      {row.overdue ? (
        <span className="ml-1.5 font-bold text-warn">期限超過（{row.overdueDays} 日）</span>
      ) : null}
      {row.convertedTo ? (
        <span className="block truncate text-[11px] text-muted">
          → {documentName(row.convertedTo)}
        </span>
      ) : null}
    </>
  );
}

/**
 * The list rows (18 §7): 番号 ・ 種別 ・ 取引先 ・ 件名 ・ 発行日 ・ 期限 ・ 金額 ・ 残高 ・ 状態 on PC, two
 * lines on phones (番号・取引先 / 件名・金額と状態). Each row is one link to the detail; void and paid
 * rows are muted.
 */
export function InvoicesTable({
  rows,
  listQuery,
}: {
  rows: readonly InvoiceListRow[];
  /** The list's query, carried to the detail so that 戻る keeps the filters. */
  listQuery: string;
}) {
  return (
    <Table label="請求の一覧" minWidth={960}>
      <TableHead {...COLUMNS}>
        <Th>番号</Th>
        <Th>種別</Th>
        <Th>取引先</Th>
        <Th>件名</Th>
        <Th>発行日</Th>
        <Th>期限</Th>
        <Th align="right">金額（円）</Th>
        <Th align="right">残高（円）</Th>
        <Th>状態</Th>
      </TableHead>
      {rows.map((row) => (
        <TableRow
          key={row.id}
          {...COLUMNS}
          muted={row.status === "void" || row.status === "paid"}
          className="relative hover:bg-black/[0.02]"
        >
          <Td sm="full">
            <Link
              href={detailHref(row.id, listQuery)}
              aria-label={`${documentName(row)} ${row.partnerName}`}
              className="num font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
            >
              {invoiceNumberLabel(row.number)}
            </Link>
            <span className="ml-1.5 text-[12px] text-muted md:hidden">
              {INVOICE_DOC_TYPE_LABELS[row.docType]}
            </span>
            <span className="ml-2 font-semibold md:hidden">{row.partnerName}</span>
          </Td>
          <Td sm="hide" className="text-[13px]">
            {INVOICE_DOC_TYPE_LABELS[row.docType]}
          </Td>
          <Td sm="hide" className="truncate">
            {row.partnerName}
          </Td>
          <Td className="min-w-0">
            <span className="block truncate">{row.title ?? "—"}</span>
            <span className="block text-[12px] md:hidden">
              <StatusText row={row} />
            </span>
          </Td>
          <Td sm="hide" className="num text-[13px]">
            {formatDate(row.issueDate)}
          </Td>
          <Td sm="hide" className="num text-[13px]">
            {row.docType === "delivery" ? "—" : formatDate(row.dueDate)}
          </Td>
          <Td align="right" className="font-bold">
            {formatYen(row.total)}
          </Td>
          <Td sm="hide" align="right">
            {row.balance === null ? "—" : formatYen(row.balance)}
          </Td>
          <Td sm="hide" className="text-[13px]">
            <StatusText row={row} />
          </Td>
        </TableRow>
      ))}
    </Table>
  );
}
