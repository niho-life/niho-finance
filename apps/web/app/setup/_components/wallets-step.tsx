"use client";

import {
  WALLET_DEFAULT_ACCOUNT_CODES,
  WALLET_KIND_LABELS,
  type WalletKind,
} from "@niho-finance/ledger";
import { useRef, useState, useTransition } from "react";
import { ActionButton } from "@/components/settings/action-button";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import type { ActionError } from "@/lib/action-types";
import { createWalletsAction, skipWalletsAction } from "../actions";

/** Kinds offered in the setup (その他 needs an account chosen by hand: 設定 › 口座). */
const SETUP_KINDS = ["bank", "card", "cash", "stripe", "owner"] as const satisfies WalletKind[];

interface WalletRow {
  key: string;
  include: boolean;
  name: string;
  kind: WalletKind;
  defaultSegmentId: string;
}

const INITIAL_ROWS: WalletRow[] = [
  {
    key: "bank",
    include: true,
    name: "普通預金",
    kind: "bank",
    defaultSegmentId: "",
  },
  {
    key: "owner",
    include: true,
    name: "役員立替",
    kind: "owner",
    defaultSegmentId: "",
  },
];

/**
 * Step 4: the bank account and 役員立替 are proposed; rows can be added. Each wallet gets the
 * account of its kind and a sub-account with its name (10 §3).
 */
export function WalletsStep({
  segments,
  accountNames,
}: {
  segments: readonly { value: string; label: string }[];
  /** `1100` → `普通預金`, for the account each kind posts to. */
  accountNames: Readonly<Record<string, string>>;
}) {
  const [rows, setRows] = useState<WalletRow[]>(INITIAL_ROWS);
  const [error, setError] = useState<ActionError | null>(null);
  const [sentKeys, setSentKeys] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const nextKey = useRef(0);

  function update(key: string, patch: Partial<WalletRow>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addRow() {
    nextKey.current += 1;
    setRows((current) => [
      ...current,
      {
        key: `row-${nextKey.current}`,
        include: true,
        name: "",
        kind: "bank",
        defaultSegmentId: "",
      },
    ]);
  }

  function submit() {
    const included = rows.filter((row) => row.include);
    if (included.length === 0) {
      setError({
        ok: false,
        error: "作る口座を 1 つ以上選ぶか、「あとで」を選んでください",
        fieldErrors: {},
      });
      return;
    }
    setSentKeys(included.map((row) => row.key));
    startTransition(async () => {
      const result = await createWalletsAction(
        included.map((row) => ({
          name: row.name,
          kind: row.kind,
          defaultSegmentId: row.defaultSegmentId,
        })),
      );
      if (result && !result.ok) setError(result);
    });
  }

  /** Errors come back as `wallets.<index of the sent rows>.<field>`. */
  function rowError(key: string): string | undefined {
    const index = sentKeys.indexOf(key);
    if (index < 0 || !error) return undefined;
    const prefix = `wallets.${index}`;
    const entry = Object.entries(error.fieldErrors).find(
      ([field]) => field === prefix || field.startsWith(`${prefix}.`),
    );
    return entry?.[1];
  }

  const rowErrorShown = rows.some((row) => rowError(row.key));

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const code = WALLET_DEFAULT_ACCOUNT_CODES[row.kind];
          const message = rowError(row.key);
          return (
            <li
              key={row.key}
              className={`rounded-card border bg-surface px-4 py-3.5 ${
                row.include ? "border-border" : "border-dashed border-border-2 opacity-70"
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-[14px] font-bold">
                  <input
                    type="checkbox"
                    checked={row.include}
                    onChange={(event) => update(row.key, { include: event.currentTarget.checked })}
                    className="size-4 accent-[var(--primary)]"
                  />
                  作る
                </label>
                <span className="text-[12px] text-muted">
                  {code
                    ? `紐づく科目: ${code} ${accountNames[code] ?? ""} ・ 補助科目: ${row.name || "（名前）"}`
                    : ""}
                </span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-bold text-muted">名前</span>
                  <Input
                    value={row.name}
                    disabled={!row.include}
                    placeholder="例: 〇〇銀行 普通"
                    onChange={(event) => update(row.key, { name: event.currentTarget.value })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-bold text-muted">種類</span>
                  <Select
                    value={row.kind}
                    disabled={!row.include}
                    onChange={(event) =>
                      update(row.key, { kind: event.currentTarget.value as WalletKind })
                    }
                  >
                    {SETUP_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {WALLET_KIND_LABELS[kind]}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-bold text-muted">既定セグメント</span>
                  <Select
                    value={row.defaultSegmentId}
                    disabled={!row.include}
                    onChange={(event) =>
                      update(row.key, { defaultSegmentId: event.currentTarget.value })
                    }
                  >
                    <option value="">なし</option>
                    {segments.map((segment) => (
                      <option key={segment.value} value={segment.value}>
                        {segment.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {message ? (
                <p role="alert" className="mt-2 text-[12px] font-bold text-danger">
                  {message}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div>
        <Button variant="ghost" onClick={addRow}>
          ＋ 行を追加
        </Button>
      </div>
      <p className="text-[12px] text-muted">
        口座の残高は仕訳から導きます。資本金の払込は次の開始仕訳で登録します。Stripe
        の接続と取込形式はあとで設定します。
      </p>
      {error && !rowErrorShown ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start justify-end gap-2">
        <ActionButton action={skipWalletsAction} label="あとで" variant="ghost" />
        <Button variant="primary" onClick={submit} disabled={pending}>
          {pending ? "保存中…" : "次へ"}
        </Button>
      </div>
    </div>
  );
}
