import {
  abs,
  dateParts,
  displayDate,
  exclusiveTaxAmount,
  formatYen,
  inclusiveTaxAmount,
  isValidInvoiceRegistrationNumber,
  lastDayOfMonth,
  sum,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import type { Reading } from "./reading";

/**
 * The validation layer (20-reader §4): checks a normalized reading against itself, today, the
 * other documents and the registry. Pure. Any issue marks the proposal "要確認"; an `error` field
 * cannot be saved.
 */

export const READING_ISSUE_CODES = [
  "illegible",
  "currency",
  "date_missing",
  "date_future",
  "date_old",
  "total_missing",
  "total_range",
  "rates_missing",
  "rates_sum",
  "rate_tax",
  "registration_format",
  "registration_check_digit",
  "registration_not_found",
  "registration_inactive",
  "duplicate",
] as const;
export type ReadingIssueCode = (typeof READING_ISSUE_CODES)[number];

export type ReadingIssueField =
  | "documentType"
  | "transactionDate"
  | "totalAmount"
  | "rates"
  | "registrationNumber"
  | "issuerName"
  | "currency";

export interface ReadingIssue {
  code: ReadingIssueCode;
  severity: "error" | "warning";
  field: ReadingIssueField | null;
  message: string;
}

/** The registry lookup for the reading's number, as of its transaction date (20-reader §6). */
export interface ReadingRegistry {
  status: "registered" | "not_registered";
  name: string | null;
  registeredOn: CalendarDate | null;
  endedOn: CalendarDate | null;
  endReason: "expired" | "revoked" | null;
}

export interface ReadingValidationContext {
  today: CalendarDate;
  /** Other (not voided) documents with the same issuer, date and total. */
  duplicates?: readonly { documentId: string; label: string }[];
  /** `undefined`: not looked up; `null`: looked up and not found. */
  registry?: ReadingRegistry | null;
}

/** Totals above this are taken as a misreading (1 億円). */
export const READING_TOTAL_LIMIT: Money = 100_000_000n;
/** Printed tax may differ from the computed tax by the rounding (切り上げ・四捨五入). */
export const READING_TAX_TOLERANCE: Money = 1n;

/** The same day two years earlier (29 Feb → 28 Feb). */
function twoYearsBefore(date: CalendarDate): CalendarDate {
  const { year, month, day } = dateParts(date);
  const last = lastDayOfMonth(year - 2, month);
  const lastDay = dateParts(last).day;
  return `${last.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}` as CalendarDate;
}

function yen(value: Money): string {
  return `${formatYen(value)} 円`;
}

/** Why the number is not registered: not yet (`登録 …`), or no longer (`失効 …` / `取消 …`). */
function inactiveDetail(registry: ReadingRegistry, date: CalendarDate | null): string {
  const { registeredOn, endedOn } = registry;
  const notYet = registeredOn !== null && date !== null && date < registeredOn;
  if (!notYet && endedOn !== null) {
    const label = registry.endReason === "revoked" ? "取消" : "失効";
    return `（${label} ${displayDate(endedOn)}）`;
  }
  return registeredOn === null ? "" : `（登録 ${displayDate(registeredOn)}）`;
}

function amountIssues(reading: Reading): ReadingIssue[] {
  const issues: ReadingIssue[] = [];
  const total = reading.totalAmount;
  if (total === null) {
    issues.push({
      code: "total_missing",
      severity: "warning",
      field: "totalAmount",
      message: "合計を読み取れませんでした",
    });
  } else if (total === 0n || total > READING_TOTAL_LIMIT) {
    issues.push({
      code: "total_range",
      severity: "warning",
      field: "totalAmount",
      message: "合計が 0 円か、1 億円を超えています",
    });
  }
  if (total !== null && reading.rates.length === 0) {
    issues.push({
      code: "rates_missing",
      severity: "warning",
      field: "rates",
      message: "税率ごとの内訳がありません（適格請求書の記載事項）",
    });
  }
  if (total !== null && reading.rates.length > 0) {
    const ratesTotal = sum(reading.rates.map((rate) => rate.inclusiveAmount));
    if (ratesTotal !== total) {
      issues.push({
        code: "rates_sum",
        severity: "warning",
        field: "rates",
        message: `税率ごとの内訳の合計（${yen(ratesTotal)}）が合計（${yen(total)}）と合いません`,
      });
    }
  }
  for (const rate of reading.rates) {
    if (rate.taxAmount === null) continue;
    const computed = rate.taxIncluded
      ? inclusiveTaxAmount(rate.amount, rate.ratePercent)
      : exclusiveTaxAmount(rate.amount, rate.ratePercent);
    if (abs(rate.taxAmount - computed) > READING_TAX_TOLERANCE) {
      issues.push({
        code: "rate_tax",
        severity: "warning",
        field: "rates",
        message: `${rate.ratePercent}% の消費税額（${yen(rate.taxAmount)}）が対価から計算した額（${yen(computed)}）と合いません`,
      });
    }
  }
  return issues;
}

function registrationIssues(
  reading: Reading,
  registry: ReadingRegistry | null | undefined,
): ReadingIssue[] {
  const number = reading.registrationNumber;
  if (number === null) return [];
  if (!/^T\d{13}$/.test(number)) {
    return [
      {
        code: "registration_format",
        severity: "error",
        field: "registrationNumber",
        message: "登録番号の形式が違います（T と 13 桁）。読み違いか、番号の誤りです",
      },
    ];
  }
  if (!isValidInvoiceRegistrationNumber(number)) {
    return [
      {
        code: "registration_check_digit",
        severity: "error",
        field: "registrationNumber",
        message: "登録番号の検査用数字が合いません。読み違いか、番号の誤りです",
      },
    ];
  }
  // Not looked up (no application ID, or the lookup failed): only the format is checked.
  if (registry === undefined) return [];
  if (registry === null) {
    return [
      {
        code: "registration_not_found",
        severity: "warning",
        field: "registrationNumber",
        message: "国税庁の公表サイトにこの登録番号がありません",
      },
    ];
  }
  if (registry.status === "registered") return [];
  const date = reading.transactionDate;
  const when = date === null ? "この番号は" : `取引年月日（${displayDate(date)}）にはこの番号は`;
  return [
    {
      code: "registration_inactive",
      severity: "warning",
      field: "registrationNumber",
      message: `${when}登録されていません${inactiveDetail(registry, date)}`,
    },
  ];
}

export function validateReading(
  reading: Reading,
  context: ReadingValidationContext,
): ReadingIssue[] {
  const issues: ReadingIssue[] = [];
  if (!reading.legible) {
    issues.push({
      code: "illegible",
      severity: "warning",
      field: null,
      message: "読めない部分があります。画像と見比べてください",
    });
  }
  const yenAmounts = reading.currency === "JPY";
  if (!yenAmounts) {
    issues.push({
      code: "currency",
      severity: "warning",
      field: "currency",
      message: `円以外の通貨です（${reading.currency}）。金額は円にして入れてください`,
    });
  }

  const date = reading.transactionDate;
  if (date === null) {
    issues.push({
      code: "date_missing",
      severity: "warning",
      field: "transactionDate",
      message: "取引年月日を読み取れませんでした",
    });
  } else if (date > context.today) {
    issues.push({
      code: "date_future",
      severity: "warning",
      field: "transactionDate",
      message: `取引年月日が未来です（${displayDate(date)}）。読み違いがないか確かめてください`,
    });
  } else if (date < twoYearsBefore(context.today)) {
    issues.push({
      code: "date_old",
      severity: "warning",
      field: "transactionDate",
      message: "取引年月日が 2 年以上前です。読み違いがないか確かめてください",
    });
  }

  // Amounts in another currency are not proposed, so their checks would only add noise.
  if (yenAmounts) issues.push(...amountIssues(reading));
  issues.push(...registrationIssues(reading, context.registry));

  const duplicates = context.duplicates ?? [];
  if (duplicates.length > 0) {
    issues.push({
      code: "duplicate",
      severity: "warning",
      field: null,
      message: `同じ発行者・日付・金額の証憑があります（${duplicates.map((d) => d.label).join("、")}）`,
    });
  }
  return issues;
}
