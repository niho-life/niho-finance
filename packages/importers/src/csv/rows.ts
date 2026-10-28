import type { CalendarDate, Money } from "@niho-finance/ledger";
import type { RowFailure, WalletTransactionDraft } from "../types";

/**
 * Internal: the CSV row a draft was read from. Kept beside the draft (not on it) so the exported
 * `WalletTransactionDraft` stays the stored shape; the continuity warnings cite the file's row.
 */
const ROW_NUMBERS = new WeakMap<WalletTransactionDraft, number>();

export function withRowNumber<T extends WalletTransactionDraft>(draft: T, rowNumber: number): T {
  ROW_NUMBERS.set(draft, rowNumber);
  return draft;
}

export function rowNumberOf(draft: WalletTransactionDraft): number | undefined {
  return ROW_NUMBERS.get(draft);
}

/** A copy of `draft` with other fields that keeps its row number. */
export function copyDraft(
  draft: WalletTransactionDraft,
  changes: Partial<WalletTransactionDraft>,
): WalletTransactionDraft {
  const copy = { ...draft, ...changes };
  const rowNumber = rowNumberOf(draft);
  return rowNumber === undefined ? copy : withRowNumber(copy, rowNumber);
}

export interface CsvDraftFields {
  txnDate: CalendarDate;
  valueDate?: CalendarDate | null;
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw?: string | null;
  balanceAfter?: Money | null;
  category?: string | null;
}

/** A statement line read from row `rowNumber` (1-based) of a CSV table; the ID comes later. */
export function csvDraft(
  fields: CsvDraftFields,
  cells: readonly string[],
  rowNumber: number,
): WalletTransactionDraft {
  return withRowNumber(
    {
      externalId: "",
      txnDate: fields.txnDate,
      valueDate: fields.valueDate ?? null,
      occurredAt: null,
      amount: fields.amount,
      descriptionRaw: fields.descriptionRaw,
      counterpartyRaw: fields.counterpartyRaw ?? null,
      balanceAfter: fields.balanceAfter ?? null,
      category: fields.category ?? null,
      raw: [...cells],
    },
    rowNumber,
  );
}

export function rowFailure(
  rowNumber: number,
  reason: string,
  cells: readonly string[],
): RowFailure {
  return { rowNumber, reason, raw: [...cells] };
}
