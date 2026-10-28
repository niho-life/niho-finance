"use client";

import { useId } from "react";
import { useFormSubmit } from "@/components/settings/inline";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors } from "@/lib/action-types";
import { saveRecordsPolicyAction } from "./actions";

const FIELDS = new Set(["effectiveOn", "manager", "operator"]);

/**
 * 施行日・管理責任者・処理責任者 of the policy (13 §5). Empty 管理責任者 is the representative, empty
 * 処理責任者 the 管理責任者 (the server fills them).
 */
export function PolicyForm({
  values,
  representative,
}: {
  values: { effectiveOn: string; manager: string; operator: string };
  /** 代表者 of 設定 › 事業所: the default 管理責任者. */
  representative: string | null;
}) {
  const id = useId();
  const toast = useToast();
  const { onSubmit, pending, error } = useFormSubmit(saveRecordsPolicyAction, {
    reset: false,
    onSuccess: () => toast("規程を保存しました"),
  });
  const fieldError = (name: string) => error?.fieldErrors[name];
  const alerts = formLevelErrors(error, (field) => FIELDS.has(field));
  const managerHelp = representative
    ? `空欄なら代表者（${representative}）`
    : "空欄なら 設定 › 事業所 の代表者。代表者がないときは入力します";

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-3">
        <FormField
          label="施行日"
          htmlFor={`${id}-effective`}
          required
          error={fieldError("effectiveOn")}
        >
          <Input
            id={`${id}-effective`}
            name="effectiveOn"
            type="date"
            required
            defaultValue={values.effectiveOn}
            {...describedBy(`${id}-effective`, { error: fieldError("effectiveOn") })}
          />
        </FormField>
        <FormField
          label="管理責任者"
          htmlFor={`${id}-manager`}
          help={managerHelp}
          error={fieldError("manager")}
        >
          <Input
            id={`${id}-manager`}
            name="manager"
            defaultValue={values.manager}
            placeholder={representative ? `${representative}（代表者）` : undefined}
            maxLength={100}
            autoComplete="off"
            {...describedBy(`${id}-manager`, { help: managerHelp, error: fieldError("manager") })}
          />
        </FormField>
        <FormField
          label="処理責任者"
          htmlFor={`${id}-operator`}
          help="空欄なら管理責任者と同じ"
          error={fieldError("operator")}
        >
          <Input
            id={`${id}-operator`}
            name="operator"
            defaultValue={values.operator}
            placeholder="管理責任者と同じ"
            maxLength={100}
            autoComplete="off"
            {...describedBy(`${id}-operator`, { help: true, error: fieldError("operator") })}
          />
        </FormField>
      </div>
      <div className="flex justify-end border-t border-border pt-4">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}
