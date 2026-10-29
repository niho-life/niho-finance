import {
  BREAKDOWN_AXES,
  BREAKDOWN_AXIS_LABELS,
  BREAKDOWN_SIDE_LABELS,
  BREAKDOWN_SIDES,
  BREAKDOWN_SORT_LABELS,
  BREAKDOWN_SORTS,
  BREAKDOWN_TOP_LABELS,
  BREAKDOWN_TOPS,
  buildBreakdown,
  type BreakdownRow,
  type ReportPeriod,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { Td } from "@/components/ui/table";
import { formatAmount } from "@/lib/format";
import { AutoSubmitSelect } from "../_components/auto-submit-select";
import { COMPACT_CONTROL } from "../_components/condition-form";
import { NoFiscalYear } from "../_components/empty";
import { FilterChips } from "../_components/filter-chips";
import { Note } from "../_components/notices";
import { ReportsFrame } from "../_components/reports-frame";
import { stickyCell, WideHead, WideRow, WideTable } from "../_components/wide-table";
import { segmentName } from "../_lib/format";
import {
  breakdownLinkParams,
  loadReports,
  parseReportParams,
  reportHref,
  resolvePeriodOrNull,
  type ReportParams,
} from "../_lib/query";

export const metadata: Metadata = { title: "集計" };

/**
 * The general ledger's period for a drill-down: 今月 still shows every month of the year here
 * (§4, §15), so the ledger opens on the year and its movement equals the row's 合計.
 */
function ledgerPeriodOf(period: ReportPeriod): ReportPeriod {
  if (period.preset !== "month") return period;
  return {
    ...period,
    preset: "year",
    from: period.fiscalYear.startDate,
    to: period.fiscalYear.endDate,
  };
}

/** Where a row leads (§15.3): the ledger (科目) or this tab on the 科目 axis with the row's value. */
function drillHref(row: BreakdownRow, period: ReportPeriod, params: ReportParams): string | null {
  const drill = row.drill;
  if (!drill) return null;
  if (drill.accountId) {
    return reportHref("ledger", ledgerPeriodOf(period), {
      account: drill.accountId,
      partner: params.partner,
      tag: params.tag,
    });
  }
  const target = drill.segmentId ? { ...period, segmentId: drill.segmentId } : period;
  return reportHref(
    "breakdown",
    target,
    breakdownLinkParams(params, {
      axis: "account",
      partner: drill.partnerId ?? params.partner,
      tag: drill.tagId ?? params.tag,
    }),
  );
}

/** 軸 ・ 収益 / 費用 ・ 上位 ・ 並び: controls of the condition form (selects submit on change). */
function BreakdownControls({ period, params }: { period: ReportPeriod; params: ReportParams }) {
  const { axis, side, top, sort } = params.breakdown;
  return (
    <>
      <AutoSubmitSelect
        name="axis"
        aria-label="集計の軸"
        defaultValue={axis}
        className={COMPACT_CONTROL}
      >
        {BREAKDOWN_AXES.map((value) => (
          <option key={value} value={value}>
            {BREAKDOWN_AXIS_LABELS[value]}別
          </option>
        ))}
      </AutoSubmitSelect>
      <div
        role="group"
        aria-label="収益か費用"
        className="inline-flex rounded-[10px] border border-border bg-surface p-[3px]"
      >
        {BREAKDOWN_SIDES.map((value) => {
          const active = value === side;
          return (
            <Link
              key={value}
              href={reportHref("breakdown", period, breakdownLinkParams(params, { side: value }))}
              aria-current={active ? "true" : undefined}
              className={`rounded-[7px] px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap ${
                active ? "bg-text text-white" : "text-muted hover:text-text"
              }`}
            >
              {BREAKDOWN_SIDE_LABELS[value]}
            </Link>
          );
        })}
      </div>
      <AutoSubmitSelect
        name="top"
        aria-label="表示する件数"
        defaultValue={top}
        className={COMPACT_CONTROL}
      >
        {BREAKDOWN_TOPS.map((value) => (
          <option key={value} value={value}>
            {BREAKDOWN_TOP_LABELS[value]}
          </option>
        ))}
      </AutoSubmitSelect>
      <AutoSubmitSelect
        name="sort"
        aria-label="並び"
        defaultValue={sort}
        className={COMPACT_CONTROL}
      >
        {BREAKDOWN_SORTS.map((value) => (
          <option key={value} value={value}>
            {BREAKDOWN_SORT_LABELS[value]}
          </option>
        ))}
      </AutoSubmitSelect>
    </>
  );
}

/**
 * 集計 (14-reports §15): revenue or expenses by 取引先 / タグ / 科目 / セグメント and by month, the
 * top n with 「その他」, the share of each row. Rows lead to the 科目 axis filtered by the row's value,
 * and from there to the general ledger and the entries.
 */
export default async function BreakdownPage({ searchParams }: PageProps<"/reports/breakdown">) {
  const { source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const { axis, side } = params.breakdown;
  const report = buildBreakdown(source, period, {
    ...params.breakdown,
    partnerId: params.partner,
    tagId: params.tag,
  });
  const own = breakdownLinkParams(params);

  const count = report.columns.length + 1;
  const columns = `minmax(10rem,1.4fr) repeat(${count}, minmax(6.25rem,1fr)) 4.5rem`;
  const minWidth = 160 + count * 100 + 72 + (count + 1) * 12 + 28;
  const last = count - 1;
  const overlap = report.overlap[report.overlap.length - 1] ?? 0n;

  const chips = [
    ...(report.partnerFilter
      ? [
          {
            filter: report.partnerFilter,
            removeHref: reportHref(
              "breakdown",
              period,
              breakdownLinkParams(params, { partner: null }),
            ),
          },
        ]
      : []),
    ...(report.tagFilter
      ? [
          {
            filter: report.tagFilter,
            removeHref: reportHref("breakdown", period, breakdownLinkParams(params, { tag: null })),
          },
        ]
      : []),
  ];

  return (
    <ReportsFrame
      tab="breakdown"
      source={source}
      period={period}
      hidden={{ side: own.side, partner: own.partner, tag: own.tag }}
      linkParams={{ axis: own.axis, top: own.top, sort: own.sort }}
      controls={<BreakdownControls period={period} params={params} />}
      segmentSwitch={axis !== "segment"}
      exportParams={own}
      exportable={!report.empty}
    >
      <FilterChips chips={chips} />
      {report.empty ? (
        <EmptyState
          title={`この期間に${BREAKDOWN_SIDE_LABELS[side]}の仕訳がありません`}
          description={
            chips.length > 0
              ? "絞り込みを外すか、期間を変えて表示します。"
              : "期間を変えて表示します。"
          }
        />
      ) : (
        <>
          <Note>
            {report.segmentId ? `${segmentName(source.segments, report.segmentId)} · ` : ""}
            金額の単位は円です。構成比は合計に対する割合です。
          </Note>
          {report.hasOverlap ? (
            <Note>
              複数のタグがついた行は、それぞれのタグに数えています（重なり {formatAmount(overlap)}{" "}
              円）。
            </Note>
          ) : null}
          <WideTable label={report.title} minWidth={minWidth}>
            <WideHead columns={columns}>
              <span role="columnheader" className={stickyCell({ background: "surface-2" })}>
                {BREAKDOWN_AXIS_LABELS[axis]}
              </span>
              {report.columns.map((column) => (
                <span key={column.key} role="columnheader" className="text-right">
                  {column.label}
                </span>
              ))}
              <span role="columnheader" className="text-right">
                合計
              </span>
              <span role="columnheader" className="text-right">
                構成比
              </span>
            </WideHead>
            {report.rows.map((row) => {
              const href = drillHref(row, period, params);
              const isTotal = row.kind === "total";
              const label = (
                <>
                  {row.code ? <span className="num mr-1.5 text-muted">{row.code}</span> : null}
                  {row.label}
                </>
              );
              return (
                <WideRow
                  key={row.key}
                  columns={columns}
                  className={isTotal ? "border-t border-t-border-2 font-bold" : ""}
                >
                  <span
                    role="rowheader"
                    className={`min-w-0 truncate ${
                      row.kind === "none" || row.kind === "other" ? "text-muted" : ""
                    } ${stickyCell()}`}
                  >
                    {href ? (
                      <Link
                        href={href}
                        className="underline-offset-4 hover:underline"
                        prefetch={false}
                      >
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </span>
                  {row.values.map((value, i) => (
                    <Td key={i} align="right" className={i === last ? "font-bold" : ""}>
                      {formatAmount(value)}
                    </Td>
                  ))}
                  <Td align="right" className="text-[13px] text-muted">
                    {row.share}
                  </Td>
                </WideRow>
              );
            })}
          </WideTable>
          <p className="mt-2 text-[12px] text-muted">
            {axis === "account"
              ? "科目から総勘定元帳へ、総勘定元帳の No. から仕訳へ辿れます。"
              : "行を開くと、その値で絞った科目別の集計になります。"}
          </p>
        </>
      )}
    </ReportsFrame>
  );
}
