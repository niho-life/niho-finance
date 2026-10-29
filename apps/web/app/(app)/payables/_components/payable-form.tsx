"use client";

import type { PayableFormAccount, PayableFormOptions, PayableFormPartner } from "@niho-finance/db";
import {
  describePaymentTerms,
  displayDate,
  formatYen,
  INPUT_TAX_ACCOUNT_CODE,
  isCalendarDate,
  LedgerValidationError,
  parseYenInput,
  payableDefaults,
  payableTaxCategoryCode,
  paymentTermsProblem,
  splitTaxInclusive,
  type AccountingMethod,
  type CalendarDate,
  type PaymentTerms,
  type TaxRateRule,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { paymentTermsHelp } from "../_lib/view";
import { registerPayableAction, savePaymentTermsAction } from "../actions";

/** What the form needs from the options (no bigint: amounts are text). */
export interface PayableFormModel {
  documentId: string;
  /** The document's own registration number (a qualified invoice even when the partner has none). */
  documentRegistrationNumber: string | null;
  partners: PayableFormPartner[];
  accounts: PayableFormAccount[];
  taxCategories: PayableFormOptions["taxCategories"];
  segments: PayableFormOptions["segments"];
  wallets: { id: string; label: string }[];
  fiscalYears: {
    startDate: CalendarDate;
    endDate: CalendarDate;
    lockedThrough: CalendarDate | null;
    accountingMethod: AccountingMethod;
  }[];
  taxRules: TaxRateRule[];
  defaults: { accountId: string | null; segmentId: string | null };
  initial: {
    partnerId: string;
    invoiceDate: string;
    amount: string;
    walletId: string;
  };
}

interface TermsDraft {
  closingDay: string;
  dueMonths: string;
  dueDay: string;
}

interface Draft {
  partnerId: string;
  invoiceDate: string;
  dueDate: string;
  amount: string;
  accountId: string;
  taxCategoryCode: string;
  segmentId: string;
  description: string;
  walletId: string;
  terms: TermsDraft;
}

/** Chosen by hand: a change of the partner, the date or the account no longer moves it. */
interface Edited {
  dueDate: boolean;
  accountId: boolean;
  taxCategoryCode: boolean;
  segmentId: boolean;
  description: boolean;
}

const FIELDS = new Set([
  "partnerId",
  "invoiceDate",
  "dueDate",
  "amount",
  "accountId",
  "taxCategoryCode",
  "segmentId",
  "description",
  "walletId",
  "closingDay",
  "dueMonths",
  "dueDay",
]);

const DAYS = Array.from({ length: 30 }, (_, index) => index + 1);
const MONTHS = [
  { value: "0", label: "当月" },
  { value: "1", label: "翌月" },
  { value: "2", label: "翌々月" },
  { value: "3", label: "3 か月後" },
];

function termsText(terms: PaymentTerms | null): TermsDraft {
  return terms
    ? {
        closingDay: String(terms.closingDay),
        dueMonths: String(terms.dueMonths),
        dueDay: String(terms.dueDay),
      }
    : { closingDay: "", dueMonths: "", dueDay: "" };
}

/** The terms in the fields: `null` when empty, `undefined` while incomplete or not valid. */
function parseTerms(draft: TermsDraft): PaymentTerms | null | undefined {
  const values = [draft.closingDay, draft.dueMonths, draft.dueDay];
  if (values.every((value) => value === "")) return null;
  if (values.some((value) => value === "")) return undefined;
  const terms = {
    closingDay: Number(draft.closingDay),
    dueMonths: Number(draft.dueMonths),
    dueDay: Number(draft.dueDay),
  };
  return paymentTermsProblem(terms) === null ? terms : undefined;
}

function sameTerms(a: PaymentTerms | null, b: PaymentTerms | null): boolean {
  if (a === null || b === null) return a === b;
  return a.closingDay === b.closingDay && a.dueMonths === b.dueMonths && a.dueDay === b.dueDay;
}

/**
 * 未払として登録 (25 §7.1): the partner and the invoice date, the due date of the partner's payment
 * terms, the tax-inclusive amount with 「うち消費税」, the account, the tax category, the segment, the
 * description and the planned wallet; the partner's terms can be edited here and saved for it. The
 * defaults follow the partner, the date and the account until the owner chooses them
 * (`payableDefaults`, the server's rule).
 */
export function PayableForm({ model }: { model: PayableFormModel }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const [savingTerms, startSavingTerms] = useTransition();

  const partners = new Map(model.partners.map((partner) => [partner.id, partner]));
  const accounts = new Map(model.accounts.map((account) => [account.id, account]));

  function withDefaults(draft: Draft, edited: Edited): Draft {
    const partner = partners.get(draft.partnerId) ?? null;
    const preferred =
      partner?.defaultAccountId && accounts.has(partner.defaultAccountId)
        ? partner.defaultAccountId
        : (model.defaults.accountId ?? "");
    const accountId = edited.accountId ? draft.accountId : preferred;
    const terms = parseTerms(draft.terms);
    const defaults = payableDefaults({
      partner: partner
        ? { ...partner, paymentTerms: terms === undefined ? partner.paymentTerms : terms }
        : null,
      account: accounts.get(accountId) ?? null,
      fallbackSegmentId: model.defaults.segmentId,
      documentRegistrationNumber: model.documentRegistrationNumber,
      invoiceDate: isCalendarDate(draft.invoiceDate) ? draft.invoiceDate : null,
    });
    return {
      ...draft,
      accountId,
      taxCategoryCode: edited.taxCategoryCode
        ? draft.taxCategoryCode
        : (defaults.taxCategoryCode ?? draft.taxCategoryCode),
      segmentId: edited.segmentId ? draft.segmentId : (defaults.segmentId ?? ""),
      dueDate: edited.dueDate ? draft.dueDate : (defaults.dueDate ?? ""),
      description: edited.description ? draft.description : defaults.description,
    };
  }

  const [edited, setEdited] = useState<Edited>({
    dueDate: false,
    accountId: false,
    taxCategoryCode: false,
    segmentId: false,
    description: false,
  });
  const [draft, setDraft] = useState<Draft>(() =>
    withDefaults(
      {
        partnerId: model.initial.partnerId,
        invoiceDate: model.initial.invoiceDate,
        dueDate: "",
        amount: model.initial.amount,
        accountId: "",
        taxCategoryCode: "purchase_10",
        segmentId: "",
        description: "",
        walletId: model.initial.walletId,
        terms: termsText(partners.get(model.initial.partnerId)?.paymentTerms ?? null),
      },
      edited,
    ),
  );

  function change(patch: Partial<Draft>, by?: keyof Edited) {
    const nextEdited = by ? { ...edited, [by]: true } : edited;
    if (by) setEdited(nextEdited);
    setDraft(withDefaults({ ...draft, ...patch }, nextEdited));
  }

  function changePartner(partnerId: string) {
    // Another partner: its own terms, and the description follows unless typed by hand.
    change({ partnerId, terms: termsText(partners.get(partnerId)?.paymentTerms ?? null) });
  }

  const partner = partners.get(draft.partnerId) ?? null;
  const qualified = Boolean(partner?.invoiceRegistrationNumber || model.documentRegistrationNumber);
  const bookedTax = payableTaxCategoryCode(draft.taxCategoryCode, qualified);
  const invoiceDate = isCalendarDate(draft.invoiceDate) ? draft.invoiceDate : null;
  const year = invoiceDate
    ? model.fiscalYears.find((item) => item.startDate <= invoiceDate && item.endDate >= invoiceDate)
    : undefined;

  let invoiceDateHelp: string | null = null;
  if (invoiceDate && !year) {
    invoiceDateHelp = `${displayDate(invoiceDate)} を含む会計期間がありません。設定 › 会計期間 で期を作ってください`;
  } else if (invoiceDate && year?.lockedThrough && invoiceDate <= year.lockedThrough) {
    invoiceDateHelp = `${displayDate(year.lockedThrough)} までは締めています。この日付では登録できません`;
  }

  // The split the ledger makes (`splitTaxInclusive`): in tax-exclusive years the 仮払消費税 row,
  // which without a qualified invoice is only the creditable share (経過措置).
  const taxNote = (() => {
    const amount = parseYenInput(draft.amount);
    if (amount === null || amount <= 0n || !invoiceDate) return null;
    try {
      const split = splitTaxInclusive(amount, bookedTax, invoiceDate, {
        accountingMethod: year?.accountingMethod ?? "tax_inclusive",
        taxRules: model.taxRules,
      });
      const separate =
        split.taxLineAmount > 0n
          ? `（税抜経理: 仮払消費税 ${INPUT_TAX_ACCOUNT_CODE} ${formatYen(split.taxLineAmount)} 円の行を足します）`
          : "";
      return { warn: false, text: `うち消費税 ${formatYen(split.taxAmount)} 円${separate}` };
    } catch (problem) {
      const message =
        problem instanceof LedgerValidationError ? problem.errors[0]?.message : undefined;
      return { warn: true, text: message ?? "税率の規則を確かめてください" };
    }
  })();
  const taxHelp =
    bookedTax !== draft.taxCategoryCode
      ? "取引先にも証憑にも登録番号がないため「インボイスなし」で計上します"
      : null;

  const formTerms = parseTerms(draft.terms);
  const savedTerms = partner?.paymentTerms ?? null;
  const termsChanged = formTerms !== undefined && !sameTerms(formTerms, savedTerms);
  const termsForHelp = formTerms === undefined ? savedTerms : formTerms;

  function saveTerms() {
    if (!partner) return;
    startSavingTerms(async () => {
      const result = await savePaymentTermsAction({ partnerId: partner.id, ...draft.terms });
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(
        result.data
          ? `${partner.name} の支払条件を保存しました（${describePaymentTerms(result.data)}）`
          : `${partner.name} の支払条件をなくしました`,
      );
      router.refresh();
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = {
      documentId: model.documentId,
      partnerId: draft.partnerId,
      invoiceDate: draft.invoiceDate,
      dueDate: draft.dueDate,
      amount: draft.amount,
      accountId: draft.accountId,
      taxCategoryCode: draft.taxCategoryCode,
      segmentId: draft.segmentId,
      description: draft.description,
      walletId: draft.walletId,
    };
    startTransition(async () => {
      const result = await registerPayableAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(
        `${result.data.partnerName} の請求書を未払として登録しました（${entryNo(result.data.entryNo)}）`,
      );
      router.push(`/payables/${result.data.documentId}`);
    });
  }

  const fieldError = (name: string) => error?.fieldErrors[name];
  const alerts = formLevelErrors(error, (name) => FIELDS.has(name));
  const field = (name: string) => `${id}-${name}`;
  const invalid = (name: string) => (fieldError(name) ? true : undefined);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
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
            aria-invalid={invalid("partnerId")}
            onChange={(event) => changePartner(event.currentTarget.value)}
          >
            <option value="">選んでください</option>
            {model.partners.map((item) => (
              <option key={item.id} value={item.id}>
                {item.isActive ? item.name : `${item.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="請求書の日付"
          htmlFor={field("invoice-date")}
          required
          error={fieldError("invoiceDate")}
          help={invoiceDateHelp ?? "この日付で計上します（費用 / 未払金）"}
        >
          <Input
            id={field("invoice-date")}
            type="date"
            value={draft.invoiceDate}
            aria-invalid={invalid("invoiceDate")}
            onChange={(event) => change({ invoiceDate: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="支払期日"
          htmlFor={field("due-date")}
          error={fieldError("dueDate")}
          help={paymentTermsHelp(termsForHelp)}
        >
          <Input
            id={field("due-date")}
            type="date"
            value={draft.dueDate}
            aria-invalid={invalid("dueDate")}
            onChange={(event) => change({ dueDate: event.currentTarget.value }, "dueDate")}
          />
        </FormField>
        <FormField
          label="金額（税込・円）"
          htmlFor={field("amount")}
          required
          error={fieldError("amount")}
          help={
            taxNote ? (
              <span className={taxNote.warn ? "font-bold text-warn" : ""}>{taxNote.text}</span>
            ) : null
          }
        >
          <MoneyInput
            id={field("amount")}
            value={draft.amount}
            aria-invalid={invalid("amount")}
            onValueChange={(text) => change({ amount: text })}
          />
        </FormField>
        <FormField
          label="科目"
          htmlFor={field("account")}
          required
          error={fieldError("accountId")}
          help="費用か資産の科目です（外注費が既定）"
        >
          <Select
            id={field("account")}
            value={draft.accountId}
            aria-invalid={invalid("accountId")}
            onChange={(event) => change({ accountId: event.currentTarget.value }, "accountId")}
          >
            <option value="">選んでください</option>
            {model.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} {account.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="税区分"
          htmlFor={field("tax")}
          required
          error={fieldError("taxCategoryCode")}
          help={taxHelp}
        >
          <Select
            id={field("tax")}
            value={draft.taxCategoryCode}
            aria-invalid={invalid("taxCategoryCode")}
            onChange={(event) =>
              change({ taxCategoryCode: event.currentTarget.value }, "taxCategoryCode")
            }
          >
            {model.taxCategories.map((category) => (
              <option key={category.code} value={category.code}>
                {category.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="セグメント" htmlFor={field("segment")} error={fieldError("segmentId")}>
          <Select
            id={field("segment")}
            value={draft.segmentId}
            aria-invalid={invalid("segmentId")}
            onChange={(event) => change({ segmentId: event.currentTarget.value }, "segmentId")}
          >
            <option value="">選んでください</option>
            {model.segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="支払元の予定"
          htmlFor={field("wallet")}
          error={fieldError("walletId")}
          help="資金繰りの見通しのための予定です。あとで変えられます"
        >
          <Select
            id={field("wallet")}
            value={draft.walletId}
            aria-invalid={invalid("walletId")}
            onChange={(event) => change({ walletId: event.currentTarget.value })}
          >
            <option value="">決めていない</option>
            {model.wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="md:col-span-2">
          <FormField label="摘要" htmlFor={field("description")} error={fieldError("description")}>
            <Input
              id={field("description")}
              value={draft.description}
              maxLength={200}
              aria-invalid={invalid("description")}
              onChange={(event) =>
                change({ description: event.currentTarget.value }, "description")
              }
            />
          </FormField>
        </div>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-card border border-border px-4 py-4">
        <legend className="px-1 text-[12px] font-bold text-muted">支払条件</legend>
        <p className="text-[13px] text-muted">
          {partner
            ? `${partner.name} の締め日・何か月後・支払日です。入れると支払期日の既定になります`
            : "取引先を選ぶと、その取引先の支払条件を出します"}
        </p>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="締め日" htmlFor={field("closing")} error={fieldError("closingDay")}>
            <Select
              id={field("closing")}
              value={draft.terms.closingDay}
              disabled={!partner}
              onChange={(event) =>
                change({ terms: { ...draft.terms, closingDay: event.currentTarget.value } })
              }
            >
              <option value="">なし</option>
              {DAYS.map((day) => (
                <option key={day} value={String(day)}>
                  {day} 日
                </option>
              ))}
              <option value="31">末日</option>
            </Select>
          </FormField>
          <FormField label="何か月後" htmlFor={field("months")} error={fieldError("dueMonths")}>
            <Select
              id={field("months")}
              value={draft.terms.dueMonths}
              disabled={!partner}
              onChange={(event) =>
                change({ terms: { ...draft.terms, dueMonths: event.currentTarget.value } })
              }
            >
              <option value="">なし</option>
              {MONTHS.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="支払日" htmlFor={field("due-day")} error={fieldError("dueDay")}>
            <Select
              id={field("due-day")}
              value={draft.terms.dueDay}
              disabled={!partner}
              onChange={(event) =>
                change({ terms: { ...draft.terms, dueDay: event.currentTarget.value } })
              }
            >
              <option value="">なし</option>
              {DAYS.map((day) => (
                <option key={day} value={String(day)}>
                  {day} 日
                </option>
              ))}
              <option value="31">末日</option>
            </Select>
          </FormField>
        </div>
        {formTerms === undefined && partner ? (
          <p className="text-[12px] font-bold text-warn">
            締め日・何か月後・支払日の 3 つをそろえてください（当月払いは支払日を締め日以後に）
          </p>
        ) : null}
        <div>
          <Button size="sm" onClick={saveTerms} disabled={!partner || !termsChanged || savingTerms}>
            {savingTerms ? "保存中…" : "この取引先の支払条件として保存"}
          </Button>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "登録中…" : "登録"}
        </Button>
        <Link
          href="/payables"
          className="text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
        >
          キャンセル
        </Link>
      </div>
    </form>
  );
}
