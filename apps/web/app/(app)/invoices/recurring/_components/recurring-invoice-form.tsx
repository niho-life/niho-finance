"use client";

import type { InvoiceFormOptions, RecurringInvoiceFormValues } from "@niho-finance/db";
import {
  addDays,
  displayDate,
  expandTargetMonth,
  isCalendarDate,
  isRecurringInvoiceFrequency,
  nextRecurringInvoiceDates,
  RECURRING_INVOICE_DUE_MONTH_LABELS,
  RECURRING_INVOICE_DUE_MONTHS,
  RECURRING_INVOICE_FREQUENCIES,
  RECURRING_INVOICE_FREQUENCY_LABELS,
  RECURRING_INVOICE_TARGET_OFFSETS,
  recurringInvoiceDates,
  recurringInvoiceDueDate,
  recurringInvoiceDueRuleProblem,
  TARGET_MONTH_PLACEHOLDER,
  type CalendarDate,
  type RecurringInvoiceFrequency,
  type RecurringInvoiceSchedule,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import {
  blankEditorLine,
  InvoiceLinesEditor,
  InvoiceTotalsSummary,
  RevenueFieldset,
  type EditorLine,
} from "../../_components/invoice-lines";
import { defaultRevenueAccountId, defaultSegmentId, draftLineTotals } from "../../_lib/line-totals";
import { createRecurringInvoiceAction, updateRecurringInvoiceAction } from "../actions";

export type RecurringInvoiceFormMode = { kind: "new" } | { kind: "edit"; id: string };

interface FormDraft extends Omit<RecurringInvoiceFormValues, "lines"> {
  lines: EditorLine[];
  /** Chosen by hand: a change of the partner or the account no longer moves it. */
  edited: { revenueAccountId: boolean; segmentId: boolean };
}

const FIELDS = new Set([
  "name",
  "partnerId",
  "title",
  "pricesIncludeTax",
  "note",
  "revenueAccountId",
  "segmentId",
  "frequency",
  "issueDay",
  "targetMonthOffset",
  "dueMonths",
  "dueDay",
  "startDate",
  "endDate",
]);
const LINE_FIELD = /^lines\.(\d+)\.(name|quantity|unit|unitPrice|taxCategoryCode)$/;

/** 1–30 and 末日 (31). */
const DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const dayLabel = (day: number) => (day === 31 ? "末日" : `${day} 日`);

const FREQUENCY_HELP: Readonly<Record<RecurringInvoiceFrequency, string>> = {
  monthly: "毎月の発行日に下書きを作ります",
  bimonthly: "開始日の月から 2 か月ごとに下書きを作ります",
  yearly: "開始日の月に、毎年 1 回下書きを作ります",
};

/** The schedule the fields say, or `null` while a date is not a date yet. */
function scheduleOf(draft: FormDraft): RecurringInvoiceSchedule | null {
  if (!isCalendarDate(draft.startDate)) return null;
  const endDate = draft.endDate === "" ? null : draft.endDate;
  if (endDate !== null && !isCalendarDate(endDate)) return null;
  if (!isRecurringInvoiceFrequency(draft.frequency)) return null;
  return {
    frequency: draft.frequency,
    issueDay: Number(draft.issueDay),
    startDate: draft.startDate,
    endDate,
  };
}

/**
 * 定期請求の追加・編集 (18 §14.5): the name and the rule of the due dates on top of the body of an
 * invoice (the same fields and lines as the invoice form, the lines without a date). Below, the next
 * 3 due dates with the due date and the title of each (`{対象月}` written in), and the totals on the
 * first one: the same pure functions the server runs when it makes a draft.
 */
export function RecurringInvoiceForm({
  mode,
  options,
  initial,
  today,
  dueWindowDays,
  sourceNote,
}: {
  mode: RecurringInvoiceFormMode;
  options: InvoiceFormOptions;
  initial: RecurringInvoiceFormValues;
  today: CalendarDate;
  /** Due dates within this many days before today are due (`RECURRING_DUE_DAYS`, 18 §14.2). */
  dueWindowDays: number;
  /** 「請求書 INV-… を雛形にします」 for `from`. */
  sourceNote?: string | null;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const [draft, setDraft] = useState<FormDraft>(() => {
    const revenueAccountId =
      initial.revenueAccountId || defaultRevenueAccountId(options, initial.partnerId);
    return {
      ...initial,
      revenueAccountId,
      segmentId:
        initial.segmentId || defaultSegmentId(options, revenueAccountId, initial.partnerId),
      lines:
        initial.lines.length > 0
          ? initial.lines.map((line, index) => ({ ...line, key: `line-${index}` }))
          : [blankEditorLine("line-0")],
      edited: {
        revenueAccountId: initial.revenueAccountId !== "",
        segmentId: initial.segmentId !== "",
      },
    };
  });

  const change = (patch: Partial<FormDraft>) => setDraft({ ...draft, ...patch });

  function changePartner(partnerId: string) {
    const revenueAccountId = draft.edited.revenueAccountId
      ? draft.revenueAccountId
      : defaultRevenueAccountId(options, partnerId);
    change({
      partnerId,
      revenueAccountId,
      segmentId: draft.edited.segmentId
        ? draft.segmentId
        : defaultSegmentId(options, revenueAccountId, partnerId),
    });
  }

  function changeLines(lines: EditorLine[]) {
    // Adding or removing a line moves the indexes the errors name: they are cleared.
    if (lines.length !== draft.lines.length) setError(null);
    change({ lines });
  }

  const schedule = scheduleOf(draft);
  const offset = Number(draft.targetMonthOffset);
  const dueRule = { dueMonths: Number(draft.dueMonths), dueDay: Number(draft.dueDay) };
  const dueRuleProblem = recurringInvoiceDueRuleProblem(Number(draft.issueDay), dueRule);
  const nextDates = schedule ? nextRecurringInvoiceDates(schedule, { after: today, count: 3 }) : [];
  // Due dates already past (within the window): their drafts can be made right after saving.
  const pastDates = schedule
    ? recurringInvoiceDates(schedule, {
        after: addDays(today, -dueWindowDays),
        through: today,
      })
    : [];
  const totalsDate = nextDates[0] ?? pastDates.at(-1) ?? null;
  const { parsed, totals, ruleProblems, incomplete } = draftLineTotals(draft.lines, {
    pricesIncludeTax: draft.pricesIncludeTax,
    date: totalsDate,
    taxRules: options.taxRules,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = {
      name: draft.name,
      partnerId: draft.partnerId,
      title: draft.title,
      pricesIncludeTax: draft.pricesIncludeTax,
      note: draft.note,
      revenueAccountId: draft.revenueAccountId,
      segmentId: draft.segmentId,
      lines: draft.lines.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        taxCategoryCode: line.taxCategoryCode,
      })),
      frequency: draft.frequency,
      issueDay: draft.issueDay,
      targetMonthOffset: draft.targetMonthOffset,
      dueMonths: draft.dueMonths,
      dueDay: draft.dueDay,
      startDate: draft.startDate,
      endDate: draft.endDate,
    };
    startTransition(async () => {
      const result =
        mode.kind === "edit"
          ? await updateRecurringInvoiceAction(mode.id, values)
          : await createRecurringInvoiceAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(mode.kind === "edit" ? "保存しました" : "定期請求を追加しました");
      router.push(`/invoices/recurring/${result.data.id}`);
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const shows = (field: string) => {
    if (FIELDS.has(field)) return true;
    const match = LINE_FIELD.exec(field);
    return match !== null && Number(match[1]) < draft.lines.length;
  };
  const alerts = formLevelErrors(error, shows);
  const field = (name: string) => `${id}-${name}`;
  const titleOn = (date: CalendarDate) =>
    draft.title.trim() === "" ? null : expandTargetMonth(draft.title, date, offset);

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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_128px]">
        <FormField
          label="名前"
          htmlFor={field("name")}
          required
          error={fieldError("name")}
          help="一覧で使います（例: 顧問料 架空デザイン）"
        >
          <Input
            id={field("name")}
            value={draft.name}
            maxLength={60}
            aria-invalid={fieldError("name") ? true : undefined}
            onChange={(event) => change({ name: event.currentTarget.value })}
          />
        </FormField>
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
        <FormField
          label="件名"
          htmlFor={field("title")}
          error={fieldError("title")}
          help={`${TARGET_MONTH_PLACEHOLDER} は下書きを作るときに「2026年11月」の形に置き換えます`}
        >
          <Input
            id={field("title")}
            value={draft.title}
            maxLength={200}
            placeholder={`顧問料（${TARGET_MONTH_PLACEHOLDER}分）`}
            aria-invalid={fieldError("title") ? true : undefined}
            onChange={(event) => change({ title: event.currentTarget.value })}
          />
        </FormField>
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
        <div className="md:col-span-2 lg:col-span-4">
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

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[15px] font-extrabold">周期</legend>
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-[150px_130px_150px_minmax(0,1fr)_168px_168px]">
          <FormField
            label="周期"
            htmlFor={field("frequency")}
            required
            error={fieldError("frequency")}
          >
            <Select
              id={field("frequency")}
              value={draft.frequency}
              onChange={(event) =>
                change({ frequency: event.currentTarget.value as RecurringInvoiceFrequency })
              }
            >
              {RECURRING_INVOICE_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {RECURRING_INVOICE_FREQUENCY_LABELS[frequency]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="発行日"
            htmlFor={field("issue-day")}
            required
            error={fieldError("issueDay")}
          >
            <Select
              id={field("issue-day")}
              value={draft.issueDay}
              onChange={(event) => change({ issueDay: event.currentTarget.value })}
            >
              {DAYS.map((day) => (
                <option key={day} value={String(day)}>
                  {dayLabel(day)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="対象月"
            htmlFor={field("target")}
            error={fieldError("targetMonthOffset")}
          >
            <Select
              id={field("target")}
              value={draft.targetMonthOffset}
              onChange={(event) => change({ targetMonthOffset: event.currentTarget.value })}
            >
              {RECURRING_INVOICE_TARGET_OFFSETS.map((item) => (
                <option key={item.value} value={String(item.value)}>
                  {item.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="支払期限"
            htmlFor={field("due-months")}
            error={dueRuleProblem ?? fieldError("dueDay") ?? fieldError("dueMonths")}
            help="発行日から数えます"
          >
            <div className="flex gap-2">
              <Select
                id={field("due-months")}
                value={draft.dueMonths}
                aria-label="支払期限の月"
                onChange={(event) => change({ dueMonths: event.currentTarget.value })}
              >
                {RECURRING_INVOICE_DUE_MONTHS.map((months) => (
                  <option key={months} value={String(months)}>
                    {RECURRING_INVOICE_DUE_MONTH_LABELS[months]}
                  </option>
                ))}
              </Select>
              <Select
                id={field("due-day")}
                value={draft.dueDay}
                aria-label="支払期限の日"
                aria-invalid={dueRuleProblem || fieldError("dueDay") ? true : undefined}
                onChange={(event) => change({ dueDay: event.currentTarget.value })}
              >
                {DAYS.map((day) => (
                  <option key={day} value={String(day)}>
                    {dayLabel(day)}
                  </option>
                ))}
              </Select>
            </div>
          </FormField>
          <FormField
            label="開始日"
            htmlFor={field("start")}
            required
            error={fieldError("startDate")}
          >
            <Input
              id={field("start")}
              type="date"
              value={draft.startDate}
              aria-invalid={fieldError("startDate") ? true : undefined}
              onChange={(event) => change({ startDate: event.currentTarget.value })}
            />
          </FormField>
          <FormField
            label="終了日（任意）"
            htmlFor={field("end")}
            error={fieldError("endDate")}
            help="空なら終わりません"
          >
            <Input
              id={field("end")}
              type="date"
              value={draft.endDate}
              aria-invalid={fieldError("endDate") ? true : undefined}
              onChange={(event) => change({ endDate: event.currentTarget.value })}
            />
          </FormField>
        </div>
        <p className="text-[12px] text-muted">
          {isRecurringInvoiceFrequency(draft.frequency) ? FREQUENCY_HELP[draft.frequency] : null}
          。下書きは自動では発行しません。予定日にホームの「やること」に出ます
        </p>
      </fieldset>

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
              : defaultSegmentId(options, revenueAccountId, draft.partnerId),
            edited: { ...draft.edited, revenueAccountId: true },
          })
        }
        onSegmentChange={(segmentId) =>
          change({ segmentId, edited: { ...draft.edited, segmentId: true } })
        }
        fieldError={fieldError}
      />

      <InvoiceLinesEditor
        idPrefix={id}
        lines={draft.lines}
        onLinesChange={changeLines}
        parsed={parsed}
        taxCategories={options.taxCategories}
        pricesIncludeTax={draft.pricesIncludeTax}
        withDate={false}
        fieldError={fieldError}
        ruleProblems={ruleProblems}
      />
      <p className="-mt-3 text-[12px] text-muted">
        品名にも {TARGET_MONTH_PLACEHOLDER} を使えます（例: 顧問料 {TARGET_MONTH_PLACEHOLDER}）
      </p>

      <InvoiceTotalsSummary
        totals={totals}
        pricesIncludeTax={draft.pricesIncludeTax}
        hasDate={totalsDate !== null}
        incomplete={incomplete}
        noDateText="開始日を入れると、最初の予定日の税率で集計します"
      />

      <section
        aria-labelledby={field("preview")}
        aria-live="polite"
        className="rounded-card border border-border px-4 py-3"
      >
        <h2 id={field("preview")} className="mb-2 text-[15px] font-extrabold">
          次回 3 回の予定日
        </h2>
        {schedule === null ? (
          <p className="text-[13px] text-muted">開始日を入れると予定日を出します</p>
        ) : nextDates.length === 0 ? (
          <p className="text-[13px] text-muted">終了日までに次の予定日はありません</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {nextDates.map((date) => {
              const title = titleOn(date);
              return (
                <li key={date} className="text-[14px]">
                  <span className="num font-bold">{displayDate(date)}</span>
                  <span className="ml-2 text-[13px] text-muted">
                    支払期限 {displayDate(recurringInvoiceDueDate(date, dueRule))}
                  </span>
                  {title ? <span className="block break-words text-[13px]">{title}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
        {pastDates.length > 0 ? (
          <p className="mt-2 text-[12px] text-muted">
            保存すると、過ぎた予定日（{pastDates.map((date) => displayDate(date)).join("・")}
            ）のうち未作成の月の下書きも作れます
          </p>
        ) : null}
      </section>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-[12px] text-muted">
          雛形を直しても、作成済みの下書きと発行済みの請求書は変わりません
        </span>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}
