import { loadCashflowInputs } from "@niho-finance/db";
import {
  buildCashflowForecast,
  CASHFLOW_DAYS,
  CASHFLOW_EVENT_KIND_LABELS,
  cashflowEventText,
  forecastStartDate,
  type CashflowForecast,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatAmount, formatDate } from "@/lib/format";
import { ForecastChart } from "../_components/forecast-chart";
import { NoFiscalYear } from "../_components/empty";
import { SectionHeading } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import {
  CASHFLOW_BASIS_NOTE,
  cashflowNoteText,
  cashflowPeriodLabel,
  negativeWarning,
  NO_RECURRING_GUIDANCE,
  RECURRING_SETTINGS_HREF,
} from "../_lib/cashflow-text";
import { loadReports, parseReportParams, resolvePeriodOrNull } from "../_lib/query";

export const metadata: Metadata = { title: "資金繰り" };

const EVENT_COLUMNS = {
  columns:
    "6.5rem minmax(10rem,2fr) minmax(4.5rem,0.6fr) minmax(6rem,1fr) minmax(6.5rem,0.9fr) minmax(7rem,1fr)",
  mobileColumns: "minmax(0,1fr) minmax(0,1fr)",
};

const OPENING_COLUMNS = {
  columns: "minmax(0,1fr) minmax(7rem,auto)",
  mobileColumns: "minmax(0,1fr) auto",
};

/** 「今日の現預金」「90 日後」「最低」 (§6). */
function Figures({ forecast }: { forecast: CashflowForecast }) {
  const items = [
    {
      key: "opening",
      label: "今日の現預金",
      value: forecast.opening.total,
      date: forecast.start,
    },
    { key: "final", label: "90 日後", value: forecast.final.balance, date: forecast.final.date },
    { key: "lowest", label: "最低", value: forecast.lowest.balance, date: forecast.lowest.date },
  ];
  return (
    <dl className="grid gap-2 sm:grid-cols-3 sm:gap-4">
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 items-baseline justify-between gap-3 sm:block">
          <dt className="text-[12px] text-muted">{item.label}</dt>
          <dd className="sm:mt-0.5">
            <span className="num text-[20px] leading-snug font-extrabold sm:text-[24px]">
              {formatAmount(item.value)}
            </span>
            <span className="ml-0.5 text-[11px] font-semibold text-muted">円</span>
            <span className="num ml-1.5 text-[12px] text-muted">{formatDate(item.date)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 資金繰り (21-cashflow §6): 現預金 from today to 90 days later as one line, what is not in it,
 * the rows of the period with the running balance, and the start by wallet. The period, the
 * segment and the fiscal year of the other tabs do not apply (the tab links keep them).
 */
export default async function CashflowPage({ searchParams }: PageProps<"/reports/cashflow">) {
  const { prisma, source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const start = forecastStartDate(source.fiscalYears, today);
  const inputs = await loadCashflowInputs(prisma, { start, days: CASHFLOW_DAYS });
  const forecast = buildCashflowForecast(source, inputs, { start, days: CASHFLOW_DAYS });
  const notes = forecast.notes.map(cashflowNoteText);
  const noRecurring = forecast.notes.some((note) => note.kind === "noRecurring");

  return (
    <ReportsFrame
      tab="cashflow"
      source={source}
      period={period}
      conditions={false}
      meta={cashflowPeriodLabel(forecast)}
      exportable
    >
      <div className="flex flex-col gap-7">
        <section aria-labelledby="cashflow-figures" className="flex flex-col gap-3">
          <h2 id="cashflow-figures" className="sr-only">
            資金繰りの数字
          </h2>
          {forecast.firstNegative ? (
            <p role="alert" className="text-[14px] font-bold text-danger">
              {negativeWarning(forecast.firstNegative)}
            </p>
          ) : null}
          <Figures forecast={forecast} />
          <ForecastChart forecast={forecast} size="report" />
        </section>

        {notes.length > 0 ? (
          <section aria-labelledby="cashflow-notes-heading" id="cashflow-notes">
            <SectionHeading id="cashflow-notes-heading">入っていないもの</SectionHeading>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px]">
              {notes.map((note) => (
                <li key={note.key}>
                  {note.text}
                  {note.href ? (
                    <>
                      {" "}
                      <Link
                        href={note.href}
                        className="font-bold whitespace-nowrap underline underline-offset-4"
                      >
                        設定 › 定期取引
                      </Link>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">{CASHFLOW_BASIS_NOTE}</p>
          </section>
        ) : (
          <p id="cashflow-notes" className="text-[12px] text-muted">
            {CASHFLOW_BASIS_NOTE}
          </p>
        )}

        <section aria-labelledby="cashflow-events">
          <SectionHeading id="cashflow-events" aside={cashflowPeriodLabel(forecast)}>
            予定の一覧
          </SectionHeading>
          {forecast.events.length === 0 ? (
            <EmptyState
              title="90 日のあいだに予定はありません"
              description={
                noRecurring ? (
                  <Link href={RECURRING_SETTINGS_HREF} className="underline underline-offset-4">
                    {NO_RECURRING_GUIDANCE}
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <Table label="予定の一覧">
              <TableHead {...EVENT_COLUMNS}>
                <Th>日付</Th>
                <Th>内容</Th>
                <Th sm="hide">種類</Th>
                <Th sm="hide">口座</Th>
                <Th align="right">入出金（円）</Th>
                <Th align="right">残高（円）</Th>
              </TableHead>
              {forecast.events.map((event) => {
                const below = event.balance !== null && event.balance < 0n;
                return (
                  <TableRow key={event.key} {...EVENT_COLUMNS}>
                    <Td className="num">{formatDate(event.date)}</Td>
                    <Td className="truncate">{cashflowEventText(event)}</Td>
                    <Td sm="hide" className="text-muted">
                      {CASHFLOW_EVENT_KIND_LABELS[event.kind]}
                    </Td>
                    <Td sm="hide" className="truncate text-muted">
                      {event.walletName ?? ""}
                    </Td>
                    <Td
                      align="right"
                      label="入出金"
                      className={event.amount === null ? "text-muted" : ""}
                    >
                      {event.amount === null ? "金額未定" : formatAmount(event.amount)}
                    </Td>
                    <Td align="right" label="残高" className={below ? "font-bold text-danger" : ""}>
                      {formatAmount(event.balance)}
                    </Td>
                  </TableRow>
                );
              })}
            </Table>
          )}
        </section>

        <section aria-labelledby="cashflow-opening">
          <SectionHeading id="cashflow-opening" aside={`${formatDate(forecast.start)} 時点`}>
            起点の内訳
          </SectionHeading>
          <Table label="起点の内訳">
            <TableHead {...OPENING_COLUMNS}>
              <Th>口座</Th>
              <Th align="right">残高（円）</Th>
            </TableHead>
            {forecast.opening.wallets.map((wallet) => (
              <TableRow key={wallet.walletId} {...OPENING_COLUMNS}>
                <Td className="truncate">{wallet.name}</Td>
                <Td align="right">{formatAmount(wallet.balance)}</Td>
              </TableRow>
            ))}
            {forecast.opening.unassigned.map((row) => (
              <TableRow
                key={`${row.accountId}:${row.subAccountId ?? ""}`}
                {...OPENING_COLUMNS}
                muted
              >
                <Td className="truncate">
                  口座に紐づかない現預金（
                  {row.subAccountName
                    ? `${row.accountName} / ${row.subAccountName}`
                    : row.accountName}
                  ）
                </Td>
                <Td align="right">{formatAmount(row.balance)}</Td>
              </TableRow>
            ))}
            <TableRow {...OPENING_COLUMNS} className="font-bold">
              <Td>今日の現預金</Td>
              <Td align="right">{formatAmount(forecast.opening.total)}</Td>
            </TableRow>
          </Table>
        </section>
      </div>
    </ReportsFrame>
  );
}
