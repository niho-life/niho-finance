import {
  listEmployees,
  listPayrollRuns,
  listPayrollSchedule,
  listWallets,
  todayInJapan,
} from "@niho-finance/db";
import { displayDate, formatYen } from "@niho-finance/ledger";
import { yearMonthLabel, yearMonthOf } from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatDateTime, walletLabel } from "@/lib/format";
import { ScheduleTable } from "./_components/schedule-table";
import { toScheduleRowView } from "./_lib/views";

export const metadata: Metadata = { title: "給与" };

const HISTORY_COLUMNS = {
  columns: "minmax(0,1.1fr) 96px 56px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

/** 給与 (22-payroll §6.6): 今月の支給・支給の履歴・納付の予定. */
export default async function PayrollPage() {
  const prisma = await db();
  const today = todayInJapan();
  const month = yearMonthOf(today);
  const [employees, runs, schedule, wallets] = await Promise.all([
    listEmployees(prisma),
    listPayrollRuns(prisma),
    listPayrollSchedule(prisma),
    listWallets(prisma),
  ]);
  const activeCount = employees.filter((employee) => employee.isActive).length;
  const thisMonth = runs.find((run) => run.payMonth === month) ?? null;
  const monthLabel = yearMonthLabel(month);

  return (
    <>
      <PageHeader
        title="給与"
        actions={
          <ButtonLink href="/payroll/employees" size="sm">
            従業員
          </ButtonLink>
        }
      />
      <div className="flex flex-col gap-8">
        <Section title="今月の支給">
          {activeCount === 0 ? (
            <EmptyState
              title="従業員がいません"
              description="給与を計算するには、まず役員・従業員を登録します。"
              action={
                <ButtonLink href="/payroll/employees?add=1" variant="primary" size="sm">
                  従業員を追加
                </ButtonLink>
              }
            />
          ) : thisMonth ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-border bg-surface px-5 py-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[12px] font-bold text-muted">
                  {monthLabel}の支給 · 確定済み · 支払日 {displayDate(thisMonth.paymentDate)}
                </span>
                <span className="text-[13px] text-muted">
                  差引支給の合計{" "}
                  <span className="num text-[20px] font-extrabold text-text">
                    {formatYen(thisMonth.totals.netPay)}
                  </span>{" "}
                  円（{thisMonth.totals.headcount} 人）
                </span>
              </div>
              <ButtonLink href={`/payroll/runs/${thisMonth.id}`} className="ml-auto" size="sm">
                明細を見る
              </ButtonLink>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-border bg-surface px-5 py-4">
              <p className="min-w-0 text-[13px] text-muted">
                {monthLabel}の支給はまだ確定していません（有効な従業員 {activeCount} 人）。
              </p>
              <ButtonLink
                href={`/payroll/runs/new?month=${month}`}
                variant="primary"
                size="sm"
                className="ml-auto"
              >
                {monthLabel}の支給を計算
              </ButtonLink>
            </div>
          )}
        </Section>

        <Section title="支給の履歴">
          {runs.length === 0 ? (
            <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
              確定した支給はまだありません。今月の支給を計算して確定すると、ここに並びます。
            </p>
          ) : (
            <Table label="支給の履歴">
              <TableHead {...HISTORY_COLUMNS}>
                <Th>支給月</Th>
                <Th sm="hide">支払日</Th>
                <Th sm="hide">人数</Th>
                <Th align="right" sm="hide">
                  総支給（円）
                </Th>
                <Th align="right" sm="hide">
                  控除計（円）
                </Th>
                <Th align="right">差引支給（円）</Th>
                <Th sm="hide">仕訳</Th>
              </TableHead>
              {runs.map((run) => (
                <TableRow key={run.id} {...HISTORY_COLUMNS}>
                  <Td className="font-bold">
                    <Link
                      href={`/payroll/runs/${run.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {yearMonthLabel(run.payMonth)}
                    </Link>
                    <span className="block text-[12px] font-normal text-muted md:hidden">
                      支払日 <span className="num">{displayDate(run.paymentDate)}</span> ·{" "}
                      {run.totals.headcount} 人
                    </span>
                  </Td>
                  <Td sm="hide" className="num text-[13px]">
                    {displayDate(run.paymentDate)}
                  </Td>
                  <Td sm="hide" className="num text-[13px]">
                    {run.totals.headcount} 人
                  </Td>
                  <Td align="right" sm="hide">
                    {formatYen(run.totals.grossPay)}
                  </Td>
                  <Td align="right" sm="hide">
                    {formatYen(run.totals.totalDeductions)}
                  </Td>
                  <Td align="right" className="font-bold">
                    {formatYen(run.totals.netPay)}
                  </Td>
                  <Td sm="hide" className="text-[13px]">
                    {[run.payEntry, run.employerEntry]
                      .filter((entry) => entry !== null)
                      .map((entry, index) => (
                        <span key={entry.id}>
                          {index > 0 ? " · " : null}
                          <Link
                            href={`/entries/${entry.id}`}
                            className="num font-bold underline underline-offset-4"
                          >
                            {entryNo(entry.no)}
                          </Link>
                        </span>
                      ))}
                  </Td>
                </TableRow>
              ))}
            </Table>
          )}
        </Section>

        <Section title="納付の予定">
          <ScheduleTable
            rows={schedule.map((row) => toScheduleRowView(row, formatDateTime))}
            wallets={wallets
              .filter((wallet) => wallet.isActive)
              .map((wallet) => ({ value: wallet.id, label: walletLabel(wallet) }))}
            today={today}
          />
        </Section>
      </div>
    </>
  );
}
