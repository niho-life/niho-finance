import { formatYen, type CalendarDate, type Money } from "@niho-finance/ledger";
import type { CsvFormat, ParsedStatement, RowFailure, WalletTransactionDraft } from "../../types";
import { cellAt } from "../cells";
import { normalizeText, parseStatementAmount, parseZenginDate } from "../fields";
import { csvDraft, rowFailure, type CsvDraftFields } from "../rows";
import { isBlankRow } from "../table";

/**
 * GMO あおぞらネット銀行 全銀 CSV: the 全銀協 入出金取引明細 records, comma separated
 * (12-imports §3.1). The columns follow the 全銀協 layout and are to be confirmed with a real
 * file (04-integrations §9).
 */

/** データ区分 of each record. */
const RECORD = { header: "1", data: "2", trailer: "8", end: "9" } as const;
/** 種別コード of 入出金取引明細 (header column 1). */
const STATEMENT_KIND = "03";
/** 入払区分. */
const DEPOSIT = "1";
const WITHDRAWAL = "2";
/** 貸越区分 "2" means the balance is negative (overdrawn). */
const OVERDRAWN = "2";

/** 取引区分 → its name (the category, and the description when 摘要内容 is empty). */
const TRANSACTION_KINDS: Readonly<Record<string, string>> = {
  "10": "現金",
  "11": "振込",
  "14": "振替",
  "18": "その他",
  "19": "訂正",
};

/** 0-based columns of each record. */
const HEADER_COLUMNS = { periodFrom: 4, periodTo: 5, overdraft: 13, balance: 14 } as const;
const DATA_COLUMNS = {
  date: 2,
  valueDate: 3,
  direction: 4,
  kind: 5,
  amount: 6,
  remitter: 14,
  description: 17,
} as const;
const TRAILER_COLUMNS = {
  depositCount: 1,
  depositTotal: 2,
  withdrawalCount: 3,
  withdrawalTotal: 4,
  overdraft: 5,
  balance: 6,
} as const;
const HEADER_LENGTH = HEADER_COLUMNS.balance + 1;
const DATA_LENGTH = DATA_COLUMNS.description + 1;
const TRAILER_LENGTH = TRAILER_COLUMNS.balance + 1;

const SINGLE_ACCOUNT = "1 つのファイルで取り込めるのは 1 口座です";

function recordOf(row: readonly string[]): string {
  return cellAt(row, 0).trim();
}

function transactionKindName(code: string): string | null {
  if (code === "") return null;
  return Object.hasOwn(TRANSACTION_KINDS, code) ? (TRANSACTION_KINDS[code] ?? code) : code;
}

function readBalance(amountText: string, overdraftText: string): Money | null {
  const amount = parseStatementAmount(amountText);
  if (amount === null) return null;
  return overdraftText.trim() === OVERDRAWN ? -amount : amount;
}

function readCount(text: string): number | null {
  const value = text.normalize("NFKC").trim();
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

interface Totals {
  count: number;
  total: Money;
}

type DataRow =
  | { ok: true; fields: CsvDraftFields; deposit: boolean; amount: Money }
  | { ok: false; reason: string };

function readDataRow(cells: readonly string[]): DataRow {
  if (cells.length < DATA_LENGTH) {
    return { ok: false, reason: `列が足りません（${DATA_LENGTH} 列が要ります）` };
  }
  const txnDate = parseZenginDate(cellAt(cells, DATA_COLUMNS.date));
  if (txnDate === null) return { ok: false, reason: "日付が読めません" };
  const valueDateText = cellAt(cells, DATA_COLUMNS.valueDate).trim();
  const valueDate = valueDateText === "" ? null : parseZenginDate(valueDateText);
  if (valueDateText !== "" && valueDate === null) {
    return { ok: false, reason: "起算日が読めません" };
  }
  const direction = cellAt(cells, DATA_COLUMNS.direction).trim();
  if (direction !== DEPOSIT && direction !== WITHDRAWAL) {
    return { ok: false, reason: "入払区分が読めません" };
  }
  const amount = parseStatementAmount(cellAt(cells, DATA_COLUMNS.amount));
  if (amount === null || amount < 0n) return { ok: false, reason: "金額が読めません" };

  const category = transactionKindName(cellAt(cells, DATA_COLUMNS.kind).trim());
  const description = normalizeText(cellAt(cells, DATA_COLUMNS.description));
  const remitter = normalizeText(cellAt(cells, DATA_COLUMNS.remitter));
  const deposit = direction === DEPOSIT;
  return {
    ok: true,
    deposit,
    amount,
    fields: {
      txnDate,
      valueDate,
      amount: deposit ? amount : -amount,
      descriptionRaw: description || category || "",
      counterpartyRaw: remitter || null,
      category,
    },
  };
}

function totalsMismatch(label: string, trailer: Totals, rows: Totals): string | null {
  if (trailer.count === rows.count && trailer.total === rows.total) return null;
  return `トレーラの${label} ${trailer.count} 件・${formatYen(trailer.total)} 円と、読めた明細の${label} ${rows.count} 件・${formatYen(rows.total)} 円が一致しません`;
}

function parse(table: string[][]): ParsedStatement {
  const rows: WalletTransactionDraft[] = [];
  const failures: RowFailure[] = [];
  const warnings: string[] = [];
  let openingBalance: Money | null = null;
  let closingBalance: Money | null = null;
  let period: { from: CalendarDate; to: CalendarDate } | null = null;
  let state: "statement" | "after-trailer" | "other-account" | "ended" = "statement";
  let headerSeen = false;
  let dataSeen = false;
  let trailerSeen = false;
  let trailer: { deposits: Totals; withdrawals: Totals } | null = null;
  let balance: Money | null = null;
  const deposits: Totals = { count: 0, total: 0n };
  const withdrawals: Totals = { count: 0, total: 0n };

  for (const [index, cells] of table.entries()) {
    const rowNumber = index + 1;
    if (isBlankRow(cells)) continue;
    if (state === "ended") {
      failures.push(rowFailure(rowNumber, "エンドレコードの後の行です", cells));
      continue;
    }
    const record = recordOf(cells);

    if (record === RECORD.header) {
      if (headerSeen || dataSeen) {
        failures.push(
          rowFailure(rowNumber, `2 つ目の口座のヘッダです（${SINGLE_ACCOUNT}）`, cells),
        );
        state = "other-account";
        continue;
      }
      headerSeen = true;
      const from = parseZenginDate(cellAt(cells, HEADER_COLUMNS.periodFrom));
      const to = parseZenginDate(cellAt(cells, HEADER_COLUMNS.periodTo));
      if (from !== null && to !== null && from <= to) period = { from, to };
      if (cells.length < HEADER_LENGTH) {
        warnings.push(`${rowNumber} 行目のヘッダの列が足りません（${HEADER_LENGTH} 列が要ります）`);
        continue;
      }
      openingBalance = readBalance(
        cellAt(cells, HEADER_COLUMNS.balance),
        cellAt(cells, HEADER_COLUMNS.overdraft),
      );
      if (openingBalance === null) {
        warnings.push(`${rowNumber} 行目のヘッダの取引前残高が読めません`);
      }
      balance = openingBalance;
    } else if (record === RECORD.data) {
      if (state === "other-account") {
        failures.push(rowFailure(rowNumber, `別の口座の明細です（${SINGLE_ACCOUNT}）`, cells));
        continue;
      }
      if (state === "after-trailer") {
        failures.push(rowFailure(rowNumber, "トレーラの後の明細です", cells));
        continue;
      }
      dataSeen = true;
      const row = readDataRow(cells);
      if (!row.ok) {
        failures.push(rowFailure(rowNumber, row.reason, cells));
        continue;
      }
      const totals = row.deposit ? deposits : withdrawals;
      totals.count += 1;
      totals.total += row.amount;
      balance = balance === null ? null : balance + row.fields.amount;
      rows.push(csvDraft({ ...row.fields, balanceAfter: balance }, cells, rowNumber));
    } else if (record === RECORD.trailer) {
      if (state === "other-account") continue;
      if (state === "after-trailer") {
        failures.push(rowFailure(rowNumber, "2 つ目のトレーラです", cells));
        continue;
      }
      state = "after-trailer";
      trailerSeen = true;
      if (cells.length < TRAILER_LENGTH) {
        warnings.push(
          `${rowNumber} 行目のトレーラの列が足りません（${TRAILER_LENGTH} 列が要ります）`,
        );
        continue;
      }
      closingBalance = readBalance(
        cellAt(cells, TRAILER_COLUMNS.balance),
        cellAt(cells, TRAILER_COLUMNS.overdraft),
      );
      const depositCount = readCount(cellAt(cells, TRAILER_COLUMNS.depositCount));
      const depositTotal = parseStatementAmount(cellAt(cells, TRAILER_COLUMNS.depositTotal));
      const withdrawalCount = readCount(cellAt(cells, TRAILER_COLUMNS.withdrawalCount));
      const withdrawalTotal = parseStatementAmount(cellAt(cells, TRAILER_COLUMNS.withdrawalTotal));
      if (
        depositCount === null ||
        depositTotal === null ||
        withdrawalCount === null ||
        withdrawalTotal === null ||
        closingBalance === null
      ) {
        warnings.push(`${rowNumber} 行目のトレーラの件数・合計・取引後残高が読めません`);
      }
      if (
        depositCount !== null &&
        depositTotal !== null &&
        withdrawalCount !== null &&
        withdrawalTotal !== null
      ) {
        trailer = {
          deposits: { count: depositCount, total: depositTotal },
          withdrawals: { count: withdrawalCount, total: withdrawalTotal },
        };
      }
    } else if (record === RECORD.end) {
      state = "ended";
    } else {
      failures.push(
        rowFailure(rowNumber, "データ区分が読めません（1・2・8・9 のどれでもありません）", cells),
      );
    }
  }

  if (!headerSeen && (rows.length > 0 || failures.length > 0)) {
    warnings.push("ヘッダの行がありません。取引前残高がないので残高を積めません");
  }
  if (headerSeen && !trailerSeen) {
    warnings.push("トレーラの行がありません。ファイルが途中で切れていないか確かめてください");
  }
  if (trailer !== null) {
    for (const mismatch of [
      totalsMismatch("入金", trailer.deposits, deposits),
      totalsMismatch("出金", trailer.withdrawals, withdrawals),
    ]) {
      if (mismatch !== null) warnings.push(mismatch);
    }
  }
  if (balance !== null && closingBalance !== null && balance !== closingBalance) {
    warnings.push(
      `トレーラの取引後残高 ${formatYen(closingBalance)} 円と、取引前残高から積んだ残高 ${formatYen(balance)} 円が一致しません`,
    );
  }

  return {
    format: "gmo_aozora_zengin",
    rows,
    failures,
    warnings,
    openingBalance,
    closingBalance,
    period,
  };
}

export const gmoAozoraZengin: CsvFormat = {
  key: "gmo_aozora_zengin",
  label: "GMO あおぞらネット銀行 全銀 CSV",
  walletKinds: ["bank"],
  detect(table) {
    const first = table.find((row) => !isBlankRow(row));
    if (!first || recordOf(first) !== RECORD.header) return false;
    if (cellAt(first, 1).trim() !== STATEMENT_KIND) return false;
    return table.some((row) => recordOf(row) === RECORD.data || recordOf(row) === RECORD.trailer);
  },
  parse: (table) => parse(table),
};
