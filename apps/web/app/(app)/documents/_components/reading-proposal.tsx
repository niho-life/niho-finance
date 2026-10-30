"use client";

import type { ReadingProposalField } from "@niho-finance/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { applyDocumentReadingAction, readDocumentAction } from "../reading-actions";

/** One item of the proposal, worded on the server. */
export interface ReadingRowView {
  field: ReadingProposalField;
  /** 種別 / 取引年月日 / 金額（円） / 取引先 / 登録番号 / メモ */
  label: string;
  /** The proposed value as shown, with how the partner was matched (（登録番号が一致）). */
  value: string;
  /** Dates, amounts and numbers: tabular figures. */
  numeric: boolean;
  /** The current value when it is set and differs (shown as 「今: …」). */
  current: string | null;
  selectable: boolean;
  defaultChecked: boolean;
  /** Why the row has no check: 保存済み, or the warning that blocks it. */
  note: string | null;
}

/** One rate line of the reading: 税率 · 対価（税込） · 消費税 · 推定の税区分. */
export interface ReadingRateView {
  rate: string;
  amount: string;
  tax: string;
  /** 「課税仕入 10%（インボイスなし・控除 70%）」, or 「—」 without an estimate. */
  category: string;
}

export interface ReadingView {
  documentId: string;
  /** 「2026/11/07 10:15 · claude-haiku-5-5」 once read. */
  heading: string | null;
  /**
   * empty: not read yet; failed / proposed: the stored reading; notice: only `message`
   * (a format the provider cannot read, a wrong setting).
   */
  state: "empty" | "failed" | "proposed" | "notice";
  /** The line under the heading: what 読み取る does, why it failed, or the notice. */
  message: string | null;
  rows: ReadingRowView[];
  /** Every proposed item equals the saved one (提案はすべて保存済みです). */
  allSaved: boolean;
  rates: ReadingRateView[];
  /** The registry lookup of the number; `muted` when it was not looked up or failed. */
  registry: { text: string; muted: boolean } | null;
  /** 要確認: one warning per line. */
  issues: string[];
  /** 読み取る / 読み取り直す: a provider is set, the document is not voided and is readable. */
  canRead: boolean;
  /** 提案を保存: a proposal of a document that is not voided. */
  canSave: boolean;
  /** Set while the provider's setting is wrong (shown instead of 読み取り直す). */
  notice: string | null;
}

const SECTION_ID = "document-reading";

function ProposalRows({
  rows,
  checked,
  onToggle,
  disabled,
}: {
  rows: readonly ReadingRowView[];
  checked: ReadonlySet<ReadingProposalField>;
  onToggle: (field: ReadingProposalField) => void;
  disabled: boolean;
}) {
  return (
    <div role="list" aria-label="読み取った項目" className="mt-1">
      {rows.map((row) => {
        const name = (
          <>
            {row.selectable ? (
              <input
                type="checkbox"
                checked={checked.has(row.field)}
                disabled={disabled}
                onChange={() => onToggle(row.field)}
                className="size-4 shrink-0 cursor-pointer accent-[var(--primary)]"
              />
            ) : (
              <span aria-hidden="true" className="size-4 shrink-0" />
            )}
            <span className="text-[12px] font-bold text-muted">{row.label}</span>
          </>
        );
        return (
          <div
            key={row.field}
            role="listitem"
            className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-3 border-b border-border py-1.5 last:border-b-0"
          >
            {row.selectable ? (
              <label className="flex min-h-8 cursor-pointer items-center gap-2">{name}</label>
            ) : (
              <span className="flex min-h-8 items-center gap-2">{name}</span>
            )}
            <div className="flex min-h-8 min-w-0 flex-col justify-center text-[14px]">
              <span className={`break-words ${row.numeric ? "num" : ""}`}>{row.value}</span>
              {row.current !== null ? (
                <span className="text-[12px] break-words text-muted">
                  今: <span className={row.numeric ? "num" : ""}>{row.current}</span>
                </span>
              ) : null}
              {row.note !== null ? (
                <span className="text-[12px] break-words text-muted">{row.note}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RateLines({ rates }: { rates: readonly ReadingRateView[] }) {
  return (
    <div className="mt-3">
      <h3 className="mb-1 text-[12px] font-bold text-muted">税率別の内訳</h3>
      <div role="table" aria-label="税率別の内訳">
        <div
          role="row"
          className="grid grid-cols-[48px_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-border pb-1 text-[11px] font-bold text-muted"
        >
          <span role="columnheader">税率</span>
          <span role="columnheader" className="text-right">
            対価（税込）
          </span>
          <span role="columnheader" className="text-right">
            消費税
          </span>
        </div>
        {rates.map((rate, index) => (
          <div
            key={index}
            role="row"
            className="grid grid-cols-[48px_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-border py-1.5 text-[13px] last:border-b-0"
          >
            <span role="cell" className="num">
              {rate.rate}
            </span>
            <span role="cell" className="num text-right">
              {rate.amount}
            </span>
            <span role="cell" className="num text-right">
              {rate.tax}
            </span>
            {/* Its own line: the category is long for the 380px column and for phones. */}
            <span role="cell" className="col-span-3 text-[12px] break-words text-muted">
              推定の税区分: {rate.category}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 読み取り of the detail (20-reader §10.1): 読み取る, the stored proposal with a check per item,
 * the rate lines with the estimated tax category, the registry lookup and 要確認. 提案を保存 saves
 * the checked items (the server takes their values from the stored reading); the page then draws
 * 項目 again with them. A voided document shows its proposal read-only.
 */
export function ReadingProposalPanel({ view }: { view: ReadingView }) {
  const router = useRouter();
  const toast = useToast();
  const [checked, setChecked] = useState<ReadonlySet<ReadingProposalField>>(
    () => new Set(view.rows.filter((row) => row.defaultChecked).map((row) => row.field)),
  );
  const [busy, setBusy] = useState<"read" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(field: ReadingProposalField) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  function read() {
    setBusy("read");
    setError(null);
    startTransition(async () => {
      const result = await readDocumentAction(view.documentId);
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // A failed reading is stored: the section shows why after the refresh.
      if (result.data.status === "proposed") {
        const { issueCount } = result.data;
        toast(issueCount > 0 ? `読み取りました（要確認 ${issueCount} 件）` : "読み取りました");
      }
      router.refresh();
    });
  }

  function save() {
    const fields = view.rows
      .filter((row) => row.selectable && checked.has(row.field))
      .map((row) => row.field);
    if (fields.length === 0) return;
    setBusy("save");
    setError(null);
    startTransition(async () => {
      const result = await applyDocumentReadingAction(view.documentId, fields);
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast("提案を保存しました");
      router.refresh();
    });
  }

  const selectedCount = view.rows.filter((row) => row.selectable && checked.has(row.field)).length;
  const readLabel =
    busy === "read" ? "読み取り中…" : view.state === "empty" ? "読み取る" : "読み取り直す";
  const readButton = view.canRead ? (
    <Button
      size="sm"
      variant={view.state === "proposed" ? "ghost" : "secondary"}
      disabled={busy !== null}
      onClick={read}
    >
      {readLabel}
    </Button>
  ) : null;
  const saveButton =
    view.canSave && view.state === "proposed" && !view.allSaved ? (
      <Button
        size="sm"
        variant="primary"
        disabled={busy !== null || selectedCount === 0}
        onClick={save}
      >
        {busy === "save" ? "保存中…" : "提案を保存"}
      </Button>
    ) : null;

  return (
    <section aria-labelledby={SECTION_ID}>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={SECTION_ID} className="text-[15px] font-extrabold">
          読み取り
        </h2>
        {view.heading ? (
          <span className="num ml-auto text-[12px] text-muted">{view.heading}</span>
        ) : null}
      </div>
      {view.message ? <p className="text-[13px] break-words text-muted">{view.message}</p> : null}
      {view.state === "proposed" ? (
        <>
          {view.allSaved ? (
            <p className="text-[13px] text-muted">提案はすべて保存済みです</p>
          ) : (
            <ProposalRows
              rows={view.rows}
              checked={checked}
              onToggle={toggle}
              disabled={busy !== null || !view.canSave}
            />
          )}
          {view.rates.length > 0 ? <RateLines rates={view.rates} /> : null}
          {view.registry ? (
            <p
              className={`mt-3 text-[13px] break-words ${view.registry.muted ? "text-muted" : ""}`}
            >
              <span className="mr-1 text-[12px] font-bold text-muted">登録番号の照合</span>
              {view.registry.text}
            </p>
          ) : null}
          {view.issues.length > 0 ? (
            <div className="mt-3">
              <h3 className="mb-1 text-[12px] font-bold text-muted">要確認</h3>
              <ul role="list" className="flex flex-col gap-1">
                {view.issues.map((issue, index) => (
                  <li key={index} className="text-[13px] break-words text-danger">
                    {issue}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {view.notice ? <p className="mt-2 text-[12px] text-muted">{view.notice}</p> : null}
      {saveButton || readButton ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {saveButton}
          {readButton}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12px] font-bold break-words text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
