"use client";

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
import type { BonusItemResultView, BonusPreviewView } from "../../_lib/bonus-views";
import { WORKER_KIND_LABELS } from "../../_lib/labels";
import { amountKey } from "../../_lib/preview-key";
import { confirmBonusRunAction, previewBonusRunAction } from "../../actions";

/** One person's amounts as typed (the master data stays on the server). */
export interface BonusItemDraft {
  employeeId: string;
  bonus: string;
  /** "" = 前月の給与なし. */
  previousMonthPay: string;
  previousMonthTax: string;
  /** Officers only (事前確定届出給与). */
  filingDate: string;
  filingAmount: string;
}

export interface BonusDraftView {
  paymentDate: string;
  title: string;
  calcPeriodOver6Months: boolean;
  /** "" = 未払金〔給与〕. */
  payFromWalletId: string;
  withholdingSpecialDue: boolean;
  /** One per active employee, in the order of `employees`. */
  items: BonusItemDraft[];
}

export interface BonusEmployee {
  id: string;
  name: string;
  kind: keyof typeof WORKER_KIND_LABELS;
  /** Coverage in the pay month. */
  coverageNotes: string[];
  /** 「甲欄 1 人」 */
  taxColumn: string;
  /** Where 前月の給与 came from (or that there was none). */
  previousMonthSource: string;
}

interface PreviewState {
  key: string;
  result: ActionResult<BonusPreviewView> | null;
}

const SETTING_FIELDS = new Set([
  "paymentDate",
  "title",
  "calcPeriodOver6Months",
  "payFromWalletId",
  "withholdingSpecialDue",
]);
/** Fields of a person drawn with an error line (`items.<n>` itself: under the name). */
const ITEM_FIELD =
  /^items\.(\d+)(\.(bonus|previousMonthPay|previousMonthTax|filingDate|filingAmount))?$/;

const PREVIEW_DELAY_MS = 300;

function toInput(payMonth: string, draft: BonusDraftView) {
  return {
    payMonth,
    paymentDate: draft.paymentDate,
    title: draft.title,
    calcPeriodOver6Months: draft.calcPeriodOver6Months,
    payFromWalletId: draft.payFromWalletId,
    withholdingSpecialDue: draft.withholdingSpecialDue,
    items: draft.items.map((item) => ({ ...item })),
  };
}

/** What the preview was computed for: amounts by value (the fields reformat themselves on blur). */
function previewKey(payMonth: string, draft: BonusDraftView): string {
  const input = toInput(payMonth, draft);
  return JSON.stringify({
    ...input,
    title: input.title.trim(),
    items: input.items.map((item) => ({
      ...item,
      bonus: amountKey(item.bonus),
      previousMonthPay: amountKey(item.previousMonthPay),
      previousMonthTax: amountKey(item.previousMonthTax),
      filingAmount: amountKey(item.filingAmount),
    })),
  });
}

/** Nobody has a bonus yet: there is nothing to calculate. */
function hasNoBonus(draft: BonusDraftView): boolean {
  return draft.items.every((item) => {
    const amount = parseYenInput(item.bonus);
    return item.bonus.trim() === "" || amount === 0n;
  });
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

function Results({ result, stale }: { result: BonusItemResultView | null; stale: boolean }) {
  return (
    <dl
      className={`grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-surface-2 px-3 py-2.5 sm:grid-cols-4 ${
        stale ? "opacity-60" : ""
      }`}
      aria-busy={stale}
    >
      <Result
        label="標準賞与額（円）"
        value={result?.standardBonus ?? null}
        detail={result?.standardBonusDetail}
      />
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
      <Result label="計算方法" value={result?.method ?? null} detail={result?.methodDetail} />
      <Result label="源泉所得税（円）" value={result?.incomeTax ?? null} />
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
 * 賞与の計算 (22-payroll §10.5): the settings, a block per active employee with the bonus, the
 * previous month's pay and tax (from the month before's run, editable) and, for an officer, the
 * 事前確定届出給与 filing; the results recomputed by the server as you type (300 ms after the last
 * change, stale answers dropped), the warnings, the tables, the 2 entries and the deadlines;
 * 「確定」 confirms what the latest calculation showed (its table versions and totals).
 */
export function BonusForm({
  payMonth,
  payMonthLabel,
  previousPayMonthLabel,
  employees,
  wallets,
  initialDraft,
}: {
  payMonth: string;
  /** 「2026 年 12 月」 */
  payMonthLabel: string;
  /** 「2026 年 11 月」 */
  previousPayMonthLabel: string;
  employees: BonusEmployee[];
  wallets: { value: string; label: string }[];
  initialDraft: BonusDraftView;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<BonusDraftView>(initialDraft);
  const [preview, setPreview] = useState<PreviewState>(() => ({
    key: previewKey(payMonth, initialDraft),
    result: null,
  }));
  const [submitted, setSubmitted] = useState<ActionError | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [previewing, startPreview] = useTransition();
  const [confirming, startConfirm] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);

  const key = previewKey(payMonth, draft);
  const empty = hasNoBonus(draft);
  const upToDate = preview.key === key && !previewing;
  const view = !empty && preview.result?.ok ? preview.result.data : null;
  const stale = !upToDate;
  const shownError =
    submitted ?? (empty || !preview.result || preview.result.ok ? null : preview.result);
  const fieldError = (field: string) => shownError?.fieldErrors[field];
  const itemError = (index: number, field?: string) =>
    shownError?.fieldErrors[field ? `items.${index}.${field}` : `items.${index}`];
  const alerts = formLevelErrors(shownError, (field) => {
    if (SETTING_FIELDS.has(field)) return true;
    const match = ITEM_FIELD.exec(field);
    return match !== null && Number(match[1]) < draft.items.length;
  });
  const canConfirm = view !== null && upToDate && !confirming;

  function change(next: BonusDraftView) {
    setDraft(next);
    setSubmitted(null);
    const nextKey = previewKey(payMonth, next);
    // Only reformatted (e.g. 300000 → 300,000 on blur): the preview asked for already applies.
    if (nextKey === key) return;
    if (timer.current) clearTimeout(timer.current);
    if (hasNoBonus(next)) {
      sequence.current += 1;
      setPreview({ key: nextKey, result: null });
      return;
    }
    timer.current = setTimeout(() => {
      sequence.current += 1;
      const request = sequence.current;
      startPreview(async () => {
        const result = await previewBonusRunAction(toInput(payMonth, next));
        if (request === sequence.current) setPreview({ key: nextKey, result });
      });
    }, PREVIEW_DELAY_MS);
  }

  const changeSettings = (patch: Partial<Omit<BonusDraftView, "items">>) =>
    change({ ...draft, ...patch });
  const changeItem = (index: number, patch: Partial<BonusItemDraft>) =>
    change({
      ...draft,
      items: draft.items.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    });

  function confirm() {
    if (!view || !upToDate) return;
    const input = { ...toInput(payMonth, draft), tableIds: view.tableIds, expected: view.expected };
    startConfirm(async () => {
      const result = await confirmBonusRunAction(input);
      if (!result.ok) {
        setSubmitted(result);
        return;
      }
      toast(`${result.data.label}を確定しました`);
      router.push(`/payroll/bonus/${result.data.id}`);
    });
  }

  const field = (name: string) => `${id}-${name}`;
  const paidFrom = wallets.find((wallet) => wallet.value === draft.payFromWalletId);

  return (
    <div className="flex flex-col gap-8">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <Section title="賞与の設定">
        <div className="grid gap-4 rounded-card border border-border bg-surface p-4 md:grid-cols-2">
          <FormField
            label="支払日"
            htmlFor={field("date")}
            required
            error={fieldError("paymentDate")}
            help={`${payMonthLabel}の日付。仕訳の日付で、税額の表はこの日の年分、社会保険料はこの月の料率です`}
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
            label="題名"
            htmlFor={field("title")}
            required
            error={fieldError("title")}
            help="仕訳の摘要と賞与明細に出します"
          >
            <Input
              id={field("title")}
              value={draft.title}
              maxLength={40}
              placeholder="例: 夏季賞与"
              onChange={(event) => changeSettings({ title: event.currentTarget.value })}
              {...describedBy(field("title"), { help: true, error: fieldError("title") })}
            />
          </FormField>
          <FormField
            label="賞与の計算期間"
            htmlFor={field("period")}
            error={fieldError("calcPeriodOver6Months")}
            help="前月の給与がないときなどに月額表で求める税額を、6 か月超なら 12 で割って 12 倍します"
          >
            <Select
              id={field("period")}
              value={draft.calcPeriodOver6Months ? "over" : "within"}
              onChange={(event) =>
                changeSettings({ calcPeriodOver6Months: event.currentTarget.value === "over" })
              }
              {...describedBy(field("period"), {
                help: true,
                error: fieldError("calcPeriodOver6Months"),
              })}
            >
              <option value="within">6 か月以下</option>
              <option value="over">6 か月超</option>
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
          <fieldset className="flex min-w-0 flex-col gap-1 md:col-span-2">
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
            {fieldError("withholdingSpecialDue") ? (
              <p role="alert" className="text-[12px] font-bold text-danger">
                {fieldError("withholdingSpecialDue")}
              </p>
            ) : null}
            <p className="text-[12px] text-muted">
              賞与の源泉所得税を給与と同じ半年ごとの納付にまとめます。住民税は賞与から控除しません
            </p>
          </fieldset>
        </div>
      </Section>

      <Section title="従業員ごとの賞与">
        {employees.map((employee, index) => {
          const item = draft.items[index];
          if (!item) return null;
          const result = view?.items.find((row) => row.employeeId === employee.id) ?? null;
          const warnings =
            view?.warnings.filter((warning) => warning.employeeId === employee.id) ?? [];
          const paid = parseYenInput(item.bonus) !== null && parseYenInput(item.bonus) !== 0n;
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
                <span className="text-[12px] text-muted">
                  {[...employee.coverageNotes, employee.taxColumn].join(" · ")}
                </span>
              </header>
              {itemError(index) ? (
                <p role="alert" className="text-[12px] font-bold text-danger">
                  {itemError(index)}
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField
                  label="賞与の額（円）"
                  htmlFor={itemField("bonus")}
                  error={itemError(index, "bonus")}
                  help="空か 0 なら、この人には支給しません"
                >
                  <MoneyInput
                    id={itemField("bonus")}
                    value={item.bonus}
                    placeholder="0"
                    onValueChange={(bonus) => changeItem(index, { bonus })}
                    {...describedBy(itemField("bonus"), {
                      help: true,
                      error: itemError(index, "bonus"),
                    })}
                  />
                </FormField>
                <FormField
                  label="前月の給与（社会保険料等控除後・円）"
                  htmlFor={itemField("previous")}
                  error={itemError(index, "previousMonthPay")}
                  help={`${employee.previousMonthSource}。空なら前月の給与なし`}
                >
                  <MoneyInput
                    id={itemField("previous")}
                    allowNegative
                    value={item.previousMonthPay}
                    placeholder="なし"
                    onValueChange={(previousMonthPay) => changeItem(index, { previousMonthPay })}
                    {...describedBy(itemField("previous"), {
                      help: true,
                      error: itemError(index, "previousMonthPay"),
                    })}
                  />
                </FormField>
                <FormField
                  label="前月の税額（円）"
                  htmlFor={itemField("previous-tax")}
                  error={itemError(index, "previousMonthTax")}
                  help={`${previousPayMonthLabel}の給与の月額表の税額。前月の給与の 10 倍を超える賞与で使います`}
                >
                  <MoneyInput
                    id={itemField("previous-tax")}
                    value={item.previousMonthTax}
                    placeholder="0"
                    onValueChange={(previousMonthTax) => changeItem(index, { previousMonthTax })}
                    {...describedBy(itemField("previous-tax"), {
                      help: true,
                      error: itemError(index, "previousMonthTax"),
                    })}
                  />
                </FormField>
              </div>
              {employee.kind === "officer" ? (
                <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
                  <legend className="px-1 text-[12px] font-bold text-muted">
                    事前確定届出給与の届出
                  </legend>
                  <FormField
                    label="届け出た支給日"
                    htmlFor={itemField("filing-date")}
                    error={itemError(index, "filingDate")}
                  >
                    <Input
                      id={itemField("filing-date")}
                      type="date"
                      value={item.filingDate}
                      onChange={(event) =>
                        changeItem(index, { filingDate: event.currentTarget.value })
                      }
                      {...describedBy(itemField("filing-date"), {
                        error: itemError(index, "filingDate"),
                      })}
                    />
                  </FormField>
                  <FormField
                    label="届け出た金額（円）"
                    htmlFor={itemField("filing-amount")}
                    error={itemError(index, "filingAmount")}
                  >
                    <MoneyInput
                      id={itemField("filing-amount")}
                      value={item.filingAmount}
                      onValueChange={(filingAmount) => changeItem(index, { filingAmount })}
                      {...describedBy(itemField("filing-amount"), {
                        error: itemError(index, "filingAmount"),
                      })}
                    />
                  </FormField>
                  <p className="text-[12px] text-muted sm:self-end">
                    役員の賞与は届け出た支給日と金額どおりでないと損金に算入されません
                  </p>
                </fieldset>
              ) : null}
              {warnings.length > 0 ? (
                <div className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
                  {warnings.map((warning) => (
                    <p key={warning.message}>{warning.message}</p>
                  ))}
                </div>
              ) : null}
              {paid ? (
                <Results result={result} stale={stale} />
              ) : (
                <p className="text-[13px] text-muted">支給なし</p>
              )}
            </section>
          );
        })}
      </Section>

      <Section title="作る仕訳と納付予定">
        {view ? (
          <div className={`flex flex-col gap-5 ${stale ? "opacity-60" : ""}`} aria-busy={stale}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-4 py-3 sm:grid-cols-5">
              <Result label="人数" value={`${view.totals.headcount} 人`} />
              <Result label="賞与の合計（円）" value={view.totals.grossPay} />
              <Result label="控除計の合計（円）" value={view.totals.totalDeductions} />
              <Result label="差引支給の合計（円）" value={view.totals.netPay} strong />
              <Result label="会社負担（円）" value={view.totals.employerTotal} />
            </dl>
            <div className="flex flex-col gap-1">
              <h3 className="text-[13px] font-bold text-muted">使う表の版</h3>
              <p className="text-[13px]">
                {view.tableTitles.join(" / ")}
                <span className="ml-2 text-muted">社会保険料の対象月 {payMonthLabel}分</span>
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
              <h3 className="text-[13px] font-bold text-muted">納付予定と届出</h3>
              {view.schedule.length > 0 || view.filing ? (
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
                  {view.filing ? (
                    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3.5 py-2 text-[14px]">
                      <span className="font-bold">届出</span>
                      <span className="num text-[13px] text-muted">期限 {view.filing.dueDate}</span>
                      <span className="min-w-0 text-[13px] text-muted">{view.filing.title}</span>
                    </li>
                  ) : null}
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
            {previewing
              ? "計算中…"
              : empty
                ? "賞与の額を入れると、結果と作る仕訳・納付予定を出します。"
                : "入力を直すと、作る仕訳と納付予定を出します。"}
          </p>
        )}
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        <p className="mr-auto text-[13px] text-muted" aria-live="polite">
          {previewing || (view && stale)
            ? "再計算中…"
            : view
              ? `差引支給の合計 ${view.totals.netPay} 円（${view.totals.headcount} 人）`
              : "賞与の額を入れると確定できます"}
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
        title={`${draft.title.trim() || "賞与"}（${payMonthLabel}支給）を確定します`}
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
              {` · ${view.totals.headcount} 人`}
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
            {view.filing ? (
              <p className="text-[13px]">
                {view.filing.title} · 期限 <span className="num">{view.filing.dueDate}</span>
              </p>
            ) : null}
            {view.warnings.length > 0 ? (
              <div className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
                {view.warnings.map((warning) => (
                  <p key={warning.message}>{warning.message}</p>
                ))}
              </div>
            ) : null}
            <p className="mt-1 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              確定後は変えられません。直すときは取引で仕訳を訂正します。
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
