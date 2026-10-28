"use client";

import type {
  InvoiceDraftFormValues,
  InvoiceFormOptions,
  InvoiceLineFormValues,
} from "@niho-finance/db";
import {
  computeInvoiceTotals,
  defaultDueDate,
  displayDate,
  formatYen,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_DUE_DATE_LABELS,
  invoiceChecklist,
  invoiceRateLabel,
  isCalendarDate,
  LedgerValidationError,
  lineAmount,
  parseQuantity,
  parseYenInput,
  type InvoiceDocType,
  type InvoiceLineAmountInput,
  type InvoiceTotals,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { createInvoiceDraftAction, updateInvoiceDraftAction } from "../actions";
import { InvoiceChecklistView } from "./invoice-checklist";

export type InvoiceFormMode = { kind: "new" } | { kind: "edit"; id: string };

interface LineDraft extends InvoiceLineFormValues {
  key: string;
}

interface FormDraft {
  partnerId: string;
  title: string;
  issueDate: string;
  dueDate: string;
  pricesIncludeTax: boolean;
  note: string;
  revenueAccountId: string;
  segmentId: string;
  lines: LineDraft[];
  /** Chosen by hand: a change of the issue date, the partner or the account no longer moves it. */
  edited: { dueDate: boolean; revenueAccountId: boolean; segmentId: boolean };
}

/** The most lines a document takes (the schema's limit). */
const MAX_LINES = 100;
const HEADER_FIELDS = new Set([
  "partnerId",
  "title",
  "issueDate",
  "dueDate",
  "pricesIncludeTax",
  "note",
  "revenueAccountId",
  "segmentId",
]);
const LINE_FIELD = /^lines\.(\d+)\.(date|name|quantity|unit|unitPrice|taxCategoryCode)$/;

function blankLine(key: string, taxCategoryCode = "sales_10"): LineDraft {
  return { key, date: "", name: "", quantity: "1", unit: "", unitPrice: "", taxCategoryCode };
}

function dueDateFor(docType: InvoiceDocType, issueDate: string): string {
  return isCalendarDate(issueDate) ? (defaultDueDate(docType, issueDate) ?? "") : "";
}

/**
 * 新規・編集 of a document (18 §8): the partner, the title, the dates and the tax of the unit prices,
 * for an invoice the revenue account and the segment, then the lines. The line amounts, the totals
 * per rate and the checklist are computed as the owner types (the same pure functions the server
 * runs); the server computes them again on save and on issue.
 */
export function InvoiceForm({
  mode,
  docType,
  options,
  initial,
  sourceNote,
}: {
  mode: InvoiceFormMode;
  docType: InvoiceDocType;
  options: InvoiceFormOptions;
  initial: InvoiceDraftFormValues;
  /** 「見積書 QT-… から作成」 for a conversion. */
  sourceNote?: string | null;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const nextKey = useRef(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const isInvoice = docType === "invoice";
  const dueLabel = INVOICE_DUE_DATE_LABELS[docType];

  const partners = new Map(options.partners.map((partner) => [partner.id, partner]));
  const accounts = new Map(options.revenueAccounts.map((account) => [account.id, account]));
  const activeSegments = new Set(
    options.segments.filter((segment) => segment.isActive).map((segment) => segment.id),
  );

  /** 18 §8: the partner's revenue account when it is one, else 4040. */
  function defaultAccount(partnerId: string): string {
    const preferred = partners.get(partnerId)?.defaultAccountId ?? null;
    const account = preferred ? accounts.get(preferred) : undefined;
    return account?.isActive ? account.id : (options.defaults.revenueAccountId ?? "");
  }

  /** The account's segment, else the partner's, else 受託. */
  function defaultSegment(accountId: string, partnerId: string): string {
    for (const segmentId of [
      accounts.get(accountId)?.defaultSegmentId,
      partners.get(partnerId)?.defaultSegmentId,
    ]) {
      if (segmentId && activeSegments.has(segmentId)) return segmentId;
    }
    return options.defaults.segmentId ?? "";
  }

  const [draft, setDraft] = useState<FormDraft>(() => {
    const revenueAccountId = initial.revenueAccountId || defaultAccount(initial.partnerId);
    return {
      partnerId: initial.partnerId,
      title: initial.title,
      issueDate: initial.issueDate,
      dueDate: initial.dueDate,
      pricesIncludeTax: initial.pricesIncludeTax,
      note: initial.note,
      revenueAccountId,
      segmentId: initial.segmentId || defaultSegment(revenueAccountId, initial.partnerId),
      lines:
        initial.lines.length > 0
          ? initial.lines.map((line, index) => ({ ...line, key: `line-${index}` }))
          : [blankLine("line-0")],
      edited: {
        dueDate: initial.dueDate !== dueDateFor(docType, initial.issueDate),
        revenueAccountId: initial.revenueAccountId !== "",
        segmentId: initial.segmentId !== "",
      },
    };
  });

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const change = (patch: Partial<FormDraft>) => setDraft({ ...draft, ...patch });

  function changePartner(partnerId: string) {
    const revenueAccountId = draft.edited.revenueAccountId
      ? draft.revenueAccountId
      : defaultAccount(partnerId);
    change({
      partnerId,
      revenueAccountId,
      segmentId: draft.edited.segmentId
        ? draft.segmentId
        : defaultSegment(revenueAccountId, partnerId),
    });
  }

  function changeIssueDate(issueDate: string) {
    change({
      issueDate,
      dueDate: draft.edited.dueDate ? draft.dueDate : dueDateFor(docType, issueDate),
    });
  }

  function changeLine(key: string, patch: Partial<InvoiceLineFormValues>) {
    setDraft({
      ...draft,
      lines: draft.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    });
  }

  function addLine(discount: boolean) {
    if (draft.lines.length >= MAX_LINES) return;
    nextKey.current += 1;
    const key = `added-${nextKey.current}`;
    const line = blankLine(key, draft.lines[0]?.taxCategoryCode ?? "sales_10");
    if (discount) {
      line.name = "値引き";
      line.unitPrice = "-";
    }
    setError(null);
    setDraft({ ...draft, lines: [...draft.lines, line] });
    setFocusId(`${id}-line-${key}-${discount ? "price" : "name"}`);
  }

  function removeLine(key: string) {
    setError(null);
    setDraft({ ...draft, lines: draft.lines.filter((line) => line.key !== key) });
  }

  // The amounts as the server computes them: lines with a quantity and a unit price.
  const parsed = draft.lines.map((line): InvoiceLineAmountInput | null => {
    const quantity = parseQuantity(line.quantity);
    const unitPrice = parseYenInput(line.unitPrice, { allowNegative: true });
    return quantity === null || unitPrice === null
      ? null
      : { quantity, unitPrice, taxCategoryCode: line.taxCategoryCode };
  });
  const complete = parsed.flatMap((input, index) => (input ? [{ input, index }] : []));
  const issueDate = isCalendarDate(draft.issueDate) ? draft.issueDate : null;
  let totals: InvoiceTotals | null = null;
  const ruleProblems = new Map<number, string>();
  if (issueDate) {
    try {
      totals = computeInvoiceTotals(
        complete.map((item) => item.input),
        { pricesIncludeTax: draft.pricesIncludeTax, issueDate, taxRules: options.taxRules },
      );
    } catch (caught) {
      if (!(caught instanceof LedgerValidationError)) throw caught;
      for (const item of caught.errors) {
        const line = item.lineIndex === undefined ? undefined : complete[item.lineIndex];
        if (line) ruleProblems.set(line.index, item.message);
      }
    }
  }
  const incomplete = complete.length < draft.lines.length;
  const partner = partners.get(draft.partnerId);
  const checklist = issueDate
    ? invoiceChecklist({
        issuer: options.issuer,
        issueDate,
        recipientName: partner?.name ?? null,
        lines: draft.lines.map((line) => ({
          name: line.name,
          date: isCalendarDate(line.date) ? line.date : null,
          taxCategoryCode: line.taxCategoryCode,
        })),
        totals,
      })
    : null;

  const fiscalYear = issueDate
    ? options.fiscalYears.find((year) => year.startDate <= issueDate && year.endDate >= issueDate)
    : undefined;
  let issueDateHelp: string | null = null;
  if (issueDate && !fiscalYear) {
    issueDateHelp = `${displayDate(issueDate)} を含む会計期間がありません。保存はできますが、発行には会計期間が要ります`;
  } else if (
    isInvoice &&
    issueDate &&
    fiscalYear?.lockedThrough &&
    issueDate <= fiscalYear.lockedThrough
  ) {
    issueDateHelp = `${displayDate(fiscalYear.lockedThrough)} までは締めています。この発行日では発行できません`;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = {
      docType,
      partnerId: draft.partnerId,
      title: draft.title,
      issueDate: draft.issueDate,
      dueDate: docType === "delivery" ? "" : draft.dueDate,
      pricesIncludeTax: draft.pricesIncludeTax,
      note: draft.note,
      revenueAccountId: isInvoice ? draft.revenueAccountId : "",
      segmentId: isInvoice ? draft.segmentId : "",
      sourceInvoiceId: initial.sourceInvoiceId,
      lines: draft.lines.map(({ key: _key, ...line }) => line),
    };
    startTransition(async () => {
      const result =
        mode.kind === "edit"
          ? await updateInvoiceDraftAction(mode.id, values)
          : await createInvoiceDraftAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(mode.kind === "edit" ? "保存しました" : "下書きを保存しました");
      router.push(`/invoices/${result.data.id}`);
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const shows = (field: string) => {
    if (HEADER_FIELDS.has(field)) {
      if (field === "dueDate") return dueLabel !== null;
      if (field === "revenueAccountId" || field === "segmentId") return isInvoice;
      return true;
    }
    const match = LINE_FIELD.exec(field);
    return match !== null && Number(match[1]) < draft.lines.length;
  };
  const alerts = formLevelErrors(error, shows);
  const field = (name: string) => `${id}-${name}`;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {sourceNote ? (
        <p className="rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">{sourceNote}</p>
      ) : null}
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_168px_168px_128px]">
        <FormField
          label="取引先"
          htmlFor={field("partner")}
          required
          error={fieldError("partnerId")}
          help={
            <Link href="/settings/partners" className="font-bold underline underline-offset-4">
              取引先を追加
            </Link>
          }
        >
          <Select
            id={field("partner")}
            value={draft.partnerId}
            aria-invalid={fieldError("partnerId") ? true : undefined}
            onChange={(event) => changePartner(event.currentTarget.value)}
          >
            <option value="">選んでください</option>
            {options.partners.map((item) => (
              <option key={item.id} value={item.id}>
                {item.isActive ? item.name : `${item.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="件名" htmlFor={field("title")} error={fieldError("title")}>
          <Input
            id={field("title")}
            value={draft.title}
            maxLength={200}
            aria-invalid={fieldError("title") ? true : undefined}
            onChange={(event) => change({ title: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="発行日"
          htmlFor={field("issue-date")}
          required
          error={fieldError("issueDate")}
          help={issueDateHelp}
        >
          <Input
            id={field("issue-date")}
            type="date"
            value={draft.issueDate}
            aria-invalid={fieldError("issueDate") ? true : undefined}
            onChange={(event) => changeIssueDate(event.currentTarget.value)}
          />
        </FormField>
        {dueLabel ? (
          <FormField label={dueLabel} htmlFor={field("due-date")} error={fieldError("dueDate")}>
            <Input
              id={field("due-date")}
              type="date"
              value={draft.dueDate}
              aria-invalid={fieldError("dueDate") ? true : undefined}
              onChange={(event) =>
                change({
                  dueDate: event.currentTarget.value,
                  edited: { ...draft.edited, dueDate: true },
                })
              }
            />
          </FormField>
        ) : (
          <div aria-hidden="true" className="hidden lg:block" />
        )}
        <FormField
          label="単価の税"
          htmlFor={field("prices")}
          error={fieldError("pricesIncludeTax")}
        >
          <Select
            id={field("prices")}
            value={draft.pricesIncludeTax ? "inclusive" : "exclusive"}
            onChange={(event) =>
              change({ pricesIncludeTax: event.currentTarget.value === "inclusive" })
            }
          >
            <option value="exclusive">税抜</option>
            <option value="inclusive">税込</option>
          </Select>
        </FormField>
        <div className="md:col-span-2 lg:col-span-5">
          <FormField
            label="備考"
            htmlFor={field("note")}
            error={fieldError("note")}
            help="書類に印字します（1,000 字まで）"
          >
            <Textarea
              id={field("note")}
              value={draft.note}
              maxLength={1000}
              rows={2}
              onChange={(event) => change({ note: event.currentTarget.value })}
            />
          </FormField>
        </div>
      </div>

      {isInvoice ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[15px] font-extrabold">会計</legend>
          <div className="grid gap-4 md:grid-cols-2 lg:max-w-[720px]">
            <FormField
              label="売上の科目"
              htmlFor={field("account")}
              error={fieldError("revenueAccountId")}
            >
              <Select
                id={field("account")}
                value={draft.revenueAccountId}
                aria-invalid={fieldError("revenueAccountId") ? true : undefined}
                onChange={(event) => {
                  const revenueAccountId = event.currentTarget.value;
                  change({
                    revenueAccountId,
                    segmentId: draft.edited.segmentId
                      ? draft.segmentId
                      : defaultSegment(revenueAccountId, draft.partnerId),
                    edited: { ...draft.edited, revenueAccountId: true },
                  });
                }}
              >
                {options.revenueAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} {account.name}
                    {account.isActive ? "" : "（無効）"}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label="セグメント"
              htmlFor={field("segment")}
              error={fieldError("segmentId")}
            >
              <Select
                id={field("segment")}
                value={draft.segmentId}
                aria-invalid={fieldError("segmentId") ? true : undefined}
                onChange={(event) =>
                  change({
                    segmentId: event.currentTarget.value,
                    edited: { ...draft.edited, segmentId: true },
                  })
                }
              >
                {options.segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.isActive ? segment.name : `${segment.name}（無効）`}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        </fieldset>
      ) : null}

      <section aria-labelledby={field("lines")} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 id={field("lines")} className="text-[15px] font-extrabold">
            行
          </h2>
          <p className="text-[12px] text-muted">
            {draft.pricesIncludeTax ? "単価は税込で入れます" : "単価は税抜で入れます"}
            。値引きは単価をマイナスにします
          </p>
        </div>
        <div
          aria-hidden="true"
          className="hidden rounded-t-lg bg-surface-2 px-3 py-2 text-[11px] font-bold text-muted-2 lg:grid lg:grid-cols-[132px_minmax(0,1fr)_76px_68px_120px_156px_104px_40px] lg:gap-x-2.5"
        >
          <span>日付</span>
          <span>品名</span>
          <span className="text-right">数量</span>
          <span>単位</span>
          <span className="text-right">単価（円）</span>
          <span>税区分</span>
          <span className="text-right">金額（円）</span>
          <span />
        </div>
        <ol className="flex flex-col">
          {draft.lines.map((line, index) => {
            const at = `${id}-line-${line.key}`;
            const row = index + 1;
            const input = parsed[index];
            const amount = input ? lineAmount(input.quantity, input.unitPrice) : null;
            const lineError = (name: string) => fieldError(`lines.${index}.${name}`);
            const taxProblem = lineError("taxCategoryCode") ?? ruleProblems.get(index);
            const label = (text: string, htmlFor: string) => (
              <label htmlFor={htmlFor} className="text-[11px] font-bold text-muted lg:sr-only">
                {row} 行目の{text}
              </label>
            );
            const errorText = (message: string | undefined) =>
              message ? (
                <p role="alert" className="text-[12px] font-bold text-danger">
                  {message}
                </p>
              ) : null;
            return (
              <li
                key={line.key}
                className="grid grid-cols-2 gap-x-2.5 gap-y-2 border-b border-border px-3 py-3 md:grid-cols-6 lg:grid-cols-[132px_minmax(0,1fr)_76px_68px_120px_156px_104px_40px] lg:items-start"
              >
                <div className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-4 lg:col-span-1">
                  {label("品名", `${at}-name`)}
                  <input
                    id={`${at}-name`}
                    className="control"
                    value={line.name}
                    maxLength={200}
                    aria-invalid={lineError("name") ? true : undefined}
                    onChange={(event) => changeLine(line.key, { name: event.currentTarget.value })}
                  />
                  {errorText(lineError("name"))}
                </div>
                <div className="flex min-w-0 flex-col gap-1 md:col-span-2 lg:order-first lg:col-span-1">
                  {label("日付（任意）", `${at}-date`)}
                  <input
                    id={`${at}-date`}
                    type="date"
                    className="control"
                    value={line.date}
                    aria-invalid={lineError("date") ? true : undefined}
                    onChange={(event) => changeLine(line.key, { date: event.currentTarget.value })}
                  />
                  {errorText(lineError("date"))}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {label("数量", `${at}-quantity`)}
                  <input
                    id={`${at}-quantity`}
                    className="control num text-right"
                    inputMode="decimal"
                    autoComplete="off"
                    value={line.quantity}
                    aria-invalid={lineError("quantity") ? true : undefined}
                    onChange={(event) =>
                      changeLine(line.key, { quantity: event.currentTarget.value })
                    }
                  />
                  {errorText(lineError("quantity"))}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {label("単位", `${at}-unit`)}
                  <input
                    id={`${at}-unit`}
                    className="control"
                    value={line.unit}
                    maxLength={20}
                    placeholder="式"
                    aria-invalid={lineError("unit") ? true : undefined}
                    onChange={(event) => changeLine(line.key, { unit: event.currentTarget.value })}
                  />
                  {errorText(lineError("unit"))}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {label("単価（円）", `${at}-price`)}
                  <MoneyInput
                    id={`${at}-price`}
                    allowNegative
                    value={line.unitPrice}
                    aria-invalid={lineError("unitPrice") ? true : undefined}
                    onValueChange={(text) => changeLine(line.key, { unitPrice: text })}
                  />
                  {errorText(lineError("unitPrice"))}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  {label("税区分", `${at}-tax`)}
                  <select
                    id={`${at}-tax`}
                    className="control"
                    value={line.taxCategoryCode}
                    aria-invalid={taxProblem ? true : undefined}
                    onChange={(event) =>
                      changeLine(line.key, { taxCategoryCode: event.currentTarget.value })
                    }
                  >
                    {options.taxCategories.map((category) => (
                      <option key={category.code} value={category.code}>
                        {category.isActive ? category.name : `${category.name}（無効）`}
                      </option>
                    ))}
                  </select>
                  {errorText(taxProblem)}
                </div>
                <div className="flex min-w-0 flex-col gap-1 lg:justify-center">
                  <span className="text-[11px] font-bold text-muted lg:sr-only">
                    {row} 行目の金額（円）
                  </span>
                  <span className="num min-h-10 content-center text-right text-[14px] font-bold">
                    {amount === null ? "—" : formatYen(amount)}
                  </span>
                </div>
                <div className="flex items-start justify-end">
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    disabled={draft.lines.length <= 1}
                    aria-label={`${row} 行目を消す`}
                    className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-[18px] text-muted hover:bg-black/5 hover:text-text disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => addLine(false)}
            disabled={draft.lines.length >= MAX_LINES}
          >
            ＋ 行を追加
          </Button>
          <Button
            variant="ghost"
            onClick={() => addLine(true)}
            disabled={draft.lines.length >= MAX_LINES}
          >
            ＋ 値引きを追加
          </Button>
          {draft.lines.length >= MAX_LINES ? (
            <span className="text-[12px] text-muted">行は {MAX_LINES} 行までです</span>
          ) : null}
        </div>
      </section>

      <section
        aria-label="集計"
        aria-live="polite"
        className="flex flex-col gap-1.5 border-t border-border pt-3 text-[14px] md:ml-auto md:w-[min(460px,100%)]"
      >
        {!issueDate ? (
          <p className="text-[13px] text-muted">発行日を入れると集計します</p>
        ) : totals === null ? (
          <p className="text-[13px] font-bold text-danger">
            税率の規則がない税区分があるため集計できません。行の税区分か 設定 › 税区分
            を確かめてください
          </p>
        ) : (
          <>
            {totals.rates.map((rate) => (
              <div
                key={rate.taxCategoryCode}
                className="flex flex-wrap items-baseline justify-between gap-x-4"
              >
                <span>
                  {invoiceRateLabel(rate)}
                  {rate.taxable ? ` 対象${draft.pricesIncludeTax ? "（税込）" : ""}` : ""}
                </span>
                <span className="num">
                  {formatYen(draft.pricesIncludeTax ? rate.amountInclusive : rate.amountExclusive)}{" "}
                  円
                  {rate.taxable ? (
                    <span className="ml-3 text-muted">消費税 {formatYen(rate.taxAmount)} 円</span>
                  ) : null}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
              <span className="font-bold">合計</span>
              <span className="num text-[20px] font-extrabold">{formatYen(totals.total)} 円</span>
            </div>
          </>
        )}
        {incomplete ? (
          <p className="text-[12px] text-muted">数量か単価のない行は集計に入っていません</p>
        ) : null}
      </section>

      {checklist ? (
        <InvoiceChecklistView
          checklist={checklist}
          note="不備があっても下書きは保存できます。不備がなくなると詳細から発行できます"
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-[12px] text-muted">
          {INVOICE_DOC_TYPE_LABELS[docType]}の下書きとして保存します。番号は発行の時点で付きます
        </span>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}
