import { getPayrollRun, todayInJapan, type PayrollRunDetail } from "@niho-finance/db";
import { displayDate, formatYen } from "@niho-finance/ledger";
import { PREMIUM_TIMING_LABELS, yearMonthLabel, yearMonthParts } from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatDateTime } from "@/lib/format";
import { WORKER_KIND_LABELS } from "../../_lib/labels";
import { coverageNotes, scheduleTarget, tableTitles, toItemResultView } from "../../_lib/views";

export const metadata: Metadata = { title: "確定した支給" };

const COLUMNS = {
  columns: "minmax(0,1.3fr) repeat(7,minmax(0,1fr)) minmax(0,1.1fr) 76px",
  mobileColumns: "minmax(0,1fr) auto",
};

const SCHEDULE_COLUMNS = {
  columns: "96px 96px minmax(0,1.4fr) 120px minmax(0,1fr)",
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

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] font-bold text-muted">{label}</dt>
      <dd className="text-[14px]">{children}</dd>
    </div>
  );
}

function EntryRefLink({ label, entry }: { label: string; entry: PayrollRunDetail["payEntry"] }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
      <span className="text-[13px] font-bold text-muted">{label}</span>
      {entry ? (
        <>
          <Link
            href={`/entries/${entry.id}`}
            className="num font-bold underline underline-offset-4"
          >
            {entryNo(entry.no)}
          </Link>
          <span className="num text-[13px] text-muted">{displayDate(entry.entryDate)}</span>
        </>
      ) : (
        <span className="text-[13px] text-muted">なし</span>
      )}
    </li>
  );
}

/** 確定した支給 (22-payroll §6.4): read only — the settings, the results, the tables, the entries. */
export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getPayrollRun(await db(), id);
  if (!run) notFound();
  const today = todayInJapan();
  const items = run.items.map((item) =>
    toItemResultView(item, coverageNotes(item.input.coverage, item.kind, run.premiumMonth, null)),
  );
  const yesNo = (value: boolean) => (value ? "承認あり" : "なし");

  return (
    <>
      <PageHeader
        title={`${yearMonthLabel(run.payMonth)}の支給`}
        meta={`確定済み · ${run.confirmedBy} が ${formatDateTime(run.confirmedAt)} に確定`}
        back={{ href: "/payroll", label: "給与" }}
      />
      <p className="mb-6 rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
        確定した支給は変えられません。直すときは次の支給の調整で行うか、取引で仕訳を訂正してください。
      </p>
      {yearMonthParts(run.payMonth).month === 12 ? (
        <p className="mb-6 rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
          年末調整は{" "}
          <Link
            href={`/payroll/year-end?year=${yearMonthParts(run.payMonth).year}`}
            className="font-bold underline underline-offset-4"
          >
            給与 › 年末調整
          </Link>{" "}
          で、この支給の確定後に行います。精算は支払日 {displayDate(run.paymentDate)}{" "}
          の仕訳にし、この月の源泉所得税の納付に足します（還付は引きます）。
        </p>
      ) : null}
      <div className="flex flex-col gap-8">
        <Section title="支給の設定">
          <dl className="grid gap-4 rounded-card border border-border bg-surface p-4 sm:grid-cols-2 md:grid-cols-3">
            <Setting label="支払日">
              <span className="num">{displayDate(run.paymentDate)}</span>
            </Setting>
            <Setting label="社会保険料の控除">
              {PREMIUM_TIMING_LABELS[run.premiumTiming]}（{yearMonthLabel(run.premiumMonth)}分）
            </Setting>
            <Setting label="支払元">
              {run.payFromWallet ? run.payFromWallet.name : "未払金〔給与〕に計上"}
            </Setting>
            <Setting label="源泉所得税の納期の特例">{yesNo(run.withholdingSpecialDue)}</Setting>
            <Setting label="住民税の納期の特例">{yesNo(run.residentTaxSpecialDue)}</Setting>
            <Setting label="使った表の版">{tableTitles(run.tables).join(" / ")}</Setting>
          </dl>
        </Section>

        <Section title="従業員ごとの結果">
          <Table label="従業員ごとの結果" minWidth={980}>
            <TableHead {...COLUMNS}>
              <Th>名前</Th>
              <Th align="right" sm="hide">
                総支給（円）
              </Th>
              <Th align="right" sm="hide">
                社会保険（円）
              </Th>
              <Th align="right" sm="hide">
                雇用保険（円）
              </Th>
              <Th align="right" sm="hide">
                源泉の対象額（円）
              </Th>
              <Th align="right" sm="hide">
                源泉所得税（円）
              </Th>
              <Th align="right" sm="hide">
                住民税（円）
              </Th>
              <Th align="right" sm="hide">
                控除計（円）
              </Th>
              <Th align="right">差引支給（円）</Th>
              <Th sm="hide">明細</Th>
            </TableHead>
            {items.map((item) => (
              <TableRow key={item.employeeId} {...COLUMNS}>
                <Td className="font-bold">
                  {item.name}
                  <span className="block text-[11px] font-normal text-muted">
                    {WORKER_KIND_LABELS[item.kind]} · {item.coverageNotes.join(" · ")}
                  </span>
                </Td>
                <Td align="right" sm="hide">
                  {item.grossPay}
                </Td>
                <Td align="right" sm="hide">
                  {item.socialInsurance}
                  <span className="block text-[11px] text-muted">{item.socialInsuranceDetail}</span>
                </Td>
                <Td align="right" sm="hide">
                  {item.employmentInsurance ?? "なし"}
                </Td>
                <Td align="right" sm="hide">
                  {item.withholdingBase}
                </Td>
                <Td align="right" sm="hide">
                  {item.incomeTax}
                  {item.incomeTaxDetail ? (
                    <span className="block text-[11px] text-muted">{item.incomeTaxDetail}</span>
                  ) : null}
                </Td>
                <Td align="right" sm="hide">
                  {item.residentTax}
                </Td>
                <Td align="right" sm="hide">
                  {item.totalDeductions}
                </Td>
                <Td align="right" className="font-bold">
                  {item.netPay}
                </Td>
                <Td sm="full">
                  <Link
                    href={`/payroll/runs/${run.id}/payslips/${item.employeeId}`}
                    className="text-[13px] font-bold underline underline-offset-4"
                  >
                    給与明細
                  </Link>
                  <span className="ml-2 text-[12px] text-muted md:hidden">
                    総支給 {item.grossPay} · 控除計 {item.totalDeductions}
                  </span>
                </Td>
              </TableRow>
            ))}
            <TableRow {...COLUMNS} className="bg-surface-2 font-bold">
              <Td>合計（{run.totals.headcount} 人）</Td>
              <Td align="right" sm="hide">
                {formatYen(run.totals.grossPay)}
              </Td>
              <Td align="right" sm="hide">
                {formatYen(run.totals.socialInsuranceEmployee)}
              </Td>
              <Td align="right" sm="hide">
                {formatYen(run.totals.employmentInsuranceEmployee)}
              </Td>
              <Td sm="hide" />
              <Td align="right" sm="hide">
                {formatYen(run.totals.incomeTax)}
              </Td>
              <Td align="right" sm="hide">
                {formatYen(run.totals.residentTax)}
              </Td>
              <Td align="right" sm="hide">
                {formatYen(run.totals.totalDeductions)}
              </Td>
              <Td align="right">{formatYen(run.totals.netPay)}</Td>
              <Td sm="hide" />
            </TableRow>
          </Table>
          {run.items
            .filter((item) => item.adjustmentNote)
            .map((item) => (
              <p key={item.employeeId} className="text-[12px] text-muted">
                調整のメモ（{item.name}）: {item.adjustmentNote}
              </p>
            ))}
        </Section>

        <Section title="仕訳">
          <ul className="rounded-card border border-border bg-surface">
            <EntryRefLink label="本人分（給与）" entry={run.payEntry} />
            <EntryRefLink
              label={`会社負担（法定福利費 ${yearMonthLabel(run.premiumMonth)}分 ${formatYen(run.totals.employerTotal)} 円）`}
              entry={run.employerEntry}
            />
          </ul>
        </Section>

        <Section title="納付の予定">
          {run.schedule.length === 0 ? (
            <p className="text-[13px] text-muted">この支給から納付する額はありません。</p>
          ) : (
            <>
              <Table label="納付の予定">
                <TableHead {...SCHEDULE_COLUMNS}>
                  <Th>区分</Th>
                  <Th sm="hide">期限</Th>
                  <Th sm="hide">対象</Th>
                  <Th align="right">額（円）</Th>
                  <Th sm="hide">状態</Th>
                </TableHead>
                {run.schedule.map((row) => (
                  <TableRow key={row.id} {...SCHEDULE_COLUMNS} muted={row.completedAt !== null}>
                    <Td className="font-bold">
                      {row.categoryLabel}
                      <span className="block text-[12px] font-normal text-muted md:hidden">
                        {scheduleTarget(row.title)} · 期限{" "}
                        <span className="num">{displayDate(row.dueDate)}</span>
                      </span>
                    </Td>
                    <Td sm="hide" className="num text-[13px]">
                      {displayDate(row.dueDate)}
                    </Td>
                    <Td sm="hide" className="text-[13px]">
                      {scheduleTarget(row.title)}
                    </Td>
                    <Td align="right" className="font-bold">
                      {formatYen(row.amount)}
                    </Td>
                    <Td sm="full" className="text-[13px] text-muted">
                      {row.completedAt ? (
                        <>
                          納付済み
                          {row.paymentEntry ? (
                            <>
                              {" "}
                              <Link
                                href={`/entries/${row.paymentEntry.id}`}
                                className="font-bold text-text underline underline-offset-4"
                              >
                                {entryNo(row.paymentEntry.no)}
                              </Link>
                            </>
                          ) : null}
                        </>
                      ) : row.dueDate < today ? (
                        <span className="font-bold text-warn">期限を過ぎています</span>
                      ) : (
                        "未納付"
                      )}
                    </Td>
                  </TableRow>
                ))}
              </Table>
              <p className="text-[12px] text-muted">
                額は確定した支給から導いた予定額です（同じ期限に入るほかの支給の分を含みます）。納付の登録は{" "}
                <Link href="/payroll" className="font-bold underline underline-offset-4">
                  給与
                </Link>{" "}
                の納付の予定から行います。
              </p>
            </>
          )}
        </Section>
      </div>
    </>
  );
}
