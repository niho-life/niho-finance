import {
  documentSearchSchema,
  getJournalEntryDetail,
  listDocumentLinks,
  searchDocuments,
} from "@niho-finance/db";
import { DOCUMENT_KIND_LABELS } from "@niho-finance/ledger";
import Link from "next/link";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate, formatYenDisplay } from "@/lib/format";
import { statusText } from "./documents-table";
import { EntryDocumentsActions } from "./entry-documents-actions";
import type { InboxDocument } from "./inbox-picker";
import { documentTitle } from "./list-query";

const COLUMNS = {
  columns: "minmax(0,1.6fr) minmax(0,0.9fr) 92px 104px minmax(0,1fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 証憑 of an entry's detail (13 §9 / 11 §5): the linked documents (voided ones muted, with the
 * reason), 「証憑を追加」 and 「受信箱から選ぶ」 (the inbox, the entry's amount first). A voided entry or
 * a reversal only lists what is linked.
 */
export async function EntryDocuments({ entryId }: { entryId: string }) {
  const prisma = await db();
  const linked = await listDocumentLinks(prisma, { kind: "journal_entry", id: entryId });
  const entry = await getJournalEntryDetail(prisma, entryId);
  const canAdd = entry !== null && entry.status === "posted" && entry.kind !== "reversal";

  let inbox: InboxDocument[] = [];
  if (entry && canAdd) {
    const linkedIds = new Set(linked.map((document) => document.id));
    const { rows } = await searchDocuments(prisma, documentSearchSchema.parse({ tab: "inbox" }), {
      pageSize: 50,
    });
    inbox = rows
      .filter((row) => !linkedIds.has(row.id))
      .map((row, index) => ({ row, index, same: row.amount === entry.debitTotal }))
      .sort((a, b) => Number(b.same) - Number(a.same) || a.index - b.index)
      .map(({ row, same }) => ({
        id: row.id,
        title: documentTitle(row),
        kind: DOCUMENT_KIND_LABELS[row.kind],
        date: row.txnDate ? formatDate(row.txnDate) : null,
        amount: row.amount === null ? null : formatYenDisplay(row.amount),
        partner: row.partnerName,
        sameAmount: same,
      }));
  }

  return (
    <section aria-labelledby="entry-documents" className="mt-6">
      <h2 id="entry-documents" className="mb-2 text-[15px] font-extrabold">
        証憑
      </h2>
      {linked.length === 0 ? (
        <p className="text-[13px] text-muted">この取引に紐づく証憑はありません</p>
      ) : (
        <Table label="この取引の証憑" minWidth={640}>
          <TableHead {...COLUMNS}>
            <Th>ファイル</Th>
            <Th>種別</Th>
            <Th>取引年月日</Th>
            <Th align="right">金額（円）</Th>
            <Th>状態</Th>
          </TableHead>
          {linked.map((document) => {
            const voided = document.status === "voided";
            return (
              <TableRow key={document.id} {...COLUMNS} muted={voided}>
                <Td>
                  <Link
                    href={`/documents/${document.id}`}
                    className="block truncate font-semibold underline-offset-4 hover:underline"
                  >
                    {documentTitle(document)}
                  </Link>
                  <span className="block truncate text-[11px] text-muted md:hidden">
                    {DOCUMENT_KIND_LABELS[document.kind]} · {statusText(document)}
                  </span>
                </Td>
                <Td sm="hide" className="truncate text-[13px]">
                  {DOCUMENT_KIND_LABELS[document.kind]}
                </Td>
                <Td sm="hide" className="num">
                  {document.txnDate ? formatDate(document.txnDate) : "—"}
                </Td>
                <Td align="right" className="font-bold">
                  {document.amount === null ? "—" : formatYenDisplay(document.amount)}
                </Td>
                <Td sm="hide" className="text-[12px] text-muted">
                  <span className="line-clamp-2">{statusText(document)}</span>
                </Td>
              </TableRow>
            );
          })}
        </Table>
      )}
      {canAdd ? <EntryDocumentsActions entryId={entryId} inbox={inbox} /> : null}
    </section>
  );
}
