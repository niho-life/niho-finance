"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import type { ActionResult } from "@/lib/action-types";
import { formatDate } from "@/lib/format";
import { useFormSubmit } from "./inline";

export interface CompanyFormValues {
  name: string;
  nameKana: string;
  representative: string;
  address: string;
  foundedOn: string;
  fiscalYearEndMonth: string;
  corporateNumber: string;
  invoiceRegistrationNumber: string;
  invoiceRegisteredOn: string;
}

export const EMPTY_COMPANY: CompanyFormValues = {
  name: "",
  nameKana: "",
  representative: "",
  address: "",
  foundedOn: "",
  fiscalYearEndMonth: "3",
  corporateNumber: "",
  invoiceRegistrationNumber: "",
  invoiceRegisteredOn: "",
};

const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1));

/**
 * 事業所 (setup Step 1 and 設定 › 事業所). The founding date and 決算月 become read-only once a
 * fiscal year exists: the periods were derived from them.
 */
export function CompanyForm({
  action,
  initial,
  locked,
  submitLabel,
  showRegisteredOn,
  savedMessage,
}: {
  action: (previous: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  initial: CompanyFormValues;
  locked: boolean;
  submitLabel: string;
  /** 登録日 is a settings field; the setup keeps the stored value. */
  showRegisteredOn: boolean;
  /** Toast after a save that stays on the page. */
  savedMessage?: string;
}) {
  const id = useId();
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit((formData) => action(null, formData), {
    reset: false,
    onSuccess: () => {
      if (savedMessage) toast(savedMessage);
    },
  });
  const fieldError = (name: string) => error?.fieldErrors[name];
  const field = (name: keyof CompanyFormValues) => `${id}-${name}`;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="商号" htmlFor={field("name")} required error={fieldError("name")}>
          <Input
            id={field("name")}
            name="name"
            defaultValue={initial.name}
            autoComplete="organization"
            required
            {...describedBy(field("name"), { error: fieldError("name") })}
          />
        </FormField>
        <FormField label="カナ" htmlFor={field("nameKana")} error={fieldError("nameKana")}>
          <Input
            id={field("nameKana")}
            name="nameKana"
            defaultValue={initial.nameKana}
            {...describedBy(field("nameKana"), { error: fieldError("nameKana") })}
          />
        </FormField>
        <FormField
          label="代表者"
          htmlFor={field("representative")}
          error={fieldError("representative")}
        >
          <Input
            id={field("representative")}
            name="representative"
            defaultValue={initial.representative}
            {...describedBy(field("representative"), { error: fieldError("representative") })}
          />
        </FormField>
        <FormField label="住所" htmlFor={field("address")} error={fieldError("address")}>
          <Input
            id={field("address")}
            name="address"
            defaultValue={initial.address}
            autoComplete="street-address"
            {...describedBy(field("address"), { error: fieldError("address") })}
          />
        </FormField>

        {locked ? (
          <>
            <FormField
              label="設立日"
              htmlFor={field("foundedOn")}
              help="会計期間を作った後は変えられません"
              error={fieldError("foundedOn")}
            >
              <Input id={field("foundedOn")} value={formatDate(initial.foundedOn)} readOnly />
              <input type="hidden" name="foundedOn" value={initial.foundedOn} />
            </FormField>
            <FormField
              label="決算月"
              htmlFor={field("fiscalYearEndMonth")}
              help="決算月は会計期間を作った後は変えられません"
              error={fieldError("fiscalYearEndMonth")}
            >
              <Input
                id={field("fiscalYearEndMonth")}
                value={`${initial.fiscalYearEndMonth} 月`}
                readOnly
              />
              <input type="hidden" name="fiscalYearEndMonth" value={initial.fiscalYearEndMonth} />
            </FormField>
          </>
        ) : (
          <>
            <FormField
              label="設立日"
              htmlFor={field("foundedOn")}
              required
              help="第 1 期はこの日から始まります"
              error={fieldError("foundedOn")}
            >
              <Input
                id={field("foundedOn")}
                name="foundedOn"
                type="date"
                defaultValue={initial.foundedOn}
                required
                {...describedBy(field("foundedOn"), {
                  help: true,
                  error: fieldError("foundedOn"),
                })}
              />
            </FormField>
            <FormField
              label="決算月"
              htmlFor={field("fiscalYearEndMonth")}
              help="事業年度の最後の月（定款のとおり）"
              error={fieldError("fiscalYearEndMonth")}
            >
              <Select
                id={field("fiscalYearEndMonth")}
                name="fiscalYearEndMonth"
                defaultValue={initial.fiscalYearEndMonth}
                {...describedBy(field("fiscalYearEndMonth"), {
                  help: true,
                  error: fieldError("fiscalYearEndMonth"),
                })}
              >
                {MONTHS.map((month) => (
                  <option key={month} value={month}>
                    {month} 月
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}

        <FormField
          label="法人番号"
          htmlFor={field("corporateNumber")}
          help="13 桁（任意）。先頭の 1 桁で番号の誤りを確かめます"
          error={fieldError("corporateNumber")}
        >
          <Input
            id={field("corporateNumber")}
            name="corporateNumber"
            defaultValue={initial.corporateNumber}
            inputMode="numeric"
            autoComplete="off"
            {...describedBy(field("corporateNumber"), {
              help: true,
              error: fieldError("corporateNumber"),
            })}
          />
        </FormField>
        <FormField
          label="インボイス登録番号"
          htmlFor={field("invoiceRegistrationNumber")}
          help="T と 13 桁（任意）。法人は T と法人番号です"
          error={fieldError("invoiceRegistrationNumber")}
        >
          <Input
            id={field("invoiceRegistrationNumber")}
            name="invoiceRegistrationNumber"
            defaultValue={initial.invoiceRegistrationNumber}
            autoComplete="off"
            {...describedBy(field("invoiceRegistrationNumber"), {
              help: true,
              error: fieldError("invoiceRegistrationNumber"),
            })}
          />
        </FormField>
        {showRegisteredOn ? (
          <FormField
            label="登録日"
            htmlFor={field("invoiceRegisteredOn")}
            help="適格請求書発行事業者の登録日（任意）"
            error={fieldError("invoiceRegisteredOn")}
          >
            <Input
              id={field("invoiceRegisteredOn")}
              name="invoiceRegisteredOn"
              type="date"
              defaultValue={initial.invoiceRegisteredOn}
              {...describedBy(field("invoiceRegisteredOn"), {
                help: true,
                error: fieldError("invoiceRegisteredOn"),
              })}
            />
          </FormField>
        ) : (
          <input type="hidden" name="invoiceRegisteredOn" value={initial.invoiceRegisteredOn} />
        )}
      </div>

      {error && Object.keys(error.fieldErrors).length === 0 ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error.error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
