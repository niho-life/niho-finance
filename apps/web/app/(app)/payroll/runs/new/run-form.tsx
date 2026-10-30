"use client";

import type { PremiumTiming } from "@niho-finance/payroll";
import { parseYenInput } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, describedBy, FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";
import { EntryPreview } from "../../_components/entry-preview";
import { WORKER_KIND_LABELS } from "../../_lib/labels";
import { amountKey } from "../../_lib/preview-key";
import type { RunItemResultView, RunPreviewView } from "../../_lib/views";
import { confirmPayrollRunAction, previewPayrollRunAction } from "../../actions";

/** One person's amounts as typed (the master data stays on the server). */
export interface RunItemDraft {
  employeeId: string;
  taxablePay: string;
  commuteAllowance: string;
  residentTax: string;
  incomeTaxAdjustment: string;
  socialInsuranceAdjustment: string;
  adjustmentNote: string;
}

export interface RunDraft {
  paymentDate: string;
  premiumTiming: PremiumTiming;
  /** "" = 未払金〔給与〕. */
  payFromWalletId: string;
  withholdingSpecialDue: boolean;
  residentTaxSpecialDue: boolean;
  /** One per active employee, in the order of `employees`. */
  items: RunItemDraft[];
}

export interface RunEmployee {
  id: string;
  name: string;
  kind: keyof typeof WORKER_KIND_LABELS;
  /** Coverage in the draft's premium month (before the first calculation comes back). */
  coverageNotes: string[];
}

interface PreviewState {
  key: string;
  result: ActionResult<RunPreviewView>;
}

const SETTING_FIELDS = new Set([
  "paymentDate",
  "premiumTiming",
  "payFromWalletId",
  "withholdingSpecialDue",
  "residentTaxSpecialDue",
]);
/** Fields of a person drawn with an error line (`items.<n>` itself: under the name). */
const ITEM_FIELD =
  /^items\.(\d+)(\.(taxablePay|commuteAllowance|residentTax|incomeTaxAdjustment|socialInsuranceAdjustment|adjustmentNote))?$/;

const PREVIEW_DELAY_MS = 300;

function toInput(payMonth: string, draft: RunDraft) {
  return {
    payMonth,
    paymentDate: draft.paymentDate,
    premiumTiming: draft.premiumTiming,
    payFromWalletId: draft.payFromWalletId,
    withholdingSpecialDue: draft.withholdingSpecialDue,
    residentTaxSpecialDue: draft.residentTaxSpecialDue,
    items: draft.items.map((item) => ({ ...item })),
  };
}

/** What the preview was computed for: amounts by value (the fields reformat themselves on blur). */
function previewKey(payMonth: string, draft: RunDraft): string {
  const input = toInput(payMonth, draft);
  return JSON.stringify({
    ...input,
    items: input.items.map((item) => ({
      ...item,
      taxablePay: amountKey(item.taxablePay),
      commuteAllowance: amountKey(item.commuteAllowance),
      residentTax: amountKey(item.residentTax),
      incomeTaxAdjustment: amountKey(item.incomeTaxAdjustment),
      socialInsuranceAdjustment: amountKey(item.socialInsuranceAdjustment),
      adjustmentNote: item.adjustmentNote.trim(),
    })),
  });
}

function isAdjusted(item: RunItemDraft): boolean {
  const nonZero = (text: string) => {
    const amount = parseYenInput(text, { allowNegative: true });
    return text.trim() !== "" && amount !== 0n;
  };
  return nonZero(item.incomeTaxAdjustment) || nonZero(item.socialInsuranceAdjustment);
}

function Result({
  label,
  value,
  detail,
  strong = false,
}: {
  label: string;
  value: string | null;
  detail?: string | null;
  strong?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] font-bold text-muted">{label}</dt>
      <dd className={`num text-[14px] ${strong ? "text-[16px] font-extrabold" : "font-bold"}`}>
        {value ?? "—"}
        {detail ? <span className="block text-[11px] font-normal text-muted">{detail}</span> : null}
      </dd>
    </div>
  );
}

function Results({ result, stale }: { result: RunItemResultView | null; stale: boolean }) {
  return (
    <dl
      className={`grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-surface-2 px-3 py-2.5 sm:grid-cols-4 ${
        stale ? "opacity-60" : ""
      }`}
      aria-busy={stale}
    >
      <Result label="総支給（円）" value={result?.grossPay ?? null} />
      <Result
        label="社会保険（円）"
        value={result?.socialInsurance ?? null}
        detail={result?.socialInsuranceDetail}
      />
      <Result
        label="雇用保険（円）"
        value={result ? (result.employmentInsurance ?? "なし") : null}
      />
      <Result label="源泉の対象額（円）" value={result?.withholdingBase ?? null} />
      <Result
        label="源泉所得税（円）"
        value={result?.incomeTax ?? null}
        detail={result?.incomeTaxDetail}
      />
      <Result label="住民税（円）" value={result?.residentTax ?? null} />
      <Result label="控除計（円）" value={result?.totalDeductions ?? null} />
      <Result label="差引支給額（円）" value={result?.netPay ?? null} strong />
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-extrabold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * 支給の計算 (22-payroll §6.3): the settings, a block per active employee with the amounts and
 * 調整, the results recomputed by the server as you type (300 ms after the last change, stale
 * answers dropped), the tables used, the 2 entries and the deadlines; 「確定」 confirms what the
 * latest calculation showed (its table versions and totals).
 */
export function RunForm({
  payMonth,
  payMonthLabel,
  employees,
  wallets,
  premiumTimings,
  premiumTimingLocked,
  initialDraft,
  initialPreview,
}: {
  payMonth: string;
  /** 「2026 年 12 月」 */
  payMonthLabel: string;
  employees: RunEmployee[];
  wallets: { value: string; label: string }[];
  premiumTimings: { value: PremiumTiming; label: string }[];
  premiumTimingLocked: boolean;
  initialDraft: RunDraft;
  initialPreview: ActionResult<RunPreviewView>;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<RunDraft>(initialDraft);
  const [preview, setPreview] = useState<PreviewState>(() => ({
    key: previewKey(payMonth, initialDraft),
    result: initialPreview,
  }));
  const [submitted, setSubmitted] = useState<ActionError | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [previewing, startPreview] = useTransition();
  const [confirming, startConfirm] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  const key = previewKey(payMonth, draft);
  const upToDate = preview.key === key && !previewing;
  const view = preview.result.ok ? preview.result.data : null;
  const stale = !upToDate;
  const shownError = submitted ?? (preview.result.ok ? null : preview.result);
  const fieldError = (field: string) => shownError?.fieldErrors[field];
  const itemError = (index: number, field?: string) =>
    shownError?.fieldErrors[field ? `items.${index}.${field}` : `items.${index}`];
  const alerts = formLevelErrors(shownError, (field) => {
    if (SETTING_FIELDS.has(field)) return true;
    const match = ITEM_FIELD.exec(field);
    return match !== null && Number(match[1]) < draft.items.length;
  });
  const canConfirm = view !== null && upToDate && !confirming;

  function change(next: RunDraft) {
    setDraft(next);
    setSubmitted(null);
    const nextKey = previewKey(payMonth, next);
    // Only reformatted (e.g. 300000 → 300,000 on blur): the preview asked for already applies.
    if (nextKey === key) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sequence.current += 1;
      const request = sequence.current;
      startPreview(async () => {
        const result = await previewPayrollRunAction(toInput(payMonth, next));
        if (request === sequence.current) setPreview({ key: nextKey, result });
      });
    }, PREVIEW_DELAY_MS);
  }

  const changeSettings = (patch: Partial<Omit<RunDraft, "items">>) =>
    change({ ...draft, ...patch });
  const changeItem = (index: number, patch: Partial<RunItemDraft>) =>
    change({
      ...draft,
      items: draft.items.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    });

  function toggleAdjustments(employeeId: string) {
    const next = new Set(expanded);
    if (next.has(employeeId)) next.delete(employeeId);
    else next.add(employeeId);
    setExpanded(next);
  }

  function confirm() {
    if (!view || !upToDate) return;
    const input = { ...toInput(payMonth, draft), tableIds: view.tableIds, expected: view.expected };
    startConfirm(async () => {
      const result = await confirmPayrollRunAction(input);
      if (!result.ok) {
        setSubmitted(result);
        return;
      }
      toast(`${result.data.payMonthLabel}の支給を確定しました`);
      router.push(`/payroll/runs/${result.data.id}`);
    });
  }

  const field = (name: string) => `${id}-${name}`;
  const paidFrom = wallets.find((wallet) => wallet.value === draft.payFromWalletId);
  const timing = premiumTimings.find((option) => option.value === draft.premiumTiming);

  return (
    <div className="flex flex-col gap-8">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <Section title="支給の設定">
        <div className="grid gap-4 rounded-card border border-border bg-surface p-4 md:grid-cols-2">
          <FormField
            label="支払日"
            htmlFor={field("date")}
            required
            error={fieldError("paymentDate")}
            help={`${payMonthLabel}の日付。仕訳の日付で、源泉徴収税額表はこの日の年分を使います`}
          >
            <Input
              id={field("date")}
              type="date"
              value={draft.paymentDate}
              onChange={(event) => changeSettings({ paymentDate: event.currentTarget.value })}
              {...describedBy(field("date"), { help: true, error: fieldError("paymentDate") })}
            />
          </FormField>
          <FormField
            label="社会保険料の控除"
            htmlFor={field("timing")}
            error={fieldError("premiumTiming")}
            help={
              premiumTimingLocked
                ? "最初の支給で決まっています。変えると対象月が抜けるか重なるので、変えられません"
                : "最初の支給で決まり、後から変えられません"
            }
          >
            <Select
              id={field("timing")}
              value={draft.premiumTiming}
              disabled={premiumTimingLocked}
              onChange={(event) =>
                changeSettings({ premiumTiming: event.currentTarget.value as PremiumTiming })
              }
              {...describedBy(field("timing"), { help: true, error: fieldError("premiumTiming") })}
            >
              {premiumTimings.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="支払元"
            htmlFor={field("wallet")}
            error={fieldError("payFromWalletId")}
            help={
              draft.payFromWalletId === ""
                ? "差引支給額を未払金〔給与〕に計上します。振込は明細か取引で消します"
                : "差引支給額をこの口座から払った仕訳にします"
            }
          >
            <Select
              id={field("wallet")}
              value={draft.payFromWalletId}
              onChange={(event) => changeSettings({ payFromWalletId: event.currentTarget.value })}
              {...describedBy(field("wallet"), {
                help: true,
                error: fieldError("payFromWalletId"),
              })}
            >
              <option value="">未払金〔給与〕に計上</option>
              {wallets.map((wallet) => (
                <option key={wallet.value} value={wallet.value}>
                  {wallet.label}
                </option>
              ))}
            </Select>
          </FormField>
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 text-[12px] font-bold text-muted">
              納期の特例（承認あり）
            </legend>
            <Checkbox
              id={field("withholding-special")}
              label="源泉所得税の納期の特例"
              checked={draft.withholdingSpecialDue}
              onChange={(event) =>
                changeSettings({ withholdingSpecialDue: event.currentTarget.checked })
              }
            />
            <Checkbox
              id={field("resident-special")}
              label="住民税の納期の特例"
              checked={draft.residentTaxSpecialDue}
              onChange={(event) =>
                changeSettings({ residentTaxSpecialDue: event.currentTarget.checked })
              }
            />
            {fieldError("withholdingSpecialDue") || fieldError("residentTaxSpecialDue") ? (
              <p role="alert" className="text-[12px] font-bold text-danger">
                {fieldError("withholdingSpecialDue") ?? fieldError("residentTaxSpecialDue")}
              </p>
            ) : null}
            <p className="text-[12px] text-muted">納付の期限が半年ごとにまとまります</p>
          </fieldset>
        </div>
      </Section>

      <Section title="従業員ごとの支給">
        {employees.map((employee, index) => {
          const item = draft.items[index];
          if (!item) return null;
          const result = view?.items.find((row) => row.employeeId === employee.id) ?? null;
          const notes = result?.coverageNotes ?? employee.coverageNotes;
          const adjusted = isAdjusted(item);
          const adjustmentError =
            itemError(index, "incomeTaxAdjustment") ??
            itemError(index, "socialInsuranceAdjustment") ??
            itemError(index, "adjustmentNote");
          const showAdjustments = adjusted || expanded.has(employee.id) || Boolean(adjustmentError);
          const itemField = (name: string) => field(`${index}-${name}`);
          return (
            <section
              key={employee.id}
              aria-labelledby={itemField("name")}
              className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
            >
              <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 id={itemField("name")} className="text-[15px] font-extrabold">
                  {employee.name}
                </h3>
                <span className="text-[12px] font-bold text-muted">
                  {WORKER_KIND_LABELS[employee.kind]}
                </span>
                <span className="text-[12px] text-muted">{notes.join(" · ")}</span>
              </header>
              {itemError(index) ? (
                <p role="alert" className="text-[12px] font-bold text-danger">
                  {itemError(index)}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField
                  label="課税支給（円）"
                  htmlFor={itemField("taxable")}
                  required
                  error={itemError(index, "taxablePay")}
                >
                  <MoneyInput
                    id={itemField("taxable")}
                    value={item.taxablePay}
                    onValueChange={(taxablePay) => changeItem(index, { taxablePay })}
                    {...describedBy(itemField("taxable"), {
                      error: itemError(index, "taxablePay"),
                    })}
                  />
                </FormField>
                <FormField
                  label="通勤手当（円）"
                  htmlFor={itemField("commute")}
                  error={itemError(index, "commuteAllowance")}
                >
                  <MoneyInput
                    id={itemField("commute")}
                    value={item.commuteAllowance}
                    onValueChange={(commuteAllowance) => changeItem(index, { commuteAllowance })}
                    {...describedBy(itemField("commute"), {
                      error: itemError(index, "commuteAllowance"),
                    })}
                  />
                </FormField>
                <FormField
                  label="住民税（円）"
                  htmlFor={itemField("resident")}
                  error={itemError(index, "residentTax")}
                >
                  <MoneyInput
                    id={itemField("resident")}
                    value={item.residentTax}
                    onValueChange={(residentTax) => changeItem(index, { residentTax })}
                    {...describedBy(itemField("resident"), {
                      error: itemError(index, "residentTax"),
                    })}
                  />
                </FormField>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => toggleAdjustments(employee.id)}
                  aria-expanded={showAdjustments}
                  aria-controls={itemField("adjustments")}
                  disabled={adjusted || Boolean(adjustmentError)}
                  className="inline-flex min-h-8 w-fit items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span aria-hidden="true">{showAdjustments ? "▾" : "▸"}</span>
                  {adjusted ? "調整（入力あり）" : "調整"}
                </button>
                {showAdjustments ? (
                  <div
                    id={itemField("adjustments")}
                    className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3"
                  >
                    <FormField
                      label="源泉所得税の調整（円）"
                      htmlFor={itemField("tax-adjustment")}
                      error={itemError(index, "incomeTaxAdjustment")}
                    >
                      <MoneyInput
                        id={itemField("tax-adjustment")}
                        allowNegative
                        value={item.incomeTaxAdjustment}
                        placeholder="0"
                        onValueChange={(incomeTaxAdjustment) =>
                          changeItem(index, { incomeTaxAdjustment })
                        }
                        {...describedBy(itemField("tax-adjustment"), {
                          error: itemError(index, "incomeTaxAdjustment"),
                        })}
                      />
                    </FormField>
                    <FormField
                      label="社会保険料の調整（円）"
                      htmlFor={itemField("social-adjustment")}
                      error={itemError(index, "socialInsuranceAdjustment")}
                    >
                      <MoneyInput
                        id={itemField("social-adjustment")}
                        allowNegative
                        value={item.socialInsuranceAdjustment}
                        placeholder="0"
                        onValueChange={(socialInsuranceAdjustment) =>
                          changeItem(index, { socialInsuranceAdjustment })
                        }
                        {...describedBy(itemField("social-adjustment"), {
                          error: itemError(index, "socialInsuranceAdjustment"),
                        })}
                      />
                    </FormField>
                    <FormField
                      label="調整のメモ"
                      htmlFor={itemField("note")}
                      required={adjusted}
                      error={itemError(index, "adjustmentNote")}
                    >
                      <Input
                        id={itemField("note")}
                        value={item.adjustmentNote}
                        maxLength={200}
                        placeholder="例: 11 月分の住民税の差額"
                        onChange={(event) =>
                          changeItem(index, { adjustmentNote: event.currentTarget.value })
                        }
                        {...describedBy(itemField("note"), {
                          error: itemError(index, "adjustmentNote"),
                        })}
                      />
                    </FormField>
                    <p className="text-[12px] text-muted sm:col-span-3">
                      前の支給の誤りを直す額です。マイナスで控除を減らします。調整したときは、何を直したかをメモに書きます。
                    </p>
                  </div>
                ) : null}
              </div>
              <Results result={result} stale={stale} />
            </section>
          );
        })}
      </Section>

      <Section title="作る仕訳と納付予定">
        {view ? (
          <div className={`flex flex-col gap-5 ${stale ? "opacity-60" : ""}`} aria-busy={stale}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-4 py-3 sm:grid-cols-5">
              <Result label="人数" value={`${view.totals.headcount} 人`} />
              <Result label="総支給の合計（円）" value={view.totals.grossPay} />
              <Result label="控除計の合計（円）" value={view.totals.totalDeductions} />
              <Result label="差引支給の合計（円）" value={view.totals.netPay} strong />
              <Result label="会社負担（円）" value={view.totals.employerTotal} />
            </dl>
            <div className="flex flex-col gap-1">
              <h3 className="text-[13px] font-bold text-muted">使う表の版</h3>
              <p className="text-[13px]">
                {view.tableTitles.join(" / ")}
                <span className="ml-2 text-muted">社会保険料の対象月 {view.premiumMonthLabel}</span>
              </p>
            </div>
            <EntryPreview entry={view.entries.pay} label="仕訳 1" />
            {view.entries.employer ? (
              <EntryPreview entry={view.entries.employer} label="仕訳 2" />
            ) : (
              <p className="text-[13px] text-muted">
                会社負担の社会保険料がないので、法定福利費の仕訳は作りません。
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <h3 className="text-[13px] font-bold text-muted">納付予定</h3>
              {view.schedule.length > 0 ? (
                <ul className="rounded-card border border-border bg-surface">
                  {view.schedule.map((row) => (
                    <li
                      key={row.key}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border px-3.5 py-2 text-[14px] last:border-b-0"
                    >
                      <span className="font-bold">{row.categoryLabel}</span>
                      <span className="num text-[13px] text-muted">期限 {row.dueDate}</span>
                      <span className="min-w-0 text-[13px] text-muted">{row.title}</span>
                      <span className="num ml-auto font-bold">{row.amount} 円</span>
                      {row.scheduledTotal ? (
                        <span className="num w-full text-right text-[12px] text-muted">
                          この期限の合計 {row.scheduledTotal} 円（ほかの支給の分を含む）
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">
                  納付する額がないので、納付予定は作りません。
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
            {previewing ? "計算中…" : "入力を直すと、作る仕訳と納付予定を出します。"}
          </p>
        )}
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        <p className="mr-auto text-[13px] text-muted" aria-live="polite">
          {previewing || (view && stale)
            ? "再計算中…"
            : view
              ? `差引支給の合計 ${view.totals.netPay} 円（${view.totals.headcount} 人）`
              : "入力を直すと確定できます"}
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setSubmitted(null);
            setConfirmOpen(true);
          }}
          disabled={!canConfirm}
        >
          確定
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen && view !== null}
        title={`${payMonthLabel}の支給を確定します`}
        confirmLabel="確定"
        pending={confirming}
        error={submitted?.error ?? null}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={confirm}
      >
        {view ? (
          <div className="flex flex-col gap-2">
            <p>
              支払日 <span className="num font-bold">{draft.paymentDate.replaceAll("-", "/")}</span>
              {" · "}
              {paidFrom ? `${paidFrom.label}から支払` : "未払金〔給与〕に計上"}
              {timing ? ` · ${timing.label}` : null}
            </p>
            <div>
              <p className="text-[13px] font-bold text-muted">
                仕訳 {view.entries.employer ? 2 : 1} 件
              </p>
              <ul className="text-[13px]">
                <li>
                  {view.entries.pay.description}{" "}
                  <span className="num font-bold">{view.entries.pay.debitTotal}</span> 円
                </li>
                {view.entries.employer ? (
                  <li>
                    {view.entries.employer.description}{" "}
                    <span className="num font-bold">{view.entries.employer.debitTotal}</span> 円
                  </li>
                ) : null}
              </ul>
            </div>
            {view.schedule.length > 0 ? (
              <div>
                <p className="text-[13px] font-bold text-muted">
                  納付予定 {view.schedule.length} 件
                </p>
                <ul className="text-[13px]">
                  {view.schedule.map((row) => (
                    <li key={row.key}>
                      {row.categoryLabel} · 期限 <span className="num">{row.dueDate}</span> ·{" "}
                      <span className="num font-bold">{row.amount}</span> 円
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="mt-1 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              確定後は変えられません。直すときは次の支給の調整で行うか、取引で仕訳を訂正します。
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
