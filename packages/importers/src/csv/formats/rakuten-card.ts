import type { CsvFormat, ParsedStatement, RowFailure, WalletTransactionDraft } from "../../types";
import { cellAt, findHeaderRow, headerKey, missingHeaderFailures, readAmountCell } from "../cells";
import { normalizeText, parseStatementDate } from "../fields";
import { csvDraft, rowFailure } from "../rows";
import { isBlankRow } from "../table";

/**
 * 楽天カード（e-NAVI）の利用明細 (12-imports §3.1). A card wallet is a liability: a purchase is money
 * leaving the wallet, so the amount is −利用金額 (a refund, a negative 利用金額, becomes positive).
 */

/** The leading header cells; the later ones (`◯月支払金額` …) change every month and are not compared. */
const HEADER_PREFIX = ["利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額"];
const HEADER_KEYS = HEADER_PREFIX.map(headerKey);
const COLUMNS = { date: 0, description: 1, paymentMethod: 3, amount: 4 } as const;
const REQUIRED_LENGTH = COLUMNS.amount + 1;

function isHeader(keys: readonly string[]): boolean {
  return HEADER_KEYS.every((key, index) => keys[index] === key);
}

function parse(table: string[][]): ParsedStatement {
  const rows: WalletTransactionDraft[] = [];
  const failures: RowFailure[] = [];
  const headerIndex = findHeaderRow(table, isHeader);
  if (headerIndex < 0) {
    failures.push(...missingHeaderFailures(table, HEADER_PREFIX));
  } else {
    for (const [index, cells] of table.entries()) {
      const rowNumber = index + 1;
      if (index <= headerIndex || isBlankRow(cells)) continue;
      // Rows without a 利用日 are totals and notes, not transactions.
      const dateText = cellAt(cells, COLUMNS.date);
      if (dateText.trim() === "") continue;
      if (cells.length < REQUIRED_LENGTH) {
        failures.push(
          rowFailure(rowNumber, `列が足りません（${REQUIRED_LENGTH} 列が要ります）`, cells),
        );
        continue;
      }
      const txnDate = parseStatementDate(dateText);
      if (txnDate === null) {
        failures.push(rowFailure(rowNumber, "日付が読めません", cells));
        continue;
      }
      const amount = readAmountCell(cellAt(cells, COLUMNS.amount));
      if (amount.kind !== "amount") {
        failures.push(rowFailure(rowNumber, "金額が読めません", cells));
        continue;
      }
      rows.push(
        csvDraft(
          {
            txnDate,
            amount: -amount.value,
            descriptionRaw: normalizeText(cellAt(cells, COLUMNS.description)),
            category: normalizeText(cellAt(cells, COLUMNS.paymentMethod)) || null,
          },
          cells,
          rowNumber,
        ),
      );
    }
  }
  return {
    format: "rakuten_card",
    rows,
    failures,
    warnings: [],
    openingBalance: null,
    closingBalance: null,
    period: null,
  };
}

export const rakutenCard: CsvFormat = {
  key: "rakuten_card",
  label: "楽天カード（e-NAVI）",
  walletKinds: ["card"],
  detect: (table) => findHeaderRow(table, isHeader) >= 0,
  parse: (table) => parse(table),
};
