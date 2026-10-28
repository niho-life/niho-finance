import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import type { OpeningPreviewView } from "@/lib/opening-view";

const COLUMNS = {
  columns: "88px minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

function Side({ lines }: { lines: OpeningPreviewView["entries"][number]["debit"] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span key={index} className="block truncate">
          {line.account}
          {line.sub ? (
            <span className="block truncate text-[11px] text-muted-2">{line.sub}</span>
          ) : null}
        </span>
      ))}
    </>
  );
}

/** The opening entries as journal rows: 日付・摘要・借方・貸方・金額 and the totals. */
export function OpeningEntriesTable({ preview }: { preview: OpeningPreviewView }) {
  return (
    <Table label="開始仕訳">
      <TableHead {...COLUMNS}>
        <Th>日付</Th>
        <Th>摘要</Th>
        <Th>借方</Th>
        <Th>貸方</Th>
        <Th align="right">金額（円）</Th>
      </TableHead>
      {preview.entries.map((entry) => (
        <TableRow key={entry.key} {...COLUMNS}>
          <Td sm="hide" className="num text-muted">
            {formatDate(entry.date)}
          </Td>
          <Td>
            <span className="mr-2 text-[11px] text-muted-2 md:hidden">
              {formatDate(entry.date)}
            </span>
            {entry.description}
          </Td>
          <Td sm="hide">
            <Side lines={entry.debit} />
          </Td>
          <Td sm="hide">
            <Side lines={entry.credit} />
          </Td>
          <Td align="right" className="font-bold">
            {entry.amount}
          </Td>
          <Td sm="full" className="text-[12px] text-muted md:hidden">
            {entry.debit
              .map((line) => line.account + (line.sub ? `（${line.sub}）` : ""))
              .join("・")}
            {" / "}
            {entry.credit
              .map((line) => line.account + (line.sub ? `（${line.sub}）` : ""))
              .join("・")}
          </Td>
        </TableRow>
      ))}
      <TableRow {...COLUMNS} className="bg-surface-2 font-bold">
        <Td sm="hide" />
        <Td>合計</Td>
        <Td sm="hide" className="num">
          借方 {preview.debitTotal}
        </Td>
        <Td sm="hide" className="num">
          貸方 {preview.creditTotal}
        </Td>
        <Td align="right">{preview.debitTotal}</Td>
      </TableRow>
    </Table>
  );
}
