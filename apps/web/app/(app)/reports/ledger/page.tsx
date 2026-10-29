import { normalSide } from "@niho-finance/ledger";
import {
  buildGeneralLedger,
  ledgerAccountChoices,
  periodSearchParams,
  type GeneralLedgerReport,
  type LedgerRow,
  type ReportAccount,
  type ReportPeriod,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Td } from "@/components/ui/table";
import { formatAmountDisplay, formatDate } from "@/lib/format";
import { AutoSubmitSelect } from "../_components/auto-submit-select";
import { NoFiscalYear } from "../_components/empty";
import { FilterChips } from "../_components/filter-chips";
import { Note, SectionHeading } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import { WideHead, WideRow, WideTable } from "../_components/wide-table";
import { segmentName } from "../_lib/format";
import { entryHref } from "../_lib/links";
import {
  loadReports,
  parseReportParams,
  reportHref,
  resolvePeriodOrNull,
  type ExtraParams,
} from "../_lib/query";

export const metadata: Metadata = { title: "総勘定元帳" };

const COLUMNS = "6rem 3.75rem minmax(10rem,1.5fr) minmax(8.5rem,1fr) 6.5rem 6.5rem 7rem";
const MIN_WIDTH = 880;

function accountOption(account: ReportAccount) {
  return (
    <option key={account.id} value={account.id}>
      {account.code} {account.name}
    </option>
  );
}

/**
 * The account select: 動きのある科目 first, then the rest (14-reports §8). Submits on change and
 * keeps 集計's partner / tag filters (§15.3).
 */
function AccountPicker({
  period,
  accountId,
  filters,
  active,
  others,
}: {
  period: ReportPeriod;
  accountId: string | null;
  filters: ExtraParams;
  active: readonly ReportAccount[];
  others: readonly ReportAccount[];
}) {
  const kept = Object.entries({ ...periodSearchParams(period), ...filters }).filter(
    (entry): entry is [string, string | number] =>
      entry[1] !== null && entry[1] !== undefined && entry[1] !== "",
  );
  return (
    <form
      method="get"
      action="/reports/ledger"
      aria-label="科目"
      className="mb-3 flex flex-wrap items-center gap-2"
    >
      {kept.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <AutoSubmitSelect
        name="account"
        aria-label="科目"
        defaultValue={accountId ?? ""}
        className="w-auto max-w-full min-w-0 sm:min-w-64"
      >
        {accountId ? null : <option value="">科目を選ぶ</option>}
        {active.length > 0 ? (
          <optgroup label="動きのある科目">{active.map(accountOption)}</optgroup>
        ) : null}
        {others.length > 0 ? <optgroup label="その他">{others.map(accountOption)}</optgroup> : null}
      </AutoSubmitSelect>
      <noscript>
        <Button type="submit" size="sm">
          表示
        </Button>
      </noscript>
      <Link
        href={reportHref("trial-balance", period)}
        className="ml-auto text-[13px] font-bold text-muted hover:text-text"
      >
        ‹ 試算表へ
      </Link>
    </form>
  );
}

function EntryNo({ row }: { row: LedgerRow }) {
  return (
    <Link href={entryHref(row.entryId)} className="underline-offset-4 hover:underline">
      {row.no}
    </Link>
  );
}

function LedgerTable({ report }: { report: GeneralLedgerReport }) {
  const blank = <Td />;
  return (
    <WideTable label="総勘定元帳" minWidth={MIN_WIDTH}>
      <WideHead columns={COLUMNS}>
        <span role="columnheader">日付</span>
        <span role="columnheader">No.</span>
        <span role="columnheader">摘要</span>
        <span role="columnheader">相手科目</span>
        <span role="columnheader" className="text-right">
          借方（円）
        </span>
        <span role="columnheader" className="text-right">
          貸方（円）
        </span>
        <span role="columnheader" className="text-right">
          残高（円）
        </span>
      </WideHead>
      <WideRow columns={COLUMNS} className="text-muted">
        <Td className="num">{formatDate(report.period.from)}</Td>
        {blank}
        <Td className="font-bold">繰越</Td>
        {blank}
        {blank}
        {blank}
        <Td align="right">{formatAmountDisplay(report.opening)}</Td>
      </WideRow>
      {report.rows.map((row, i) => {
        const voided = row.status === "voided";
        return (
          <WideRow
            key={`${row.entryId}:${i}`}
            columns={COLUMNS}
            className={voided ? "text-muted" : ""}
          >
            <Td className="num">{formatDate(row.entryDate)}</Td>
            <Td className="num">
              <EntryNo row={row} />
            </Td>
            <Td className="truncate">
              {row.description}
              {row.lineDescription ? (
                <span className="text-muted">（{row.lineDescription}）</span>
              ) : null}
              {row.stateLabel ? (
                <span className="ml-2 text-[11px] font-semibold text-muted">{row.stateLabel}</span>
              ) : null}
            </Td>
            <Td className="truncate text-[13px]">{row.counterpart}</Td>
            <Td align="right">{row.debit === 0n ? "" : formatAmountDisplay(row.debit)}</Td>
            <Td align="right">{row.credit === 0n ? "" : formatAmountDisplay(row.credit)}</Td>
            <Td align="right">{formatAmountDisplay(row.balance)}</Td>
          </WideRow>
        );
      })}
      <WideRow columns={COLUMNS} className="border-t border-t-border-2 font-bold">
        {blank}
        {blank}
        <Td>合計</Td>
        {blank}
        <Td align="right">{formatAmountDisplay(report.debitTotal)}</Td>
        <Td align="right">{formatAmountDisplay(report.creditTotal)}</Td>
        {blank}
      </WideRow>
      <WideRow columns={COLUMNS} className="font-bold">
        <Td className="num">{formatDate(report.period.to)}</Td>
        {blank}
        <Td>残高</Td>
        {blank}
        {blank}
        {blank}
        <Td align="right">{formatAmountDisplay(report.closing)}</Td>
      </WideRow>
    </WideTable>
  );
}

/**
 * 総勘定元帳 (14-reports §8): one account (or one sub-account) over the period with 繰越, the
 * running balance on the account's normal side, 合計 and 残高. Without an account: the accounts
 * to choose from.
 */
export default async function LedgerPage({ searchParams }: PageProps<"/reports/ledger">) {
  const { source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const choices = ledgerAccountChoices(source, period);
  const report = params.account
    ? buildGeneralLedger(source, period, {
        accountId: params.account,
        subAccountId: params.sub,
        partnerId: params.partner,
        tagId: params.tag,
      })
    : null;
  const segment = period.segmentId ? segmentName(source.segments, period.segmentId) : null;
  // 集計's filters (§15.3) stay on every link of the tab until their chip's × removes them.
  const filters = { partner: params.partner, tag: params.tag };
  const kept = { account: params.account, sub: params.sub, ...filters };
  const chips = [
    ...(report?.partnerFilter
      ? [
          {
            filter: report.partnerFilter,
            removeHref: reportHref("ledger", period, { ...kept, partner: null }),
          },
        ]
      : []),
    ...(report?.tagFilter
      ? [
          {
            filter: report.tagFilter,
            removeHref: reportHref("ledger", period, { ...kept, tag: null }),
          },
        ]
      : []),
  ];

  return (
    <ReportsFrame
      tab="ledger"
      source={source}
      period={period}
      hidden={kept}
      exportParams={kept}
      exportable={report !== null && !report.empty}
    >
      <AccountPicker
        period={period}
        accountId={params.account}
        filters={filters}
        active={choices.active}
        others={choices.others}
      />
      <FilterChips chips={chips} />
      {report ? (
        <div className="flex flex-col gap-3">
          {report.subAccounts.length > 0 ? (
            <nav aria-label="補助科目" className="flex flex-wrap gap-1.5">
              {[null, ...report.subAccounts].map((sub) => {
                const active = (sub?.id ?? null) === (report.subAccount?.id ?? null);
                return (
                  <Link
                    key={sub?.id ?? "all"}
                    href={reportHref("ledger", period, {
                      ...filters,
                      account: report.account.id,
                      sub: sub?.id ?? null,
                    })}
                    aria-current={active ? "true" : undefined}
                    className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${
                      active ? "border-text text-text" : "border-border text-muted hover:text-text"
                    }`}
                  >
                    {sub ? sub.name : "全部"}
                  </Link>
                );
              })}
            </nav>
          ) : null}
          <SectionHeading
            aside={`残高は${normalSide(report.account.kind) === "debit" ? "借方" : "貸方"}をプラスで表示`}
          >
            {report.account.code} {report.account.name}
            {report.subAccount ? ` / ${report.subAccount.name}` : ""}
          </SectionHeading>
          {segment ? <Note>{segment} の行だけを足しています（繰越も同じ）。</Note> : null}
          {chips.length > 0 ? (
            <Note>
              絞り込みに当たる行だけを足しています（繰越も同じ）。取引先は集計と同じ決め方です。
            </Note>
          ) : null}
          {report.empty ? (
            <EmptyState
              title="この期間にこの科目の仕訳はありません"
              description="期間か科目を変えて表示します。"
            />
          ) : (
            <LedgerTable report={report} />
          )}
        </div>
      ) : (
        <section aria-labelledby="ledger-accounts" className="flex flex-col gap-4">
          <SectionHeading id="ledger-accounts">科目を選ぶ</SectionHeading>
          {[
            { label: "動きのある科目", accounts: choices.active },
            { label: "その他", accounts: choices.others },
          ].map((group) =>
            group.accounts.length > 0 ? (
              <div key={group.label}>
                <h3 className="mb-1 text-[12px] font-bold text-muted">{group.label}</h3>
                <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                  {group.accounts.map((account) => (
                    <li key={account.id} className="border-b border-border">
                      <Link
                        href={reportHref("ledger", period, { ...filters, account: account.id })}
                        className="flex min-h-10 items-center gap-2 px-1 text-[14px] hover:bg-black/[0.02]"
                      >
                        <span className="num text-muted">{account.code}</span>
                        <span className="min-w-0 truncate">{account.name}</span>
                        <span aria-hidden="true" className="ml-auto text-muted-2">
                          ›
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </section>
      )}
    </ReportsFrame>
  );
}
