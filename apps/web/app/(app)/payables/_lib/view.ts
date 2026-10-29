import type { PayablesFilter } from "@niho-finance/db";
import {
  describePaymentTerms,
  formatYen,
  PAYABLE_FEE_LIMIT,
  PAYABLE_STATE_LABELS,
  splitPayablePayment,
  type Money,
  type PayableState,
  type PaymentTerms,
} from "@niho-finance/ledger";

/*
 * What the payables screens (25 §6, §7) say about a payable, shared by the server pages and the
 * client forms: pure, no server imports.
 */

/** The parameters of `/payables` (25 §6) that differ from the defaults, in a stable order. */
export function payablesQuery(filters: Partial<PayablesFilter>): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== "open") params.set("status", filters.status);
  if (filters.partner) params.set("partner", filters.partner);
  if (filters.view && filters.view !== "due") params.set("view", filters.view);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

const LIST_KEYS = new Set(["status", "partner", "view", "q", "page"]);

/** The list a detail was opened from (`?list=` carries its query), so that 戻る keeps the filters. */
export function payablesListHref(list: unknown): string {
  if (typeof list !== "string" || list.length > 1_000) return "/payables";
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(list)) {
    if (LIST_KEYS.has(key) && value.length <= 100) kept.set(key, value);
  }
  const query = kept.toString();
  return query ? `/payables?${query}` : "/payables";
}

export function payableDetailHref(id: string, listQuery: string): string {
  return listQuery ? `/payables/${id}?list=${encodeURIComponent(listQuery)}` : `/payables/${id}`;
}

/** 「<取引先> の請求書」: the name of a payable (the detail's title, the toasts). */
export function payableName(partnerName: string): string {
  return partnerName ? `${partnerName} の請求書` : "請求書";
}

export interface StatusPart {
  text: string;
  tone: "warn" | "plain";
}

/**
 * 状態 of a row (25 §6): 「期限超過（n 日）」 in the warn colour, then 一部支払 / 支払済み / 取消; a
 * payable that is simply unpaid and not late says 未払.
 */
export function payableStatusParts(row: {
  state: PayableState;
  overdue: boolean;
  overdueDays: number;
}): StatusPart[] {
  const parts: StatusPart[] = [];
  if (row.overdue) parts.push({ text: `期限超過（${row.overdueDays} 日）`, tone: "warn" });
  if (row.state !== "unpaid" || parts.length === 0) {
    parts.push({ text: PAYABLE_STATE_LABELS[row.state], tone: "plain" });
  }
  return parts;
}

export interface PaymentOutcome {
  /** 充当額・手数料・支払後の残り (`null` while the amount is not a positive number). */
  applied: Money | null;
  fee: Money;
  remainingAfter: Money | null;
  /** 差額の扱いと支払後の残り, as a sentence. */
  text: string | null;
  /** Why the server will refuse it (a fee above 1,100 yen). */
  problem: string | null;
}

/**
 * 差額の扱い (25 §4.2, §7.2): above the rest the difference is the transfer fee (up to 1,100 yen),
 * below it the payment is partial; the rest after the payment, said before sending.
 */
export function paymentOutcome(amount: Money | null, remaining: Money): PaymentOutcome {
  if (amount === null || amount <= 0n) {
    return { applied: null, fee: 0n, remainingAfter: null, text: null, problem: null };
  }
  const split = splitPayablePayment(amount, remaining);
  if (split.problem) {
    return { applied: null, fee: 0n, remainingAfter: null, text: null, problem: split.problem };
  }
  const after = `支払後の残りは ${formatYen(split.remainingAfter)} 円です`;
  const text =
    split.fee > 0n
      ? `差額 ${formatYen(split.fee)} 円は振込手数料（支払手数料）にします。${after}`
      : split.remainingAfter > 0n
        ? `一部支払です。${after}`
        : `${after}（支払済み）`;
  return {
    applied: split.applied,
    fee: split.fee,
    remainingAfter: split.remainingAfter,
    text,
    problem: null,
  };
}

/** The difference a candidate has with the rest, as the lists show it (「一致」 when none). */
export function differenceText(amount: Money, remaining: Money): string {
  if (amount === remaining) return "一致";
  if (amount > remaining) {
    const fee = amount - remaining;
    return fee <= PAYABLE_FEE_LIMIT ? `手数料 ${formatYen(fee)}` : `超過 ${formatYen(fee)}`;
  }
  return `一部 残り ${formatYen(remaining - amount)}`;
}

/** The help of 支払期日 (25 §3): the partner's terms, or how to make them the default. */
export function paymentTermsHelp(terms: PaymentTerms | null): string {
  return terms
    ? `支払条件: ${describePaymentTerms(terms)}`
    : "支払条件がないため、請求書の日付の翌月末にしています。取引先の支払条件を入れると既定になります";
}
