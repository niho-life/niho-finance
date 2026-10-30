import {
  getRecurringInvoiceDetail,
  loadRecurringInvoiceHistory,
  todayInJapan,
} from "@niho-finance/db";
import {
  displayDate,
  INVOICE_STATUS_LABELS,
  invoiceNumberLabel,
  recurringInvoiceDueDate,
} from "@niho-finance/ledger";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { db } from "@/lib/data";
import { formatDate, formatYenDisplay } from "@/lib/format";
import { InvoiceHistory } from "../../_components/invoice-history";
import { PauseButton } from "../_components/pause-button";

export const metadata: Metadata = { title: "定期請求の詳細" };

const LINE_COLUMNS = {
  columns: "minmax(0,1fr) 96px 104px 72px 112px",
  mobileColumns: "minmax(0,1fr) auto",
};

const MADE_COLUMNS = {
  columns: "120px minmax(0,1fr) 112px 112px 104px",
  mobileColumns: "minmax(0,1fr) auto",
};

function Band({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p
      className={`rounded-lg px-3.5 py-2.5 text-[14px] ${
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-text"
      }`}
    >
      {children}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-[15px] font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * 定期請求の詳細 (18 §14.5): the template (宛名・件名・行・合計), the rule and the next 3 due dates,
 * the invoices made from it (対象の月・番号か「下書き」・状態), 編集 / 停止・再開 and the history.
 */
export default async function RecurringInvoiceDetailPage({
  params,
}: PageProps<"/invoices/recurring/[id]">) {
  const { id } = await params;
  const prisma = await db();
  const today = todayInJapan();
  const detail = await getRecurringInvoiceDetail(prisma, id, { today });
  if (!detail) notFound();
  const history = await loadRecurringInvoiceHistory(prisma, id);
  const dueRule = { dueMonths: detail.dueMonths, dueDay: detail.dueDay };
  const period = detail.endDate
    ? `${formatDate(detail.startDate)} – ${formatDate(detail.endDate)}`
    : `${formatDate(detail.startDate)} から`;

  return (
    <>
      <PageHeader
        title={detail.name}
        meta={[detail.isActive ? "有効" : "停止", detail.scheduleLabel, detail.partner.name].join(
          " · ",
        )}
        back={{ href: "/invoices/recurring", label: "定期請求" }}
        actions={
          <>
            <ButtonLink href={`/invoices/recurring/${detail.id}/edit`} size="sm">
              編集
            </ButtonLink>
            <PauseButton id={detail.id} name={detail.name} isActive={detail.isActive} />
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-2">
        {!detail.isActive ? (
          <Band>
            停止しています。予定日が来ても下書きを作りません。再開すると、また予定日に出ます
          </Band>
        ) : null}
        {detail.due.length > 0 ? (
          <Band tone="warn">
            予定日が来た月の下書きがまだありません（
            {detail.due.map((item) => displayDate(item.date)).join("・")}）。
            <Link
              href="/invoices/recurring/due"
              className="ml-1 font-bold underline underline-offset-4"
            >
              下書きを作る
            </Link>
          </Band>
        ) : null}
        {!detail.partner.isActive ? (
          <Band tone="warn">
            取引先「{detail.partner.name}
            」は無効です。下書きを作るには、編集で有効な取引先を選ぶか、設定 › 取引先
            で有効にしてください
          </Band>
        ) : null}
      </div>

      <Section title="周期">
        <dl className="grid gap-x-6 gap-y-2 text-[14px] md:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-[12px] font-bold text-muted md:text-[14px] md:font-normal">発行日</dt>
          <dd>{detail.scheduleLabel}</dd>
          <dt className="text-[12px] font-bold text-muted md:text-[14px] md:font-normal">対象月</dt>
          <dd>{detail.targetMonthLabel}</dd>
          <dt className="text-[12px] font-bold text-muted md:text-[14px] md:font-normal">
            支払期限
          </dt>
          <dd>{detail.dueRuleLabel}</dd>
          <dt className="text-[12px] font-bold text-muted md:text-[14px] md:font-normal">期間</dt>
          <dd className="num">{period}</dd>
          <dt className="text-[12px] font-bold text-muted md:text-[14px] md:font-normal">
            次回 3 回の予定日
          </dt>
          <dd>
            {detail.nextDates.length === 0 ? (
              <span className="text-muted">終了日までに次の予定日はありません</span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {detail.nextDates.map((date) => (
                  <li key={date} className="num">
                    {displayDate(date)}
                    <span className="ml-2 text-[13px] text-muted">
                      支払期限 {displayDate(recurringInvoiceDueDate(date, dueRule))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </Section>

      <Section title="雛形">
        <div className="rounded-card border border-border px-4 py-3">
          <p className="text-[15px] font-bold">{detail.partner.name} 御中</p>
          {detail.partner.address ? (
            <p className="text-[12px] text-muted">{detail.partner.address}</p>
          ) : null}
          <p className="mt-2 text-[14px] break-words">
            <span className="text-muted">件名 </span>
            {detail.title ?? "—"}
          </p>
          {detail.titlePreview && detail.titlePreview !== detail.title ? (
            <p className="text-[12px] break-words text-muted">
              {formatDate(detail.totalsDate)} の下書きでは「{detail.titlePreview}」
            </p>
          ) : null}
          <div className="mt-3">
            <Table label="雛形の行" minWidth={560}>
              <TableHead {...LINE_COLUMNS}>
                <Th>品名</Th>
                <Th align="right">数量</Th>
                <Th align="right">単価（円）</Th>
                <Th>税率</Th>
                <Th align="right">金額（円）</Th>
              </TableHead>
              {detail.lines.map((line, index) => (
                <TableRow key={index} {...LINE_COLUMNS}>
                  <Td className="min-w-0">
                    <span className="block break-words">
                      {line.name}
                      {line.reduced ? " ※" : ""}
                    </span>
                    <span className="block text-[12px] text-muted md:hidden">
                      {line.unit ? `${line.quantity} ${line.unit}` : line.quantity} ×{" "}
                      {formatYenDisplay(line.unitPrice)} 円
                    </span>
                  </Td>
                  <Td sm="hide" align="right" className="num">
                    {line.unit ? `${line.quantity} ${line.unit}` : line.quantity}
                  </Td>
                  <Td sm="hide" align="right">
                    {formatYenDisplay(line.unitPrice)}
                  </Td>
                  <Td sm="hide" className="text-[13px]">
                    {detail.totals?.rates.find(
                      (rate) => rate.taxCategoryCode === line.taxCategoryCode,
                    )?.label ?? "—"}
                  </Td>
                  <Td align="right" className="font-bold">
                    {formatYenDisplay(line.amount)}
                  </Td>
                </TableRow>
              ))}
            </Table>
          </div>
          {detail.totals ? (
            <div className="mt-2 flex flex-col gap-1 text-[14px] md:ml-auto md:w-[min(420px,100%)]">
              {detail.totals.rates.map((rate) => (
                <div
                  key={rate.taxCategoryCode}
                  className="flex flex-wrap items-baseline justify-between gap-x-4"
                >
                  <span>
                    {rate.label}
                    {rate.taxable ? ` 対象${detail.pricesIncludeTax ? "（税込）" : ""}` : ""}
                  </span>
                  <span className="num">
                    {formatYenDisplay(
                      detail.pricesIncludeTax ? rate.amountInclusive : rate.amountExclusive,
                    )}{" "}
                    円
                    {rate.taxable ? (
                      <span className="ml-3 text-muted">
                        消費税 {formatYenDisplay(rate.taxAmount)} 円
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                <span className="font-bold">合計</span>
                <span className="num text-[20px] font-extrabold">
                  {formatYenDisplay(detail.totals.total)} 円
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[13px] font-bold text-danger">
              税率の規則がない税区分があるため集計できません。編集で行の税区分を確かめてください
            </p>
          )}
          {detail.note ? (
            <p className="mt-3 text-[13px] break-words whitespace-pre-wrap">
              <span className="text-muted">備考 </span>
              {detail.note}
            </p>
          ) : null}
          <p className="mt-3 text-[12px] text-muted">
            {detail.revenueAccount
              ? `${detail.revenueAccount.code} ${detail.revenueAccount.name}`
              : "売上の科目は下書きを作るときの既定"}
            {" · "}
            {detail.segment ? detail.segment.name : "セグメントは下書きを作るときの既定"}
            {" · "}
            {detail.pricesIncludeTax ? "単価は税込" : "単価は税抜"}
          </p>
        </div>
      </Section>

      <Section title="作成した請求書">
        {detail.invoices.length === 0 ? (
          <p className="text-[13px] text-muted">まだ請求書を作っていません</p>
        ) : (
          <Table label="作成した請求書" minWidth={600}>
            <TableHead {...MADE_COLUMNS}>
              <Th>予定の月</Th>
              <Th>番号</Th>
              <Th>発行日</Th>
              <Th align="right">金額（円）</Th>
              <Th>状態</Th>
            </TableHead>
            {detail.invoices.map((invoice) => (
              <TableRow
                key={invoice.id}
                {...MADE_COLUMNS}
                muted={invoice.status === "void"}
                className="relative hover:bg-black/[0.02]"
              >
                <Td>
                  <Link
                    href={`/invoices/${invoice.id}`}
                    className="font-semibold after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-primary"
                  >
                    {invoice.monthLabel}
                  </Link>
                  <span className="ml-2 text-[12px] text-muted md:hidden">
                    {invoiceNumberLabel(invoice.number)}
                  </span>
                </Td>
                <Td sm="hide" className="num">
                  {invoiceNumberLabel(invoice.number)}
                </Td>
                <Td sm="hide" className="num text-[13px]">
                  {formatDate(invoice.issueDate)}
                </Td>
                <Td sm="hide" align="right" className="font-bold">
                  {formatYenDisplay(invoice.total)}
                </Td>
                <Td className="text-[13px]">{INVOICE_STATUS_LABELS[invoice.status]}</Td>
              </TableRow>
            ))}
          </Table>
        )}
      </Section>

      <InvoiceHistory rows={history} />
    </>
  );
}
