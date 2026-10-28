import type { Money } from "@niho-finance/ledger";
import type { CsvFormat, ParsedStatement, RowFailure, WalletTransactionDraft } from "../../types";
import { cellAt, findHeaderRow, headerKey, missingHeaderFailures, readAmountCell } from "../cells";
import { normalizeText, parseStatementDate } from "../fields";
import { csvDraft, rowFailure } from "../rows";
import { isBlankRow } from "../table";

/** ドコモ SMTB ネット銀行（旧 住信 SBI ネット銀行）: one row per transaction (12-imports §3.1). */

const HEADER = ["日付", "内容", "出金金額(円)", "入金金額(円)", "残高(円)", "メモ"];
const HEADER_KEYS = HEADER.map(headerKey);
const COLUMNS = { date: 0, description: 1, withdrawal: 2, deposit: 3, balance: 4 } as const;
/** メモ may be missing; the columns up to 残高 are read. */
const REQUIRED_LENGTH = COLUMNS.balance + 1;

function isHeader(keys: readonly string[]): boolean {
  return (
    HEADER_KEYS.every((key, index) => keys[index] === key) &&
    keys.slice(HEADER_KEYS.length).every((key) => key === "")
  );
}

type Amount = { ok: true; amount: Money; balance: Money | null } | { ok: false; reason: string };

function readAmounts(cells: readonly string[]): Amount {
  const withdrawal = readAmountCell(cellAt(cells, COLUMNS.withdrawal));
  const deposit = readAmountCell(cellAt(cells, COLUMNS.deposit));
  if (withdrawal.kind === "invalid" || deposit.kind === "invalid") {
    return { ok: false, reason: "金額が読めません" };
  }
  if (withdrawal.kind === "blank" && deposit.kind === "blank") {
    return { ok: false, reason: "金額が読めません" };
  }
  const balance = readAmountCell(cellAt(cells, COLUMNS.balance));
  if (balance.kind === "invalid") return { ok: false, reason: "残高が読めません" };
  return {
    ok: true,
    amount:
      (deposit.kind === "amount" ? deposit.value : 0n) -
      (withdrawal.kind === "amount" ? withdrawal.value : 0n),
    balance: balance.kind === "amount" ? balance.value : null,
  };
}

function parse(table: string[][]): ParsedStatement {
  const rows: WalletTransactionDraft[] = [];
  const failures: RowFailure[] = [];
  const headerIndex = findHeaderRow(table, isHeader);
  if (headerIndex < 0) {
    failures.push(...missingHeaderFailures(table, HEADER));
  } else {
    for (const [index, cells] of table.entries()) {
      const rowNumber = index + 1;
      if (index <= headerIndex || isBlankRow(cells)) continue;
      if (cells.length < REQUIRED_LENGTH) {
        failures.push(
          rowFailure(rowNumber, `列が足りません（${REQUIRED_LENGTH} 列が要ります）`, cells),
        );
        continue;
      }
      const txnDate = parseStatementDate(cellAt(cells, COLUMNS.date));
      if (txnDate === null) {
        failures.push(rowFailure(rowNumber, "日付が読めません", cells));
        continue;
      }
      const amounts = readAmounts(cells);
      if (!amounts.ok) {
        failures.push(rowFailure(rowNumber, amounts.reason, cells));
        continue;
      }
      rows.push(
        csvDraft(
          {
            txnDate,
            amount: amounts.amount,
            descriptionRaw: normalizeText(cellAt(cells, COLUMNS.description)),
            balanceAfter: amounts.balance,
          },
          cells,
          rowNumber,
        ),
      );
    }
  }
  return {
    format: "docomo_smtb",
    rows,
    failures,
    warnings: [],
    openingBalance: null,
    closingBalance: null,
    period: null,
  };
}

export const docomoSmtb: CsvFormat = {
  key: "docomo_smtb",
  label: "ドコモ SMTB ネット銀行（旧 住信 SBI ネット銀行）",
  walletKinds: ["bank"],
  detect: (table) => findHeaderRow(table, isHeader) >= 0,
  parse: (table) => parse(table),
};
