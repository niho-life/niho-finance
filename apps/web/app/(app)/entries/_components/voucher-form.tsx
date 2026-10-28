"use client";

import type { EntryFormOptions } from "@niho-finance/db";
import {
  ENTRY_KIND_LABELS,
  formatYen,
  isCalendarDate,
  parseYenInput,
  voucherLineTaxAmount,
  type EntryKind,
  type Side,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { correctEntryAction, postVoucherEntryAction } from "../actions";
import {
  accountLabel,
  DateField,
  fiscalYearOn,
  FormAlerts,
  TagsField,
  TaxCategoryOptions,
} from "./form-kit";

export interface VoucherLineDraft {
  key: string;
  side: Side;
  accountId: string;
  subAccountId: string;
  amount: string;
  taxCategoryCode: string;
  segmentId: string;
  partnerId: string;
  description: string;
  /** Chosen by hand on this row: a change of account no longer overwrites it. */
  edited: { taxCategoryCode: boolean; segmentId: boolean };
}

export interface VoucherDraft {
  kind: EntryKind;
  entryDate: string;
  description: string;
  /** The partner of the rows left blank. */
  partnerId: string;
  memoTagIds: string[];
  lines: VoucherLineDraft[];
}

export type VoucherMode =
  | { kind: "new" }
  | {
      kind: "correct";
      entryId: string;
      no: number;
      /** Under the date: why it starts on the first open day. */
      dateHelp: string | null;
      /** What happens to the original (the reversal and its date). */
      notice: string;
    };

const HEADER_FIELDS = new Set([
  "kind",
  "entryDate",
  "description",
  "partnerId",
  "memoTagIds",
  "lines",
]);
const LINE_FIELD =
  /^lines\.(\d+)\.(side|accountId|subAccountId|amount|taxCategoryCode|segmentId|partnerId|description)$/;

export function blankLine(key: string, side: Side): VoucherLineDraft {
  return {
    key,
    side,
    accountId: "",
    subAccountId: "",
    amount: "",
    taxCategoryCode: "na",
    segmentId: "",
    partnerId: "",
    description: "",
    edited: { taxCategoryCode: false, segmentId: false },
  };
}

function amountOf(text: string): bigint {
  const amount = parseYenInput(text);
  return amount !== null && amount > 0n ? amount : 0n;
}

/**
 * 伝票 (11 §4.4) and 訂正 (11 §6): a header and the debit / credit rows. 登録 stays disabled while
 * the totals differ; the server rejects an unbalanced entry too.
 */
export function VoucherForm({
  options,
  today,
  initial,
  kinds,
  mode,
}: {
  options: EntryFormOptions;
  today: string;
  /** The rows to start from (訂正); a blank 借方 / 貸方 pair otherwise. */
  initial?: VoucherDraft;
  kinds: readonly EntryKind[];
  mode: VoucherMode;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const nextKey = useRef(0);
  const [draft, setDraft] = useState<VoucherDraft>(
    () =>
      initial ?? {
        kind: kinds[0] ?? "normal",
        entryDate: today,
        description: "",
        partnerId: "",
        memoTagIds: [],
        lines: [blankLine("line-1", "debit"), blankLine("line-2", "credit")],
      },
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const accounts = new Map(options.accounts.map((account) => [account.id, account]));
  const year = fiscalYearOn(draft.entryDate, options.fiscalYears);
  const method = year?.accountingMethod ?? "tax_inclusive";

  const change = (patch: Partial<VoucherDraft>) => setDraft({ ...draft, ...patch });

  function changeLine(key: string, patch: Partial<VoucherLineDraft>) {
    setDraft({
      ...draft,
      lines: draft.lines.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, ...patch, edited: { ...line.edited, ...patch.edited } };
        if (patch.accountId !== undefined && patch.accountId !== line.accountId) {
          // A new account: its sub-accounts differ, and its defaults fill what was not chosen.
          const account = accounts.get(patch.accountId);
          next.subAccountId = "";
          if (!next.edited.taxCategoryCode) {
            next.taxCategoryCode = account?.defaultTaxCategoryCode ?? "na";
          }
          if (!next.edited.segmentId) next.segmentId = account?.defaultSegmentId ?? "";
        }
        return next;
      }),
    });
  }

  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of draft.lines) {
    if (line.side === "debit") debitTotal += amountOf(line.amount);
    else creditTotal += amountOf(line.amount);
  }
  const difference = debitTotal - creditTotal;

  function addLine() {
    nextKey.current += 1;
    const side: Side = difference > 0n ? "credit" : "debit";
    const line = blankLine(`added-${nextKey.current}`, side);
    if (difference !== 0n) line.amount = formatYen(difference > 0n ? difference : -difference);
    setError(null);
    setDraft({ ...draft, lines: [...draft.lines, line] });
  }

  function removeLine(key: string) {
    setError(null);
    setDraft({ ...draft, lines: draft.lines.filter((line) => line.key !== key) });
  }

  const values = () => ({
    kind: draft.kind,
    entryDate: draft.entryDate,
    description: draft.description,
    partnerId: draft.partnerId,
    memoTagIds: draft.memoTagIds,
    lines: draft.lines.map(({ key: _key, edited: _edited, ...line }) => line),
  });

  function send(keepGoing: boolean) {
    startTransition(async () => {
      if (mode.kind === "correct") {
        const result = await correctEntryAction(mode.entryId, {
          reason,
          replacement: values(),
        });
        if (!result.ok) {
          setError(result);
          return;
        }
        toast(
          `${entryNo(result.data.voidedNo)} を取り消し、${entryNo(result.data.no)} として登録しました`,
        );
        router.push(`/entries/${result.data.id}`);
        return;
      }
      const result = await postVoucherEntryAction(values());
      if (!result.ok) {
        setError(result);
        return;
      }
      setError(null);
      toast(`${entryNo(result.data.no)} を登録しました`);
      if (keepGoing) {
        // Same kind and date; the amounts, the description and the partner start over (11 §4).
        setDraft({
          ...draft,
          description: "",
          partnerId: "",
          lines: draft.lines.map((line) => ({
            ...line,
            amount: "",
            description: "",
            partnerId: "",
          })),
        });
        document.getElementById(`${id}-description`)?.focus();
      } else {
        router.push(`/entries/${result.data.id}`);
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (difference !== 0n) return;
    send(false);
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const shows = (field: string) => {
    if (HEADER_FIELDS.has(field) || (mode.kind === "correct" && field === "reason")) return true;
    const match = LINE_FIELD.exec(field);
    return Boolean(match && Number(match[1]) < draft.lines.length);
  };
  const subAccountsOf = (accountId: string) =>
    options.subAccounts.filter((sub) => sub.accountId === accountId);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      {mode.kind === "correct" ? (
        <section className="flex flex-col gap-3 rounded-card border border-border px-4 py-3.5">
          <p className="text-[14px] font-bold">{mode.notice}</p>
          <FormField label="理由" htmlFor={`${id}-reason`} required error={fieldError("reason")}>
            <Textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </FormField>
        </section>
      ) : null}
      <FormAlerts messages={formLevelErrors(error, shows)} />

      <div className="grid gap-4 md:grid-cols-[160px_180px_minmax(0,1fr)]">
        <FormField label="種類" htmlFor={`${id}-kind`} error={fieldError("kind")}>
          <Select
            id={`${id}-kind`}
            value={draft.kind}
            onChange={(event) => change({ kind: event.currentTarget.value as EntryKind })}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {ENTRY_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
        </FormField>
        <DateField
          id={`${id}-date`}
          value={draft.entryDate}
          onChange={(entryDate) => change({ entryDate })}
          fiscalYears={options.fiscalYears}
          error={fieldError("entryDate")}
          help={mode.kind === "correct" ? mode.dateHelp : null}
        />
        <FormField
          label="摘要"
          htmlFor={`${id}-description`}
          required
          error={fieldError("description")}
        >
          <Input
            id={`${id}-description`}
            value={draft.description}
            maxLength={200}
            onChange={(event) => change({ description: event.currentTarget.value })}
          />
        </FormField>
        <FormField
          label="取引先"
          htmlFor={`${id}-partner`}
          error={fieldError("partnerId")}
          help="行の取引先が空のときに使います"
        >
          <Select
            id={`${id}-partner`}
            value={draft.partnerId}
            onChange={(event) => change({ partnerId: event.currentTarget.value })}
          >
            <option value="">なし</option>
            {options.partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.isActive ? partner.name : `${partner.name}（無効）`}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="md:col-span-2">
          <TagsField
            idPrefix={id}
            tags={options.memoTags}
            value={draft.memoTagIds}
            onChange={(memoTagIds) => change({ memoTagIds })}
            error={fieldError("memoTagIds")}
          />
        </div>
      </div>

      <section aria-labelledby={`${id}-lines`} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 id={`${id}-lines`} className="text-[15px] font-extrabold">
            行
          </h2>
          <p className="text-[12px] text-muted">
            {method === "tax_exclusive"
              ? "税抜経理の期: 金額は税抜で入れ、仮受・仮払消費税の行も書きます"
              : "金額は税込で入れます"}
          </p>
        </div>
        <div
          aria-hidden="true"
          className="voucher-line hidden rounded-t-lg bg-surface-2 px-3 py-2 text-[11px] font-bold text-muted-2 lg:grid"
        >
          <span style={{ gridArea: "side" }}>貸借</span>
          <span style={{ gridArea: "account" }}>科目</span>
          <span style={{ gridArea: "sub" }}>補助科目</span>
          <span style={{ gridArea: "amount" }} className="text-right">
            金額（円）
          </span>
          <span style={{ gridArea: "tax" }}>税区分</span>
          <span style={{ gridArea: "taxamt" }} className="text-right">
            税額
          </span>
        </div>
        <ol className="flex flex-col">
          {draft.lines.map((line, index) => {
            const at = `${id}-line-${line.key}`;
            const row = index + 1;
            const subAccounts = subAccountsOf(line.accountId);
            const amount = parseYenInput(line.amount);
            let tax: string;
            try {
              const computed =
                amount !== null && amount > 0n && isCalendarDate(draft.entryDate)
                  ? voucherLineTaxAmount(
                      amount,
                      line.taxCategoryCode,
                      draft.entryDate,
                      method,
                      options.taxRules,
                    )
                  : 0n;
              tax = computed === null ? "規則なし" : computed === 0n ? "—" : formatYen(computed);
            } catch {
              tax = "規則なし";
            }
            const lineError = (field: string) => fieldError(`lines.${index}.${field}`);
            const label = (text: string, htmlFor: string) => (
              <label htmlFor={htmlFor} className="text-[11px] font-bold text-muted lg:sr-only">
                {row} 行目の{text}
              </label>
            );
            const errorText = (field: string) =>
              lineError(field) ? (
                <p role="alert" className="text-[12px] font-bold text-danger">
                  {lineError(field)}
                </p>
              ) : null;
            return (
              <li
                key={line.key}
                className="voucher-line border-b border-border px-3 py-3 last:border-b-0"
              >
                <div style={{ gridArea: "side" }} className="flex min-w-0 flex-col gap-1">
                  {label("貸借", `${at}-side`)}
                  <select
                    id={`${at}-side`}
                    className="control"
                    value={line.side}
                    onChange={(event) =>
                      changeLine(line.key, { side: event.currentTarget.value as Side })
                    }
                  >
                    <option value="debit">借方</option>
                    <option value="credit">貸方</option>
                  </select>
                </div>
                <div style={{ gridArea: "account" }} className="flex min-w-0 flex-col gap-1">
                  {label("科目", `${at}-account`)}
                  <select
                    id={`${at}-account`}
                    className="control"
                    value={line.accountId}
                    aria-invalid={lineError("accountId") ? true : undefined}
                    onChange={(event) =>
                      changeLine(line.key, { accountId: event.currentTarget.value })
                    }
                  >
                    <option value="">選んでください</option>
                    {options.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {accountLabel(account)}
                      </option>
                    ))}
                  </select>
                  {errorText("accountId")}
                </div>
                <div style={{ gridArea: "sub" }} className="flex min-w-0 flex-col gap-1">
                  {subAccounts.length > 0 ? (
                    <>
                      {label("補助科目", `${at}-sub`)}
                      <select
                        id={`${at}-sub`}
                        className="control"
                        value={line.subAccountId}
                        aria-invalid={lineError("subAccountId") ? true : undefined}
                        onChange={(event) =>
                          changeLine(line.key, { subAccountId: event.currentTarget.value })
                        }
                      >
                        <option value="">なし</option>
                        {subAccounts.map((sub) => (
                          <option key={sub.id} value={sub.id}>
                            {sub.isActive ? sub.name : `${sub.name}（無効）`}
                          </option>
                        ))}
                      </select>
                      {errorText("subAccountId")}
                    </>
                  ) : (
                    <span
                      aria-hidden="true"
                      className="hidden min-h-10 items-center text-muted-2 lg:flex"
                    >
                      —
                    </span>
                  )}
                </div>
                <div style={{ gridArea: "amount" }} className="flex min-w-0 flex-col gap-1">
                  {label("金額（円）", `${at}-amount`)}
                  <MoneyInput
                    id={`${at}-amount`}
                    value={line.amount}
                    aria-invalid={lineError("amount") ? true : undefined}
                    onValueChange={(text) => changeLine(line.key, { amount: text })}
                  />
                  {errorText("amount")}
                </div>
                <div style={{ gridArea: "tax" }} className="flex min-w-0 flex-col gap-1">
                  {label("税区分", `${at}-tax`)}
                  <select
                    id={`${at}-tax`}
                    className="control"
                    value={line.taxCategoryCode}
                    aria-invalid={lineError("taxCategoryCode") ? true : undefined}
                    onChange={(event) =>
                      changeLine(line.key, {
                        taxCategoryCode: event.currentTarget.value,
                        edited: { ...line.edited, taxCategoryCode: true },
                      })
                    }
                  >
                    <TaxCategoryOptions categories={options.taxCategories} />
                  </select>
                  {errorText("taxCategoryCode")}
                </div>
                <div
                  style={{ gridArea: "taxamt" }}
                  className="flex min-w-0 flex-col gap-1 lg:justify-center"
                >
                  <span className="text-[11px] font-bold text-muted lg:sr-only">税額</span>
                  <span className="num min-h-10 content-center text-right text-[14px] text-muted">
                    {tax}
                  </span>
                </div>
                <div style={{ gridArea: "remove" }} className="flex items-start justify-end">
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    disabled={draft.lines.length <= 2}
                    aria-label={`${row} 行目を消す`}
                    className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-[18px] text-muted hover:bg-black/5 hover:text-text disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
                <div style={{ gridArea: "segment" }} className="flex min-w-0 flex-col gap-1">
                  {label("セグメント", `${at}-segment`)}
                  <select
                    id={`${at}-segment`}
                    className="control"
                    value={line.segmentId}
                    aria-invalid={lineError("segmentId") ? true : undefined}
                    onChange={(event) =>
                      changeLine(line.key, {
                        segmentId: event.currentTarget.value,
                        edited: { ...line.edited, segmentId: true },
                      })
                    }
                  >
                    <option value="">セグメントなし</option>
                    {options.segments.map((segment) => (
                      <option key={segment.id} value={segment.id}>
                        {segment.isActive ? segment.name : `${segment.name}（無効）`}
                      </option>
                    ))}
                  </select>
                  {errorText("segmentId")}
                </div>
                <div style={{ gridArea: "partner" }} className="flex min-w-0 flex-col gap-1">
                  {label("取引先", `${at}-partner`)}
                  <select
                    id={`${at}-partner`}
                    className="control"
                    value={line.partnerId}
                    onChange={(event) =>
                      changeLine(line.key, { partnerId: event.currentTarget.value })
                    }
                  >
                    <option value="">取引先は仕訳のもの</option>
                    {options.partners.map((partner) => (
                      <option key={partner.id} value={partner.id}>
                        {partner.isActive ? partner.name : `${partner.name}（無効）`}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ gridArea: "desc" }} className="flex min-w-0 flex-col gap-1">
                  {label("摘要", `${at}-description`)}
                  <input
                    id={`${at}-description`}
                    className="control"
                    value={line.description}
                    maxLength={200}
                    placeholder="行の摘要（任意）"
                    onChange={(event) =>
                      changeLine(line.key, { description: event.currentTarget.value })
                    }
                  />
                </div>
              </li>
            );
          })}
        </ol>
        <div>
          <Button variant="ghost" onClick={addLine}>
            ＋ 行を追加
          </Button>
        </div>
      </section>

      <section
        aria-live="polite"
        className="flex flex-wrap items-baseline justify-end gap-x-5 gap-y-1 border-t border-border pt-3 text-[14px]"
      >
        <span>
          借方合計 <span className="num font-bold">{formatYen(debitTotal)}</span>
        </span>
        <span>
          貸方合計 <span className="num font-bold">{formatYen(creditTotal)}</span>
        </span>
        <span className={difference === 0n ? "text-muted" : "font-extrabold"}>
          差額 <span className="num">{formatYen(difference < 0n ? -difference : difference)}</span>
        </span>
        {difference !== 0n ? (
          <span className="basis-full text-right text-[12px] text-muted">
            借方と貸方の合計が同じになると登録できます
          </span>
        ) : null}
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        {mode.kind === "new" ? (
          <Button onClick={() => send(true)} disabled={pending || difference !== 0n}>
            続けて登録
          </Button>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending || difference !== 0n}>
          {pending ? "登録中…" : mode.kind === "correct" ? "訂正を登録" : "登録"}
        </Button>
      </div>
    </form>
  );
}
