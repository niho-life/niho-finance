import { buildSegmentReport } from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import { Td } from "@/components/ui/table";
import { formatAmountDisplay } from "@/lib/format";
import { SegmentBars } from "../../_home/segment-bars";
import { NoEntries, NoFiscalYear } from "../_components/empty";
import { SectionHeading } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import { stickyCell, WideGroupRow, WideHead, WideRow, WideTable } from "../_components/wide-table";
import { loadReports, parseReportParams, reportHref, resolvePeriodOrNull } from "../_lib/query";

export const metadata: Metadata = { title: "セグメント損益" };

/**
 * セグメント損益 (14-reports §5): profit by segment as bars, then revenue → expenses → internal by
 * segment with the total column. The segment switch is not shown: this tab is the comparison.
 */
export default async function SegmentsPage({ searchParams }: PageProps<"/reports/segments">) {
  const { source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const report = buildSegmentReport(source, period);
  const count = report.columns.length;
  const columns = `minmax(9rem,1.3fr) repeat(${count}, minmax(6.5rem,1fr))`;
  const minWidth = 144 + count * 104 + count * 12 + 28;
  const last = count - 1;
  // The whole company's period: the segment of the other tabs does not narrow this one.
  const companyPeriod = { ...period, segmentId: null };

  return (
    <ReportsFrame tab="segments" source={source} period={period} exportable={!report.empty}>
      {report.empty ? (
        <NoEntries />
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="segment-profit">
            <SectionHeading id="segment-profit">利益</SectionHeading>
            <SegmentBars
              label="セグメント別の利益"
              bars={report.bars.map((bar) => ({
                key: bar.segmentId ?? "unassigned",
                label: bar.label,
                value: bar.value,
              }))}
            />
          </section>
          <section aria-labelledby="segment-table">
            <SectionHeading id="segment-table" aside="金額の単位は円">
              セグメント別の損益
            </SectionHeading>
            <WideTable label="セグメント損益" minWidth={minWidth}>
              <WideHead columns={columns}>
                <span role="columnheader" className={stickyCell({ background: "surface-2" })}>
                  科目
                </span>
                {report.columns.map((column) => (
                  <span key={column.key} role="columnheader" className="text-right">
                    {column.label}
                  </span>
                ))}
              </WideHead>
              {report.rows.map((row) => {
                if (row.kind === "section") {
                  return <WideGroupRow key={row.key}>{row.label}</WideGroupRow>;
                }
                const strong = row.kind === "subtotal" || row.kind === "total";
                return (
                  <WideRow
                    key={row.key}
                    columns={columns}
                    className={`${strong ? "font-bold" : ""} ${row.kind === "total" ? "border-t border-t-border-2" : ""}`}
                  >
                    <span
                      role="rowheader"
                      className={`min-w-0 truncate ${stickyCell({ indent: row.kind === "account" ? 1 : 0 })}`}
                    >
                      {row.accountId ? (
                        <Link
                          href={reportHref("ledger", companyPeriod, { account: row.accountId })}
                          className="underline-offset-4 hover:underline"
                          prefetch={false}
                        >
                          {row.label}
                        </Link>
                      ) : (
                        row.label
                      )}
                    </span>
                    {row.values.map((value, i) => (
                      <Td key={i} align="right" className={i === last ? "font-bold" : ""}>
                        {formatAmountDisplay(value)}
                      </Td>
                    ))}
                  </WideRow>
                );
              })}
            </WideTable>
            <p className="mt-2 text-[12px] text-muted">
              利益 = 収益 − 費用 − 内部取引。内部取引は会社全体（合計）で 0 です。
            </p>
          </section>
        </div>
      )}
    </ReportsFrame>
  );
}
