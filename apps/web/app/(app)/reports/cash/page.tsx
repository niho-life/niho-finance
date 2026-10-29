import { loadWalletStatus } from "@niho-finance/db";
import { WALLET_KIND_LABELS } from "@niho-finance/ledger";
import { buildCashReport } from "@niho-finance/reports";
import type { Metadata } from "next";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatAmountDisplay, formatDate } from "@/lib/format";
import { WalletCards } from "../../_home/wallet-cards";
import { CashChart } from "../_components/cash-chart";
import { NoEntries, NoFiscalYear } from "../_components/empty";
import { SectionHeading } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import { loadReports, parseReportParams, resolvePeriodOrNull } from "../_lib/query";

export const metadata: Metadata = { title: "現預金" };

const OWED_COLUMNS = {
  columns: "minmax(8rem,1.4fr) minmax(5rem,0.8fr) minmax(7rem,1fr) minmax(5rem,0.6fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

/**
 * 現預金 (14-reports §6): cash on `to` (the same number as 試算表) with the wallets, the daily
 * balances of the period, and the wallets that are not cash (cards, the officer's advances).
 * Always the whole company: the segment does not apply.
 */
export default async function CashPage({ searchParams }: PageProps<"/reports/cash">) {
  const { prisma, source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const status = await loadWalletStatus(prisma, { through: period.to });
  const report = buildCashReport(source, period, status);

  return (
    <ReportsFrame tab="cash" source={source} period={period} exportable={!report.empty}>
      {report.empty ? (
        <NoEntries />
      ) : (
        <div className="flex flex-col gap-7">
          <section aria-labelledby="cash-total">
            <h2 id="cash-total" className="text-[13px] font-bold text-muted">
              現預金
            </h2>
            <p className="num mt-1 text-[32px] leading-tight font-extrabold tracking-tight">
              {formatAmountDisplay(report.total)}
              <span className="ml-1 text-[14px] font-semibold text-muted">円</span>
            </p>
            <p className="mt-1 mb-3 text-[12px] text-muted">
              {formatDate(report.asOf)} 時点 · 仕訳から導出（試算表の現預金と同じ）
            </p>
            <WalletCards wallets={report.wallets} showStatement />
            {report.unassigned.length > 0 ? (
              <div className="mt-2 text-[12px] text-muted">
                <p>口座に紐づかない現預金</p>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {report.unassigned.map((row) => (
                    <li key={`${row.accountId}:${row.subAccountId ?? ""}`} className="flex gap-2">
                      <span className="min-w-0 truncate">
                        {row.subAccountName
                          ? `${row.accountName} / ${row.subAccountName}`
                          : row.accountName}
                      </span>
                      <span className="num ml-auto">{formatAmountDisplay(row.balance)} 円</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="cash-trend">
            <SectionHeading id="cash-trend" aside="各日の残高（円）">
              残高の推移
            </SectionHeading>
            <CashChart series={report.series} total={report.total} />
          </section>

          {report.otherWallets.length > 0 ? (
            <section aria-labelledby="cash-owed">
              <SectionHeading id="cash-owed" aside={`${formatDate(report.asOf)} 時点`}>
                未払・立替
              </SectionHeading>
              <Table label="未払・立替">
                <TableHead {...OWED_COLUMNS}>
                  <Th>名前</Th>
                  <Th sm="hide">種類</Th>
                  <Th align="right">残高（円）</Th>
                  <Th align="right" sm="hide">
                    未処理
                  </Th>
                </TableHead>
                {report.otherWallets.map((wallet) => (
                  <TableRow key={wallet.walletId} {...OWED_COLUMNS}>
                    <Td className="truncate">{wallet.name}</Td>
                    <Td sm="hide" className="text-muted">
                      {WALLET_KIND_LABELS[wallet.kind]}
                    </Td>
                    <Td align="right">{formatAmountDisplay(wallet.balance)}</Td>
                    <Td align="right" sm="hide" className="text-muted">
                      {wallet.pendingCount > 0 ? `${wallet.pendingCount} 件` : "—"}
                    </Td>
                  </TableRow>
                ))}
              </Table>
            </section>
          ) : null}
        </div>
      )}
    </ReportsFrame>
  );
}
