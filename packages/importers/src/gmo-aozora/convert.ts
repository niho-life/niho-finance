import { isCalendarDate, type Money } from "@niho-finance/ledger";
import { withRowNumber } from "../csv/rows";
import type { RowFailure, WalletTransactionDraft } from "../types";
import type { GmoTransaction } from "./types";

/** `transactionType` → 入払 (19-bank-api §3.2). */
export const GMO_TRANSACTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  "1": "入金",
  "2": "出金",
};

const INTEGER = /^-?\d+$/;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An integer string (a minus sign allowed) as yen; `null` for anything else. */
function integerYen(value: unknown): Money | null {
  return typeof value === "string" && INTEGER.test(value) ? BigInt(value) : null;
}

/** The cells shown for a line that could not be read: 日付・入払・金額・摘要. */
function failureCells(t: GmoTransaction): string[] {
  const type = text(t.transactionType);
  return [
    text(t.transactionDate),
    GMO_TRANSACTION_TYPE_LABELS[type] ?? type,
    text(t.amount),
    text(t.remarks).trim(),
  ];
}

function failure(t: GmoTransaction, rowNumber: number, reason: string) {
  return {
    draft: null,
    failure: { rowNumber, reason, raw: failureCells(t) } satisfies RowFailure,
  };
}

/**
 * One line of the 入出金明細 API → one statement line (19-bank-api §3.2): `externalId` is the
 * `itemKey`, the amount is signed by `transactionType` (1 入金 +, 2 出金 −; a negative amount, a
 * correction, keeps its sign under it), `balance` is the balance after. A line without an
 * `itemKey`, or whose date, type or amount cannot be read, is a failure. `rowNumber` is the
 * line's 1-based place among those fetched (cited by the balance warnings too).
 */
export function convertGmoTransaction(
  t: GmoTransaction,
  rowNumber: number,
): { draft: WalletTransactionDraft | null; failure: RowFailure | null } {
  const itemKey = text(t.itemKey).trim();
  if (itemKey === "") return failure(t, rowNumber, "明細キーがありません");
  const txnDate = t.transactionDate;
  if (!isCalendarDate(txnDate)) return failure(t, rowNumber, "日付が読めません");
  const valueDateText = text(t.valueDate);
  if (valueDateText !== "" && !isCalendarDate(valueDateText)) {
    return failure(t, rowNumber, "起算日が読めません");
  }
  const type = text(t.transactionType);
  const sign = type === "1" ? 1n : type === "2" ? -1n : null;
  if (sign === null) return failure(t, rowNumber, "入払区分が読めません");
  const amount = integerYen(t.amount);
  if (amount === null) return failure(t, rowNumber, "金額が読めません");
  const balanceText = text(t.balance);
  const balanceAfter = balanceText === "" ? null : integerYen(balanceText);
  if (balanceText !== "" && balanceAfter === null) {
    return failure(t, rowNumber, "残高が読めません");
  }
  const remarks = text(t.remarks).trim();
  const draft: WalletTransactionDraft = {
    externalId: itemKey,
    txnDate,
    valueDate: isCalendarDate(valueDateText) ? valueDateText : null,
    occurredAt: null,
    amount: sign * amount,
    descriptionRaw: remarks === "" ? (GMO_TRANSACTION_TYPE_LABELS[type] ?? type) : remarks,
    counterpartyRaw: null,
    balanceAfter,
    category: null,
    raw: t,
  };
  return { draft: withRowNumber(draft, rowNumber), failure: null };
}
