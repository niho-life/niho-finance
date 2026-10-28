import type { Money } from "@niho-finance/ledger";
import type {
  CsvFormat,
  GenericCsvConfig,
  ParsedStatement,
  RowFailure,
  WalletTransactionDraft,
} from "../../types";
import { cellAt, readAmountCell } from "../cells";
import { normalizeText, parseStatementDate } from "../fields";
import { csvDraft, rowFailure } from "../rows";
import { isBlankRow } from "../table";
import type { StatementOrder } from "../order";

/** 汎用: any statement CSV, read with the column mapping saved on the wallet (12-imports §3.1). */

interface GenericColumns {
  date: number;
  description: number;
  amount: number | null;
  deposit: number | null;
  withdrawal: number | null;
  balance: number | null;
  counterparty: number | null;
}

const ORDERS: readonly unknown[] = ["asc", "desc", "auto"] satisfies StatementOrder[];
/** Header rows skipped when a saved mapping has none (the screen's default). */
const DEFAULT_HEADER_ROWS = 1;

/** A column index: a non-negative integer, or `null` when not mapped (`undefined` / `null`). */
function optionalColumn(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("列の番号は 0 以上の整数で指定してください");
  }
  return value;
}

function requiredColumn(value: unknown, message: string): number {
  const column = optionalColumn(value);
  if (column === null) throw new RangeError(message);
  return column;
}

/**
 * Checks a column mapping. The db layer validates it with Zod first, so a failure here is a bug:
 * it throws a `RangeError` (with an owner-facing message) instead of returning a result. Fields
 * a saved mapping may lack (`headerRows`, `order`) take their defaults.
 */
function validateConfig(config: GenericCsvConfig | null): {
  headerRows: number;
  columns: GenericColumns;
  invertSign: boolean;
} {
  if (config === null) throw new RangeError("汎用の形式には列の対応が要ります");
  const headerRows: unknown = config.headerRows ?? DEFAULT_HEADER_ROWS;
  if (typeof headerRows !== "number" || !Number.isSafeInteger(headerRows) || headerRows < 0) {
    throw new RangeError("ヘッダ行の数は 0 以上の整数で指定してください");
  }
  const order: unknown = config.order ?? "auto";
  if (!ORDERS.includes(order)) {
    throw new RangeError("並びは 自動・古い順・新しい順 のどれかを選んでください");
  }
  const { columns } = config;
  const mapped: GenericColumns = {
    date: requiredColumn(columns.date, "日付の列を選んでください"),
    description: requiredColumn(columns.description, "摘要の列を選んでください"),
    amount: optionalColumn(columns.amount),
    deposit: optionalColumn(columns.deposit),
    withdrawal: optionalColumn(columns.withdrawal),
    balance: optionalColumn(columns.balance),
    counterparty: optionalColumn(columns.counterparty),
  };
  const split = mapped.deposit !== null || mapped.withdrawal !== null;
  if (mapped.amount !== null && split) {
    throw new RangeError("金額（符号付き）と出金・入金は、どちらか一方だけを選んでください");
  }
  if (mapped.amount === null && !split) {
    throw new RangeError("金額（符号付き）か、出金・入金の列を選んでください");
  }
  return { headerRows, columns: mapped, invertSign: config.invertSign === true };
}

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

function readSignedAmount(
  cells: readonly string[],
  columns: GenericColumns,
  invertSign: boolean,
): Read<Money> {
  if (columns.amount !== null) {
    const amount = readAmountCell(cellAt(cells, columns.amount));
    if (amount.kind !== "amount") return { ok: false, reason: "金額が読めません" };
    return { ok: true, value: invertSign ? -amount.value : amount.value };
  }
  const deposit = columns.deposit === null ? null : readAmountCell(cellAt(cells, columns.deposit));
  const withdrawal =
    columns.withdrawal === null ? null : readAmountCell(cellAt(cells, columns.withdrawal));
  if (deposit?.kind === "invalid" || withdrawal?.kind === "invalid") {
    return { ok: false, reason: "金額が読めません" };
  }
  if (deposit?.kind !== "amount" && withdrawal?.kind !== "amount") {
    return { ok: false, reason: "金額が読めません" };
  }
  const depositValue = deposit?.kind === "amount" ? deposit.value : 0n;
  const withdrawalValue = withdrawal?.kind === "amount" ? withdrawal.value : 0n;
  return { ok: true, value: depositValue - withdrawalValue };
}

function readBalance(cells: readonly string[], column: number | null): Read<Money | null> {
  if (column === null) return { ok: true, value: null };
  const balance = readAmountCell(cellAt(cells, column));
  switch (balance.kind) {
    case "blank":
      return { ok: true, value: null };
    case "invalid":
      return { ok: false, reason: "残高が読めません" };
    case "amount":
      return { ok: true, value: balance.value };
  }
}

function parse(table: string[][], config: GenericCsvConfig | null): ParsedStatement {
  const { headerRows, columns, invertSign } = validateConfig(config);
  const requiredLength =
    Math.max(...Object.values(columns).filter((column): column is number => column !== null)) + 1;
  const rows: WalletTransactionDraft[] = [];
  const failures: RowFailure[] = [];

  for (const [index, cells] of table.entries()) {
    const rowNumber = index + 1;
    if (index < headerRows || isBlankRow(cells)) continue;
    if (cells.length < requiredLength) {
      failures.push(
        rowFailure(rowNumber, `列が足りません（${requiredLength} 列が要ります）`, cells),
      );
      continue;
    }
    const txnDate = parseStatementDate(cellAt(cells, columns.date));
    if (txnDate === null) {
      failures.push(rowFailure(rowNumber, "日付が読めません", cells));
      continue;
    }
    const amount = readSignedAmount(cells, columns, invertSign);
    if (!amount.ok) {
      failures.push(rowFailure(rowNumber, amount.reason, cells));
      continue;
    }
    const balance = readBalance(cells, columns.balance);
    if (!balance.ok) {
      failures.push(rowFailure(rowNumber, balance.reason, cells));
      continue;
    }
    const counterparty =
      columns.counterparty === null ? "" : normalizeText(cellAt(cells, columns.counterparty));
    rows.push(
      csvDraft(
        {
          txnDate,
          amount: amount.value,
          descriptionRaw: normalizeText(cellAt(cells, columns.description)),
          counterpartyRaw: counterparty || null,
          balanceAfter: balance.value,
        },
        cells,
        rowNumber,
      ),
    );
  }

  return {
    format: "generic",
    rows,
    failures,
    warnings: [],
    openingBalance: null,
    closingBalance: null,
    period: null,
  };
}

export const generic: CsvFormat = {
  key: "generic",
  label: "汎用",
  walletKinds: ["bank", "card", "other"],
  detect: () => false,
  parse,
};
