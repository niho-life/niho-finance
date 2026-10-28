"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { countsText } from "@/app/(app)/imports/_lib/format";
import { Button, buttonClass } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  chooseBankAccountAction,
  connectBankAction,
  disconnectBankAction,
  syncBankWalletAction,
} from "./actions";
import { useBankOutcome, type BankOutcome } from "./feedback";
import type { BankAccountOption, BankSyncView } from "./types";

/** 320px: buttons take the full width, one under another (19-bank-api §1.1). */
const STACKED = "w-full sm:w-auto";

/** The S4 wording of a sync: 「新規 n 件・重複 n 件・失敗 n 件」, or why it failed. */
function syncOutcome(walletName: string, view: BankSyncView): BankOutcome {
  if (view.error) {
    return {
      tone: "error",
      text: `${walletName} を同期できませんでした。${view.error}`,
      batchId: view.batchId,
    };
  }
  return {
    tone: "success",
    text: `${walletName} を同期しました。${countsText(view)}`,
    details: view.warnings,
    batchId: view.batchId,
  };
}

/** 「この口座を接続する」: connected, then the first sync's outcome. */
function connectOutcome(walletName: string, view: BankSyncView): BankOutcome {
  if (view.error) {
    return {
      tone: "warn",
      text: `${walletName} を接続しました。最初の同期はできませんでした。${view.error}`,
      batchId: view.batchId,
    };
  }
  return {
    tone: "success",
    text: `${walletName} を接続しました。最初の同期: ${countsText(view)}`,
    details: view.warnings,
    batchId: view.batchId,
  };
}

/**
 * 「接続する」/「再接続する」 (19-bank-api §1.1, §2.2): the authorization code flow goes to the
 * bank's screen (a plain link: the entry answers with a redirect); the sunabar token is checked on
 * the spot and then leads to 口座の選択 (or back to 接続済み on a reconnection).
 */
export function ConnectBankControl({
  walletId,
  walletName,
  mode,
  label,
}: {
  walletId: string;
  walletName: string;
  mode: "oauth" | "token";
  label: "接続する" | "再接続する";
}) {
  const toast = useToast();
  const settle = useBankOutcome();
  const [pending, startTransition] = useTransition();

  if (mode === "oauth") {
    return (
      <a
        href={`/api/bank/gmo-aozora/authorize?wallet=${encodeURIComponent(walletId)}`}
        className={buttonClass({ variant: "primary", className: STACKED })}
      >
        {label}
      </a>
    );
  }

  function connect() {
    startTransition(async () => {
      const result = await connectBankAction(walletId);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        settle({ tone: "error", text: result.error });
        return;
      }
      const text =
        result.data.status === "connected"
          ? `${walletName} を再接続しました。次の同期は前回の続きから取り込みます`
          : "銀行 API のトークンを確かめました。接続する口座を選んでください";
      toast(text);
      settle({ tone: "success", text });
    });
  }

  return (
    <Button variant="primary" className={STACKED} onClick={connect} disabled={pending}>
      {pending ? "確かめています…" : label}
    </Button>
  );
}

/**
 * 口座の選択 (19-bank-api §1.1): the bank's yen ordinary accounts as radios, those connected to
 * another wallet disabled. 「この口座を接続する」 saves the choice and runs the first sync.
 */
export function BankAccountChoice({
  walletId,
  walletName,
  accounts,
}: {
  walletId: string;
  walletName: string;
  accounts: readonly BankAccountOption[];
}) {
  const id = useId();
  const toast = useToast();
  const settle = useBankOutcome();
  const choosable = accounts.filter((account) => account.linkedWalletName === null);
  const [accountId, setAccountId] = useState(
    choosable.length === 1 ? (choosable[0]?.accountId ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await chooseBankAccountAction({ walletId, accountId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      const outcome = connectOutcome(walletName, result.data);
      toast(outcome.text, outcome.tone === "success" ? {} : { tone: "error" });
      settle(outcome);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-3">
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-[12px] font-bold text-muted">接続する口座</legend>
        <ul className="flex flex-col">
          {accounts.map((account, index) => {
            const taken = account.linkedWalletName !== null;
            return (
              <li key={account.accountId} className="border-b border-border">
                <label
                  className={`flex min-h-11 items-start gap-2.5 py-2.5 ${
                    taken ? "cursor-not-allowed text-muted" : "cursor-pointer"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${id}-account`}
                    value={account.accountId}
                    checked={accountId === account.accountId}
                    disabled={taken || pending}
                    onChange={() => setAccountId(account.accountId)}
                    aria-describedby={taken ? `${id}-taken-${index}` : undefined}
                    className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[14px] font-bold break-words">{account.label}</span>
                    {taken ? (
                      <span id={`${id}-taken-${index}`} className="text-[12px] break-words">
                        「{account.linkedWalletName}」に接続済み
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {error ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="submit"
          variant="primary"
          className={STACKED}
          disabled={pending || accountId === ""}
        >
          {pending ? "接続して同期しています…" : "この口座を接続する"}
        </Button>
      </div>
    </form>
  );
}

/** 今すぐ同期 (when `sync`) and 接続を外す, with the confirmation of 19-bank-api §1.1. */
export function BankLinkActions({
  walletId,
  walletName,
  sync,
}: {
  walletId: string;
  walletName: string;
  sync: boolean;
}) {
  const toast = useToast();
  const settle = useBankOutcome();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, startSync] = useTransition();
  const [removing, startRemove] = useTransition();

  function syncNow() {
    startSync(async () => {
      const result = await syncBankWalletAction(walletId);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        settle({ tone: "error", text: result.error });
        return;
      }
      const outcome = syncOutcome(walletName, result.data);
      toast(outcome.text, outcome.tone === "success" ? {} : { tone: "error" });
      settle(outcome);
    });
  }

  function remove() {
    startRemove(async () => {
      const result = await disconnectBankAction(walletId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfirming(false);
      setError(null);
      const text = `${walletName} の銀行 API の接続を外しました。取り込んだ明細は残ります`;
      toast(text);
      settle({ tone: "success", text });
    });
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      {sync ? (
        <Button
          variant="primary"
          className={STACKED}
          onClick={syncNow}
          disabled={syncing || removing}
          aria-label={`${walletName} を今すぐ同期`}
        >
          {syncing ? "同期中…" : "今すぐ同期"}
        </Button>
      ) : null}
      <Button
        variant={sync ? "ghost" : "secondary"}
        className={STACKED}
        onClick={() => setConfirming(true)}
        disabled={syncing || removing}
      >
        接続を外す
      </Button>
      <ConfirmDialog
        open={confirming}
        title={`${walletName} の銀行 API の接続を外す`}
        confirmLabel="接続を外す"
        variant="danger"
        pending={removing}
        error={error}
        onConfirm={remove}
        onCancel={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        接続を外します。取り込んだ明細は残ります。もう一度つなぐには、銀行の認可からやり直します
      </ConfirmDialog>
    </div>
  );
}
