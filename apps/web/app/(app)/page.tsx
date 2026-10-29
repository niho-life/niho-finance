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
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { db, loadSetupProgress, loadShell, requireSetupReady } from "@/lib/data";
import { formatAmount, formatDate, formatMonth, formatPeriod } from "@/lib/format";
import { FirstMonthGuide } from "./_components/first-month-guide";
import { HomeCard } from "./_home/card";
import { CashflowCard } from "./_home/cashflow-card";
import { profitFigures, segmentBars } from "./_home/figures";
import { ProfitCard } from "./_home/profit-card";
import { TodoCard, type TodoRow } from "./_home/todo-card";
import { owedSummary, WalletCards } from "./_home/wallet-cards";

export const metadata: Metadata = { title: "ホーム" };

/**
 * ホーム (14-reports §9): how much money there is now, how this month and this year go, and what
 * to do. Everything is derived from the posted entries on the day of today (the first day of the
 * books before they start).
 */
export default async function HomePage() {
  await requireSetupReady();
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
  const month = resolve({ period: "month" });
  const year = resolve({ period: "year" });
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
  const owed = cash ? owedSummary(cash.otherWallets) : null;

  return (
    <>
      <PageHeader
        title="ホーム"
        meta={`${formatMonth(asOf)}${shell.fiscalYearNo ? ` · 第${shell.fiscalYearNo}期` : ""}`}
      />
      <FirstMonthGuide />
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <HomeCard
          id="home-cash"
          title="現預金"
          href={
            cashPeriod
              ? `/reports/cash?${new URLSearchParams(periodSearchParams(cashPeriod)).toString()}`
              : undefined
          }
        >
          <p className="num text-[32px] leading-tight font-extrabold tracking-tight">
            {formatAmount(cash?.total ?? 0n)}
            <span className="ml-1 text-[14px] font-semibold text-muted">円</span>
          </p>
          <p className="mt-1.5 text-[12px] text-muted">{formatDate(asOf)} 時点 · 仕訳から導出</p>
          {owed ? <p className="num mt-3 text-[12px] text-muted">{owed}</p> : null}
        </HomeCard>
        <HomeCard id="home-wallets" title="口座">
          {cash && cash.wallets.length > 0 ? (
            <WalletCards wallets={cash.wallets} />
          ) : (
            <p className="text-[14px] text-muted">現預金の口座はまだありません。</p>
          )}
        </HomeCard>
      </div>

      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          {month ? (
            <ProfitCard
              id="home-month"
              title="今月の損益"
              href="/reports/trial-balance?period=month"
              periodLabel={formatPeriod(month.from, month.to)}
              figures={profitFigures(buildTrialBalance(source, month), source)}
              bars={segmentBars(buildSegmentReport(source, month))}
            />
          ) : null}
          {year ? (
            <ProfitCard
              id="home-year"
              title="今期の損益"
              href="/reports/trial-balance?period=year"
              periodLabel={`第${year.fiscalYear.no}期 ${formatPeriod(year.from, year.to)}`}
              figures={profitFigures(buildTrialBalance(source, year), source)}
              bars={segmentBars(buildSegmentReport(source, year))}
            />
          ) : null}
        </div>
        <TodoCard rows={rows} className="lg:self-start" />
      </div>

      <CashflowCard forecast={forecast} className="mt-3.5" />

      <p className="mt-6 text-[13px] text-muted">
        <Link href="/entries" className="font-bold text-text underline underline-offset-4">
          取引
        </Link>
        ・
        <Link href="/statements" className="font-bold text-text underline underline-offset-4">
          明細
        </Link>
        の登録・証憑の保存・報告が使えます。勘定科目や口座は{" "}
        <Link href="/settings" className="font-bold text-text underline underline-offset-4">
          設定
        </Link>{" "}
        から変えられます。
      </p>
    </>
  );
}
