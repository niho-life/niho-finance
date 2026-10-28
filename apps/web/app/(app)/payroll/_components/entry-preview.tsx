import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { SIDE_LABELS } from "../_lib/labels";
import type { EntryView } from "../_lib/views";

const COLUMNS = {
  columns: "52px minmax(0,1.6fr) minmax(0,1fr) 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

/** An entry the payroll will post (22-payroll §5.3・§5.4): 借方 / 貸方 ・ 科目 ・ 税区分 ・ 金額 and the totals. */
export function EntryPreview({ entry, label }: { entry: EntryView; label?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-[13px] font-bold">
        {label ? <span className="mr-2 text-muted">{label}</span> : null}
        {entry.description}
        <span className="num ml-2 text-[12px] font-normal text-muted">{entry.entryDate}</span>
      </p>
      <Table label={entry.description}>
        <TableHead {...COLUMNS}>
          <Th>貸借</Th>
          <Th>科目</Th>
          <Th sm="hide">税区分</Th>
          <Th align="right">金額（円）</Th>
        </TableHead>
        {entry.lines.map((line) => (
          <TableRow key={line.key} {...COLUMNS}>
            <Td sm="hide" className="text-[13px] text-muted">
              {SIDE_LABELS[line.side]}
            </Td>
            <Td>
              <span className="mr-2 text-[12px] text-muted md:hidden">
                {SIDE_LABELS[line.side]}
              </span>
              {line.account}
              {line.sub ? <span className="text-muted"> / {line.sub}</span> : null}
              {line.tax ? (
                <span className="block text-[11px] text-muted md:hidden">{line.tax}</span>
              ) : null}
            </Td>
            <Td sm="hide" className="text-[13px] text-muted">
              {line.tax ?? "—"}
            </Td>
            <Td align="right" className="font-bold">
              {line.amount}
            </Td>
          </TableRow>
        ))}
        <TableRow {...COLUMNS} className="bg-surface-2 font-bold">
          <Td sm="hide" />
          <Td>
            合計
            <span className="num ml-3 text-[12px] font-normal text-muted">
              借方 {entry.debitTotal} / 貸方 {entry.creditTotal}
            </span>
          </Td>
          <Td sm="hide" />
          <Td align="right">{entry.debitTotal}</Td>
        </TableRow>
      </Table>
    </div>
  );
}
