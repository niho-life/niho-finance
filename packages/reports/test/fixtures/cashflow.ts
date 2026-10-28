/**
 * A fictional book for the cash-flow forecast (21-cashflow §8): two cash-like wallets (a bank and
 * Stripe) and a card, a few posted entries before and after the start, nine recurring items and
 * three deadlines. Nothing here is a real company, account or number.
 *
 * Start 2026-12-01 (a Tuesday), end 2027-03-01 (90 days later).
 *
 * The book through the start (= the opening):
 *   bank   1,000,000 (No.1 capital) − 110,000 (No.4 rent) + 30,000 (No.5, on the start day) = 920,000
 *   Stripe 55,000 (No.2 sales)
 *   → 現預金 975,000. The card owes 33,000 (No.3).
 */
import type { CalendarDate, Money, Side } from "@niho-finance/ledger";
import type {
  CashflowDeadline,
  CashflowInputs,
  CashflowRecurringItem,
  ReportEntry,
  ReportLine,
  ReportSource,
  ReportWallet,
} from "../../src";
import { ACCOUNTS, BOOK, FY1, FY2 } from "./book";

export const CF_START: CalendarDate = "2026-12-01";
export const CF_END: CalendarDate = "2027-03-01";

export const CF_WALLETS: ReportWallet[] = [
  {
    id: "w:bank",
    name: "架空銀行 普通",
    kind: "bank",
    accountId: "acc:1100",
    subAccountId: "sub:bank",
    isActive: true,
  },
  {
    id: "w:stripe",
    name: "Stripe 架空",
    kind: "stripe",
    accountId: "acc:1150",
    subAccountId: "sub:stripe",
    isActive: true,
  },
  {
    id: "w:card",
    name: "架空カード",
    kind: "card",
    accountId: "acc:2100",
    subAccountId: "sub:card",
    isActive: true,
  },
];

type LineSpec = [side: Side, account: string, amount: Money, sub?: string];

export function cfEntry(
  id: string,
  no: number,
  date: CalendarDate,
  description: string,
  lines: LineSpec[],
  extra: Partial<Pick<ReportEntry, "status" | "reversalOfId" | "kind" | "voidReason">> = {},
): ReportEntry {
  return {
    id,
    fiscalYearId: FY1.id,
    no,
    entryDate: date,
    description,
    kind: extra.kind ?? "normal",
    sourceKind: "manual",
    status: extra.status ?? "posted",
    reversalOfId: extra.reversalOfId ?? null,
    replacedById: null,
    voidReason: extra.voidReason ?? null,
    lines: lines.map(([side, account, amount, sub], i): ReportLine => ({
      lineNo: i + 1,
      side,
      accountId: `acc:${account}`,
      subAccountId: sub ? `sub:${sub}` : null,
      amount,
      taxCategoryCode: "na",
      taxAmount: 0n,
      segmentId: null,
      partnerId: null,
      description: null,
      memoTagIds: [],
    })),
  };
}

export const CF_ENTRIES: ReportEntry[] = [
  cfEntry("cf1", 1, "2026-11-02", "資本金の払込", [
    ["debit", "1100", 1_000_000n, "bank"],
    ["credit", "3000", 1_000_000n],
  ]),
  cfEntry("cf2", 2, "2026-11-15", "Stripe の売上", [
    ["debit", "1150", 55_000n, "stripe"],
    ["credit", "4030", 55_000n],
  ]),
  cfEntry("cf3", 3, "2026-11-25", "クラウドの利用料（カード）", [
    ["debit", "5320", 33_000n],
    ["credit", "2100", 33_000n, "card"],
  ]),
  cfEntry("cf4", 4, "2026-11-30", "11 月分の家賃", [
    ["debit", "5300", 110_000n],
    ["credit", "1100", 110_000n, "bank"],
  ]),
  // On the start day: in the opening, not a row.
  cfEntry("cf5", 5, "2026-12-01", "受託の着手金", [
    ["debit", "1100", 30_000n, "bank"],
    ["credit", "4040", 30_000n],
  ]),
  // After the start: a row on its day.
  cfEntry("cf6", 6, "2026-12-18", "PC の購入", [
    ["debit", "1510", 165_000n],
    ["credit", "1100", 165_000n, "bank"],
  ]),
  // Cash moves inside 現預金 only: no row.
  cfEntry("cf7", 7, "2027-01-05", "Stripe の入金", [
    ["debit", "1100", 50_000n, "bank"],
    ["credit", "1150", 50_000n, "stripe"],
  ]),
  // A voided entry and its reversal on the same day: no rows.
  cfEntry(
    "cf8",
    8,
    "2027-01-20",
    "誤登録",
    [
      ["debit", "5490", 5_000n],
      ["credit", "1100", 5_000n, "bank"],
    ],
    { status: "voided", voidReason: "二重登録" },
  ),
  cfEntry(
    "cf9",
    9,
    "2027-01-20",
    "取消: 誤登録",
    [
      ["debit", "1100", 5_000n, "bank"],
      ["credit", "5490", 5_000n],
    ],
    { kind: "reversal", reversalOfId: "cf8" },
  ),
  // After the end: not in the forecast.
  cfEntry("cf10", 10, "2027-03-05", "受託の残金", [
    ["debit", "1100", 70_000n, "bank"],
    ["credit", "4040", 70_000n],
  ]),
];

export const CF_BOOK: ReportSource = {
  ...BOOK,
  fiscalYears: [FY1, FY2],
  accounts: ACCOUNTS,
  subAccounts: [
    { id: "sub:bank", accountId: "acc:1100", name: "架空銀行 普通", isActive: true, sortOrder: 0 },
    { id: "sub:stripe", accountId: "acc:1150", name: "架空", isActive: true, sortOrder: 0 },
    { id: "sub:card", accountId: "acc:2100", name: "架空カード", isActive: true, sortOrder: 0 },
  ],
  wallets: CF_WALLETS,
  entries: [...CF_ENTRIES].reverse(),
};

function item(
  id: string,
  name: string,
  rest: Partial<CashflowRecurringItem> &
    Pick<CashflowRecurringItem, "amount" | "dayOfMonth" | "accountId" | "startDate">,
): CashflowRecurringItem {
  return {
    id,
    name,
    frequency: "monthly",
    monthOfYear: null,
    endDate: null,
    walletId: "w:bank",
    isActive: true,
    ...rest,
  };
}

export const CF_RECURRING: CashflowRecurringItem[] = [
  // 末日: 12/31, 1/31, 2/28.
  item("r:rent", "家賃", {
    amount: -110_000n,
    dayOfMonth: 31,
    accountId: "acc:5300",
    startDate: "2026-11-30",
  }),
  // Starts on its first occurrence: 12/25, 1/25, 2/25.
  item("r:salary", "役員報酬", {
    amount: -300_000n,
    dayOfMonth: 25,
    accountId: "acc:5200",
    startDate: "2026-12-25",
  }),
  // Paid by card: the card's debt grows, 現預金 does not move.
  item("r:gcp", "GCP", {
    amount: -3_300n,
    dayOfMonth: 5,
    walletId: "w:card",
    accountId: "acc:5320",
    startDate: "2026-11-05",
  }),
  // The card's withdrawal from the bank, ending on 1/10: 12/10 and 1/10 (not 2/10).
  item("r:card", "カードの引落し", {
    amount: -40_000n,
    dayOfMonth: 10,
    accountId: "acc:2100",
    startDate: "2026-12-10",
    endDate: "2027-01-10",
  }),
  // Stripe → bank: inside 現預金.
  item("r:payout", "Stripe の入金", {
    amount: 50_000n,
    dayOfMonth: 1,
    accountId: "acc:1150",
    startDate: "2026-11-01",
  }),
  // On the 1st: 12/1 is the start day (not counted), 1/1, 2/1 and 3/1 (the last day) are.
  item("r:maintenance", "保守の売上", {
    amount: 200_000n,
    dayOfMonth: 1,
    accountId: "acc:4040",
    startDate: "2026-10-01",
  }),
  // Yearly on 2/29: 2/28 in a common year.
  item("r:insurance", "保険料（年払い）", {
    frequency: "yearly",
    monthOfYear: 2,
    amount: -60_000n,
    dayOfMonth: 29,
    accountId: "acc:5450",
    startDate: "2026-11-01",
  }),
  // Inactive: never counted.
  item("r:old-rent", "旧オフィスの家賃", {
    amount: -80_000n,
    dayOfMonth: 15,
    accountId: "acc:5300",
    startDate: "2026-11-01",
    isActive: false,
  }),
  // Starts on 1/20 with day 15: 1/15 is before the start, the first is 2/15.
  item("r:advisor", "顧問料", {
    amount: -33_000n,
    dayOfMonth: 15,
    accountId: "acc:5410",
    startDate: "2027-01-20",
  }),
];

export const CF_DEADLINES: CashflowDeadline[] = [
  { date: "2027-01-10", title: "源泉所得税の納付", amount: 45_000n },
  { date: "2027-01-31", title: "社会保険料の納付", amount: 90_000n },
  { date: "2027-02-28", title: "法人税等の中間申告・納付", amount: null },
];

export const CF_INPUTS: CashflowInputs = {
  recurring: CF_RECURRING,
  deadlines: CF_DEADLINES,
  receivables: null,
  payables: null,
};

/**
 * Hand-computed rows (date, kind, label, amount, balance after the row), from 975,000:
 *   12/10 カードの引落し      −40,000 →   935,000
 *   12/18 No.6 PC の購入     −165,000 →   770,000
 *   12/25 役員報酬           −300,000 →   470,000
 *   12/31 家賃（末日）        −110,000 →   360,000
 *    1/01 保守の売上          +200,000 →   560,000   (1/05 Stripe の入金 No.7: no row)
 *    1/10 カードの引落し       −40,000 →   520,000   (定期取引 before 納付 on the same day)
 *    1/10 源泉所得税の納付     −45,000 →   475,000
 *    1/25 役員報酬           −300,000 →   175,000   (1/20 voided No.8 + reversal No.9: no rows)
 *    1/31 家賃               −110,000 →    65,000
 *    1/31 社会保険料の納付     −90,000 →   −25,000   ← first day below 0
 *    2/01 保守の売上          +200,000 →   175,000
 *    2/15 顧問料              −33,000 →   142,000
 *    2/25 役員報酬           −300,000 →  −158,000
 *    2/28 家賃（末日）        −110,000 →  −268,000
 *    2/28 保険料（年払い）     −60,000 →  −328,000   ← lowest
 *    2/28 法人税等の中間申告・納付 金額未定 (a mark)
 *    3/01 保守の売上          +200,000 →  −128,000   ← 90 日後
 */
export const CF_EXPECTED_ROWS: [CalendarDate, string, string, Money | null, Money | null][] = [
  ["2026-12-10", "recurring", "カードの引落し", -40_000n, 935_000n],
  ["2026-12-18", "entry", "PC の購入", -165_000n, 770_000n],
  ["2026-12-25", "recurring", "役員報酬", -300_000n, 470_000n],
  ["2026-12-31", "recurring", "家賃", -110_000n, 360_000n],
  ["2027-01-01", "recurring", "保守の売上", 200_000n, 560_000n],
  ["2027-01-10", "recurring", "カードの引落し", -40_000n, 520_000n],
  ["2027-01-10", "deadline", "源泉所得税の納付", -45_000n, 475_000n],
  ["2027-01-25", "recurring", "役員報酬", -300_000n, 175_000n],
  ["2027-01-31", "recurring", "家賃", -110_000n, 65_000n],
  ["2027-01-31", "deadline", "社会保険料の納付", -90_000n, -25_000n],
  ["2027-02-01", "recurring", "保守の売上", 200_000n, 175_000n],
  ["2027-02-15", "recurring", "顧問料", -33_000n, 142_000n],
  ["2027-02-25", "recurring", "役員報酬", -300_000n, -158_000n],
  ["2027-02-28", "recurring", "家賃", -110_000n, -268_000n],
  ["2027-02-28", "recurring", "保険料（年払い）", -60_000n, -328_000n],
  ["2027-02-28", "deadline", "法人税等の中間申告・納付", null, null],
  ["2027-03-01", "recurring", "保守の売上", 200_000n, -128_000n],
];

/**
 * The line as steps: [day index from the start, balance from that day on]. Day indexes:
 * 12/10 = 9, 12/18 = 17, 12/25 = 24, 12/31 = 30, 1/01 = 31, 1/10 = 40, 1/25 = 55, 1/31 = 61,
 * 2/01 = 62, 2/15 = 76, 2/25 = 86, 2/28 = 89, 3/01 = 90.
 */
export const CF_EXPECTED_STEPS: [day: number, balance: Money][] = [
  [0, 975_000n],
  [9, 935_000n],
  [17, 770_000n],
  [24, 470_000n],
  [30, 360_000n],
  [31, 560_000n],
  [40, 475_000n],
  [55, 175_000n],
  [61, -25_000n],
  [62, 175_000n],
  [76, 142_000n],
  [86, -158_000n],
  [89, -328_000n],
  [90, -128_000n],
];

/** The 91 daily balances of the steps. */
export function expandSteps(steps: readonly [number, Money][], days: number): Money[] {
  const balances: Money[] = [];
  let current = steps[0]?.[1] ?? 0n;
  for (let day = 0; day <= days; day += 1) {
    const step = steps.find(([at]) => at === day);
    if (step) current = step[1];
    balances.push(current);
  }
  return balances;
}
