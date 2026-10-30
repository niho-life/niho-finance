import { listBonusRuns, listEmployees, todayInJapan } from "@niho-finance/db";
import { displayDate } from "@niho-finance/ledger";
import { yearMonthLabel, yearMonthOf } from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatYenDisplay } from "@/lib/format";

export const metadata: Metadata = { title: "賞与" };

const HISTORY_COLUMNS = {
  columns: "minmax(0,1.3fr) 96px 56px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr)",
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

/** 賞与 (22-payroll §10.5): 賞与の計算への入口と賞与の履歴. */
export default async function BonusRunsPage() {
  const prisma = await db();
  const month = yearMonthOf(todayInJapan());
  const [employees, runs] = await Promise.all([listEmployees(prisma), listBonusRuns(prisma)]);
  const activeCount = employees.filter((employee) => employee.isActive).length;
  const thisMonth = runs.find((run) => run.payMonth === month) ?? null;

  return (
    <>
      <PageHeader title="賞与" back={{ href: "/payroll", label: "給与" }} />
      <div className="flex flex-col gap-8">
        <Section title="賞与を計算">
          {activeCount === 0 ? (
            <EmptyState
              title="従業員がいません"
              description="賞与を計算するには、まず役員・従業員を登録します。"
              action={
                <ButtonLink href="/payroll/employees?add=1" variant="primary" size="sm">
                  従業員を追加
                </ButtonLink>
              }
            />
          ) : (
            <form
              action="/payroll/bonus/new"
              method="get"
              className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-card border border-border bg-surface px-5 py-4"
            >
              <label className="flex min-w-0 flex-col gap-1">
                <span className="text-[12px] font-bold text-muted">支給月</span>
                <Input type="month" name="month" defaultValue={month} required className="w-44" />
              </label>
              <p className="min-w-0 flex-1 text-[13px] text-muted">
                賞与は 1 か月に 1 回です。支給月を選んで、従業員ごとの額を入れます
                {thisMonth ? `（${yearMonthLabel(month)}の賞与は確定済み）` : ""}。
              </p>
              <button type="submit" className={buttonClass({ variant: "primary", size: "sm" })}>
                賞与を計算
              </button>
            </form>
          )}
        </Section>

        <Section title="賞与の履歴">
          {runs.length === 0 ? (
            <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
              確定した賞与はまだありません。賞与を計算して確定すると、ここに並びます。
            </p>
          ) : (
            <Table label="賞与の履歴">
              <TableHead {...HISTORY_COLUMNS}>
                <Th>賞与</Th>
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
                      href={`/payroll/bonus/${run.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {run.title}
                    </Link>
                    <span className="block text-[12px] font-normal text-muted">
                      {yearMonthLabel(run.payMonth)}支給
                      <span className="md:hidden">
                        {" "}
                        · 支払日 <span className="num">{displayDate(run.paymentDate)}</span> ·{" "}
                        {run.totals.headcount} 人
                      </span>
                    </span>
                  </Td>
                  <Td sm="hide" className="num text-[13px]">
                    {displayDate(run.paymentDate)}
                  </Td>
                  <Td sm="hide" className="num text-[13px]">
                    {run.totals.headcount} 人
                  </Td>
                  <Td align="right" sm="hide">
                    {formatYenDisplay(run.totals.grossPay)}
                  </Td>
                  <Td align="right" sm="hide">
                    {formatYenDisplay(run.totals.totalDeductions)}
                  </Td>
                  <Td align="right" className="font-bold">
                    {formatYenDisplay(run.totals.netPay)}
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
      </div>
    </>
  );
}
