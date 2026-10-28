"use client";

import Link from "next/link";
import type { KeyboardEvent, Ref } from "react";
import { Button } from "@/components/ui/button";
import type { ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { RowMenu, type MenuItem } from "./row-menu";
import {
  amountOf,
  CHIP_ERROR_FIELDS,
  PRIMARY_LABELS,
  ROW_ERROR_LABELS,
  shortDate,
  signedAmount,
  type ChipField,
  type ClientStatementRow,
  type Lookups,
  type RowDraft,
} from "./model";

/** What a row asks the list to do (the list owns the drafts, the dialogs and the server calls). */
export interface RowHandlers {
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: ClientStatementRow) => void;
  onFocusRow: (row: ClientStatementRow) => void;
  onPrimary: (row: ClientStatementRow) => void;
  onSecondary: (row: ClientStatementRow) => void;
  onChip: (row: ClientStatementRow, field: ChipField) => void;
  onTransferChip: (row: ClientStatementRow) => void;
  /** 証憑 of the line (「…」 and the 「証憑なし」 chip). */
  onDocuments: (row: ClientStatementRow) => void;
  onToggle: (row: ClientStatementRow) => void;
  menuItems: (row: ClientStatementRow) => MenuItem[];
}

type ChipTone = "rule" | "guess" | "edited" | "empty";

function chipClass(tone: ChipTone, invalid: boolean): string {
  return [
    "inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[12px] whitespace-nowrap",
    tone === "rule" || tone === "edited" ? "border-solid" : "border-dashed",
    tone === "empty" ? "text-muted-2" : "text-text",
    invalid ? "border-danger" : tone === "empty" ? "border-border-2" : "border-muted-2",
  ].join(" ");
}

function Chip({
  name,
  value,
  emptyLabel,
  tone,
  invalid,
  onClick,
}: {
  /** 科目 / 税区分 / 取引先 / セグメント / 振替. */
  name: string;
  value: string | null;
  emptyLabel: string;
  tone: ChipTone;
  invalid: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={value ? `${name}: ${value}（変更）` : emptyLabel}
      aria-invalid={invalid || undefined}
      className={`${chipClass(value ? tone : "empty", invalid)} hover:bg-surface-2`}
    >
      {value ?? emptyLabel}
    </button>
  );
}

function toneOf(source: string | null | undefined, edited: boolean, sameAsSuggestion: boolean) {
  if (edited && !sameAsSuggestion) return "edited";
  return source === "rule" ? "rule" : "guess";
}

/** 「証憑なし」 (15 §3): an outflow without a document; it opens the line's 証憑. */
function NoDocumentChip({ row, handlers }: { row: ClientStatementRow; handlers: RowHandlers }) {
  return (
    <button
      type="button"
      onClick={() => handlers.onDocuments(row)}
      aria-label="証憑なし（証憑を紐づける）"
      className="inline-flex min-h-6 shrink-0 items-center rounded-full bg-warn-soft px-2 text-[11px] font-bold whitespace-nowrap text-warn hover:brightness-95"
    >
      証憑なし
    </button>
  );
}

/** The chips of a pending row (15 §3–§4). */
function PendingChips({
  row,
  draft,
  lookups,
  thisYear,
  error,
  handlers,
}: {
  row: ClientStatementRow;
  draft: RowDraft;
  lookups: Lookups;
  thisYear: number;
  error: ActionError | null;
  handlers: RowHandlers;
}) {
  const suggestion = row.suggestion;
  const sources = suggestion?.sources;
  const invalid = (field: ChipField) => Boolean(error?.fieldErrors[CHIP_ERROR_FIELDS[field]]);
  const chips = [];
  if (draft.mode === "transfer") {
    const candidate = row.candidates.find(
      (item) => `${item.kind}:${item.id}` === draft.counterpart,
    );
    const walletId = candidate?.walletId ?? draft.transferToWalletId;
    const wallet = lookups.wallets.get(walletId)?.name ?? "相手の口座";
    const value = candidate
      ? `${wallet} ${shortDate(candidate.date, thisYear)} ${signedAmount(candidate.amount)}`
      : wallet;
    const tone = draft.edited ? "edited" : sources?.transfer === "rule" ? "rule" : "guess";
    chips.push(
      <button
        key="transfer"
        type="button"
        onClick={() => handlers.onTransferChip(row)}
        aria-label={`振替: ${value}（変更）`}
        aria-invalid={Boolean(error?.fieldErrors.counterpart) || undefined}
        className={`${chipClass(tone, Boolean(error?.fieldErrors.counterpart))} hover:bg-surface-2`}
      >
        振替 → {value}
      </button>,
    );
  } else if (draft.mode === "ignore") {
    chips.push(
      <span key="ignore" className={chipClass(sources ? "rule" : "guess", false)}>
        {draft.ignoredReason ? `無視（${draft.ignoredReason}）` : "無視"}
      </span>,
    );
  } else {
    const same = (key: "accountId" | "taxCategoryCode" | "partnerId" | "segmentId") =>
      (suggestion?.[key] ?? "") === draft[key];
    const account = lookups.accounts.get(draft.accountId);
    chips.push(
      <Chip
        key="account"
        name="科目"
        value={account ? account.name : null}
        emptyLabel="科目を選ぶ"
        tone={toneOf(sources?.account, draft.edited, same("accountId"))}
        invalid={invalid("account")}
        onClick={() => handlers.onChip(row, "account")}
      />,
      <Chip
        key="tax"
        name="税区分"
        value={lookups.taxCategories.get(draft.taxCategoryCode) ?? null}
        emptyLabel="税区分を選ぶ"
        tone={toneOf(sources?.taxCategory, draft.edited, same("taxCategoryCode"))}
        invalid={invalid("taxCategory")}
        onClick={() => handlers.onChip(row, "taxCategory")}
      />,
      <Chip
        key="partner"
        name="取引先"
        value={lookups.partners.get(draft.partnerId) ?? null}
        emptyLabel="取引先なし"
        tone={toneOf(sources?.partner, draft.edited, same("partnerId"))}
        invalid={invalid("partner")}
        onClick={() => handlers.onChip(row, "partner")}
      />,
      <Chip
        key="segment"
        name="セグメント"
        value={lookups.segments.get(draft.segmentId) ?? null}
        emptyLabel="セグメントを選ぶ"
        tone={toneOf(sources?.segment, draft.edited, same("segmentId"))}
        invalid={invalid("segment")}
        onClick={() => handlers.onChip(row, "segment")}
      />,
    );
  }
  if (amountOf(row) < 0n && !row.hasDocument) {
    chips.push(<NoDocumentChip key="document" row={row} handlers={handlers} />);
  }
  return <>{chips}</>;
}

/** 「科目: セグメントを選んでください」: the server's problems of the last attempt, under the chips. */
function RowErrors({ error, stored }: { error: ActionError | null; stored: string | null }) {
  const messages: string[] = [];
  if (error) {
    const fields = Object.entries(error.fieldErrors);
    if (fields.length === 0) messages.push(error.error);
    for (const [field, message] of fields) {
      const label = ROW_ERROR_LABELS[field];
      messages.push(label ? `${label}: ${message}` : message);
    }
  } else if (stored) {
    messages.push(`自動登録できませんでした: ${stored}`);
  }
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="mt-1 text-[12px] leading-snug font-bold text-danger">
      {[...new Set(messages)].map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

/** The result of a settled row (15 §3): 「No. 12 · 地代家賃」 / 「無視（理由）」 and its notes. */
function SettledResult({ row, handlers }: { row: ClientStatementRow; handlers: RowHandlers }) {
  const entry = row.entry;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
      {row.status === "ignored" ? (
        <span>{row.ignoredReason ? `無視（${row.ignoredReason}）` : "無視"}</span>
      ) : entry ? (
        <Link
          href={`/entries/${entry.id}`}
          className="font-bold underline-offset-4 hover:underline"
        >
          {entryNo(entry.no)}
          {entry.summary ? ` · ${entry.summary}` : ""}
        </Link>
      ) : (
        <span className="text-muted">仕訳なし</span>
      )}
      {entry?.status === "voided" ? (
        <span className="text-[12px] text-muted">
          {entry.replacedByNo ? `→ ${entryNo(entry.replacedByNo)} に訂正` : "取消済み"}
        </span>
      ) : null}
      {row.autoPosted ? <span className="text-[12px] text-muted">ルールで自動登録</span> : null}
      {row.status === "registered" && amountOf(row) < 0n && !row.hasDocument ? (
        <NoDocumentChip row={row} handlers={handlers} />
      ) : null}
    </span>
  );
}

export function StatementRowView({
  row,
  draft,
  lookups,
  thisYear,
  current,
  selected,
  error,
  rowRef,
  handlers,
}: {
  row: ClientStatementRow;
  /** `null` for settled rows. */
  draft: RowDraft | null;
  lookups: Lookups;
  thisYear: number;
  /** The row that takes Tab (roving tabindex). */
  current: boolean;
  selected: boolean;
  error: ActionError | null;
  rowRef: Ref<HTMLDivElement>;
  handlers: RowHandlers;
}) {
  const pending = row.status === "pending" && draft !== null;
  const date = shortDate(row.txnDate, thisYear);
  const [year, monthDay] = date.length > 5 ? [date.slice(0, 4), date.slice(5)] : [null, date];
  const primary = draft ? (amountOf(row) === 0n ? "ignore" : draft.mode) : null;
  const where = `${date} ${row.descriptionRaw} ${signedAmount(row.amount)}`;

  return (
    <div
      ref={rowRef}
      role="row"
      tabIndex={current ? 0 : -1}
      data-row-id={row.id}
      onKeyDown={(event) => handlers.onKeyDown(event, row)}
      onFocus={() => handlers.onFocusRow(row)}
      className={`statement-row ${pending ? "" : "is-settled"} ${selected ? "bg-primary-soft/60" : ""}`}
    >
      {pending ? (
        <span role="cell" data-area="sel" className="flex min-h-7 items-center">
          <input
            type="checkbox"
            checked={selected}
            aria-label={`選択: ${where}`}
            onChange={() => handlers.onToggle(row)}
            className="size-4 cursor-pointer accent-[var(--primary)]"
          />
        </span>
      ) : null}
      <span role="cell" data-area="date" className="num text-[13px] leading-tight text-muted">
        {year ? <span className="block text-[11px] text-muted-2">{year}</span> : null}
        {monthDay}
      </span>
      <span role="cell" data-area="desc" className="min-w-0">
        <span className="block break-words">
          <span className="num mr-2 text-[12px] text-muted lg:hidden">{date}</span>
          {row.descriptionRaw}
        </span>
        <span className="block text-[12px] text-muted-2">
          {row.walletActive ? row.walletName : `${row.walletName}（無効）`}
          {row.counterpartyRaw ? ` · 振込人: ${row.counterpartyRaw}` : ""}
        </span>
        {row.note ? (
          <span className="block text-[12px] break-words text-muted">メモ: {row.note}</span>
        ) : null}
      </span>
      <span role="cell" data-area="amount" className="num text-right whitespace-nowrap">
        {signedAmount(row.amount)}
      </span>
      <div className="statement-foot">
        <span role="cell" data-area="chips" className="min-w-0 flex-1">
          {pending && draft ? (
            <>
              <span className="-my-1 flex gap-1.5 overflow-x-auto py-1 lg:flex-wrap lg:overflow-visible">
                <PendingChips
                  row={row}
                  draft={draft}
                  lookups={lookups}
                  thisYear={thisYear}
                  error={error}
                  handlers={handlers}
                />
              </span>
              <RowErrors error={error} stored={row.error} />
            </>
          ) : (
            <>
              <SettledResult row={row} handlers={handlers} />
              <RowErrors error={error} stored={null} />
            </>
          )}
        </span>
        <span
          role="cell"
          data-area="actions"
          className="flex shrink-0 items-center justify-end gap-1"
        >
          {pending && primary ? (
            <>
              <Button size="sm" variant="primary" onClick={() => handlers.onPrimary(row)}>
                {PRIMARY_LABELS[primary]}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handlers.onSecondary(row)}>
                {primary === "ignore" ? "登録" : "無視"}
              </Button>
            </>
          ) : null}
          <RowMenu label={`操作: ${where}`} items={handlers.menuItems(row)} />
        </span>
      </div>
    </div>
  );
}
