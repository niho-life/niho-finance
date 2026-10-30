"use client";

import type { BankApiStatus, SelectOption, WalletSettings } from "@niho-finance/db";
import {
  formatYenInput,
  WALLET_DEFAULT_ACCOUNT_CODES,
  WALLET_KIND_LABELS,
  WALLET_KINDS,
  type WalletKind,
} from "@niho-finance/ledger";
import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { InactiveToggle, useFormSubmit } from "@/components/settings/inline";
import { FormError, OpenButton } from "@/components/settings/row-parts";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableHead, TableRow, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatDate, formatYenDisplay } from "@/lib/format";
import { createWalletAction, setWalletActiveAction, updateWalletAction } from "../actions";

/**
 * A wallet as the page passes it (the opening balance as text: bigint stays on the server), with
 * its 取込形式 (`null` for wallets that do not import: cash and 役員立替) and, for a bank wallet,
 * its bank API connection (`null` when it has none).
 */
export type WalletRow = Omit<WalletSettings, "openingBalance"> & {
  openingBalance: string | null;
  importerLabel: string | null;
  bankApiStatus: BankApiStatus | null;
};

/** 取込形式 of a bank wallet connected to the bank API (19-bank-api §1.2). */
const BANK_API_LABELS: Readonly<Record<BankApiStatus, string>> = {
  connected: "銀行 API 接続済み",
  reauth_required: "再接続が必要",
  authorized: "口座の選択待ち",
};

type AccountOption = SelectOption & { code: string };

const COLUMNS = {
  columns: "minmax(0,1.3fr) 84px minmax(0,1.4fr) 110px 104px 110px 56px 76px",
  mobileColumns: "minmax(0,1fr) auto",
};

function accountForKind(kind: WalletKind, accounts: readonly AccountOption[]): string {
  const code = WALLET_DEFAULT_ACCOUNT_CODES[kind];
  return accounts.find((account) => account.code === code)?.value ?? "";
}

function WalletSheet({
  wallet,
  accounts,
  segments,
  foundedOn,
  onClose,
}: {
  /** `null`: a new wallet. */
  wallet: WalletRow | null;
  accounts: readonly AccountOption[];
  segments: readonly SelectOption[];
  foundedOn: string | null;
  onClose: () => void;
}) {
  const id = useId();
  const toast = useToast();
  const [kind, setKind] = useState<WalletKind>(wallet?.kind ?? "bank");
  const [accountId, setAccountId] = useState(wallet?.accountId ?? accountForKind("bank", accounts));
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [toggling, startToggle] = useTransition();
  const action = wallet
    ? (formData: FormData) => updateWalletAction(wallet.id, formData)
    : createWalletAction;
  const { onSubmit, pending, error } = useFormSubmit(action, {
    reset: false,
    onSuccess: () => {
      toast(wallet ? "口座を保存しました" : "口座を追加しました");
      onClose();
    },
  });
  const fieldError = (name: string) => error?.fieldErrors[name];
  const formId = `${id}-form`;

  function toggleActive() {
    if (!wallet) return;
    startToggle(async () => {
      const result = await setWalletActiveAction(wallet.id, !wallet.isActive);
      if (result.ok) {
        toast(wallet.isActive ? "口座を無効にしました" : "口座を有効にしました");
        onClose();
      } else setToggleError(result.error);
    });
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={wallet ? wallet.name : "口座を追加"}
      description={
        wallet
          ? `${WALLET_KIND_LABELS[wallet.kind]} · ${wallet.accountCode} ${wallet.accountName}`
          : "紐づく科目は種類から決まります。補助科目は口座の名前で作ります"
      }
      footer={
        <>
          {wallet ? (
            <Button variant="ghost" className="mr-auto" onClick={toggleActive} disabled={toggling}>
              {wallet.isActive ? "無効にする" : "有効にする"}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={pending}>
            {pending ? (wallet ? "保存中…" : "追加中…") : wallet ? "保存" : "追加"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <FormField label="名前" htmlFor={`${id}-name`} required error={fieldError("name")}>
          <Input
            id={`${id}-name`}
            name="name"
            defaultValue={wallet?.name ?? ""}
            placeholder="例: 〇〇銀行 普通"
            maxLength={100}
            {...describedBy(`${id}-name`, { error: fieldError("name") })}
          />
        </FormField>
        <FormField label="種類" htmlFor={`${id}-kind`} error={fieldError("kind")}>
          <Select
            id={`${id}-kind`}
            name="kind"
            value={kind}
            onChange={(event) => {
              const next = event.currentTarget.value as WalletKind;
              setKind(next);
              const account = accountForKind(next, accounts);
              if (account) setAccountId(account);
            }}
          >
            {WALLET_KINDS.map((value) => (
              <option key={value} value={value}>
                {WALLET_KIND_LABELS[value]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="紐づく科目"
          htmlFor={`${id}-account`}
          help="種類から自動で選びます。仕訳のある口座は変えられません"
          error={fieldError("accountId")}
        >
          <Select
            id={`${id}-account`}
            name="accountId"
            value={accountId}
            onChange={(event) => setAccountId(event.currentTarget.value)}
            {...describedBy(`${id}-account`, { help: true, error: fieldError("accountId") })}
          >
            <option value="">選んでください</option>
            {accounts.map((account) => (
              <option key={account.value} value={account.value}>
                {account.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="既定セグメント"
          htmlFor={`${id}-segment`}
          error={fieldError("defaultSegmentId")}
        >
          <Select
            id={`${id}-segment`}
            name="defaultSegmentId"
            defaultValue={wallet?.defaultSegmentId ?? ""}
          >
            <option value="">なし</option>
            {segments.map((segment) => (
              <option key={segment.value} value={segment.value}>
                {segment.label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="明細の残高の日付"
            htmlFor={`${id}-opening-date`}
            help={foundedOn ? `空欄は設立日（${formatDate(foundedOn)}）` : undefined}
            error={fieldError("openingBalanceDate")}
          >
            <Input
              id={`${id}-opening-date`}
              name="openingBalanceDate"
              type="date"
              defaultValue={wallet?.openingBalanceDate ?? ""}
            />
          </FormField>
          <FormField
            label="明細の残高（円）"
            htmlFor={`${id}-opening`}
            help="その日の明細の残高。取込の照合に使い、帳簿の現預金には足しません"
            error={fieldError("openingBalance")}
          >
            <MoneyInput
              id={`${id}-opening`}
              name="openingBalance"
              allowNegative
              defaultValue={
                wallet?.openingBalance ? formatYenInput(BigInt(wallet.openingBalance)) : ""
              }
            />
          </FormField>
        </div>
        <FormField label="メモ" htmlFor={`${id}-note`} error={fieldError("note")}>
          <Textarea
            id={`${id}-note`}
            name="note"
            defaultValue={wallet?.note ?? ""}
            maxLength={500}
          />
        </FormField>
        <p className="text-[12px] text-muted">
          取込形式（CSV・Stripe の接続）は{" "}
          <Link
            href={wallet ? `/imports/wallets/${wallet.id}` : "/imports"}
            className="font-bold text-text underline underline-offset-4"
          >
            明細の取込 › 取込の設定
          </Link>{" "}
          で設定します。
        </p>
        {wallet?.kind === "bank" ? (
          <p className="text-[12px] text-muted">
            銀行 API の接続（GMO あおぞらネット銀行）は{" "}
            <Link
              href={`/settings/wallets/${wallet.id}/bank`}
              className="font-bold text-text underline underline-offset-4"
            >
              銀行 API の接続
            </Link>{" "}
            で行います。
          </p>
        ) : null}
        {error && Object.keys(error.fieldErrors).length === 0 ? <FormError error={error} /> : null}
        {toggleError ? (
          <p role="alert" className="text-[12px] font-bold text-danger">
            {toggleError}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}

export function WalletsTable({
  wallets,
  accounts,
  segments,
  foundedOn,
}: {
  wallets: WalletRow[];
  accounts: AccountOption[];
  segments: SelectOption[];
  foundedOn: string | null;
}) {
  const [showInactive, setShowInactive] = useState(false);
  /** `"new"`, a wallet id, or `null` when the sheet is closed. */
  const [editing, setEditing] = useState<string | null>(null);
  const shown = wallets.filter((wallet) => wallet.isActive || showInactive);
  const inactiveCount = wallets.filter((wallet) => !wallet.isActive).length;
  const edited = wallets.find((wallet) => wallet.id === editing) ?? null;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <Link
          href="/imports"
          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
        >
          明細の取込
          <span aria-hidden="true">›</span>
        </Link>
        <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
          口座を追加
        </Button>
      </div>
      {shown.length > 0 ? (
        <Table label="口座">
          <TableHead {...COLUMNS}>
            <Th>名前</Th>
            <Th sm="hide">種類</Th>
            <Th>紐づく科目・補助科目</Th>
            <Th sm="hide">既定セグメント</Th>
            <Th sm="hide">取込形式</Th>
            <Th align="right">明細の残高（円）</Th>
            <Th sm="hide">状態</Th>
            <Th />
          </TableHead>
          {shown.map((wallet) => (
            <TableRow key={wallet.id} {...COLUMNS} muted={!wallet.isActive}>
              <Td className="font-bold">
                {wallet.name}
                <span className="ml-2 text-[11px] font-normal text-muted md:hidden">
                  {WALLET_KIND_LABELS[wallet.kind]}
                </span>
              </Td>
              <Td sm="hide">{WALLET_KIND_LABELS[wallet.kind]}</Td>
              <Td sm="full" className="text-[13px] text-muted">
                {wallet.accountCode} {wallet.accountName}
                {wallet.subAccountName ? ` / ${wallet.subAccountName}` : ""}
                {wallet.openingBalance ? (
                  <span className="ml-2 md:hidden">
                    明細の残高 {formatYenDisplay(BigInt(wallet.openingBalance))} 円
                  </span>
                ) : null}
              </Td>
              <Td sm="hide" className="text-muted">
                {wallet.defaultSegmentName ?? "—"}
              </Td>
              <Td sm="hide" className="truncate text-[13px]">
                {wallet.bankApiStatus ? (
                  <Link
                    href={`/settings/wallets/${wallet.id}/bank`}
                    title={BANK_API_LABELS[wallet.bankApiStatus]}
                    className={
                      wallet.bankApiStatus === "reauth_required"
                        ? "font-bold text-warn underline-offset-4 hover:underline"
                        : "text-muted underline-offset-4 hover:text-text hover:underline"
                    }
                  >
                    {BANK_API_LABELS[wallet.bankApiStatus]}
                  </Link>
                ) : wallet.importerLabel ? (
                  <Link
                    href={`/imports/wallets/${wallet.id}`}
                    title={wallet.importerLabel}
                    className="text-muted underline-offset-4 hover:text-text hover:underline"
                  >
                    {wallet.importerLabel}
                  </Link>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Td>
              <Td align="right" sm="hide">
                {wallet.openingBalance ? formatYenDisplay(BigInt(wallet.openingBalance)) : "—"}
                {wallet.openingBalanceDate ? (
                  <span className="block text-[11px] text-muted">
                    {formatDate(wallet.openingBalanceDate)}
                  </span>
                ) : null}
              </Td>
              <Td sm="hide" className="text-muted">
                {wallet.isActive ? "有効" : "無効"}
              </Td>
              <Td>
                <OpenButton label={`${wallet.name} を編集`} onClick={() => setEditing(wallet.id)}>
                  編集
                </OpenButton>
              </Td>
            </TableRow>
          ))}
        </Table>
      ) : (
        <p className="rounded-card border border-dashed border-border-2 bg-surface px-5 py-6 text-[14px]">
          口座がありません。「口座を追加」から銀行・カード・現金・Stripe・役員立替を登録します。
        </p>
      )}
      <InactiveToggle
        count={inactiveCount}
        open={showInactive}
        onToggle={() => setShowInactive(!showInactive)}
      />
      {editing ? (
        <WalletSheet
          key={editing}
          wallet={edited}
          accounts={accounts}
          segments={segments}
          foundedOn={foundedOn}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
