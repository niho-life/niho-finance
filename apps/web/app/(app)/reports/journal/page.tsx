import { buildJournal, type JournalEntryRow } from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import { Td } from "@/components/ui/table";
import { formatAmount, formatDate } from "@/lib/format";
import { AutoSubmitSelect } from "../_components/auto-submit-select";
import { COMPACT_CONTROL } from "../_components/condition-form";
import { NoEntries, NoFiscalYear } from "../_components/empty";
import { Pagination } from "../_components/pagination";
import { ReportsFrame } from "../_components/reports-frame";
import { WideHead, WideRow, WideTable } from "../_components/wide-table";
import { entryHref } from "../_lib/links";
import { loadReports, parseReportParams, reportHref, resolvePeriodOrNull } from "../_lib/query";

export const metadata: Metadata = { title: "仕訳帳" };

const COLUMNS =
  "2.75rem minmax(10rem,1.4fr) 6.25rem 6.25rem minmax(8.5rem,1fr) minmax(6rem,0.8fr) minmax(7rem,0.9fr) minmax(7.5rem,1fr)";
const MIN_WIDTH = 980;

function EntryNo({ entry }: { entry: JournalEntryRow }) {
  const href = entryHref(entry.id);
  const text = `No. ${entry.no}`;
  return href ? (
    <Link href={href} className="underline-offset-4 hover:underline">
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  );
}

function EntryRows({ entry }: { entry: JournalEntryRow }) {
  const voided = entry.status === "voided";
  return (
    <div role="rowgroup">
      <div
        role="row"
        className={`data-group text-[13px] font-normal ${voided ? "text-muted" : "text-text"}`}
      >
        <span
          role="rowheader"
          className="sticky left-3.5 inline-flex max-w-full flex-wrap items-baseline gap-x-3 gap-y-0.5"
        >
          <span className="num">{formatDate(entry.entryDate)}</span>
          <span className="num">
            <EntryNo entry={entry} />
          </span>
          <span className="font-bold">{entry.description}</span>
          <span className="text-[11px] font-semibold text-muted">{entry.kindLabel}</span>
          {entry.stateLabel ? (
            <span className="text-[11px] font-semibold text-muted">{entry.stateLabel}</span>
          ) : null}
        </span>
      </div>
      {entry.lines.map((line) => (
        <WideRow key={line.lineNo} columns={COLUMNS} className={voided ? "text-muted" : ""}>
          <Td className="text-[12px] text-muted">{line.side === "debit" ? "借方" : "貸方"}</Td>
          <Td className="truncate">
            {line.accountName}
            {line.subAccountName ? (
              <span className="text-muted"> / {line.subAccountName}</span>
            ) : null}
          </Td>
          <Td align="right">{line.side === "debit" ? formatAmount(line.amount) : ""}</Td>
          <Td align="right">{line.side === "credit" ? formatAmount(line.amount) : ""}</Td>
          <Td className="truncate text-[13px]">
            {line.taxName}
            {line.taxAmount !== 0n ? (
              <span className="num text-muted">（{formatAmount(line.taxAmount)}）</span>
            ) : null}
          </Td>
          <Td className="truncate text-[13px]">{line.segmentName ?? ""}</Td>
          <Td className="truncate text-[13px]">{line.partnerName ?? ""}</Td>
          <Td className="truncate text-[13px]">
            {line.description ?? ""}
            {line.memoTagNames.length > 0 ? (
              <span className="text-muted">
                {line.description ? " " : ""}
                {line.memoTagNames.map((name) => `#${name}`).join(" ")}
              </span>
            ) : null}
          </Td>
        </WideRow>
      ))}
    </div>
  );
}

/**
 * 仕訳帳 (14-reports §7): every entry of the period in date and number order, 50 per page, with
 * its lines. Voided entries stay (muted); 「登録済みだけ」 leaves out voided entries and reversals.
 */
export default async function JournalPage({ searchParams }: PageProps<"/reports/journal">) {
  const { source, today } = await loadReports();
  const params = parseReportParams(await searchParams, source);
  const period = resolvePeriodOrNull(source, params.query, today);
  if (!period) return <NoFiscalYear />;

  const report = buildJournal(source, period, { status: params.status, page: params.page });
  const status = report.status === "all" ? null : report.status;

  return (
    <ReportsFrame
      tab="journal"
      source={source}
      period={period}
      linkParams={{ status }}
      exportParams={{ status }}
      exportable={!report.empty}
      controls={
        <AutoSubmitSelect
          name="status"
          aria-label="状態"
          defaultValue={report.status}
          className={COMPACT_CONTROL}
        >
          <option value="all">すべて</option>
          <option value="posted">登録済みだけ</option>
        </AutoSubmitSelect>
      }
    >
      {report.empty ? (
        <NoEntries />
      ) : (
        <div className="flex flex-col gap-3">
          <WideTable label="仕訳帳" minWidth={MIN_WIDTH}>
            <WideHead columns={COLUMNS}>
              <span role="columnheader">貸借</span>
              <span role="columnheader">科目 / 補助科目</span>
              <span role="columnheader" className="text-right">
                借方（円）
              </span>
              <span role="columnheader" className="text-right">
                貸方（円）
              </span>
              <span role="columnheader">税区分（税額）</span>
              <span role="columnheader">セグメント</span>
              <span role="columnheader">取引先</span>
              <span role="columnheader">行の摘要</span>
            </WideHead>
            {report.entries.map((entry) => (
              <EntryRows key={entry.id} entry={entry} />
            ))}
          </WideTable>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
            <div className="flex gap-2">
              <dt className="text-muted">借方合計</dt>
              <dd className="num font-bold">{formatAmount(report.debitTotal)} 円</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">貸方合計</dt>
              <dd className="num font-bold">{formatAmount(report.creditTotal)} 円</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">仕訳</dt>
              <dd className="num font-bold">{report.total.toLocaleString("ja-JP")} 件</dd>
            </div>
          </dl>
          {report.pageCount > 1 ? (
            <Pagination
              page={report.page}
              pageCount={report.pageCount}
              total={report.total}
              unit="件"
              hrefFor={(page) => reportHref("journal", period, { status, page })}
            />
          ) : null}
        </div>
      )}
    </ReportsFrame>
  );
}
