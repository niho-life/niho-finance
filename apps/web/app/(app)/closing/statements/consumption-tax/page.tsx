import {
  buildConsumptionTaxSummary,
  DEEMED_PURCHASE_PERCENT,
  SIMPLIFIED_TAX_CLASS_LABELS,
  TAX_RATE_LABELS,
  type ConsumptionTaxCategoryRow,
  type ConsumptionTaxEstimate,
  type ConsumptionTaxSubtotal,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { formatAmountDisplay, formatDate, formatPeriod } from "@/lib/format";
import { WarningBand } from "../../../reports/_components/notices";
import { FiscalYearSelect, NoFiscalYear, Section } from "../_components/parts";
import { DownloadLink } from "../_components/statement-tables";
import { statementExportHref, statementsHref } from "../_lib/links";
import { loadStatementsBook } from "../_lib/load";
import { firstParam, resolveStatementsYear } from "../_lib/query";

export const metadata: Metadata = { title: "消費税の集計" };

const CATEGORY_COLUMNS = {
  columns: "minmax(10rem,1fr) 4.5rem repeat(3, minmax(6.5rem,8.5rem))",
  mobileColumns: "minmax(0,1fr) auto",
};

const ESTIMATE_COLUMNS = {
  columns: "minmax(8rem,1fr) repeat(3, minmax(5.5rem,7.5rem))",
  mobileColumns: "minmax(0,1fr) auto",
};

function TableBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <div role="table" aria-label={label} className="md:min-w-[560px]">
        {children}
      </div>
    </div>
  );
}

function CategoryRow({
  label,
  row,
  subtotal = false,
}: {
  label: string;
  row: ConsumptionTaxCategoryRow | ConsumptionTaxSubtotal;
  subtotal?: boolean;
}) {
  return (
    <TableRow
      {...CATEGORY_COLUMNS}
      className={subtotal ? "border-t border-t-border-2 font-bold" : ""}
    >
      <Td>{label}</Td>
      <Td align="right" sm="hide">
        {row.lineCount}
      </Td>
      <Td align="right" sm="hide">
        {formatAmountDisplay(row.amountInclusive)}
      </Td>
      <Td align="right" sm="hide">
        {formatAmountDisplay(row.amountExclusive)}
      </Td>
      <Td align="right">{formatAmountDisplay(row.taxAmount)}</Td>
    </TableRow>
  );
}

function EstimateTable({ estimate }: { estimate: ConsumptionTaxEstimate }) {
  const taxClass = estimate.simplifiedTaxClass;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[15px] font-bold">{estimate.label}</h3>
        {estimate.current ? (
          <span className="rounded-full border border-border-2 px-2 py-0.5 text-[11px] font-bold text-muted">
            この期の方式
          </span>
        ) : null}
      </div>
      {taxClass ? (
        <p className="text-[13px] text-muted">
          事業区分: {SIMPLIFIED_TAX_CLASS_LABELS[taxClass]}（みなし仕入率{" "}
          {DEEMED_PURCHASE_PERCENT[taxClass]}%）。決算書の設定で変えます。
        </p>
      ) : null}
      <TableBox label={estimate.label}>
        <TableHead {...ESTIMATE_COLUMNS}>
          <Th>項目</Th>
          <Th align="right" sm="hide">
            {TAX_RATE_LABELS.standard}
          </Th>
          <Th align="right" sm="hide">
            {TAX_RATE_LABELS.reduced}
          </Th>
          <Th align="right">合計（円）</Th>
        </TableHead>
        {estimate.rows.map((row) => (
          <TableRow
            key={row.key}
            {...ESTIMATE_COLUMNS}
            className={row.key === "payable" ? "border-t border-t-border-2 font-bold" : ""}
          >
            <Td>{row.label}</Td>
            <Td align="right" sm="hide">
              {row.byRate ? formatAmountDisplay(row.byRate.standard) : ""}
            </Td>
            <Td align="right" sm="hide">
              {row.byRate ? formatAmountDisplay(row.byRate.reduced) : ""}
            </Td>
            <Td align="right">{formatAmountDisplay(row.total)}</Td>
          </TableRow>
        ))}
      </TableBox>
      {estimate.note ? <p className="text-[12px] text-muted">{estimate.note}</p> : null}
    </div>
  );
}

/**
 * 消費税の集計 (17-financial-statements §8.3): 税区分別の集計 and the estimates of 本則課税 and 簡易課税
 * for one fiscal year. An exempt year's figures are 参考. Owners read it to decide and to check; the
 * return itself is the tax accountant's.
 */
export default async function ConsumptionTaxPage({
  searchParams,
}: PageProps<"/closing/statements/consumption-tax">) {
  const raw = await searchParams;
  const { source, today } = await loadStatementsBook();
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const fiscalYear = resolveStatementsYear(years, firstParam(raw.fy), today);
  if (!fiscalYear) return <NoFiscalYear title="消費税の集計" />;

  const summary = buildConsumptionTaxSummary(source, fiscalYear.id);
  const sales = summary.categories.filter((row) => row.direction === "sales");
  const purchases = summary.categories.filter((row) => row.direction === "purchase");
  const hasEntries = source.entries.some((entry) => entry.fiscalYearId === fiscalYear.id);

  return (
    <>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-baseline gap-2">
            消費税の集計
            {summary.reference ? (
              <span className="rounded-full border border-border-2 px-2 py-0.5 text-[12px] font-bold text-muted">
                参考
              </span>
            ) : null}
          </span>
        }
        meta={`第${fiscalYear.no}期 ${formatPeriod(fiscalYear.startDate, fiscalYear.endDate)}`}
        back={{ href: statementsHref(fiscalYear.no), label: "決算書" }}
        actions={
          <>
            <FiscalYearSelect
              action="/closing/statements/consumption-tax"
              years={years}
              current={fiscalYear}
            />
            {hasEntries ? (
              <DownloadLink href={statementExportHref(fiscalYear.no, "consumption-tax", "csv")}>
                CSV
              </DownloadLink>
            ) : null}
          </>
        }
      />

      <dl className="mb-5 flex flex-wrap gap-x-8 gap-y-2 text-[14px]">
        <div className="flex gap-2">
          <dt className="text-muted">経理方式</dt>
          <dd className="font-bold">{summary.accountingMethodLabel}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">消費税の方式</dt>
          <dd className="font-bold">{summary.methodLabel}</dd>
        </div>
      </dl>
      {summary.referenceNote ? (
        <p className="mb-4 rounded-card border border-border px-4 py-3 text-[14px]">
          {summary.referenceNote}
        </p>
      ) : null}
      {summary.excludedBefore ? (
        <p className="mb-4 text-[13px] text-muted">
          インボイスの登録日（{formatDate(summary.excludedBefore)}
          ）より前の行は集計に入れていません。
        </p>
      ) : null}
      {summary.issues.length > 0 ? <WarningBand messages={summary.issues} /> : null}

      <Section
        id="categories"
        title="税区分別の集計"
        aside="金額は円。返品・返金は差し引いた額です"
      >
        <TableBox label="税区分別の集計">
          <TableHead {...CATEGORY_COLUMNS}>
            <Th>税区分</Th>
            <Th align="right" sm="hide">
              件数
            </Th>
            <Th align="right" sm="hide">
              税込金額
            </Th>
            <Th align="right" sm="hide">
              税抜金額
            </Th>
            <Th align="right">消費税額（控除できる額）</Th>
          </TableHead>
          <div role="row" className="data-group">
            <span role="rowheader">売上</span>
          </div>
          {sales.map((row) => (
            <CategoryRow key={row.code} label={row.name} row={row} />
          ))}
          <CategoryRow label="売上 計" row={summary.sales} subtotal />
          <div role="row" className="data-group">
            <span role="rowheader">仕入</span>
          </div>
          {purchases.map((row) => (
            <CategoryRow key={row.code} label={row.name} row={row} />
          ))}
          <CategoryRow label="仕入 計" row={summary.purchases} subtotal />
          <TableRow {...CATEGORY_COLUMNS} className="border-t border-t-border-2">
            <Td className="font-bold">課税売上割合</Td>
            <Td sm="hide" />
            <Td sm="hide" />
            <Td sm="hide" />
            <Td align="right" className="font-bold">
              {summary.ratio.label}
            </Td>
          </TableRow>
        </TableBox>
      </Section>

      <Section id="estimates" title="納付税額の概算">
        <div className="grid gap-6 lg:grid-cols-2">
          <EstimateTable estimate={summary.general} />
          <EstimateTable estimate={summary.simplified} />
        </div>
      </Section>

      <p className="mb-8 text-[13px] text-muted">{summary.disclaimer}</p>
    </>
  );
}
