"use client";

import type { InvoiceBankAccount } from "@niho-finance/db";
import { BANK_ACCOUNT_TYPE_LABELS, BANK_ACCOUNT_TYPES } from "@niho-finance/ledger";
import { useId } from "react";
import { useFormSubmit } from "@/components/settings/inline";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors } from "@/lib/action-types";
import { saveInvoiceSettingsAction } from "../actions";

const FIELDS = [
  "bankName",
  "branchName",
  "accountType",
  "accountNumber",
  "accountHolder",
  "note",
] as const;

/**
 * 振込先 (18 §10): printed on invoices and copied on issue. Every item is optional; all empty
 * means no bank account on the documents.
 */
export function BankAccountForm({ initial }: { initial: InvoiceBankAccount | null }) {
  const id = useId();
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit(saveInvoiceSettingsAction, {
    reset: false,
    onSuccess: () => toast("振込先を保存しました"),
  });
  const fieldError = (name: string) => error?.fieldErrors[name];
  const field = (name: string) => `${id}-${name}`;
  const alerts = formLevelErrors(error, (name) => (FIELDS as readonly string[]).includes(name));

  const text = (
    name: (typeof FIELDS)[number],
    label: string,
    options: { maxLength: number; help?: string; inputMode?: "numeric"; placeholder?: string },
  ) => (
    <FormField label={label} htmlFor={field(name)} help={options.help} error={fieldError(name)}>
      <Input
        id={field(name)}
        name={name}
        defaultValue={initial?.[name] ?? ""}
        maxLength={options.maxLength}
        inputMode={options.inputMode}
        placeholder={options.placeholder}
        {...describedBy(field(name), { help: options.help, error: fieldError(name) })}
      />
    </FormField>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {text("bankName", "銀行名", { maxLength: 100 })}
        {text("branchName", "支店名", { maxLength: 100 })}
        <FormField label="種別" htmlFor={field("accountType")} error={fieldError("accountType")}>
          <Select
            id={field("accountType")}
            name="accountType"
            defaultValue={initial?.accountType ?? ""}
          >
            <option value="">選ばない</option>
            {BANK_ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {BANK_ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        </FormField>
        {text("accountNumber", "口座番号", { maxLength: 20, inputMode: "numeric" })}
        {text("accountHolder", "口座名義（カナ）", { maxLength: 100 })}
        {text("note", "補足", {
          maxLength: 200,
          placeholder: "振込手数料は貴社にてご負担ください",
        })}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-[12px] text-muted">
          発行した請求書には、発行した時点の振込先が残ります
        </span>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}
