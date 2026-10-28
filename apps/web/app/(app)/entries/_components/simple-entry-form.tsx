"use client";

import type { EntryFormOptions } from "@niho-finance/db";
import {
  formatYen,
  getTaxCategory,
  isCalendarDate,
  isReservedAccount,
  LedgerValidationError,
  parseYenInput,
  splitTaxInclusive,
  walletAccountIdsOf,
  type TaxDirection,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo, walletLabel } from "@/lib/format";
import { postSimpleEntryAction } from "../actions";
import {
  accountLabel,
  DateField,
  fiscalYearOn,
  FormAlerts,
  TagsField,
  TaxCategoryOptions,
} from "./form-kit";

type FlowType = "income" | "expense";

interface Draft {
  entryDate: string;
  description: string;
  /** `wallet:<id>` or `account:<id>` (11 §4.1). */
  counterpart: string;
  accountId: string;
  amount: string;
  taxCategoryCode: string;
  segmentId: string;
  partnerId: string;
  memoTagIds: string[];
}

/** The fields the owner chose by hand: defaults no longer overwrite them (11 §4). */
interface Edited {
  accountId: boolean;
  taxCategoryCode: boolean;
  segmentId: boolean;
}

const FIELDS = new Set([
  "entryDate",
  "description",
  "counterpart",
  "accountId",
  "amount",
  "taxCategoryCode",
  "segmentId",
  "partnerId",
  "memoTagIds",
]);

const TEXT = {
  income: {
    counterpart: "入金先",
    account: "科目",
    direction: "sales",
    defaultTax: "sales_10",
    taxLine: "仮受消費税",
  },
  expense: {
    counterpart: "支払元",
    account: "科目",
    direction: "purchase",
    defaultTax: "purchase_10",
    taxLine: "仮払消費税",
  },
} as const satisfies Record<
  FlowType,
  {
    counterpart: string;
    account: string;
    direction: TaxDirection;
    defaultTax: string;
    taxLine: string;
  }
>;

const REVENUE_GROUP_ORDER = ["sales", "non_operating_income", "extraordinary_income"];

type Account = EntryFormOptions["accounts"][number];

/**
 * 収入: revenue (売上高・営業外収益 の順). 支出: expenses, then non-cash assets, then liabilities.
 * The accounts the ledger refuses here are left out (`isReservedAccount`: wallets' accounts, cash,
 * 仮払・仮受消費税): money in a wallet is chosen as the wallet.
 */
function accountChoices(
  type: FlowType,
  accounts: readonly Account[],
  walletAccountIds: ReadonlySet<string>,
): Account[] {
  const usable = accounts.filter((account) => !isReservedAccount(account, walletAccountIds));
  if (type === "income") {
    return usable
      .filter((account) => account.kind === "revenue")
      .sort(
        (a, b) =>
          REVENUE_GROUP_ORDER.indexOf(a.group) - REVENUE_GROUP_ORDER.indexOf(b.group) ||
          a.code.localeCompare(b.code),
      );
  }
  return [
    ...usable.filter((account) => account.kind === "expense"),
    ...usable.filter((account) => account.kind === "asset"),
    ...usable.filter((account) => account.kind === "liability"),
  ];
}

/** 入金先: assets and liabilities (例: 売掛金). 支払元: liabilities (例: 未払費用). Same exclusions. */
function counterpartAccounts(
  type: FlowType,
  accounts: readonly Account[],
  walletAccountIds: ReadonlySet<string>,
): Account[] {
  return accounts.filter(
    (account) =>
      !isReservedAccount(account, walletAccountIds) &&
      (account.kind === "liability" || (type === "income" && account.kind === "asset")),
  );
}

/** A tax category the form can default to: one of its direction, or outside the tax. */
function fitsDirection(code: string | null | undefined, direction: TaxDirection): code is string {
  if (!code) return false;
  const category = getTaxCategory(code);
  return Boolean(category && (category.direction === direction || category.direction === "none"));
}

export function SimpleEntryForm({
  type,
  options,
  today,
}: {
  type: FlowType;
  options: EntryFormOptions;
  today: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const text = TEXT[type];

  const lookups = useMemo(() => {
    const walletAccountIds = walletAccountIdsOf(options.wallets);
    const choices = accountChoices(type, options.accounts, walletAccountIds);
    return {
      choices,
      choiceIds: new Set(choices.map((account) => account.id)),
      counterAccounts: counterpartAccounts(type, options.accounts, walletAccountIds),
      accounts: new Map(options.accounts.map((account) => [account.id, account])),
      wallets: new Map(options.wallets.map((wallet) => [wallet.id, wallet])),
      partners: new Map(options.partners.map((partner) => [partner.id, partner])),
    };
  }, [type, options]);

  /** Fills the fields the owner has not chosen: 取引先 → 科目 → 口座 (11 §4). */
  function withDefaults(draft: Draft, edited: Edited): Draft {
    const partner = lookups.partners.get(draft.partnerId);
    let accountId = draft.accountId;
    if (
      !edited.accountId &&
      partner?.defaultAccountId &&
      lookups.choiceIds.has(partner.defaultAccountId)
    ) {
      accountId = partner.defaultAccountId;
    }
    const account = lookups.accounts.get(accountId);
    const wallet = draft.counterpart.startsWith("wallet:")
      ? lookups.wallets.get(draft.counterpart.slice("wallet:".length))
      : undefined;
    const tax = [partner?.defaultTaxCategoryCode, account?.defaultTaxCategoryCode].find((code) =>
      fitsDirection(code, text.direction),
    );
    return {
      ...draft,
      accountId,
      taxCategoryCode: edited.taxCategoryCode
        ? draft.taxCategoryCode
        : (tax ?? draft.taxCategoryCode),
      segmentId: edited.segmentId
        ? draft.segmentId
        : (partner?.defaultSegmentId ??
          account?.defaultSegmentId ??
          wallet?.defaultSegmentId ??
          ""),
    };
  }

  const firstWallet = options.wallets.find((wallet) => wallet.isActive);
  const [edited, setEdited] = useState<Edited>({
    accountId: false,
    taxCategoryCode: false,
    segmentId: false,
  });
  const [draft, setDraft] = useState<Draft>(() =>
    withDefaults(
      {
        entryDate: today,
        description: "",
        counterpart: firstWallet
          ? `wallet:${firstWallet.id}`
          : lookups.counterAccounts[0]
            ? `account:${lookups.counterAccounts[0].id}`
            : "",
        accountId: "",
        amount: "",
        taxCategoryCode: text.defaultTax,
        segmentId: "",
        partnerId: "",
        memoTagIds: [],
      },
      { accountId: false, taxCategoryCode: false, segmentId: false },
    ),
  );
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function change(patch: Partial<Draft>, by?: keyof Edited) {
    const nextEdited = by ? { ...edited, [by]: true } : edited;
    if (by) setEdited(nextEdited);
    setDraft(withDefaults({ ...draft, ...patch }, nextEdited));
  }

  const fieldError = (field: keyof Draft) => error?.fieldErrors[field];
  const year = fiscalYearOn(draft.entryDate, options.fiscalYears);
  // The same split the ledger makes (`splitTaxInclusive`): in tax-exclusive years the 仮受・仮払
  // line, which for a purchase without a qualified invoice is only the creditable share (経過措置).
  const taxNote = (() => {
    const amount = parseYenInput(draft.amount);
    if (amount === null || amount <= 0n || !isCalendarDate(draft.entryDate)) return null;
    let split: ReturnType<typeof splitTaxInclusive>;
    try {
      split = splitTaxInclusive(amount, draft.taxCategoryCode, draft.entryDate, {
        accountingMethod: year?.accountingMethod ?? "tax_inclusive",
        taxRules: options.taxRules,
      });
    } catch (problem) {
      const message =
        problem instanceof LedgerValidationError ? problem.errors[0]?.message : undefined;
      return {
        warn: true,
        text: message ?? "税率の規則が重なっています。設定 › 税区分 で確かめてください",
      };
    }
    const separate =
      split.taxLineAmount > 0n
        ? `（税抜経理: ${text.taxLine} ${formatYen(split.taxLineAmount)} 円の行を足します）`
        : "";
    return { warn: false, text: `うち消費税 ${formatYen(split.taxAmount)} 円${separate}` };
  })();

  /** 登録 (Enter) opens the new entry; 続けて登録 stays on the form. */
  function send(keepGoing: boolean) {
    const values = { type, ...draft };
    startTransition(async () => {
      const result = await postSimpleEntryAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(`${entryNo(result.data.no)} を登録しました`);
      if (keepGoing) {
        // Same type and date; the amount, the description and the partner start over (11 §4).
        setDraft(withDefaults({ ...draft, amount: "", description: "", partnerId: "" }, edited));
        document.getElementById(`${id}-amount`)?.focus();
      } else {
        router.push(`/entries/${result.data.id}`);
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send(false);
  }

  // Errors of fields that are not drawn (the tags when there are none) go above the form.
  const alerts = formLevelErrors(
    error,
    (field) => FIELDS.has(field) && (field !== "memoTagIds" || options.memoTags.length > 0),
  );
  const wallets = options.wallets.filter((wallet) => wallet.isActive);

  return (
    <form onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-4">
      <FormAlerts messages={alerts} />
      <div className="grid gap-4 md:grid-cols-2">
        <DateField
          id={`${id}-date`}
          value={draft.entryDate}
          onChange={(entryDate) => change({ entryDate })}
          fiscalYears={options.fiscalYears}
          error={fieldError("entryDate")}
        />
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
        <FormField
          label={text.counterpart}
          htmlFor={`${id}-counterpart`}
          required
          error={fieldError("counterpart")}
        >
          <Select
            id={`${id}-counterpart`}
            value={draft.counterpart}
            onChange={(event) => change({ counterpart: event.currentTarget.value })}
          >
            {draft.counterpart === "" ? <option value="">選んでください</option> : null}
            {wallets.length > 0 ? (
              <optgroup label="口座">
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={`wallet:${wallet.id}`}>
                    {walletLabel(wallet)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="科目">
              {lookups.counterAccounts.map((account) => (
                <option key={account.id} value={`account:${account.id}`}>
                  {accountLabel(account)}
                </option>
              ))}
            </optgroup>
          </Select>
        </FormField>
        <FormField
          label={text.account}
          htmlFor={`${id}-account`}
          required
          error={fieldError("accountId")}
        >
          <Select
            id={`${id}-account`}
            value={draft.accountId}
            onChange={(event) => change({ accountId: event.currentTarget.value }, "accountId")}
          >
            <option value="">選んでください</option>
            {lookups.choices.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </Select>
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
            <TaxCategoryOptions categories={options.taxCategories} first={text.direction} />
          </Select>
        </FormField>
        <FormField
          label="摘要"
          htmlFor={`${id}-description`}
          required
          error={fieldError("description")}
          className="md:col-span-2"
        >
          <Input
            id={`${id}-description`}
            value={draft.description}
            maxLength={200}
            onChange={(event) => change({ description: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="セグメント"
          htmlFor={`${id}-segment`}
          error={fieldError("segmentId")}
          help="収益・費用の科目では必須です"
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
        <TagsField
          idPrefix={id}
          tags={options.memoTags}
          value={draft.memoTagIds}
          onChange={(memoTagIds) => change({ memoTagIds })}
          error={fieldError("memoTagIds")}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        {/* The only submit button: Enter in any field registers (11 §4). */}
        <Button onClick={() => send(true)} disabled={pending}>
          続けて登録
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "登録中…" : "登録"}
        </Button>
      </div>
    </form>
  );
}
