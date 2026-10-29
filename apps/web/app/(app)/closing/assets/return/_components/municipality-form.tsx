"use client";

import { useId } from "react";
import { useFormSubmit } from "@/components/settings/inline";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors } from "@/lib/action-types";
import { savePropertyTaxMunicipalityAction } from "../actions";

/** 申告先 (16 §14.4): 本店所在地の市町村, saved on the company. */
export function MunicipalityForm({ municipality }: { municipality: string }) {
  const id = useId();
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit(savePropertyTaxMunicipalityAction, {
    reset: false,
    onSuccess: (data) =>
      toast(
        data.municipality ? `申告先を「${data.municipality}」にしました` : "申告先を消しました",
      ),
  });
  const fieldId = `${id}-municipality`;
  const help = "償却資産申告書を出す、本店所在地の市町村です";
  const fieldError = error?.fieldErrors.municipality;
  const alerts = formLevelErrors(error, (field) => field === "municipality");

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-2">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      <FormField label="申告先" htmlFor={fieldId} help={help} error={fieldError}>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={fieldId}
            name="municipality"
            defaultValue={municipality}
            maxLength={100}
            autoComplete="off"
            placeholder="〇〇市"
            className="min-w-0 flex-1 basis-48"
            {...describedBy(fieldId, { help, error: fieldError })}
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </Button>
        </div>
      </FormField>
    </form>
  );
}
