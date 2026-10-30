import {
  loadFeeReports,
  loadStatements,
  todayInJapan,
  type FeeReportsOverview,
  type StatementsOverview,
} from "@niho-finance/db";
import { dateParts, displayDate } from "@niho-finance/ledger";
import {
  annualReportDueDate,
  FEE_CATEGORIES,
  FEE_CATEGORY_KEYS,
  FEE_ITEM_LABELS,
  FEE_REPORT_THRESHOLD,
  feeReportTotals,
  PayrollTableMissingError,
} from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatYenDisplay } from "@/lib/format";
import { TABLE_MISSING_HINT, WORKER_KIND_LABELS } from "../_lib/labels";
import { PartnerKindSelect } from "./_components/partner-kind-select";
import { categoryQuery, readCategories, readYear, searchEntries } from "./_lib/params";

export const metadata: Metadata = { title: "法定調書" };

const RECIPIENT_COLUMNS = {
  columns:
    "minmax(0,1.2fr) minmax(0,1.3fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1.3fr) 72px",
  mobileColumns: "minmax(0,1fr) auto",
};

const FEE_COLUMNS = {
  columns: "minmax(0,1.3fr) 104px minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,1fr)",
  mobileColumns: "minmax(0,1fr) auto",
};

const STATE_LABELS = {
  adjusted: "年末調整済み",
  not_adjusted: "年末調整の対象外",
  pending: "年末調整が未確定",
} as const;

function TotalsTable({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; label: string; people: string; paid: string; withheld: string }[];
}) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="sr-only">{label}</caption>
      <thead>
        <tr className="border-y border-border-2 bg-surface-2 text-[11px] text-muted">
          <th scope="col" className="px-2 py-1.5 text-left font-bold">
            区分
          </th>
          <th scope="col" className="px-2 py-1.5 text-right font-bold">
            人員
          </th>
          <th scope="col" className="px-2 py-1.5 text-right font-bold">
            支払金額（円）
          </th>
          <th scope="col" className="px-2 py-1.5 text-right font-bold">
            源泉徴収税額（円）
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-border">
            <th scope="row" className="px-2 py-1.5 text-left font-normal">
              {row.label}
            </th>
            <td className="num px-2 py-1.5 text-right">{row.people}</td>
            <td className="num px-2 py-1.5 text-right">{row.paid}</td>
            <td className="num px-2 py-1.5 text-right">{row.withheld}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Recipients({ overview }: { overview: StatementsOverview }) {
  const year = overview.year;
  if (overview.recipients.length === 0) {
    return (
      <EmptyState
        title={`${year} 年に支給した人がいません`}
        description="その年に確定した給与・賞与を受けた人が並びます。"
        action={
          <ButtonLink href="/payroll" size="sm">
            給与を開く
          </ButtonLink>
        }
      />
    );
  }
  return (
    <Table label={`${year} 年分の源泉徴収票`}>
      <TableHead {...RECIPIENT_COLUMNS}>
        <Th>名前</Th>
        <Th sm="hide">年末調整</Th>
        <Th align="right" sm="hide">
          支払金額（円）
        </Th>
        <Th align="right" sm="hide">
          源泉徴収税額（円）
        </Th>
        <Th sm="hide">給与支払報告書</Th>
        <Th sm="hide">足りない欄</Th>
        <Th />
      </TableHead>
      {overview.recipients.map((recipient) => {
        const href = `/payroll/statements/${year}/${recipient.employee.id}`;
        return (
          <TableRow key={recipient.employee.id} {...RECIPIENT_COLUMNS}>
            <Td className="font-bold">
              <Link href={href} className="underline-offset-4 hover:underline">
                {recipient.employee.name}
              </Link>
              <span className="block text-[11px] font-normal text-muted">
                {WORKER_KIND_LABELS[recipient.employee.kind]}
                {recipient.employee.leftOn
                  ? ` · ${displayDate(recipient.employee.leftOn)} 退職`
                  : ""}
              </span>
            </Td>
            <Td sm="hide" className="text-[13px]">
              {STATE_LABELS[recipient.state]}
              {recipient.reason ? (
                <span className="block text-[11px] text-muted">{recipient.reason}</span>
              ) : null}
            </Td>
            <Td align="right" sm="hide">
              {formatYenDisplay(recipient.slip.paid)}
            </Td>
            <Td align="right" sm="hide">
              {formatYenDisplay(recipient.slip.withheld)}
            </Td>
            <Td sm="hide" className="text-[13px]">
              {recipient.inSalaryReport ? "出す" : "出さない（年の中途の退職・30 万円以下）"}
              {recipient.inTaxOffice ? (
                <span className="block text-[11px] text-muted">税務署の提出範囲</span>
              ) : null}
            </Td>
            <Td sm="hide" className="text-[13px]">
              {recipient.inSalaryReport && recipient.missing.length > 0
                ? recipient.missing.join("・")
                : "なし"}
            </Td>
            <Td>
              <Link
                href={href}
                className="text-[13px] font-bold underline underline-offset-4"
                aria-label={`${recipient.employee.name} の源泉徴収票`}
              >
                開く
              </Link>
            </Td>
          </TableRow>
        );
      })}
    </Table>
  );
}

function FeeReports({ fees, year }: { fees: FeeReportsOverview; year: number }) {
  const { payees, unassigned, ambiguousWithholding } = fees.aggregation;
  if (payees.length === 0 && unassigned.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-4 text-[14px]">
        {year} 年に 支払報酬料・業務委託費 の仕訳はありません。
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {fees.undecided.length > 0 ? (
        <p role="status" className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
          個人か法人かを決めていない取引先が {fees.undecided.length}{" "}
          件あります。支払調書は個人の取引先だけに出すので、下の表で決めます（登録番号だけでは個人か法人か分かりません）。
        </p>
      ) : null}
      {unassigned.length > 0 ? (
        <p role="status" className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
          取引先のない行が {unassigned.length} 件あります（
          {unassigned
            .slice(0, 5)
            .map((line) => entryNo(line.entryNo))
            .join("・")}
          {unassigned.length > 5 ? " ほか" : ""}）。取引で取引先を付けると集計に入ります。
        </p>
      ) : null}
      {ambiguousWithholding.length > 0 ? (
        <p role="status" className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
          複数の取引先の仕訳で、預り金の行に取引先がないものがあります（
          {ambiguousWithholding.map((line) => entryNo(line.entryNo)).join("・")}
          ）。預り金の行に取引先を付けると源泉徴収税額に入ります。
        </p>
      ) : null}
      <form action="/payroll/statements" method="get" className="flex flex-col gap-3">
        <input type="hidden" name="year" value={year} />
        <Table label={`${year} 年分の報酬の支払`}>
          <TableHead {...FEE_COLUMNS}>
            <Th>取引先</Th>
            <Th sm="hide">個人か法人か</Th>
            <Th sm="hide">区分（支払調書）</Th>
            <Th align="right">支払金額（円）</Th>
            <Th align="right" sm="hide">
              源泉徴収税額（円）
            </Th>
            <Th sm="hide">支払調書</Th>
          </TableHead>
          {payees.map((payee) => (
            <TableRow key={payee.partner.id} {...FEE_COLUMNS}>
              <Td className="font-bold">
                {payee.partner.name}
                <span className="block text-[11px] font-normal text-muted">
                  仕訳 {payee.entries.length} 件
                </span>
              </Td>
              <Td sm="hide">
                <PartnerKindSelect
                  partnerId={payee.partner.id}
                  partnerName={payee.partner.name}
                  value={
                    payee.partner.isIndividual === true
                      ? "individual"
                      : payee.partner.isIndividual === false
                        ? "corporation"
                        : "unknown"
                  }
                />
              </Td>
              <Td sm="hide" className="flex flex-col gap-1">
                {payee.items.map((item) => (
                  <label key={item.accountCode} className="flex flex-col gap-0.5 text-[11px]">
                    <span className="text-muted">
                      {fees.accountNames[item.accountCode] ?? item.accountCode}
                    </span>
                    <Select
                      name={`cat.${payee.partner.id}.${item.accountCode}`}
                      defaultValue={item.category}
                      className="h-8 text-[13px]"
                    >
                      {FEE_CATEGORY_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {FEE_CATEGORIES[key].label}（{FEE_CATEGORIES[key].item} 号）
                        </option>
                      ))}
                    </Select>
                  </label>
                ))}
              </Td>
              <Td align="right">{formatYenDisplay(payee.paid)}</Td>
              <Td align="right" sm="hide">
                {formatYenDisplay(payee.withheld)}
              </Td>
              <Td sm="hide" className="text-[13px]">
                {payee.reportable
                  ? "出す"
                  : payee.partner.isIndividual === false
                    ? "出さない（法人）"
                    : payee.partner.isIndividual === null
                      ? "個人か法人かを決めます"
                      : `出さない（${formatYenDisplay(FEE_REPORT_THRESHOLD)} 円以下）`}
              </Td>
            </TableRow>
          ))}
        </Table>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={buttonClass({ size: "sm" })}>
            区分を反映
          </button>
          <p className="text-[12px] text-muted">
            区分は保存しません。PDF と CSV に渡します。既定は 支払報酬料 → 税理士報酬、業務委託費 →
            デザイン料。
          </p>
        </div>
      </form>
    </div>
  );
}

/**
 * 法定調書 (22-payroll §12) of `?year=YYYY`: the 源泉徴収票 of everyone paid in the year (本人交付・
 * 給与支払報告書の範囲・足りない欄), 法定調書合計表の元データ, and the 報酬 payees for 支払調書 (個人か
 * 法人か・区分), with the PDFs and the CSVs.
 */
export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const today = todayInJapan();
  // 1〜3 月 is the season of last year's reports.
  const { year: thisYear, month } = dateParts(today);
  const year = readYear(params.year, month <= 3 ? thisYear - 1 : thisYear);
  const categories = readCategories(searchEntries(params));
  const prisma = await db();
  let overview: StatementsOverview | null = null;
  let missing: string | null = null;
  try {
    overview = await loadStatements(prisma, year);
  } catch (error) {
    if (!(error instanceof PayrollTableMissingError)) throw error;
    missing = `${error.message}。${TABLE_MISSING_HINT}`;
  }
  const fees = await loadFeeReports(prisma, year, categories);
  const feeTotals = feeReportTotals(fees.aggregation.payees);
  const query = categoryQuery(categories);
  const withQuery = (path: string) => (query === "" ? path : `${path}?${query}`);

  return (
    <>
      <PageHeader
        title="法定調書"
        meta={`${year} 年分`}
        back={{ href: "/payroll", label: "給与" }}
      />
      <div className="flex flex-col gap-8">
        <form
          action="/payroll/statements"
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
          <p className="min-w-0 basis-full text-[13px] text-muted">
            給与支払報告書は受給者の {year + 1} 年 1 月 1
            日現在の住所（退職者は退職時の住所）の市区町村へ、 法定調書合計表は税務署へ、
            {displayDate(annualReportDueDate(year))} までに出します。{year + 1} 年 1
            月以後は、給与支払報告書を出すと源泉徴収票は税務署に出したものとみなされます。
          </p>
        </form>

        {missing ? (
          <p
            role="alert"
            className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger"
          >
            {missing}
          </p>
        ) : overview ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-[15px] font-extrabold">源泉徴収票・給与支払報告書</h2>
                <p className="text-[13px] text-muted">
                  源泉徴収票（受給者交付用）はその年に支給した全員に渡します。退職した人には退職後 1
                  か月以内に渡します。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/payroll/statements/${year}/csv`}
                  className={buttonClass({ variant: "primary", size: "sm" })}
                >
                  統一 CSV を作る
                </Link>
                {/* Plain links: a download must not be prefetched (the audit log records it). */}
                <a
                  href={`/payroll/statements/${year}/summary/pdf`}
                  className={buttonClass({ size: "sm" })}
                >
                  総括表の PDF を書き出す
                </a>
              </div>
            </div>
            {overview.pending > 0 ? (
              <p
                role="status"
                className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn"
              >
                年末調整をまだ確定していない人が {overview.pending} 人います。
                <Link
                  href={`/payroll/year-end?year=${year}`}
                  className="font-bold underline underline-offset-4"
                >
                  給与 › 年末調整
                </Link>
                で確定してから、その人の源泉徴収票を出します。
              </p>
            ) : null}
            <Recipients overview={overview} />
          </section>
        ) : null}

        {overview ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 className="text-[15px] font-extrabold">法定調書合計表の元データ</h2>
              <a
                href={withQuery(`/payroll/statements/${year}/totals/pdf`)}
                className={buttonClass({ size: "sm" })}
              >
                合計表の元データの PDF を書き出す
              </a>
            </div>
            <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
              <TotalsTable
                label="給与所得の源泉徴収票合計表"
                rows={[
                  ["all", "俸給、給与、賞与等の総額", overview.totals.all],
                  ["adjusted", "うち 年末調整をしたもの", overview.totals.adjusted],
                  ["not", "うち 年末調整をしないもの", overview.totals.notAdjusted],
                  ["officers", "うち 役員", overview.totals.officers],
                  ["office", "源泉徴収票を提出するもの（税務署の範囲）", overview.totals.taxOffice],
                  ["report", "給与支払報告書を提出するもの", overview.totals.salaryReport],
                ].map(([key, label, row]) => {
                  const data = row as { people: number; paid: bigint; withheld: bigint };
                  return {
                    key: key as string,
                    label: label as string,
                    people: `${data.people} 人`,
                    paid: formatYenDisplay(data.paid),
                    withheld: formatYenDisplay(data.withheld),
                  };
                })}
              />
              <TotalsTable
                label="報酬、料金、契約金及び賞金の支払調書合計表"
                rows={[
                  ...feeTotals.byItem.map((item) => ({
                    key: `item-${item.item}`,
                    label: `${FEE_ITEM_LABELS[item.item]}（うち提出 ${item.row.reported.people} 人）`,
                    people: `${item.row.people} 人`,
                    paid: formatYenDisplay(item.row.paid),
                    withheld: formatYenDisplay(item.row.withheld),
                  })),
                  {
                    key: "total",
                    label: `報酬の計（うち提出 ${feeTotals.total.reported.people} 人）`,
                    people: `${feeTotals.total.people} 人`,
                    paid: formatYenDisplay(feeTotals.total.paid),
                    withheld: formatYenDisplay(feeTotals.total.withheld),
                  },
                ]}
              />
            </div>
          </section>
        ) : null}

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-[15px] font-extrabold">報酬、料金、契約金及び賞金の支払調書</h2>
              <p className="text-[13px] text-muted">
                支払報酬料・業務委託費
                の仕訳（取消した仕訳を除く）を取引先ごとに集計します。個人の取引先で、年間{" "}
                {formatYenDisplay(FEE_REPORT_THRESHOLD)} 円を超える人に出します。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href={withQuery(`/payroll/statements/${year}/fees/csv`)}
                className={buttonClass({ size: "sm" })}
              >
                e-Tax の CSV を作る
              </Link>
              <a
                href={withQuery(`/payroll/statements/${year}/fees/pdf`)}
                className={buttonClass({ size: "sm" })}
              >
                支払調書の PDF を書き出す
              </a>
            </div>
          </div>
          <FeeReports fees={fees} year={year} />
        </section>
      </div>
    </>
  );
}
