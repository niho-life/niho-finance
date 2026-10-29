import type { Money } from "@niho-finance/ledger";
import {
  buildMonthlyTrend,
  hasPriorFiscalYear,
  type MonthlyRow,
  type ReportPeriod,
} from "@niho-finance/reports";
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
import {
  conditionsKey,
  loadReportFrame,
  loadReports,
  parseReportParams,
  reportHref,
  resolvePeriodOrNull,
} from "../_lib/query";

export const metadata: Metadata = { title: "月次推移" };

/** The amounts of a row; with 前年同月 (§15.6) a muted second line under each (「—」 before the books). */
function AmountCells({
  values,
  prior,
  className = "",
}: {
  values: readonly Money[];
  prior?: readonly (Money | null)[] | undefined;
  className?: string;
}) {
  return values.map((value, i) => (
    <Td
      key={i}
      align="right"
      className={`${i === values.length - 1 ? "font-bold" : ""} ${className}`}
    >
      {formatAmount(value)}
      {prior ? (
        <span className="block text-[11px] leading-tight font-normal text-muted">
          <span className="sr-only">前年 </span>
          {prior[i] === null || prior[i] === undefined ? "—" : formatAmount(prior[i])}
        </span>
      ) : null}
    </Td>
  ));
}

/** 前年同月 on / off (`compare=prior`): a toggle inside the condition form, from the 2nd year. */
function PriorToggle({ period, on }: { period: ReportPeriod; on: boolean }) {
  return (
    <Link
      href={reportHref("monthly", period, { compare: on ? null : "prior" })}
      aria-label={on ? "前年同月を隠す" : "前年同月を並べる"}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[13px] font-semibold whitespace-nowrap ${
        on ? "border-text text-text" : "border-border text-muted hover:text-text"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-flex size-3.5 items-center justify-center rounded-[4px] border text-[10px] leading-none ${
          on ? "border-text bg-text text-white" : "border-border-2"
        }`}
      >
        {on ? "✓" : ""}
      </span>
      前年同月
    </Link>
  );
}

/** The numbers of the tab, computed once for the table and the CSV / PDF links. */
async function monthlyOf(period: ReportPeriod, comparePrior: boolean) {
  const { source } = await loadReports();
  return {
    source,
    report: buildMonthlyTrend(source, period, { compareWithPriorYear: comparePrior }),
  };
}

/** The table of the tab, streamed after the frame (05-ui-ux §3.1). */
async function MonthlyBody({
  data,
  period,
}: {
  data: ReturnType<typeof monthlyOf>;
  period: ReportPeriod;
}) {
  const { source, report } = await data;
  const count = report.columns.length + 1;
  const columns = `minmax(10rem,1.4fr) repeat(${count}, minmax(6.25rem,1fr))`;
  const minWidth = 160 + count * 100 + count * 12 + 28;

  const rows: ReactNode[] = [];
  const accountRow = (row: MonthlyRow) => (
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
      <AmountCells values={row.value} prior={row.prior} />
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
          cells={<AmountCells values={row.value} prior={row.prior} className="text-muted" />}
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
        <AmountCells values={row.value} prior={row.prior} />
      </WideRow>,
    );
  }

  return report.empty ? (
    <NoEntries />
  ) : (
    <>
      <Note>
        {period.segmentId ? `${segmentName(source.segments, period.segmentId)} · ` : ""}
        金額の単位は円です。各月の当期純利益は、その月の損益計算書と一致します。
        {report.comparing ? "下の小さな数字は前年同月です（帳簿が始まる前の月は「—」）。" : ""}
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
  );
}

/**
 * 月次推移 (14-reports §4): the income statement by month and the total. Groups open and close;
 * the table scrolls sideways inside its frame on narrow screens.
 */
export default async function MonthlyPage({ searchParams }: PageProps<"/reports/monthly">) {
  const raw = await searchParams;
  const { source, today } = await loadReportFrame();
  const params = parseReportParams(raw, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  // 前年同月 depends on the years only (§15.6): the frame shows the switch before the numbers.
  const hasPriorYear = hasPriorFiscalYear(source.fiscalYears, period);
  const comparing = params.comparePrior && hasPriorYear;
  const compare = comparing ? "prior" : null;
  const data = monthlyOf(period, params.comparePrior);

  return (
    <ReportsFrame
      tab="monthly"
      source={source}
      period={period}
      hidden={{ compare }}
      controls={hasPriorYear ? <PriorToggle period={period} on={comparing} /> : undefined}
      exportParams={{ compare }}
      exportable={data.then(({ report }) => !report.empty)}
      streamKey={conditionsKey(raw)}
    >
      <MonthlyBody data={data} period={period} />
    </ReportsFrame>
  );
}
