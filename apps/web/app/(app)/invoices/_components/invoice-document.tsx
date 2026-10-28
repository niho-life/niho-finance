import type { InvoiceBankAccount, InvoiceDetail, InvoiceRateRow } from "@niho-finance/db";
import {
  BANK_ACCOUNT_TYPE_LABELS,
  formatYen,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_DUE_DATE_LABELS,
  invoiceNumberLabel,
} from "@niho-finance/ledger";
import type { ReactNode } from "react";
import { formatDate } from "@/lib/format";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="num min-w-0 break-words">{children}</dd>
    </>
  );
}

/** One rate of the totals (18 §9.2): 適格 with the tax per rate, 区分記載 with the tax-inclusive amount. */
function RateLine({
  rate,
  qualified,
  pricesIncludeTax,
}: {
  rate: InvoiceRateRow;
  qualified: boolean;
  pricesIncludeTax: boolean;
}) {
  if (!rate.taxable) {
    return (
      <div className="flex items-baseline justify-between gap-4">
        <span>{rate.label}</span>
        <span className="num">{formatYen(rate.amountInclusive)} 円</span>
      </div>
    );
  }
  if (qualified) {
    const inclusive = pricesIncludeTax;
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span>
          {rate.label} 対象{inclusive ? "（税込）" : ""}
        </span>
        <span className="num">
          {formatYen(inclusive ? rate.amountInclusive : rate.amountExclusive)} 円
          <span className="ml-3 text-muted">消費税 {formatYen(rate.taxAmount)} 円</span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-4">
        <span>{rate.label} 対象（税込）</span>
        <span className="num">{formatYen(rate.amountInclusive)} 円</span>
      </div>
      <span className="num self-end text-[12px] text-muted">
        うち消費税相当額 {formatYen(rate.taxAmount)} 円
      </span>
    </div>
  );
}

function BankAccount({ account }: { account: InvoiceBankAccount }) {
  const first = [
    account.bankName,
    account.branchName,
    account.accountType ? BANK_ACCOUNT_TYPE_LABELS[account.accountType] : null,
    account.accountNumber,
  ].filter(Boolean);
  return (
    <section aria-label="振込先" className="text-[13px]">
      <h3 className="mb-1 text-[12px] font-bold text-muted">振込先</h3>
      {first.length > 0 ? <p className="num">{first.join(" ")}</p> : null}
      {account.accountHolder ? <p>口座名義 {account.accountHolder}</p> : null}
      {account.note ? <p className="text-muted">{account.note}</p> : null}
    </section>
  );
}

/**
 * The document as it is issued (18 §9.2), standing in for the PDF until it exists: the recipient,
 * the issuer (the copy once issued, the current settings for a draft), the lines, the totals per
 * rate as stored, the 振込先 and the note. Paper-like: white, thin rules, room around.
 */
export function InvoiceDocument({ detail }: { detail: InvoiceDetail }) {
  const typeLabel = INVOICE_DOC_TYPE_LABELS[detail.docType];
  const dueLabel = INVOICE_DUE_DATE_LABELS[detail.docType];
  const rateLabels = new Map<string, string>(
    detail.rates.map((rate) => [rate.taxCategoryCode, rate.label]),
  );
  const dated = detail.lines.some((line) => line.date !== null);
  // Two PC templates: with or without the 日付 column (only when a line has its own date).
  const lineGrid = dated
    ? "md:grid-cols-[76px_minmax(0,1fr)_64px_52px_96px_76px_104px]"
    : "md:grid-cols-[minmax(0,1fr)_64px_52px_96px_76px_104px]";
  const { issuer, recipient } = detail;

  return (
    <article
      aria-label={`${typeLabel}の内容`}
      className="rounded-card border border-border bg-surface px-4 py-6 text-[14px] md:px-10 md:py-9"
    >
      <h2 className="text-center text-[22px] font-extrabold tracking-[0.3em]">{typeLabel}</h2>

      <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 md:max-w-[52%]">
          <p className="border-b border-text pb-1 text-[17px] font-bold break-words">
            {recipient.name} 御中
          </p>
          {recipient.address ? (
            <p className="mt-1 text-[13px] break-words text-muted">{recipient.address}</p>
          ) : null}
          {detail.title ? (
            <p className="mt-4 break-words">
              <span className="mr-2 text-[12px] text-muted">件名</span>
              {detail.title}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-4 md:max-w-[44%] md:items-end md:text-right">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[13px] md:text-left">
            <Row label="番号">{invoiceNumberLabel(detail.number)}</Row>
            <Row label="発行日">{formatDate(detail.issueDate)}</Row>
            {dueLabel ? <Row label={dueLabel}>{formatDate(detail.dueDate)}</Row> : null}
          </dl>
          <div className="text-[13px]">
            <p className="text-[15px] font-bold break-words">{issuer.name ?? "（商号が未設定）"}</p>
            {issuer.address ? <p className="break-words">{issuer.address}</p> : null}
            {issuer.representative ? <p>{issuer.representative}</p> : null}
            {issuer.qualified && issuer.invoiceRegistrationNumber ? (
              <p className="num">登録番号 {issuer.invoiceRegistrationNumber}</p>
            ) : null}
          </div>
        </div>
      </div>

      <div role="table" aria-label="明細" className="mt-7 border-t border-text">
        <div
          role="row"
          className={`hidden border-b border-border py-2 text-[11px] font-bold text-muted md:grid md:gap-x-3 ${lineGrid}`}
        >
          {dated ? <span role="columnheader">日付</span> : null}
          <span role="columnheader">品名</span>
          <span role="columnheader" className="text-right">
            数量
          </span>
          <span role="columnheader">単位</span>
          <span role="columnheader" className="text-right">
            単価（円）
          </span>
          <span role="columnheader">税率</span>
          <span role="columnheader" className="text-right">
            金額（円）
          </span>
        </div>
        {detail.lines.map((line, index) => (
          <div
            key={index}
            role="row"
            className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b border-border py-2 md:items-center ${lineGrid}`}
          >
            {dated ? (
              <span role="cell" className="num hidden text-[13px] md:block">
                {line.date ? formatDate(line.date) : ""}
              </span>
            ) : null}
            <span role="cell" className="col-span-2 min-w-0 break-words md:col-span-1">
              {line.name}
              {line.reduced ? <span aria-label="軽減税率対象"> ※</span> : null}
              {line.date ? (
                <span className="num ml-2 text-[12px] text-muted md:hidden">
                  {formatDate(line.date)}
                </span>
              ) : null}
            </span>
            <span role="cell" className="num hidden text-right md:block">
              {line.quantity}
            </span>
            <span role="cell" className="hidden md:block">
              {line.unit ?? ""}
            </span>
            <span role="cell" className="num hidden text-right md:block">
              {formatYen(line.unitPrice)}
            </span>
            <span role="cell" className="hidden text-[13px] md:block">
              {rateLabels.get(line.taxCategoryCode) ?? "—"}
            </span>
            <span role="cell" className="num text-[13px] text-muted md:hidden">
              {line.quantity}
              {line.unit ?? ""} × {formatYen(line.unitPrice)} 円 ·{" "}
              {rateLabels.get(line.taxCategoryCode) ?? "—"}
            </span>
            <span role="cell" className="num text-right">
              {formatYen(line.amount)}
            </span>
          </div>
        ))}
      </div>
      {detail.hasReducedRate ? <p className="mt-2 text-[12px] text-muted">※ 軽減税率対象</p> : null}

      <div className="mt-5 flex flex-col gap-1.5 md:ml-auto md:w-[min(420px,100%)]">
        {detail.rates.map((rate) => (
          <RateLine
            key={rate.taxCategoryCode}
            rate={rate}
            qualified={detail.qualified}
            pricesIncludeTax={detail.pricesIncludeTax}
          />
        ))}
        <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-text pt-2">
          <span className="font-bold">合計</span>
          <span className="num text-[24px] font-extrabold">{formatYen(detail.total)} 円</span>
        </div>
      </div>

      {detail.docType === "invoice" && issuer.bankAccount ? (
        <div className="mt-6">
          <BankAccount account={issuer.bankAccount} />
        </div>
      ) : null}
      {detail.note ? (
        <section aria-label="備考" className="mt-6 text-[13px]">
          <h3 className="mb-1 text-[12px] font-bold text-muted">備考</h3>
          <p className="break-words whitespace-pre-wrap">{detail.note}</p>
        </section>
      ) : null}
    </article>
  );
}
