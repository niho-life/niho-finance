"use client";

import { ACCOUNT_KIND_LABELS, parseYenInput } from "@niho-finance/ledger";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Select } from "@/components/ui/form";
import { MoneyInput } from "@/components/ui/money-input";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";
import { formatYenDisplay } from "@/lib/format";
import { TaxCategoryOptions } from "../../entries/_components/form-kit";
import type { SettledStatement } from "../actions";
import { DialogAlert, Modal } from "./modal";
import {
  accountChoices,
  amountOf,
  directionOf,
  shortDate,
  signedAmount,
  withAccount,
  type ClientStatementRow,
  type Lookups,
  type RowDraft,
  type StatementOptions,
} from "./model";

interface SplitLine {
  key: number;
  accountId: string;
  taxCategoryCode: string;
  amount: string;
  segmentId: string;
  description: string;
  touched: RowDraft["touched"];
}

const LINE_FIELDS = ["accountId", "taxCategoryCode", "amount", "segmentId", "description"] as const;

function emptyLine(key: number, segmentId: string): SplitLine {
  return {
    key,
    accountId: "",
    taxCategoryCode: "",
    amount: "",
    segmentId,
    description: "",
    touched: { taxCategoryCode: false, segmentId: false },
  };
}

/**
 * 分割 (15 §9): one entry with several lines of 科目 · 税区分 · 金額（税込）· セグメント · 摘要. 登録 is
 * enabled when the lines add up to the amount of the statement line (差額 0, bold, never red); the
 * server checks the total again (`lines`) and names the cell of each problem (`lines.<i>.<field>`).
 */
export function SplitDialog({
  row,
  draft,
  options,
  lookups,
  thisYear,
  onCancel,
  onSubmit,
}: {
  row: ClientStatementRow;
  draft: RowDraft;
  options: StatementOptions;
  lookups: Lookups;
  thisYear: number;
  onCancel: () => void;
  /** Registers the split; the dialog shows the problems of a failure. */
  onSubmit: (input: unknown) => Promise<ActionResult<SettledStatement>>;
}) {
  const id = useId();
  const direction = directionOf(row);
  const groups = accountChoices(direction, options);
  const walletSegmentId = lookups.wallets.get(row.walletId)?.defaultSegmentId ?? null;
  const [partnerId, setPartnerId] = useState(draft.partnerId);
  const [description, setDescription] = useState(draft.description);
  const [nextKey, setNextKey] = useState(2);
  const [lines, setLines] = useState<SplitLine[]>(() => [
    {
      ...emptyLine(0, draft.segmentId),
      accountId: draft.accountId,
      taxCategoryCode: draft.taxCategoryCode,
      touched: draft.touched,
    },
    emptyLine(1, walletSegmentId ?? ""),
  ]);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  const size = amountOf(row) < 0n ? -amountOf(row) : amountOf(row);
  const parsed = lines.map((line) => parseYenInput(line.amount));
  const total = parsed.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  const difference = size - total;
  const complete = parsed.every((value) => value !== null && value > 0n);

  function change(index: number, patch: Partial<SplitLine>) {
    setLines(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
    setError(null);
  }

  function changeAccount(index: number, accountId: string) {
    const line = lines[index];
    if (!line) return;
    const next = withAccount(
      {
        mode: "register",
        accountId: line.accountId,
        taxCategoryCode: line.taxCategoryCode,
        partnerId: "",
        segmentId: line.segmentId,
        description: "",
        transferToWalletId: "",
        counterpart: "",
        ignoredReason: "",
        edited: true,
        touched: line.touched,
      },
      accountId,
      { direction, accounts: lookups.accounts, walletSegmentId },
    );
    change(index, {
      accountId,
      taxCategoryCode: next.taxCategoryCode,
      segmentId: next.segmentId,
    });
  }

  const cellError = (index: number, field: (typeof LINE_FIELDS)[number]) =>
    error?.fieldErrors[`lines.${index}.${field}`];
  const shown = (field: string) =>
    field === "partnerId" ||
    field === "description" ||
    lines.some((_, index) => LINE_FIELDS.some((name) => field === `lines.${index}.${name}`));
  const alerts = formLevelErrors(error, shown);

  return (
    <Modal
      wide
      title="分割して登録"
      description={`${shortDate(row.txnDate, thisYear)} ${row.walletName} · ${row.descriptionRaw} ${signedAmount(row.amount)}`}
      busy={pending}
      onClose={onCancel}
      onSubmit={() => {
        if (difference !== 0n || !complete) return;
        startTransition(async () => {
          const result = await onSubmit({
            description,
            partnerId,
            ruleId: "",
            lines: lines.map((line) => ({
              accountId: line.accountId,
              amount: line.amount,
              taxCategoryCode: line.taxCategoryCode,
              segmentId: line.segmentId,
              partnerId: "",
              description: line.description,
            })),
          });
          if (!result.ok) setError(result);
        });
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            キャンセル
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || difference !== 0n || !complete}
          >
            {pending ? "登録中…" : "登録"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="取引先" htmlFor={`${id}-partner`} error={error?.fieldErrors.partnerId}>
          <Select
            id={`${id}-partner`}
            value={partnerId}
            onChange={(event) => setPartnerId(event.currentTarget.value)}
          >
            <option value="">なし</option>
            {options.partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="摘要"
          htmlFor={`${id}-description`}
          error={error?.fieldErrors.description}
        >
          <Input
            id={`${id}-description`}
            value={description}
            maxLength={200}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </FormField>
      </div>

      <div role="table" aria-label="分割の行" className="flex flex-col gap-2">
        <div
          role="row"
          className="hidden gap-2 text-[11px] font-bold text-muted md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_112px_minmax(0,1fr)_minmax(0,1fr)_32px]"
        >
          <span role="columnheader">科目</span>
          <span role="columnheader">税区分</span>
          <span role="columnheader" className="text-right">
            金額（税込・円）
          </span>
          <span role="columnheader">セグメント</span>
          <span role="columnheader">摘要</span>
          <span role="columnheader">
            <span className="sr-only">削除</span>
          </span>
        </div>
        {lines.map((line, index) => {
          const label = (name: string) => `${index + 1} 行目の${name}`;
          const invalid = (field: (typeof LINE_FIELDS)[number]) =>
            cellError(index, field) ? true : undefined;
          return (
            <div
              key={line.key}
              role="row"
              className="grid grid-cols-2 gap-2 border-b border-border pb-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_112px_minmax(0,1fr)_minmax(0,1fr)_32px] md:border-0 md:pb-0"
            >
              <span role="cell" className="col-span-2 min-w-0 md:col-span-1">
                <select
                  aria-label={label("科目")}
                  aria-invalid={invalid("accountId")}
                  value={line.accountId}
                  onChange={(event) => changeAccount(index, event.currentTarget.value)}
                  className="control min-h-9! py-1! text-[14px]!"
                >
                  <option value="">科目を選ぶ</option>
                  {groups.map((group) => (
                    <optgroup key={group.kind} label={ACCOUNT_KIND_LABELS[group.kind]}>
                      {group.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} {account.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <CellError message={cellError(index, "accountId")} />
              </span>
              <span role="cell" className="min-w-0">
                <select
                  aria-label={label("税区分")}
                  aria-invalid={invalid("taxCategoryCode")}
                  value={line.taxCategoryCode}
                  onChange={(event) =>
                    change(index, {
                      taxCategoryCode: event.currentTarget.value,
                      touched: { ...line.touched, taxCategoryCode: true },
                    })
                  }
                  className="control min-h-9! py-1! text-[14px]!"
                >
                  <option value="">税区分</option>
                  <TaxCategoryOptions
                    categories={options.taxCategories}
                    first={direction === "in" ? "sales" : "purchase"}
                  />
                </select>
                <CellError message={cellError(index, "taxCategoryCode")} />
              </span>
              <span role="cell" className="min-w-0">
                <MoneyInput
                  aria-label={label("金額（税込・円）")}
                  aria-invalid={invalid("amount")}
                  value={line.amount}
                  onValueChange={(text) => change(index, { amount: text })}
                  placeholder="0"
                  className="min-h-9! py-1! text-[14px]!"
                />
                <CellError message={cellError(index, "amount")} />
              </span>
              <span role="cell" className="min-w-0">
                <select
                  aria-label={label("セグメント")}
                  aria-invalid={invalid("segmentId")}
                  value={line.segmentId}
                  onChange={(event) =>
                    change(index, {
                      segmentId: event.currentTarget.value,
                      touched: { ...line.touched, segmentId: true },
                    })
                  }
                  className="control min-h-9! py-1! text-[14px]!"
                >
                  <option value="">セグメントなし</option>
                  {options.segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.name}
                    </option>
                  ))}
                </select>
                <CellError message={cellError(index, "segmentId")} />
              </span>
              <span role="cell" className="min-w-0">
                <input
                  aria-label={label("摘要")}
                  aria-invalid={invalid("description")}
                  value={line.description}
                  maxLength={200}
                  placeholder="任意"
                  onChange={(event) => change(index, { description: event.currentTarget.value })}
                  className="control min-h-9! py-1! text-[14px]!"
                />
                <CellError message={cellError(index, "description")} />
              </span>
              <span role="cell" className="flex items-start justify-end">
                <button
                  type="button"
                  aria-label={`${index + 1} 行目を削除`}
                  disabled={lines.length <= 2}
                  onClick={() => setLines(lines.filter((_, at) => at !== index))}
                  className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-text disabled:opacity-40"
                >
                  ×
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={lines.length >= 30}
          onClick={() => {
            setLines([...lines, emptyLine(nextKey, walletSegmentId ?? "")]);
            setNextKey(nextKey + 1);
          }}
        >
          ＋ 行を追加
        </Button>
      </div>
      <dl className="num ml-auto grid w-full max-w-72 grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[14px]">
        <dt className="text-muted">合計</dt>
        <dd className="text-right">{formatYenDisplay(total)}</dd>
        <dt className="text-muted">明細の金額</dt>
        <dd className="text-right">{formatYenDisplay(size)}</dd>
        <dt className="font-bold">差額</dt>
        <dd className="text-right font-bold" aria-live="polite">
          {signedAmount(difference)}
        </dd>
      </dl>
      <DialogAlert messages={alerts} />
    </Modal>
  );
}

function CellError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <span className="mt-0.5 block text-[12px] font-bold text-danger">{message}</span>;
}
