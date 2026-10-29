import {
  loadCashflowInputs,
  loadHomeTodos,
  loadReportSource,
  loadWalletStatus,
  todayInJapan,
} from "@niho-finance/db";
import {
  buildCashflowForecast,
  buildCashReport,
  buildSegmentReport,
  buildTrialBalance,
  CASHFLOW_DAYS,
  fiscalYearOn,
  periodSearchParams,
  resolveReportPeriod,
  type ReportPeriod,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db, loadSetupProgress, loadShell, requireSetupReady } from "@/lib/data";
import { formatMonth, formatPeriod } from "@/lib/format";
import { CashCard } from "./_home/cash-card";
import { CashflowCard } from "./_home/cashflow-card";
import { profitFigures, segmentBars } from "./_home/figures";
import { parseProfitPeriod, ProfitCard } from "./_home/profit-card";
import { TodoCard, type TodoRow } from "./_home/todo-card";
import { owedSummary } from "./_home/wallet-cards";

export const metadata: Metadata = { title: "ホーム" };

/**
 * The layout of 14-reports §9. The DOM order is the phone's: 現預金 → やること → 損益 → 資金繰り.
 * From 1024px, two columns: 現預金 over 損益 on the left (2fr), やること beside both on the right
 * (1fr), 資金繰り across the bottom. The second row takes what やること needs beyond 現預金, so a
 * long list never stretches 現預金; 損益 and やること keep their own heights.
 */
const GRID =
  "grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr_auto] lg:[grid-template-areas:'cash_todo'_'profit_todo'_'cashflow_cashflow']";

/**
 * ホーム (14-reports §9): how much money there is now, how this month or this year goes (`pl`), and
 * what to do. Everything is derived from the posted entries on the day of today (the first day of
 * the books before they start).
 */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  await requireSetupReady();
  const profitPeriod = parseProfitPeriod((await searchParams).pl);
  const prisma = await db();
  const shell = await loadShell();
  const progress = await loadSetupProgress();
  const source = await loadReportSource(prisma);
  const today = todayInJapan();
  const fiscalYear = fiscalYearOn(source.fiscalYears, today);
  const asOf = fiscalYear && today < fiscalYear.startDate ? fiscalYear.startDate : today;
  const resolve = (query: Parameters<typeof resolveReportPeriod>[0]) =>
    resolveReportPeriod(query, source.fiscalYears, asOf);

  // 現預金 on `asOf`: the cash tab with this period shows the same total.
  const cashPeriod: ReportPeriod | null = fiscalYear
    ? resolve({ fy: fiscalYear.no, period: "custom", from: fiscalYear.startDate, to: asOf })
    : null;
  const cash = cashPeriod
    ? buildCashReport(source, cashPeriod, await loadWalletStatus(prisma, { through: asOf }))
    : null;
  // 損益 of the chosen period only.
  const period = resolve({ period: profitPeriod });
  const todos = await loadHomeTodos(prisma, today);
  // 資金繰り（90 日）from the same day as 現預金 (21-cashflow §5).
  const forecast = buildCashflowForecast(
    source,
    await loadCashflowInputs(prisma, { start: asOf, days: CASHFLOW_DAYS }),
    { start: asOf, days: CASHFLOW_DAYS },
  );

  const rows: TodoRow[] = todos.map((todo) => ({
    key: todo.key,
    badge: todo.badge,
    tone: todo.tone,
    label: todo.label,
    href: todo.href,
  }));
  if (progress.skipped.wallets) {
    rows.push({
      key: "setup-wallets",
      badge: null,
      tone: "warn",
      label: "口座がまだありません。銀行や役員立替を登録します",
      href: "/settings/wallets",
    });
  }
  if (progress.skipped.opening) {
    rows.push({
      key: "setup-opening",
      badge: null,
      tone: "warn",
      label: "開始仕訳（資本金の払込・創立費）がまだありません",
      href: "/setup?step=opening",
    });
  }

  return (
    <>
      <PageHeader
        title="ホーム"
        meta={`${formatMonth(asOf)}${shell.fiscalYearNo ? ` · 第${shell.fiscalYearNo}期` : ""}`}
      />
      <div className={GRID}>
        <CashCard
          href={
            cashPeriod
              ? `/reports/cash?${new URLSearchParams(periodSearchParams(cashPeriod)).toString()}`
              : undefined
          }
          total={cash?.total ?? 0n}
          asOf={asOf}
          owed={cash ? owedSummary(cash.otherWallets) : null}
          wallets={cash?.wallets ?? []}
          className="lg:[grid-area:cash]"
        />
        <TodoCard rows={rows} className="lg:self-start lg:[grid-area:todo]" />
        {period ? (
          <ProfitCard
            period={profitPeriod}
            periodLabel={
              profitPeriod === "year"
                ? `第${period.fiscalYear.no}期 ${formatPeriod(period.from, period.to)}`
                : formatPeriod(period.from, period.to)
            }
            figures={profitFigures(buildTrialBalance(source, period), source)}
            bars={segmentBars(buildSegmentReport(source, period))}
            className="lg:self-start lg:[grid-area:profit]"
          />
        ) : null}
        <CashflowCard forecast={forecast} className="lg:[grid-area:cashflow]" />
      </div>
    </>
  );
}
