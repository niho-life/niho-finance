import type { CalendarDate } from "@niho-finance/ledger";
import type { RowFailure, WalletTransactionDraft } from "../types";
import type { StripeBalanceTransaction } from "./types";

/** Owner-facing names of `reporting_category` (12-imports §4.3). */
export const STRIPE_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  charge: "決済",
  payment: "決済",
  refund: "返金",
  payment_refund: "返金",
  refund_failure: "返金の失敗",
  dispute: "チャージバック",
  dispute_reversal: "チャージバックの取消",
  fee: "手数料",
  payout: "入金（銀行へ）",
  payout_reversal: "入金の戻り",
  platform_earning: "プラットフォーム手数料",
  platform_earning_refund: "プラットフォーム手数料の返金",
  transfer: "振替",
  transfer_reversal: "振替の取消",
  topup: "チャージ",
  adjustment: "調整",
  risk_reserved_funds: "留保",
  other_adjustment: "その他の調整",
};

const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const FEE_CATEGORY = "fee";
const FEE_LABEL = STRIPE_CATEGORY_LABELS[FEE_CATEGORY] ?? FEE_CATEGORY;

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date of a Unix time in `timeZone` (accounting dates are JST days). */
export function calendarDateOfUnix(seconds: number, timeZone: string): CalendarDate {
  let format = dateFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(seconds * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}` as CalendarDate;
}

function categoryLabel(category: string): string {
  return Object.hasOwn(STRIPE_CATEGORY_LABELS, category)
    ? (STRIPE_CATEGORY_LABELS[category] ?? category)
    : category;
}

/** The ID of a balance transaction's `source`, whether it came as an ID or an expanded object. */
export function sourceIdOf(source: unknown): string | null {
  if (typeof source === "string") return source;
  if (typeof source === "object" && source !== null && "id" in source) {
    const { id } = source;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/**
 * One balance transaction → its statement lines (12-imports §4.3, 04-integrations §1.2): the gross
 * line (`<id>`, `amount`) and the fee line (`<id>:fee`, `−fee`). A zero amount with a fee yields
 * the fee line only; zero and zero yields nothing. A currency other than JPY is a failure.
 */
export function convertBalanceTransaction(
  bt: StripeBalanceTransaction,
  options: { timeZone?: string } = {},
): { rows: WalletTransactionDraft[]; failure: RowFailure | null } {
  if (bt.currency !== "jpy") {
    return {
      rows: [],
      failure: { rowNumber: 0, reason: `通貨が円ではありません（${bt.currency}）` },
    };
  }
  if (!Number.isSafeInteger(bt.amount) || !Number.isSafeInteger(bt.fee)) {
    return { rows: [], failure: { rowNumber: 0, reason: "金額が読めません" } };
  }
  if (!Number.isSafeInteger(bt.created) || !Number.isSafeInteger(bt.available_on)) {
    return { rows: [], failure: { rowNumber: 0, reason: "日付が読めません" } };
  }
  if (bt.amount === 0 && bt.fee === 0) return { rows: [], failure: null };

  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const txnDate = calendarDateOfUnix(bt.created, timeZone);
  const valueDate = calendarDateOfUnix(bt.available_on, timeZone);
  const occurredAt = new Date(bt.created * 1000);
  const label = categoryLabel(bt.reporting_category);
  const descriptionRaw = bt.description ? `${label} ${bt.description}` : label;
  const common = {
    txnDate,
    valueDate,
    counterpartyRaw: null,
    balanceAfter: null,
  };

  const rows: WalletTransactionDraft[] = [];
  if (bt.amount !== 0) {
    rows.push({
      externalId: bt.id,
      ...common,
      occurredAt,
      amount: BigInt(bt.amount),
      descriptionRaw,
      category: bt.reporting_category,
      raw: { ...bt, source: sourceIdOf(bt.source) },
    });
  }
  if (bt.fee !== 0) {
    rows.push({
      externalId: `${bt.id}:fee`,
      ...common,
      occurredAt: new Date(occurredAt),
      amount: -BigInt(bt.fee),
      descriptionRaw: `${FEE_LABEL} · ${descriptionRaw}`,
      category: FEE_CATEGORY,
      raw: {
        balanceTransactionId: bt.id,
        feeDetails: bt.fee_details.map((detail) => ({ ...detail })),
      },
    });
  }
  return { rows, failure: null };
}
