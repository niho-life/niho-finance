"use client";

import type { EntryFormOptions } from "@niho-finance/db";
import {
  containedTaxAmount,
  formatYen,
  getTaxCategory,
  isCalendarDate,
  parseYenInput,
  TRANSFER_FEE_ACCOUNT_CODE,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo, walletLabel } from "@/lib/format";
import { postSimpleEntryAction } from "../actions";
import { DateField, FormAlerts, TagsField } from "./form-kit";

interface Draft {
  entryDate: string;
  description: string;
  fromWalletId: string;
  toWalletId: string;
  amount: string;
  fee: string;
  memoTagIds: string[];
}

const FIELDS = new Set([
  "entryDate",
  "description",
  "fromWalletId",
  "toWalletId",
  "amount",
  "fee",
  "memoTagIds",
]);

/** 振替 (11 §4.3): between two wallets; the fee goes to 支払手数料 and leaves the paying wallet. */
export function TransferForm({ options, today }: { options: EntryFormOptions; today: string }) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const wallets = options.wallets.filter((wallet) => wallet.isActive);
  const [draft, setDraft] = useState<Draft>({
    entryDate: today,
    description: "振替",
    fromWalletId: wallets[0]?.id ?? "",
    toWalletId: wallets[1]?.id ?? "",
    amount: "",
    fee: "",
    memoTagIds: [],
  });
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const change = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const fieldError = (field: keyof Draft) => error?.fieldErrors[field];

  const feeAccount = options.accounts.find((account) => account.code === TRANSFER_FEE_ACCOUNT_CODE);
  const feeTaxCode = feeAccount?.defaultTaxCategoryCode ?? "na";
  const feeHelp = (() => {
    const name = feeAccount ? feeAccount.name : "支払手数料";
    const taxName = getTaxCategory(feeTaxCode)?.name ?? "";
    const base = `${name}（${taxName}）として出金元から引きます`;
    const fee = parseYenInput(draft.fee);
    if (fee === null || fee <= 0n || !isCalendarDate(draft.entryDate)) return base;
    try {
      const tax = containedTaxAmount(fee, feeTaxCode, draft.entryDate, options.taxRules);
      return tax === null ? base : `${base}。うち消費税 ${formatYen(tax)} 円`;
    } catch {
      return base;
    }
  })();

  function send(keepGoing: boolean) {
    const values = { type: "transfer", ...draft };
    startTransition(async () => {
      const result = await postSimpleEntryAction(values);
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(`${entryNo(result.data.no)} を登録しました`);
      if (keepGoing) {
        setDraft({ ...draft, amount: "", fee: "", description: "振替" });
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

  const walletOptions = wallets.map((wallet) => (
    <option key={wallet.id} value={wallet.id}>
      {walletLabel(wallet)}
    </option>
  ));

  return (
    <form onSubmit={submit} noValidate className="flex max-w-3xl flex-col gap-4">
      <FormAlerts messages={formLevelErrors(error, (field) => FIELDS.has(field))} />
      <div className="grid gap-4 md:grid-cols-2">
        <DateField
          id={`${id}-date`}
          value={draft.entryDate}
          onChange={(entryDate) => change({ entryDate })}
          fiscalYears={options.fiscalYears}
          error={fieldError("entryDate")}
        />
        <FormField
          label="摘要"
          htmlFor={`${id}-description`}
          required
          error={fieldError("description")}
        >
          <Input
            id={`${id}-description`}
            value={draft.description}
            maxLength={200}
            onChange={(event) => change({ description: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="出金元の口座"
          htmlFor={`${id}-from`}
          required
          error={fieldError("fromWalletId")}
        >
          <Select
            id={`${id}-from`}
            value={draft.fromWalletId}
            onChange={(event) => change({ fromWalletId: event.currentTarget.value })}
          >
            {draft.fromWalletId === "" ? <option value="">選んでください</option> : null}
            {walletOptions}
          </Select>
        </FormField>
        <FormField
          label="入金先の口座"
          htmlFor={`${id}-to`}
          required
          error={fieldError("toWalletId")}
        >
          <Select
            id={`${id}-to`}
            value={draft.toWalletId}
            onChange={(event) => change({ toWalletId: event.currentTarget.value })}
          >
            {draft.toWalletId === "" ? <option value="">選んでください</option> : null}
            {walletOptions}
          </Select>
        </FormField>
        <FormField
          label="金額（円）"
          htmlFor={`${id}-amount`}
          required
          error={fieldError("amount")}
        >
          <MoneyInput
            id={`${id}-amount`}
            value={draft.amount}
            onValueChange={(amount) => change({ amount })}
          />
        </FormField>
        <FormField
          label="手数料（円・任意）"
          htmlFor={`${id}-fee`}
          error={fieldError("fee")}
          help={feeHelp}
        >
          <MoneyInput id={`${id}-fee`} value={draft.fee} onValueChange={(fee) => change({ fee })} />
        </FormField>
        <TagsField
          idPrefix={id}
          tags={options.memoTags}
          value={draft.memoTagIds}
          onChange={(memoTagIds) => change({ memoTagIds })}
          error={fieldError("memoTagIds")}
        />
      </div>
      {wallets.length < 2 ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
          振替には口座が 2 つ以上要ります。設定 › 口座 で足してください
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
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
