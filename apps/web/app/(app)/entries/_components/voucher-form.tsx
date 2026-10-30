"use client";

import type { EntryCandidates, EntryFormOptions } from "@niho-finance/db";
import {
  ENTRY_KIND_LABELS,
  formatYen,
  isCalendarDate,
  parseYenInput,
  voucherLineTaxAmount,
  type AccountingMethod,
  type CalendarDate,
  type EntryKind,
  type Side,
} from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo, formatYenDisplay } from "@/lib/format";
import { correctEntryAction, postVoucherEntryAction } from "../actions";
import { defaultEntryDate } from "./entry-date";
import { entryFormKeyDown } from "./entry-keys";
import {
  accountLabel,
  ChoiceOptions,
  DateField,
  EntryFormActions,
  fiscalYearOn,
  FormAlerts,
  partnerLabel,
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

/** A row of the entry being corrected, as the server matches it to keep its tax (amounts as digits). */
export interface OriginalRow {
  side: Side;
  accountId: string;
  subAccountId: string;
  amount: string;
  taxCategoryCode: string;
  taxAmount: string;
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
      /** The original's rows and method: unchanged rows keep their tax (`correctJournalEntry`). */
      original: { accountingMethod: AccountingMethod; rows: readonly OriginalRow[] };
    };

/**
 * The tax the server keeps for each row (`keepUnchangedTax` in the repository): a row equal to an
 * original row (side, account, sub-account, amount, tax category; each original row once) keeps the
 * original's tax when the method is the same. `null` = computed.
 */
function keptTaxes(
  lines: readonly VoucherLineDraft[],
  mode: VoucherMode,
  accountingMethod: AccountingMethod,
): (bigint | null)[] {
  if (mode.kind !== "correct" || mode.original.accountingMethod !== accountingMethod) {
    return lines.map(() => null);
  }
  const unmatched = [...mode.original.rows];
  return lines.map((line) => {
    const amount = parseYenInput(line.amount);
    const index = unmatched.findIndex(
      (row) =>
        row.side === line.side &&
        row.accountId === line.accountId &&
        row.subAccountId === line.subAccountId &&
        amount !== null &&
        BigInt(row.amount) === amount &&
        row.taxCategoryCode === line.taxCategoryCode,
    );
    const [match] = index < 0 ? [] : unmatched.splice(index, 1);
    return match ? BigInt(match.taxAmount) : null;
  });
}

/** Header fields with an error line under them. Errors of anything not drawn go above the form. */
const HEADER_FIELDS = new Set(["kind", "entryDate", "description", "partnerId"]);
/** Row inputs with an error line under them (貸借・取引先・摘要 have none). */
const LINE_FIELD = /^lines\.(\d+)\.(accountId|subAccountId|amount|taxCategoryCode|segmentId)$/;
/** The most rows a 伝票 takes (the schema's limit). */
const MAX_LINES = 100;

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

/** Debit minus credit of the rows. */
function differenceOf(lines: readonly VoucherLineDraft[]): bigint {
  let difference = 0n;
  for (const line of lines) {
    difference += line.side === "debit" ? amountOf(line.amount) : -amountOf(line.amount);
  }
  return difference;
}

/** A plain Tab (not Shift+Tab, not while an IME converts). */
function isPlainTab(event: KeyboardEvent<HTMLElement>): boolean {
  return (
    event.key === "Tab" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.nativeEvent.isComposing
  );
}

/**
 * 伝票 (11 §4.4) and 訂正 (11 §6): a header and the debit / credit rows. 登録 stays disabled while
 * the totals differ; the server rejects an unbalanced entry too.
 */
export function VoucherForm({
  options,
  candidates,
  today,
  entryDate,
  initial,
  kinds,
  mode,
}: {
  options: EntryFormOptions;
  /** The recent accounts and partners (11 §4.7); none on 訂正. */
  candidates?: EntryCandidates;
  today: CalendarDate;
  /** The date of a new 伝票 (`?date=`); `defaultEntryDate` otherwise. */
  entryDate?: CalendarDate;
  /** The rows to start from (訂正); a blank 借方 / 貸方 pair otherwise. */
  initial?: VoucherDraft;
  kinds: readonly EntryKind[];
  mode: VoucherMode;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const nextKey = useRef(0);
  /** The row whose first field takes the focus once drawn (Tab on the last row, 11 §4.4). */
  const focusLine = useRef<string | null>(null);
  const blankLines = () => {
    nextKey.current += 2;
    return [
      blankLine(`blank-${nextKey.current - 1}`, "debit"),
      blankLine(`blank-${nextKey.current}`, "credit"),
    ];
  };
  const [draft, setDraft] = useState<VoucherDraft>(
    () =>
      initial ?? {
        kind: kinds[0] ?? "normal",
        entryDate: entryDate ?? defaultEntryDate(today, options.fiscalYears),
        description: "",
        partnerId: "",
        memoTagIds: [],
        lines: [blankLine("line-1", "debit"), blankLine("line-2", "credit")],
      },
  );
  /** On a new 伝票 the date's problem is told once the date is changed (11 §4: none on opening). */
  const [dateChanged, setDateChanged] = useState(mode.kind === "correct");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();
  const accounts = new Map(options.accounts.map((account) => [account.id, account]));
  const year = fiscalYearOn(draft.entryDate, options.fiscalYears);
  const method = year?.accountingMethod ?? "tax_inclusive";
  const kept = keptTaxes(draft.lines, mode, method);

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
  const lastLine = draft.lines.at(-1);
  /** What the rows above the last one leave for it (「差額を入れる」). */
  const remainder = differenceOf(draft.lines.slice(0, -1));

  useEffect(() => {
    if (!focusLine.current) return;
    document.getElementById(`${id}-line-${focusLine.current}-side`)?.focus();
    focusLine.current = null;
  }, [id, draft.lines]);

  /** A row; with the difference on the short side. `focus`: its first field takes the focus. */
  function addLine(focus = false) {
    if (draft.lines.length >= MAX_LINES) return;
    nextKey.current += 1;
    const side: Side = difference > 0n ? "credit" : "debit";
    const line = blankLine(`added-${nextKey.current}`, side);
    if (difference !== 0n) line.amount = formatYen(difference > 0n ? difference : -difference);
    if (focus) focusLine.current = line.key;
    setError(null);
    setDraft({ ...draft, lines: [...draft.lines, line] });
  }

  /**
   * 「差額を入れる」 (11 §4.4): the last row takes what the other rows leave, on the short side
   * (credit when the debits are more); its account and the rest stay.
   */
  function fillDifference() {
    if (!lastLine || remainder === 0n) return;
    changeLine(lastLine.key, {
      side: remainder > 0n ? "credit" : "debit",
      amount: formatYen(remainder > 0n ? remainder : -remainder),
    });
  }

  /**
   * Tab out of the last row's 摘要 adds a row (the difference on its short side) and goes to its
   * first field while the totals differ; balanced, Tab goes on to the buttons. Shift+Tab only goes
   * back.
   */
  function tabOutOfLastRow(event: KeyboardEvent<HTMLInputElement>) {
    if (!isPlainTab(event) || difference === 0n || draft.lines.length >= MAX_LINES) return;
    event.preventDefault();
    addLine(true);
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
      if (keepGoing) {
        toast(`${entryNo(result.data.no)} を登録しました`, {
          link: { href: `/entries/${result.data.id}`, label: "開く" },
        });
        // The kind and the date stay; the rest starts over from a blank 借方 / 貸方 pair (11 §4.5).
        const lines = blankLines();
        setDraft((current) => ({
          ...current,
          description: "",
          partnerId: "",
          memoTagIds: [],
          lines,
        }));
        document.getElementById(`${id}-description`)?.focus();
      } else {
        toast(`${entryNo(result.data.no)} を登録しました`);
        router.push(`/entries/${result.data.id}`);
      }
    });
  }

  /** 訂正: 訂正を登録. New: 続けて登録 (the submit button; 登録して開く is a plain button). */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (difference !== 0n) return;
    send(mode.kind === "new");
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const subAccountsOf = (accountId: string) =>
    options.subAccounts.filter((sub) => sub.accountId === accountId);
  /** Only the fields an error is drawn under; the rest (e.g. `lines`: 100 行まで) go above. */
  const shows = (field: string) => {
    if (HEADER_FIELDS.has(field)) return true;
    if (field === "memoTagIds") return options.memoTags.length > 0;
    if (field === "reason") return mode.kind === "correct";
    const match = LINE_FIELD.exec(field);
    const line = match ? draft.lines[Number(match[1])] : undefined;
    if (!match || !line) return false;
    return match[2] !== "subAccountId" || subAccountsOf(line.accountId).length > 0;
  };

  const accountChoiceList = options.accounts.map((account) => ({
    value: account.id,
    label: accountLabel(account),
  }));
  const partnerChoiceList = options.partners.map((partner) => ({
    value: partner.id,
    label: partnerLabel(partner),
  }));
  const recentPartners = candidates?.recentPartnerIds ?? [];

  return (
    <form
      onSubmit={submit}
      onKeyDown={mode.kind === "new" ? entryFormKeyDown : undefined}
      noValidate
      className="flex flex-col gap-5"
    >
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
          onChange={(entryDate) => {
            setDateChanged(true);
            change({ entryDate });
          }}
          fiscalYears={options.fiscalYears}
          error={fieldError("entryDate")}
          help={mode.kind === "correct" ? mode.dateHelp : null}
          periodHint={dateChanged}
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
            <ChoiceOptions choices={partnerChoiceList} recent={recentPartners} />
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
          className="voucher-line hidden rounded-t-lg bg-surface-2 px-3 py-2 text-[11px] font-bold text-muted lg:grid"
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
                kept[index] ??
                (amount !== null && amount > 0n && isCalendarDate(draft.entryDate)
                  ? voucherLineTaxAmount(
                      amount,
                      line.taxCategoryCode,
                      draft.entryDate,
                      method,
                      options.taxRules,
                    )
                  : 0n);
              tax =
                computed === null ? "規則なし" : computed === 0n ? "—" : formatYenDisplay(computed);
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
                    <ChoiceOptions
                      choices={accountChoiceList}
                      recent={candidates?.recentAccounts.voucher}
                    />
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
                      className="hidden min-h-10 items-center text-muted lg:flex"
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
                    <ChoiceOptions choices={partnerChoiceList} recent={recentPartners} />
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
                    onKeyDown={line === lastLine ? tabOutOfLastRow : undefined}
                  />
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            onClick={() => addLine()}
            disabled={draft.lines.length >= MAX_LINES}
          >
            ＋ 行を追加
          </Button>
          {draft.lines.length >= MAX_LINES ? (
            <span className="text-[12px] text-muted">行は {MAX_LINES} 行までです</span>
          ) : null}
        </div>
      </section>

      <section
        aria-live="polite"
        className="flex flex-wrap items-baseline justify-end gap-x-5 gap-y-1 border-t border-border pt-3 text-[14px]"
      >
        <span>
          借方合計 <span className="num font-bold">{formatYenDisplay(debitTotal)}</span>
        </span>
        <span>
          貸方合計 <span className="num font-bold">{formatYenDisplay(creditTotal)}</span>
        </span>
        <span className={difference === 0n ? "text-muted" : "font-extrabold"}>
          差額{" "}
          <span className="num">
            {formatYenDisplay(difference < 0n ? -difference : difference)}
          </span>
        </span>
        {difference !== 0n && remainder !== 0n ? (
          <Button size="sm" onClick={fillDifference} className="self-center">
            差額を入れる
          </Button>
        ) : null}
        {difference !== 0n ? (
          <span className="basis-full text-right text-[12px] text-muted">
            借方と貸方の合計が同じになると登録できます
          </span>
        ) : null}
      </section>

      {mode.kind === "new" ? (
        <EntryFormActions
          pending={pending}
          disabled={difference !== 0n}
          divider={false}
          onOpen={() => send(false)}
        />
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" variant="primary" disabled={pending || difference !== 0n}>
            {pending ? "登録中…" : "訂正を登録"}
          </Button>
        </div>
      )}
    </form>
  );
}
