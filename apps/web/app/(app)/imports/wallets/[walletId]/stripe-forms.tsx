"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { describedBy, FormField, Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { removeStripeAccountLinkAction, saveStripeAccountLinkAction } from "../../actions";
import { SyncButton } from "../../_components/sync-button";

const SHOWN_FIELDS: ReadonlySet<string> = new Set(["stripeAccountId", "secretName"]);

/**
 * Stripe の接続 (12-imports §1.4, §4.1): the account ID and the name of the environment variable
 * that holds the read-only key. The key itself is never typed here.
 */
export function StripeLinkForm({
  walletId,
  stripeAccountId,
  secretName,
}: {
  walletId: string;
  stripeAccountId: string;
  secretName: string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState({ stripeAccountId, secretName });
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const connected = stripeAccountId !== "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveStripeAccountLinkAction({ walletId, ...values });
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(connected ? "接続を保存しました" : "Stripe に接続しました");
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => SHOWN_FIELDS.has(field));
  const keyHelp = "鍵そのものではなく、鍵を置いた環境変数の名前。NIHO_FINANCE_STRIPE_ で始めます";

  return (
    <form onSubmit={submit} noValidate className="flex max-w-xl flex-col gap-4">
      {alerts.length > 0 ? (
        <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {alerts.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      ) : null}
      <FormField
        label="アカウント ID"
        htmlFor={`${id}-account`}
        required
        help="acct_ で始まる Stripe のアカウント ID"
        error={fieldError("stripeAccountId")}
      >
        <Input
          id={`${id}-account`}
          value={values.stripeAccountId}
          onChange={(event) => setValues({ ...values, stripeAccountId: event.currentTarget.value })}
          placeholder="acct_…"
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          {...describedBy(`${id}-account`, { help: true, error: fieldError("stripeAccountId") })}
        />
      </FormField>
      <FormField
        label="鍵の名前"
        htmlFor={`${id}-secret`}
        required
        help={keyHelp}
        error={fieldError("secretName")}
      >
        <Input
          id={`${id}-secret`}
          value={values.secretName}
          onChange={(event) => setValues({ ...values, secretName: event.currentTarget.value })}
          placeholder="NIHO_FINANCE_STRIPE_KEY_PLATFORM"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={80}
          {...describedBy(`${id}-secret`, { help: true, error: fieldError("secretName") })}
        />
      </FormField>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
    </form>
  );
}

/** 同期 and 接続を外す of a connected Stripe wallet. */
export function StripeLinkActions({
  walletId,
  walletName,
}: {
  walletId: string;
  walletName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await removeStripeAccountLinkAction(walletId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      setError(null);
      toast(`${walletName} の接続を外しました`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SyncButton walletId={walletId} walletName={walletName} variant="primary" size="md" />
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        接続を外す
      </Button>
      <ConfirmDialog
        open={confirming}
        title={`${walletName} の Stripe の接続を外す`}
        confirmLabel="接続を外す"
        variant="danger"
        pending={pending}
        error={error}
        onConfirm={remove}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        明細と取込の履歴は残ります。次に接続したときは、明細の残高の日付から取り直します（重複は取り込みません）
      </ConfirmDialog>
    </div>
  );
}
