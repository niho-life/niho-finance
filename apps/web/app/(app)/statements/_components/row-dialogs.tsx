"use client";

import { ACCOUNT_KIND_LABELS } from "@niho-finance/ledger";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { describedBy, FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import type { FieldErrors } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { TaxCategoryOptions } from "../../entries/_components/form-kit";
import { noteStatementAction } from "../actions";
import { DialogLink, Modal } from "./modal";
import {
  accountChoices,
  directionOf,
  shortDate,
  signedAmount,
  withAccount,
  type ChipField,
  type ClientCandidate,
  type ClientStatementRow,
  type Lookups,
  type RowDraft,
  type StatementOptions,
} from "./model";

/** 「01/05 振込 ｶ)ｶｸｳﾌﾄﾞｳｻﾝ −88,000」: which line a dialog is about. */
export function lineSummary(row: ClientStatementRow, thisYear: number): string {
  return `${shortDate(row.txnDate, thisYear)} ${row.walletName} · ${row.descriptionRaw} ${signedAmount(row.amount)}`;
}

// ---------------------------------------------------------------------------
// 編集 (E・チップ): 科目・税区分・取引先・セグメント・摘要
// ---------------------------------------------------------------------------

export function EditDialog({
  row,
  draft: initial,
  focus,
  errors,
  options,
  lookups,
  thisYear,
  onCancel,
  onApply,
  onRegister,
  onSplit,
  onRule,
}: {
  row: ClientStatementRow;
  draft: RowDraft;
  /** The chip that opened the dialog (Enter without an account: 科目). */
  focus: ChipField;
  /** The server's problems of the last attempt (`lines.0.accountId` …). */
  errors: FieldErrors | null;
  options: StatementOptions;
  lookups: Lookups;
  thisYear: number;
  onCancel: () => void;
  /** 反映: keep as the row's draft. */
  onApply: (draft: RowDraft) => void;
  onRegister: (draft: RowDraft) => void;
  onSplit: (draft: RowDraft) => void;
  onRule: (draft: RowDraft) => void;
}) {
  const id = useId();
  const direction = directionOf(row);
  const [draft, setDraft] = useState<RowDraft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const groups = accountChoices(direction, options);
  const wallet = lookups.wallets.get(row.walletId);

  /** The draft as the row will keep it: a registration, edited when anything changed. */
  function result(): RowDraft {
    const changed = (
      ["accountId", "taxCategoryCode", "partnerId", "segmentId", "description"] as const
    ).some((key) => draft[key] !== initial[key]);
    return {
      ...draft,
      mode: "register",
      edited: initial.edited || changed || initial.mode !== "register",
    };
  }

  const fieldError = (field: string) => errors?.[field];
  const autofocus = (field: ChipField) => (focus === field ? { "data-autofocus": true } : {});

  return (
    <Modal
      title="登録の内容"
      description={lineSummary(row, thisYear)}
      onClose={onCancel}
      onSubmit={() => {
        if (!draft.accountId) {
          setProblem("科目を選んでください");
          document.getElementById(`${id}-account`)?.focus();
          return;
        }
        onRegister(result());
      }}
      footer={
        <>
          <span className="mr-auto flex gap-2">
            <DialogLink onClick={() => onSplit(result())}>分割</DialogLink>
            <DialogLink onClick={() => onRule(result())}>ルールにする</DialogLink>
          </span>
          <Button variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
          <Button variant="secondary" onClick={() => onApply(result())}>
            反映
          </Button>
          <Button type="submit" variant="primary">
            登録
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <FormField
          label="科目"
          htmlFor={`${id}-account`}
          required
          error={problem ?? fieldError("lines.0.accountId")}
        >
          <Select
            id={`${id}-account`}
            value={draft.accountId}
            {...autofocus("account")}
            {...describedBy(`${id}-account`, {
              error: problem ?? fieldError("lines.0.accountId"),
            })}
            onChange={(event) => {
              setProblem(null);
              setDraft(
                withAccount(draft, event.currentTarget.value, {
                  direction,
                  accounts: lookups.accounts,
                  walletSegmentId: wallet?.defaultSegmentId ?? null,
                }),
              );
            }}
          >
            <option value="">選んでください</option>
            {groups.map((group) => (
              <optgroup key={group.kind} label={ACCOUNT_KIND_LABELS[group.kind]}>
                {group.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} {account.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </FormField>
        <FormField
          label="税区分"
          htmlFor={`${id}-tax`}
          required
          error={fieldError("lines.0.taxCategoryCode")}
        >
          <Select
            id={`${id}-tax`}
            value={draft.taxCategoryCode}
            {...autofocus("taxCategory")}
            {...describedBy(`${id}-tax`, { error: fieldError("lines.0.taxCategoryCode") })}
            onChange={(event) =>
              setDraft({
                ...draft,
                taxCategoryCode: event.currentTarget.value,
                touched: { ...draft.touched, taxCategoryCode: true },
              })
            }
          >
            <option value="">選んでください</option>
            <TaxCategoryOptions
              categories={options.taxCategories}
              first={direction === "in" ? "sales" : "purchase"}
            />
          </Select>
        </FormField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="取引先" htmlFor={`${id}-partner`} error={fieldError("partnerId")}>
            <Select
              id={`${id}-partner`}
              value={draft.partnerId}
              {...autofocus("partner")}
              onChange={(event) => setDraft({ ...draft, partnerId: event.currentTarget.value })}
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
            label="セグメント"
            htmlFor={`${id}-segment`}
            error={fieldError("lines.0.segmentId")}
          >
            <Select
              id={`${id}-segment`}
              value={draft.segmentId}
              {...autofocus("segment")}
              {...describedBy(`${id}-segment`, { error: fieldError("lines.0.segmentId") })}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  segmentId: event.currentTarget.value,
                  touched: { ...draft.touched, segmentId: true },
                })
              }
            >
              <option value="">なし</option>
              {options.segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.isActive ? segment.name : `${segment.name}（無効）`}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <FormField label="摘要" htmlFor={`${id}-description`} error={fieldError("description")}>
          <Input
            id={`${id}-description`}
            value={draft.description}
            maxLength={200}
            onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
          />
        </FormField>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 振替 (T): the candidates, or the other wallet with the fee (15 §8)
// ---------------------------------------------------------------------------

export function candidateLabel(
  candidate: ClientCandidate,
  lookups: Lookups,
  thisYear: number,
): string {
  const date = shortDate(candidate.date, thisYear);
  if (candidate.kind === "entry") {
    return `${entryNo(candidate.entryNo ?? 0)} ${date} ${candidate.description}（登録済み）`;
  }
  const wallet = lookups.wallets.get(candidate.walletId)?.name ?? "相手の口座";
  return `${wallet} ${date} ${signedAmount(candidate.amount)} ${candidate.description}`;
}

const WALLET_CHOICE = "wallet";

export function TransferDialog({
  row,
  draft,
  options,
  lookups,
  thisYear,
  onCancel,
  onTransfer,
}: {
  row: ClientStatementRow;
  draft: RowDraft;
  options: StatementOptions;
  lookups: Lookups;
  thisYear: number;
  onCancel: () => void;
  onTransfer: (input: { counterpart: string; fee: string; walletId: string }) => void;
}) {
  const id = useId();
  const candidates = row.candidates;
  const known = (value: string) =>
    candidates.some((candidate) => `${candidate.kind}:${candidate.id}` === value);
  const first = candidates[0];
  const [choice, setChoice] = useState(
    known(draft.counterpart)
      ? draft.counterpart
      : first && !(draft.transferToWalletId && draft.edited)
        ? `${first.kind}:${first.id}`
        : WALLET_CHOICE,
  );
  const wallets = options.wallets.filter((wallet) => wallet.isActive && wallet.id !== row.walletId);
  const [walletId, setWalletId] = useState(
    wallets.some((wallet) => wallet.id === draft.transferToWalletId)
      ? draft.transferToWalletId
      : "",
  );
  const [fee, setFee] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <Modal
      title="振替"
      description={lineSummary(row, thisYear)}
      onClose={onCancel}
      onSubmit={() => {
        if (choice !== WALLET_CHOICE) {
          onTransfer({ counterpart: choice, fee: "", walletId: "" });
          return;
        }
        if (!walletId) {
          setProblem("相手口座を選んでください");
          document.getElementById(`${id}-wallet`)?.focus();
          return;
        }
        onTransfer({ counterpart: `wallet:${walletId}`, fee, walletId });
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary">
            振替
          </Button>
        </>
      }
    >
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-1 text-[12px] font-bold text-muted">相手</legend>
        {candidates.map((candidate, index) => {
          const value = `${candidate.kind}:${candidate.id}`;
          return (
            <label
              key={value}
              className="flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-[14px] hover:bg-surface-2"
            >
              <input
                type="radio"
                name={`${id}-counterpart`}
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                {...(index === 0 ? { "data-autofocus": true } : {})}
              />
              <span className="min-w-0 break-words">
                {candidateLabel(candidate, lookups, thisYear)}
              </span>
            </label>
          );
        })}
        <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] hover:bg-surface-2">
          <input
            type="radio"
            name={`${id}-counterpart`}
            value={WALLET_CHOICE}
            checked={choice === WALLET_CHOICE}
            onChange={() => setChoice(WALLET_CHOICE)}
            className="size-4 shrink-0 accent-[var(--primary)]"
            {...(candidates.length === 0 ? { "data-autofocus": true } : {})}
          />
          相手口座を選ぶ
        </label>
      </fieldset>
      {choice === WALLET_CHOICE ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField
            label="相手口座"
            htmlFor={`${id}-wallet`}
            required
            error={problem ?? undefined}
          >
            <Select
              id={`${id}-wallet`}
              value={walletId}
              {...describedBy(`${id}-wallet`, { error: problem ?? undefined })}
              onChange={(event) => {
                setWalletId(event.currentTarget.value);
                setProblem(null);
              }}
            >
              <option value="">選んでください</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="手数料（円）"
            htmlFor={`${id}-fee`}
            help="支払手数料として出金側の口座から引きます"
          >
            <MoneyInput
              id={`${id}-fee`}
              value={fee}
              onValueChange={setFee}
              {...describedBy(`${id}-fee`, { help: true })}
            />
          </FormField>
        </div>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 理由をつけて無視・メモ
// ---------------------------------------------------------------------------

export function IgnoreDialog({
  row,
  initialReason,
  thisYear,
  onCancel,
  onIgnore,
}: {
  row: ClientStatementRow;
  initialReason: string;
  thisYear: number;
  onCancel: () => void;
  onIgnore: (reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState(initialReason);
  return (
    <Modal
      title="理由をつけて無視"
      description={lineSummary(row, thisYear)}
      onClose={onCancel}
      onSubmit={() => onIgnore(reason.trim())}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary">
            無視
          </Button>
        </>
      }
    >
      <FormField
        label="理由"
        htmlFor={`${id}-reason`}
        help="帳簿に載せない理由（私用・重複・残高調整など）"
      >
        <Input
          id={`${id}-reason`}
          value={reason}
          maxLength={200}
          data-autofocus
          {...describedBy(`${id}-reason`, { help: true })}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </FormField>
    </Modal>
  );
}

export function NoteDialog({
  row,
  thisYear,
  onCancel,
  onSaved,
}: {
  row: ClientStatementRow;
  thisYear: number;
  onCancel: () => void;
  onSaved: (note: string | null) => void;
}) {
  const id = useId();
  const [note, setNote] = useState(row.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Modal
      title="メモ"
      description={lineSummary(row, thisYear)}
      busy={pending}
      onClose={onCancel}
      onSubmit={() =>
        startTransition(async () => {
          const result = await noteStatementAction(row.id, { note });
          if (result.ok) onSaved(result.data.note);
          else setError(result.fieldErrors.note ?? result.error);
        })
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <FormField
        label="メモ"
        htmlFor={`${id}-note`}
        help="仕訳には書きません。一覧の摘要の下に出ます"
        error={error ?? undefined}
      >
        <Textarea
          id={`${id}-note`}
          value={note}
          maxLength={500}
          data-autofocus
          {...describedBy(`${id}-note`, { help: true, error: error ?? undefined })}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </FormField>
    </Modal>
  );
}
