import type { RowFailure } from "@niho-finance/importers";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";

/*
 * The failed rows and the warnings of a preview or a batch (12-imports §1.2, §1.3, §3.5). Plain
 * components: both the result page and the CSV screen's client component render them.
 */

const FAILURE_COLUMNS = {
  columns: "64px minmax(0,1fr) minmax(0,1.4fr)",
  mobileColumns: "56px minmax(0,1fr)",
};

/** 元の行: the cells joined with 「 , 」 (the full text on hover). */
function rawText(raw: readonly string[] | undefined): string {
  return raw && raw.length > 0 ? raw.join(" , ") : "—";
}

export function FailuresTable({
  failures,
  label = "失敗した行",
}: {
  failures: readonly RowFailure[];
  label?: string;
}) {
  if (failures.length === 0) return null;
  return (
    <Table label={label}>
      <TableHead {...FAILURE_COLUMNS}>
        <Th align="right">行</Th>
        <Th>理由</Th>
        <Th>元の行</Th>
      </TableHead>
      {failures.map((failure, index) => {
        const raw = rawText(failure.raw);
        return (
          <TableRow key={`${failure.rowNumber}-${index}`} {...FAILURE_COLUMNS}>
            <Td align="right" className="text-muted">
              {failure.rowNumber > 0 ? failure.rowNumber : "—"}
            </Td>
            <Td className="break-words">{failure.reason}</Td>
            <Td sm="full" className="truncate text-[12px] text-muted" label="元の行">
              <span title={raw}>{raw}</span>
            </Td>
          </TableRow>
        );
      })}
    </Table>
  );
}

/** 警告 (残高の連続性など): they never stop an import. */
export function WarningsList({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]">
      {warnings.map((warning, index) => (
        <li key={`${index}-${warning}`} className="flex gap-2">
          <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 break-words">{warning}</span>
        </li>
      ))}
    </ul>
  );
}
