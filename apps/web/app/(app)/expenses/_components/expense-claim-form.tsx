"use client";

import type { EntryFormAccount, EntryFormOptions } from "@niho-finance/db";
import {
  CORPORATE_SEGMENT_CODE,
  formatYen,
  getTaxCategory,
  isCalendarDate,
  LedgerValidationError,
  parseYenInput,
  splitTaxInclusive,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { Uploader } from "../../documents/_components/uploader";
import {
  accountLabel,
  dateProblem,
  fiscalYearOn,
  FormAlerts,
  TaxCategoryOptions,
} from "../../entries/_components/form-kit";
import { submitExpenseClaimAction } from "../actions";

/** An inbox document to choose (受信箱から選ぶ). */
export interface InboxDocumentView {
  id: string;
  title: string;
  /** 領収書 / 請求書 … */
  kind: string;
  date: string | null;
  /** Formatted, or `null` when the document has none. */
  amount: string | null;
  partner: string | null;
}

export interface ClaimantOption {
  id: string;
  label: string;
}

interface Draft {
  claimantId: string;
  spentOn: string;
  amount: string;
  description: string;
  accountId: string;
  taxCategoryCode: string;
  segmentId: string;
  partnerId: string;
  documentId: string;
}

/** The fields chosen by hand: the defaults (取引先 → 科目) no longer overwrite them. */
interface Edited {
  accountId: boolean;
  taxCategoryCode: boolean;
  segmentId: boolean;
}

const FIELDS = new Set([
  "claimantId",
  "spentOn",
  "amount",
  "description",
  "accountId",
  "taxCategoryCode",
  "segmentId",
  "partnerId",
  "documentId",
]);

const DEFAULT_TAX = "purchase_10";

/** A purchase category or 対象外: what a receipt can have. */
function fitsPurchase(code: string | null | undefined): code is string {
  if (!code) return false;
  const direction = getTaxCategory(code)?.direction;
  return direction === "purchase" || direction === "none";
}

/**
 * 立替を出す (23-users-and-expenses §6): 立替えた人 (yourself by default), 利用日, 金額, 内容, and the
 * parts of 支出 (科目・税区分・セグメント・取引先), with a document from the inbox or a new file.
 * 提出 posts the accrual on 利用日 and returns to the list.
 */
export function ExpenseClaimForm({
  claimants,
  defaultClaimantId,
  options,
  accounts,
  inbox,
  today,
}: {
  claimants: readonly ClaimantOption[];
  defaultClaimantId: string;
  options: EntryFormOptions;
  /** What 支出 offers (`loadExpenseFormOptions().expenseAccounts`). */
  accounts: readonly EntryFormAccount[];
  inbox: readonly InboxDocumentView[];
  today: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();

  const lookups = useMemo(
    () => ({
      accounts: new Map(accounts.map((account) => [account.id, account])),
      partners: new Map(options.partners.map((partner) => [partner.id, partner])),
      corporateSegmentId:
        options.segments.find((segment) => segment.code === CORPORATE_SEGMENT_CODE)?.id ?? "",
    }),
    [accounts, options],
  );

  /** 取引先 → 科目 → 共通, for the fields not chosen by hand (11 §4). */
  function withDefaults(draft: Draft, edited: Edited): Draft {
    const partner = lookups.partners.get(draft.partnerId);
    let accountId = draft.accountId;
    if (
      !edited.accountId &&
      partner?.defaultAccountId &&
      lookups.accounts.has(partner.defaultAccountId)
    ) {
      accountId = partner.defaultAccountId;
    }
    const account = lookups.accounts.get(accountId);
    const tax = [partner?.defaultTaxCategoryCode, account?.defaultTaxCategoryCode].find(
      fitsPurchase,
    );
    return {
      ...draft,
      accountId,
      taxCategoryCode: edited.taxCategoryCode
        ? draft.taxCategoryCode
        : (tax ?? draft.taxCategoryCode),
      segmentId: edited.segmentId
        ? draft.segmentId
        : (partner?.defaultSegmentId ?? account?.defaultSegmentId ?? lookups.corporateSegmentId),
    };
  }

  const [edited, setEdited] = useState<Edited>({
    accountId: false,
    taxCategoryCode: false,
    segmentId: false,
  });
  const [draft, setDraft] = useState<Draft>(() =>
    withDefaults(
      {
        claimantId: defaultClaimantId,
        spentOn: today,
        amount: "",
        description: "",
        accountId: "",
        taxCategoryCode: DEFAULT_TAX,
        segmentId: "",
        partnerId: "",
        documentId: "",
      },
      { accountId: false, taxCategoryCode: false, segmentId: false },
    ),
  );
  /** A file added here (not in the inbox list yet). */
  const [uploaded, setUploaded] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function change(patch: Partial<Draft>, by?: keyof Edited) {
    const nextEdited = by ? { ...edited, [by]: true } : edited;
    if (by) setEdited(nextEdited);
    setDraft(withDefaults({ ...draft, ...patch }, nextEdited));
  }

  const fieldError = (field: keyof Draft) => error?.fieldErrors[field];
  const year = fiscalYearOn(draft.spentOn, options.fiscalYears);
  // The split the ledger makes (`splitTaxInclusive`), as 支出 shows it.
  const taxNote = (() => {
    const amount = parseYenInput(draft.amount);
    if (amount === null || amount <= 0n || !isCalendarDate(draft.spentOn)) return null;
    try {
      const split = splitTaxInclusive(amount, draft.taxCategoryCode, draft.spentOn, {
        accountingMethod: year?.accountingMethod ?? "tax_inclusive",
        taxRules: options.taxRules,
      });
      const separate =
        split.taxLineAmount > 0n
          ? `（税抜経理: 仮払消費税 ${formatYen(split.taxLineAmount)} 円の行を足します）`
          : "";
      return { warn: false, text: `うち消費税 ${formatYen(split.taxAmount)} 円${separate}` };
    } catch (problem) {
      const message =
        problem instanceof LedgerValidationError ? problem.errors[0]?.message : undefined;
      return { warn: true, text: message ?? "税率の規則が重なっています" };
    }
  })();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await submitExpenseClaimAction({ ...draft });
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(`立替精算を提出しました（仕訳 ${entryNo(result.data.entryNo)}）`);
      router.push("/expenses");
    });
  }

  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  const datehelp = error ? null : dateProblem(draft.spentOn, options.fiscalYears);
  const chosenDocument =
    uploaded && uploaded.id === draft.documentId
      ? uploaded.title
      : inbox.find((document) => document.id === draft.documentId)?.title;

  return (
    <form onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-4">
      <FormAlerts messages={alerts} />
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          label="立替えた人"
          htmlFor={`${id}-claimant`}
          required
          error={fieldError("claimantId")}
        >
          <Select
            id={`${id}-claimant`}
            value={draft.claimantId}
            onChange={(event) => change({ claimantId: event.currentTarget.value })}
          >
            {draft.claimantId === "" ? <option value="">選んでください</option> : null}
            {claimants.map((claimant) => (
              <option key={claimant.id} value={claimant.id}>
                {claimant.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="利用日"
          htmlFor={`${id}-spent-on`}
          required
          error={fieldError("spentOn")}
          help={datehelp}
        >
          <Input
            id={`${id}-spent-on`}
            type="date"
            required
            value={draft.spentOn}
            onChange={(event) => change({ spentOn: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="金額（税込・円）"
          htmlFor={`${id}-amount`}
          required
          error={fieldError("amount")}
          help={taxNote && !taxNote.warn ? <span className="num">{taxNote.text}</span> : undefined}
        >
          <MoneyInput
            id={`${id}-amount`}
            value={draft.amount}
            onValueChange={(amount) => change({ amount })}
          />
        </FormField>
        <FormField
          label="内容"
          htmlFor={`${id}-description`}
          required
          error={fieldError("description")}
          help="例: 客先までのタクシー代"
        >
          <Input
            id={`${id}-description`}
            value={draft.description}
            maxLength={60}
            onChange={(event) => change({ description: event.currentTarget.value })}
          />
        </FormField>
        <FormField label="科目" htmlFor={`${id}-account`} required error={fieldError("accountId")}>
          <Select
            id={`${id}-account`}
            value={draft.accountId}
            onChange={(event) => change({ accountId: event.currentTarget.value }, "accountId")}
          >
            <option value="">選んでください</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="税区分"
          htmlFor={`${id}-tax`}
          required
          error={fieldError("taxCategoryCode")}
          help={
            taxNote?.warn ? <span className="font-bold text-warn">{taxNote.text}</span> : undefined
          }
        >
          <Select
            id={`${id}-tax`}
            value={draft.taxCategoryCode}
            onChange={(event) =>
              change({ taxCategoryCode: event.currentTarget.value }, "taxCategoryCode")
            }
          >
            <TaxCategoryOptions
              categories={options.taxCategories.filter(
                (category) => category.direction !== "sales",
              )}
              first="purchase"
            />
          </Select>
        </FormField>
        <FormField
          label="セグメント"
          htmlFor={`${id}-segment`}
          error={fieldError("segmentId")}
          help="費用の科目では必須です"
        >
          <Select
            id={`${id}-segment`}
            value={draft.segmentId}
            onChange={(event) => change({ segmentId: event.currentTarget.value }, "segmentId")}
          >
            <option value="">なし</option>
            {options.segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.isActive ? segment.name : `${segment.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="取引先" htmlFor={`${id}-partner`} error={fieldError("partnerId")}>
          <Select
            id={`${id}-partner`}
            value={draft.partnerId}
            onChange={(event) => change({ partnerId: event.currentTarget.value })}
          >
            <option value="">なし</option>
            {options.partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.isActive ? partner.name : `${partner.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <section aria-labelledby={`${id}-documents`} className="flex flex-col gap-2">
        <h2 id={`${id}-documents`} className="text-[12px] font-bold text-muted">
          証憑
        </h2>
        {chosenDocument ? (
          <p className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3.5 py-2.5 text-[14px]">
            <span className="min-w-0 flex-1 break-words">
              「{chosenDocument}」を計上の仕訳に紐づけます
            </span>
            <Button size="sm" variant="ghost" onClick={() => change({ documentId: "" })}>
              外す
            </Button>
          </p>
        ) : null}
        {fieldError("documentId") ? (
          <p role="alert" className="text-[12px] font-bold text-danger">
            {fieldError("documentId")}
          </p>
        ) : null}
        <Uploader
          compact
          onSaved={(outcome) => {
            const documentId = outcome.saved[0] ?? outcome.duplicates[0];
            if (!documentId) return;
            setUploaded({ id: documentId, title: "追加したファイル" });
            change({ documentId });
          }}
        />
        {inbox.length > 0 ? (
          <FormField label="受信箱から選ぶ" htmlFor={`${id}-inbox`}>
            <Select
              id={`${id}-inbox`}
              value={
                inbox.some((document) => document.id === draft.documentId) ? draft.documentId : ""
              }
              onChange={(event) => change({ documentId: event.currentTarget.value })}
            >
              <option value="">選ばない</option>
              {inbox.map((document) => (
                <option key={document.id} value={document.id}>
                  {[
                    document.title,
                    document.date,
                    document.amount === null ? null : `${document.amount} 円`,
                    document.partner,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
      </section>

      <p className="text-[12px] text-muted">役員の立替は 明細 › 役員立替 で登録します。</p>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "提出中…" : "提出"}
        </Button>
      </div>
    </form>
  );
}
