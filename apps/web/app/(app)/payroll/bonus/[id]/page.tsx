import { getBonusRun, todayInJapan, type BonusRunDetail } from "@niho-finance/db";
import { displayDate } from "@niho-finance/ledger";
import { yearMonthLabel } from "@niho-finance/payroll";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { entryNo, formatDateTime, formatYenDisplay } from "@/lib/format";
import { bonusTableTitles, storedBonusNotes, toBonusItemView } from "../../_lib/bonus-views";
import { WORKER_KIND_LABELS } from "../../_lib/labels";
import { scheduleTarget } from "../../_lib/views";

export const metadata: Metadata = { title: "確定した賞与" };

const COLUMNS = {
  columns: "minmax(0,1.3fr) repeat(6,minmax(0,1fr)) minmax(0,1.2fr) minmax(0,1.1fr) 76px",
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

function EntryRefLink({ label, entry }: { label: string; entry: BonusRunDetail["payEntry"] }) {
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

/** 確定した賞与 (22-payroll §10.5): read only — the settings, the results, the entries, the payslips. */
export default async function BonusRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getBonusRun(await db(), id);
  if (!run) notFound();
  const today = todayInJapan();
  const items = run.items.map((item) =>
    toBonusItemView(item, storedBonusNotes(item, run.payMonth)),
  );
  const label = `${run.title}（${yearMonthLabel(run.payMonth)}支給）`;

  return (
    <>
      <PageHeader
        title={label}
        meta={`確定済み · ${run.confirmedBy} が ${formatDateTime(run.confirmedAt)} に確定`}
        back={{ href: "/payroll/bonus", label: "賞与" }}
      />
      <p className="mb-6 rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
        確定した賞与は変えられません。直すときは取引で仕訳を訂正してください。
      </p>
      <div className="flex flex-col gap-8">
        {run.warnings.length > 0 ? (
          <div className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">
            {run.warnings.map((warning) => (
              <p key={warning.message}>{warning.message}</p>
            ))}
          </div>
        ) : null}

        <Section title="賞与の設定">
          <dl className="grid gap-4 rounded-card border border-border bg-surface p-4 sm:grid-cols-2 md:grid-cols-3">
            <Setting label="支払日">
              <span className="num">{displayDate(run.paymentDate)}</span>
            </Setting>
            <Setting label="賞与の計算期間">
              {run.calcPeriodOver6Months ? "6 か月超" : "6 か月以下"}
            </Setting>
            <Setting label="支払元">
              {run.payFromWallet ? run.payFromWallet.name : "未払金〔給与〕に計上"}
            </Setting>
            <Setting label="源泉所得税の納期の特例">
              {run.withholdingSpecialDue ? "承認あり" : "なし"}
            </Setting>
            <Setting label="社会保険料の対象月">{yearMonthLabel(run.payMonth)}分</Setting>
            <Setting label="使った表の版">{bonusTableTitles(run.tables).join(" / ")}</Setting>
          </dl>
        </Section>

        <Section title="従業員ごとの結果">
          <Table label="従業員ごとの結果" minWidth={1040}>
            <TableHead {...COLUMNS}>
              <Th>名前</Th>
              <Th align="right" sm="hide">
                賞与（円）
              </Th>
              <Th align="right" sm="hide">
                標準賞与額（円）
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
              <Th sm="hide">計算方法</Th>
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
                  {item.bonus}
                </Td>
                <Td align="right" sm="hide">
                  {item.standardBonus}
                  {item.standardBonusDetail ? (
                    <span className="block text-[11px] text-muted">{item.standardBonusDetail}</span>
                  ) : null}
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
                </Td>
                <Td sm="hide" className="text-[12px]">
                  {item.method}
                  <span className="block text-[11px] text-muted">{item.methodDetail}</span>
                </Td>
                <Td align="right" className="font-bold">
                  {item.netPay}
                </Td>
                <Td sm="full">
                  <Link
                    href={`/payroll/bonus/${run.id}/payslips/${item.employeeId}`}
                    className="text-[13px] font-bold underline underline-offset-4"
                  >
                    賞与明細を開く
                  </Link>
                  <span className="ml-2 text-[12px] text-muted md:hidden">
                    賞与 {item.bonus} · 控除計 {item.totalDeductions}
                  </span>
                </Td>
              </TableRow>
            ))}
            <TableRow {...COLUMNS} className="bg-surface-2 font-bold">
              <Td>合計（{run.totals.headcount} 人）</Td>
              <Td align="right" sm="hide">
                {formatYenDisplay(run.totals.grossPay)}
              </Td>
              <Td sm="hide" />
              <Td align="right" sm="hide">
                {formatYenDisplay(run.totals.socialInsuranceEmployee)}
              </Td>
              <Td align="right" sm="hide">
                {formatYenDisplay(run.totals.employmentInsuranceEmployee)}
              </Td>
              <Td sm="hide" />
              <Td align="right" sm="hide">
                {formatYenDisplay(run.totals.incomeTax)}
              </Td>
              <Td sm="hide" />
              <Td align="right">{formatYenDisplay(run.totals.netPay)}</Td>
              <Td sm="hide" />
            </TableRow>
          </Table>
        </Section>

        <Section title="仕訳">
          <ul className="rounded-card border border-border bg-surface">
            <EntryRefLink label="本人分（賞与）" entry={run.payEntry} />
            <EntryRefLink
              label={`会社負担（法定福利費 ${formatYenDisplay(run.totals.employerTotal)} 円）`}
              entry={run.employerEntry}
            />
          </ul>
        </Section>

        <Section title="納付の予定と届出">
          {run.schedule.length === 0 && !run.filing ? (
            <p className="text-[13px] text-muted">この賞与から納付する額はありません。</p>
          ) : (
            <>
              <Table label="納付の予定と届出">
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
                      {formatYenDisplay(row.amount)}
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
                {run.filing ? (
                  <TableRow {...SCHEDULE_COLUMNS} muted={run.filing.completedAt !== null}>
                    <Td className="font-bold">
                      届出
                      <span className="block text-[12px] font-normal text-muted md:hidden">
                        {scheduleTarget(run.filing.title)} · 期限{" "}
                        <span className="num">{displayDate(run.filing.dueDate)}</span>
                      </span>
                    </Td>
                    <Td sm="hide" className="num text-[13px]">
                      {displayDate(run.filing.dueDate)}
                    </Td>
                    <Td sm="hide" className="text-[13px]">
                      被保険者賞与支払届
                    </Td>
                    <Td align="right">—</Td>
                    <Td sm="full" className="text-[13px] text-muted">
                      {run.filing.completedAt ? (
                        "提出済み"
                      ) : run.filing.dueDate < today ? (
                        <span className="font-bold text-warn">期限を過ぎています</span>
                      ) : (
                        "未提出"
                      )}
                    </Td>
                  </TableRow>
                ) : null}
              </Table>
              <p className="text-[12px] text-muted">
                額は確定した支給と賞与から導いた予定額です（同じ期限に入る給与の分を含みます）。納付の登録は{" "}
                <Link href="/payroll" className="font-bold underline underline-offset-4">
                  給与
                </Link>{" "}
                の納付の予定から、届出の完了は{" "}
                <Link href="/calendar" className="font-bold underline underline-offset-4">
                  期限
                </Link>{" "}
                から記録します。
              </p>
            </>
          )}
        </Section>
      </div>
    </>
  );
}
