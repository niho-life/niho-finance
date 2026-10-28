import type { Money } from "@niho-finance/ledger";
import { buildMonthlyTrend, type StatementRow } from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Td } from "@/components/ui/table";
import { formatAmount } from "@/lib/format";
import { DisclosureRows } from "../_components/disclosure-rows";
import { NoEntries, NoFiscalYear } from "../_components/empty";
import { Note } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import { stickyCell, WideHead, wideGrid, WideRow, WideTable } from "../_components/wide-table";
import { segmentName } from "../_lib/format";
import { loadReports, parseReportParams, reportHref, resolvePeriodOrNull } from "../_lib/query";

export const metadata: Metadata = { title: "月次推移" };

function AmountCells({ values, className = "" }: { values: readonly Money[]; className?: string }) {
  return values.map((value, i) => (
    <Td
      key={i}
      align="right"
      className={`${i === values.length - 1 ? "font-bold" : ""} ${className}`}
    >
      {formatAmount(value)}
    </Td>
  ));
}

/**
 * 月次推移 (14-reports §4): the income statement by month and the total. Groups open and close;
 * the table scrolls sideways inside its frame on narrow screens.
 */
export default async function MonthlyPage({ searchParams }: PageProps<"/reports/monthly">) {
  const { source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const report = buildMonthlyTrend(source, period);
  const count = report.columns.length + 1;
  const columns = `minmax(10rem,1.4fr) repeat(${count}, minmax(6.25rem,1fr))`;
  const minWidth = 160 + count * 100 + count * 12 + 28;

  const rows: ReactNode[] = [];
  const accountRow = (row: StatementRow<Money[]>) => (
    <WideRow key={row.key} columns={columns}>
      <span role="rowheader" className={`min-w-0 truncate ${stickyCell({ indent: 2 })}`}>
        {row.accountId ? (
          <Link
            href={reportHref("ledger", period, { account: row.accountId })}
            className="underline-offset-4 hover:underline"
            prefetch={false}
          >
            {row.label}
          </Link>
        ) : (
          row.label
        )}
      </span>
      <AmountCells values={row.value} />
    </WideRow>
  );
  for (let i = 0; i < report.rows.length; i += 1) {
    const row = report.rows[i];
    if (!row) continue;
    if (row.kind === "group") {
      const children: ReactNode[] = [];
      while (report.rows[i + 1]?.kind === "account") {
        const account = report.rows[i + 1];
        if (account) children.push(accountRow(account));
        i += 1;
      }
      rows.push(
        <DisclosureRows
          key={row.key}
          style={wideGrid(columns)}
          labelClassName={`font-bold ${stickyCell()}`}
          label={row.label}
          labelIsToggle
          toggleLabel={`${row.label}の科目`}
          cells={<AmountCells values={row.value} className="text-muted" />}
          defaultOpen
        >
          {children}
        </DisclosureRows>,
      );
      continue;
    }
    if (row.kind === "account") {
      rows.push(accountRow(row));
      continue;
    }
    rows.push(
      <WideRow
        key={row.key}
        columns={columns}
        className={`font-bold ${row.kind === "total" ? "border-t border-t-border-2" : ""}`}
      >
        <span role="rowheader" className={`min-w-0 ${stickyCell()}`}>
          {row.label}
        </span>
        <AmountCells values={row.value} />
      </WideRow>,
    );
  }

  return (
    <ReportsFrame tab="monthly" source={source} period={period} exportable={!report.empty}>
      {report.empty ? (
        <NoEntries />
      ) : (
        <>
          <Note>
            {period.segmentId ? `${segmentName(source.segments, period.segmentId)} · ` : ""}
            金額の単位は円です。各月の当期純利益は、その月の損益計算書と一致します。
          </Note>
          <WideTable label="月次推移" minWidth={minWidth}>
            <WideHead columns={columns}>
              <span role="columnheader" className={stickyCell({ background: "surface-2" })}>
                科目
              </span>
              {report.columns.map((column) => (
                <span key={column.key} role="columnheader" className="text-right">
                  {column.label}
                </span>
              ))}
              <span role="columnheader" className="text-right">
                合計
              </span>
            </WideHead>
            {rows}
          </WideTable>
        </>
      )}
    </ReportsFrame>
  );
}
