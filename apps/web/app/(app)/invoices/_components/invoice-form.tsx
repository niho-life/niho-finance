"use client";

import type {
  InvoiceDraftFormValues,
  InvoiceFormOptions,
  InvoiceLineFormValues,
} from "@niho-finance/db";
import {
  defaultDueDate,
  displayDate,
  INVOICE_DOC_TYPE_LABELS,
  INVOICE_DUE_DATE_LABELS,
  invoiceChecklist,
  isCalendarDate,
  type InvoiceDocType,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { defaultRevenueAccountId, defaultSegmentId, draftLineTotals } from "../_lib/line-totals";
import { createInvoiceDraftAction, updateInvoiceDraftAction } from "../actions";
import { InvoiceChecklistView } from "./invoice-checklist";
import {
  blankEditorLine,
  InvoiceLinesEditor,
  InvoiceTotalsSummary,
  RevenueFieldset,
  type EditorLine,
} from "./invoice-lines";

export type InvoiceFormMode = { kind: "new" } | { kind: "edit"; id: string };

type LineDraft = EditorLine & InvoiceLineFormValues;

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

function blankLine(key: string): LineDraft {
  return { ...blankEditorLine(key), date: "" };
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
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const isInvoice = docType === "invoice";
  const dueLabel = INVOICE_DUE_DATE_LABELS[docType];

  const partners = new Map(options.partners.map((partner) => [partner.id, partner]));
  const defaultAccount = (partnerId: string) => defaultRevenueAccountId(options, partnerId);
  const defaultSegment = (accountId: string, partnerId: string) =>
    defaultSegmentId(options, accountId, partnerId);

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

  function changeLines(lines: EditorLine[]) {
    // Adding or removing a line moves the indexes the errors name: they are cleared.
    if (lines.length !== draft.lines.length) setError(null);
    setDraft({
      ...draft,
      lines: lines.map((line) => ({ ...line, date: line.date ?? "" })),
    });
  }

  // The amounts as the server computes them: lines with a quantity and a unit price.
  const issueDate = isCalendarDate(draft.issueDate) ? draft.issueDate : null;
  const { parsed, totals, ruleProblems, incomplete } = draftLineTotals(draft.lines, {
    pricesIncludeTax: draft.pricesIncludeTax,
    date: issueDate,
    taxRules: options.taxRules,
  });
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
        <RevenueFieldset
          idPrefix={id}
          options={options}
          revenueAccountId={draft.revenueAccountId}
          segmentId={draft.segmentId}
          onAccountChange={(revenueAccountId) =>
            change({
              revenueAccountId,
              segmentId: draft.edited.segmentId
                ? draft.segmentId
                : defaultSegment(revenueAccountId, draft.partnerId),
              edited: { ...draft.edited, revenueAccountId: true },
            })
          }
          onSegmentChange={(segmentId) =>
            change({ segmentId, edited: { ...draft.edited, segmentId: true } })
          }
          fieldError={fieldError}
        />
      ) : null}

      <InvoiceLinesEditor
        idPrefix={id}
        lines={draft.lines}
        onLinesChange={changeLines}
        parsed={parsed}
        taxCategories={options.taxCategories}
        pricesIncludeTax={draft.pricesIncludeTax}
        withDate
        fieldError={fieldError}
        ruleProblems={ruleProblems}
      />

      <InvoiceTotalsSummary
        totals={totals}
        pricesIncludeTax={draft.pricesIncludeTax}
        hasDate={issueDate !== null}
        incomplete={incomplete}
        noDateText="発行日を入れると集計します"
      />

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
