import type { Metadata } from "next";
import { formatDate, formatPeriod } from "@/lib/format";
import { NoEntries, NoFiscalYear } from "../_components/empty";
import { Note, SectionHeading, WarningBand } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import { StatementTable } from "../_components/statement-table";
import { segmentName } from "../_lib/format";
import { loadReports, parseReportParams, reportHref, resolvePeriodOrNull } from "../_lib/query";
import { buildTrialBalanceView } from "../_lib/trial-balance-view";

export const metadata: Metadata = { title: "試算表" };

/** 試算表 (14-reports §3): 貸借対照表 on `to`, 損益計算書 of `from`..`to`. */
export default async function TrialBalancePage({
  searchParams,
}: PageProps<"/reports/trial-balance">) {
  const { source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const view = buildTrialBalanceView(source, period);
  const { report } = view;
  // The balance sheet is the whole company's: its accounts open the ledger without the segment,
  // so that the ledger's closing balance is the number clicked (14-reports §14).
  const companyPeriod = { ...period, segmentId: null };
  const bsLedger = (accountId: string, subAccountId?: string | null) =>
    reportHref("ledger", companyPeriod, { account: accountId, sub: subAccountId });
  const plLedger = (accountId: string, subAccountId?: string | null) =>
    reportHref("ledger", period, { account: accountId, sub: subAccountId });

  return (
    <ReportsFrame tab="trial-balance" source={source} period={period} exportable={!report.empty}>
      {report.check.ok ? null : <WarningBand messages={report.check.messages} />}
      {report.empty ? (
        <NoEntries />
      ) : (
        <div className="flex flex-col gap-7">
          <section aria-labelledby="balance-sheet">
            <SectionHeading id="balance-sheet" aside={`${formatDate(period.to)} 時点`}>
              貸借対照表
            </SectionHeading>
            {report.incomeStatement.filteredBySegment ? (
              <Note>貸借対照表は全社の数字です。</Note>
            ) : null}
            <StatementTable label="貸借対照表" lines={view.balanceSheet} ledgerHref={bsLedger} />
          </section>
          <section aria-labelledby="income-statement">
            <SectionHeading
              id="income-statement"
              aside={[
                formatPeriod(period.from, period.to),
                period.segmentId ? segmentName(source.segments, period.segmentId) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              損益計算書
            </SectionHeading>
            <StatementTable label="損益計算書" lines={view.incomeStatement} ledgerHref={plLedger} />
          </section>
        </div>
      )}
    </ReportsFrame>
  );
}
