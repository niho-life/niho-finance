import { getPartner, loadReportSource, todayInJapan } from "@niho-finance/db";
import { PARTNER_KIND_LABELS, type CalendarDate, type Money } from "@niho-finance/ledger";
import {
  buildPartnerSummary,
  type PartnerBalances,
  type ReportFiscalYear,
  type ReportPeriod,
} from "@niho-finance/reports";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db, requireSetupReady } from "@/lib/data";
import { formatAmountDisplay, formatDate, formatPeriod } from "@/lib/format";
import { segmentName } from "../../../reports/_lib/format";
import { reportHref } from "../../../reports/_lib/query";

export const metadata: Metadata = { title: "取引先の詳細" };

const COLUMNS = { columns: "minmax(0,1fr) 10rem", mobileColumns: "minmax(0,1fr) 8rem" };

function yearPeriod(fiscalYear: ReportFiscalYear): ReportPeriod {
  return {
    fiscalYear,
    preset: "year",
    from: fiscalYear.startDate,
    to: fiscalYear.endDate,
    segmentId: null,
  };
}

/** The year's start through today (inside the year): the ledger then ends on today's balance. */
function balancePeriod(fiscalYear: ReportFiscalYear, today: CalendarDate): ReportPeriod {
  const to =
    today < fiscalYear.startDate
      ? fiscalYear.startDate
      : today > fiscalYear.endDate
        ? fiscalYear.endDate
        : today;
  return { fiscalYear, preset: "custom", from: fiscalYear.startDate, to, segmentId: null };
}

function Amount({ value, href }: { value: Money; href?: string | null }) {
  return href ? (
    <Link href={href} className="underline-offset-4 hover:underline" prefetch={false}>
      {formatAmountDisplay(value)}
    </Link>
  ) : (
    formatAmountDisplay(value)
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-bold text-muted">{label}</dt>
      <dd className="truncate text-[14px]">{children}</dd>
    </div>
  );
}

/**
 * 取引先の詳細 (14-reports §15.5): the partner's settings (read-only; edited in the list) and the
 * year containing today: 収益 ・ 費用 ・ 未入金 ・ 未払, each leading to 集計 or the general ledger.
 */
export default async function PartnerDetailPage({ params }: PageProps<"/settings/partners/[id]">) {
  await requireSetupReady();
  const { id } = await params;
  const prisma = await db();
  const partner = await getPartner(prisma, id);
  if (!partner) notFound();
  const source = await loadReportSource(prisma);
  const today = todayInJapan();
  const summary = buildPartnerSummary(source, partner.id, { today });
  const fiscalYear = summary.fiscalYear;

  const account = source.accounts.find((candidate) => candidate.id === partner.defaultAccountId);
  const tax = source.taxCategories.find(
    (candidate) => candidate.code === partner.defaultTaxCategoryCode,
  );
  const year = fiscalYear ? yearPeriod(fiscalYear) : null;
  const balances = fiscalYear ? balancePeriod(fiscalYear, today) : null;
  const sideHref = (side: "revenue" | "expense") =>
    year ? reportHref("breakdown", year, { axis: "account", side, partner: partner.id }) : null;

  const balanceRows = (label: string, value: PartnerBalances) => [
    <TableRow key={label} {...COLUMNS} className="font-bold">
      <Td>{label}</Td>
      <Td align="right">{formatAmountDisplay(value.total)}</Td>
    </TableRow>,
    ...value.rows.map((row) => (
      <TableRow key={`${label}:${row.account.id}`} {...COLUMNS}>
        <Td className="truncate pl-4 text-[13px] text-muted">
          {row.account.code} {row.account.name}
        </Td>
        <Td align="right">
          <Amount
            value={row.balance}
            href={
              balances
                ? reportHref("ledger", balances, { account: row.account.id, partner: partner.id })
                : null
            }
          />
        </Td>
      </TableRow>
    )),
  ];

  return (
    <>
      <PageHeader
        title={partner.name}
        meta={`${PARTNER_KIND_LABELS[partner.kind]}${partner.isActive ? "" : " · 無効"}`}
        back={{ href: "/settings/partners", label: "取引先" }}
        actions={
          <ButtonLink href={`/entries?partner=${partner.id}`} variant="secondary" size="sm">
            仕訳を見る
          </ButtonLink>
        }
      />

      <section aria-labelledby="partner-settings" className="mb-6">
        <h2 id="partner-settings" className="sr-only">
          取引先の設定
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Field label="区分">{PARTNER_KIND_LABELS[partner.kind]}</Field>
          <Field label="カナ">{partner.nameKana ?? "—"}</Field>
          <Field label="登録番号">
            <span className="num">{partner.invoiceRegistrationNumber ?? "—"}</span>
          </Field>
          <Field label="既定の科目">{account ? `${account.code} ${account.name}` : "—"}</Field>
          <Field label="既定のセグメント">
            {partner.defaultSegmentId
              ? segmentName(source.segments, partner.defaultSegmentId)
              : "—"}
          </Field>
          <Field label="既定の税区分">{tax?.name ?? "—"}</Field>
        </dl>
        <p className="mt-2 text-[12px] text-muted">
          項目は
          <Link href="/settings/partners" className="mx-0.5 underline underline-offset-4">
            取引先の一覧
          </Link>
          で編集します。
        </p>
      </section>

      <section aria-labelledby="partner-year" className="max-w-xl">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="partner-year" className="text-[15px] font-extrabold">
            {fiscalYear ? `第${fiscalYear.no}期` : "今期"}
          </h2>
          {fiscalYear ? (
            <span className="text-[12px] text-muted">
              {formatPeriod(fiscalYear.startDate, fiscalYear.endDate)}
            </span>
          ) : null}
        </div>
        <Table label="今期の収益・費用・未入金・未払">
          <TableHead {...COLUMNS}>
            <Th>項目</Th>
            <Th align="right">金額（円）</Th>
          </TableHead>
          <TableRow {...COLUMNS}>
            <Td>収益</Td>
            <Td align="right">
              <Amount value={summary.revenue} href={sideHref("revenue")} />
            </Td>
          </TableRow>
          <TableRow {...COLUMNS}>
            <Td>費用</Td>
            <Td align="right">
              <Amount value={summary.expense} href={sideHref("expense")} />
            </Td>
          </TableRow>
          {balanceRows("未入金", summary.receivables)}
          {balanceRows("未払", summary.payables)}
        </Table>
        <p className="mt-2 text-[12px] text-muted">
          収益・費用は期首から期末まで（決算振替を除く）。未入金（売掛金・未収入金）と未払（買掛金・未払金・未払費用）は今日（
          {formatDate(today)}
          ）時点の残高で、行か補助科目にこの取引先がある行だけを足します。カードで払った分はカード会社への未払金なので、買った先の未払には入りません。
        </p>
      </section>
    </>
  );
}
