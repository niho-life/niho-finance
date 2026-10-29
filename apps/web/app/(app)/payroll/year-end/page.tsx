import { loadYearEnd, todayInJapan, type YearEndOverview } from "@niho-finance/db";
import { dateParts, displayDate, formatYen } from "@niho-finance/ledger";
import { PayrollTableMissingError } from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatDateTime } from "@/lib/format";
import { TABLE_MISSING_HINT, TAX_COLUMN_LABELS, WORKER_KIND_LABELS } from "../_lib/labels";
import { settlementText } from "../_lib/year-end-views";

export const metadata: Metadata = { title: "年末調整" };

const COLUMNS = {
  columns:
    "minmax(0,1.3fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.2fr) minmax(0,1.4fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

function readYear(value: string | string[] | undefined, fallback: number): number {
  if (typeof value !== "string" || !/^\d{4}$/.test(value)) return fallback;
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : fallback;
}

/**
 * 年末調整 (22-payroll §11.5) of `?year=YYYY` (this year when missing): everyone of the year with the
 * declaration's state, the estimated 過不足 and whether it can be confirmed.
 */
export default async function YearEndListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { year: yearParam } = await searchParams;
  const year = readYear(yearParam, dateParts(todayInJapan()).year);
  const prisma = await db();
  let overview: YearEndOverview | null = null;
  let missing: string | null = null;
  try {
    overview = await loadYearEnd(prisma, year);
  } catch (error) {
    if (!(error instanceof PayrollTableMissingError)) throw error;
    missing = `${error.message}。${TABLE_MISSING_HINT}`;
  }

  return (
    <>
      <PageHeader
        title="年末調整"
        meta={`${year} 年分`}
        back={{ href: "/payroll", label: "給与" }}
      />
      <div className="flex flex-col gap-6">
        <form
          action="/payroll/year-end"
          method="get"
          className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-card border border-border bg-surface px-5 py-4"
        >
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[12px] font-bold text-muted">年分</span>
            <Input
              name="year"
              type="number"
              inputMode="numeric"
              min={2000}
              max={2100}
              defaultValue={year}
              className="w-[120px]"
            />
          </label>
          <button type="submit" className={buttonClass({ size: "sm" })}>
            表示
          </button>
        </form>

        {missing ? (
          <p
            role="alert"
            className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger"
          >
            {missing}
          </p>
        ) : overview ? (
          <>
            {overview.decemberRun ? (
              <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
                精算は{" "}
                <Link
                  href={`/payroll/runs/${overview.decemberRun.id}`}
                  className="font-bold underline underline-offset-4"
                >
                  {year} 年 12 月の支給
                </Link>
                （支払日{" "}
                <span className="num">{displayDate(overview.decemberRun.paymentDate)}</span>
                ）の日付で、
                {overview.decemberRun.payFromWallet
                  ? `${overview.decemberRun.payFromWallet.name}との間で`
                  : "未払金〔給与〕との間で"}
                仕訳にします。
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-border bg-surface px-5 py-4">
                <p className="min-w-0 text-[14px]">
                  {year} 年 12 月の支給はまだ確定していません。申告の入力と概算は今できます。確定は
                  12 月の支給を確定した後に行います。
                </p>
                <ButtonLink
                  href={`/payroll/runs/new?month=${year}-12`}
                  size="sm"
                  className="ml-auto"
                >
                  {year} 年 12 月の支給を計算
                </ButtonLink>
              </div>
            )}
            <p className="text-[13px] text-muted">
              使う表: {overview.table.title}（{displayDate(overview.table.source.fetchedAt)}{" "}
              に取得）
            </p>

            {overview.rows.length === 0 ? (
              <EmptyState
                title={`${year} 年分の対象者がいません`}
                description="その年に支給した人と有効な従業員が並びます。まず役員・従業員を登録します。"
                action={
                  <ButtonLink href="/payroll/employees?add=1" variant="primary" size="sm">
                    従業員を追加
                  </ButtonLink>
                }
              />
            ) : (
              <Table label={`${year} 年分の年末調整`}>
                <TableHead {...COLUMNS}>
                  <Th>名前</Th>
                  <Th sm="hide">申告</Th>
                  <Th align="right" sm="hide">
                    年税額（円）
                  </Th>
                  <Th align="right" sm="hide">
                    徴収済み（円）
                  </Th>
                  <Th>過不足</Th>
                  <Th sm="hide">状態</Th>
                </TableHead>
                {overview.rows.map((row) => {
                  const href = `/payroll/year-end/${year}/${row.employee.id}`;
                  const state = row.confirmed
                    ? `確定済み · ${formatDateTime(row.confirmed.confirmedAt)}`
                    : row.blockers.length === 0
                      ? "確定できます"
                      : (row.blockers[0] ?? "");
                  return (
                    <TableRow key={row.employee.id} {...COLUMNS}>
                      <Td className="font-bold">
                        <Link href={href} className="underline-offset-4 hover:underline">
                          {row.employee.name}
                        </Link>
                        <span className="block text-[11px] font-normal text-muted">
                          {WORKER_KIND_LABELS[row.employee.kind]} ·{" "}
                          {TAX_COLUMN_LABELS[row.employee.taxColumn]}
                          {row.employee.isActive ? "" : " · 無効"}
                        </span>
                      </Td>
                      <Td sm="hide" className="text-[13px]">
                        {row.declaration
                          ? `保存済み · ${formatDateTime(row.declaration.updatedAt)}`
                          : "未入力"}
                      </Td>
                      <Td align="right" sm="hide">
                        {formatYen(row.result.annualTax)}
                      </Td>
                      <Td align="right" sm="hide">
                        {formatYen(row.result.withheld)}
                      </Td>
                      <Td className="text-[13px] font-bold">
                        {settlementText(row.result)}
                        {row.confirmed ? null : (
                          <span className="block text-[11px] font-normal text-muted">概算</span>
                        )}
                      </Td>
                      <Td sm="hide" className="text-[13px]">
                        {state}
                        {row.confirmed?.settlementEntry ? (
                          <Link
                            href={`/entries/${row.confirmed.settlementEntry.id}`}
                            className="num ml-2 font-bold underline underline-offset-4"
                          >
                            {entryNo(row.confirmed.settlementEntry.no)}
                          </Link>
                        ) : null}
                      </Td>
                    </TableRow>
                  );
                })}
              </Table>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
