/**
 * A fictional book for the report tests (14-reports §13): two fiscal years, every segment,
 * Stripe sales with fees and a payout, a card and its settlement, cash sales, an invoice and its
 * receipt (a 諸口 voucher), an internal transaction, a voided entry with its reversal and the
 * corrected entry, a year-end adjustment. Nothing here is a real company, account or number.
 *
 * Hand-checked totals of the first year (2026-11-02 – 2027-03-31):
 *   revenue 370,700 / expenses 283,431 / net income 87,269
 *   bank 210,389 / cash 2,200 / Stripe 27,500 (platform 5,500 + kamakura 22,000) → 現預金 240,089
 *   創立費 165,000 → assets 405,089; card 1,650 + 未払費用 9,870 + 役員借入金 256,300 = liabilities 267,820
 *   資本金 50,000 + net income 87,269 = equity 137,269
 *   by segment: platform 5,200 / kamakura −242,066 / contract 327,580 / corporate −3,445
 *   by month: 11 −76,846 / 12 330,075 / 1 −88,440 / 2 20,350 / 3 −97,870
 */
import {
  CHART_TEMPLATE,
  STANDARD_SEGMENTS,
  TAX_CATEGORIES,
  type CalendarDate,
  type EntryKind,
  type Money,
  type Side,
  type SourceKind,
} from "@niho-finance/ledger";
import type {
  ReportAccount,
  ReportEntry,
  ReportFiscalYear,
  ReportLine,
  ReportSource,
  ReportSubAccount,
  ReportWallet,
} from "../../src";

export const FY1: ReportFiscalYear = {
  id: "fy1",
  no: 1,
  startDate: "2026-11-02",
  endDate: "2027-03-31",
  lockedThrough: null,
  status: "open",
  consumptionTax: "exempt",
  accountingMethod: "tax_inclusive",
};

export const FY2: ReportFiscalYear = {
  id: "fy2",
  no: 2,
  startDate: "2027-04-01",
  endDate: "2028-03-31",
  lockedThrough: null,
  status: "open",
  consumptionTax: "exempt",
  accountingMethod: "tax_inclusive",
};

export const ACCOUNTS: ReportAccount[] = CHART_TEMPLATE.map((account) => ({
  id: `acc:${account.code}`,
  code: account.code,
  name: account.name,
  kind: account.kind,
  group: account.group,
  isCashLike: account.isCashLike,
  isActive: true,
  sortOrder: Number(account.code),
}));

export const SUB_ACCOUNTS: ReportSubAccount[] = [
  { id: "sub:bank", accountId: "acc:1100", name: "架空銀行 普通", isActive: true, sortOrder: 0 },
  { id: "sub:card", accountId: "acc:2100", name: "架空カード", isActive: true, sortOrder: 0 },
  { id: "sub:cash", accountId: "acc:1000", name: "本社", isActive: true, sortOrder: 0 },
  { id: "sub:stripe", accountId: "acc:1150", name: "platform", isActive: true, sortOrder: 0 },
  { id: "sub:stripe2", accountId: "acc:1150", name: "kamakura", isActive: true, sortOrder: 1 },
  { id: "sub:owner", accountId: "acc:2400", name: "役員立替", isActive: true, sortOrder: 0 },
  {
    id: "sub:ar-design",
    accountId: "acc:1200",
    name: "架空デザイン合同会社",
    isActive: true,
    sortOrder: 0,
  },
];

export const WALLETS: ReportWallet[] = [
  {
    id: "w:bank",
    name: "架空銀行 普通",
    kind: "bank",
    accountId: "acc:1100",
    subAccountId: "sub:bank",
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
  {
    id: "w:cash",
    name: "現金",
    kind: "cash",
    accountId: "acc:1000",
    subAccountId: "sub:cash",
    isActive: true,
  },
  {
    id: "w:stripe",
    name: "Stripe platform",
    kind: "stripe",
    accountId: "acc:1150",
    subAccountId: "sub:stripe",
    isActive: true,
  },
  {
    id: "w:stripe2",
    name: "Stripe kamakura",
    kind: "stripe",
    accountId: "acc:1150",
    subAccountId: "sub:stripe2",
    isActive: true,
  },
  {
    id: "w:owner",
    name: "役員立替",
    kind: "owner",
    accountId: "acc:2400",
    subAccountId: "sub:owner",
    isActive: true,
  },
];

interface LineSpec {
  side: Side;
  account: string;
  amount: Money;
  sub?: string;
  tax?: string;
  taxAmount?: Money;
  segment?: string;
  partner?: string;
  description?: string;
  tags?: string[];
}

interface EntrySpec {
  id: string;
  fy: ReportFiscalYear;
  no: number;
  date: CalendarDate;
  description: string;
  kind?: EntryKind;
  source?: SourceKind;
  lines: LineSpec[];
  voided?: { reason: string; replacedById: string | null };
  reversalOfId?: string;
}

function line(spec: LineSpec, lineNo: number): ReportLine {
  return {
    lineNo,
    side: spec.side,
    accountId: `acc:${spec.account}`,
    subAccountId: spec.sub ? `sub:${spec.sub}` : null,
    amount: spec.amount,
    taxCategoryCode: spec.tax ?? "na",
    taxAmount: spec.taxAmount ?? 0n,
    segmentId: spec.segment ? `seg:${spec.segment}` : null,
    partnerId: spec.partner ? `p:${spec.partner}` : null,
    description: spec.description ?? null,
    memoTagIds: (spec.tags ?? []).map((tag) => `tag:${tag}`),
  };
}

function entry(spec: EntrySpec): ReportEntry {
  return {
    id: spec.id,
    fiscalYearId: spec.fy.id,
    no: spec.no,
    entryDate: spec.date,
    description: spec.description,
    kind: spec.kind ?? "normal",
    sourceKind: spec.source ?? "manual",
    status: spec.voided ? "voided" : "posted",
    reversalOfId: spec.reversalOfId ?? null,
    replacedById: spec.voided?.replacedById ?? null,
    voidReason: spec.voided?.reason ?? null,
    lines: spec.lines.map((spec, i) => line(spec, i + 1)),
  };
}

const d = (
  side: Side,
  account: string,
  amount: Money,
  rest: Omit<LineSpec, "side" | "account" | "amount"> = {},
): LineSpec => ({ side, account, amount, ...rest });

export const ENTRIES: ReportEntry[] = [
  entry({
    id: "e1",
    fy: FY1,
    no: 1,
    date: "2026-11-02",
    description: "資本金の払込",
    kind: "opening",
    source: "system",
    lines: [d("debit", "1100", 50_000n, { sub: "bank" }), d("credit", "3000", 50_000n)],
  }),
  entry({
    id: "e2",
    fy: FY1,
    no: 2,
    date: "2026-11-02",
    description: "設立費用（役員立替）",
    kind: "opening",
    source: "system",
    lines: [
      d("debit", "1700", 150_000n, {
        tax: "purchase_out",
        description: "登録免許税",
        tags: ["founding"],
      }),
      d("debit", "1700", 15_000n, {
        tax: "purchase_exempt",
        description: "定款認証",
        tags: ["founding"],
      }),
      d("credit", "2400", 165_000n, { sub: "owner" }),
    ],
  }),
  entry({
    id: "e3",
    fy: FY1,
    no: 3,
    date: "2026-11-05",
    description: "クラウドサービス利用料",
    lines: [
      d("debit", "5320", 1_650n, {
        tax: "purchase_10",
        taxAmount: 150n,
        segment: "platform",
        partner: "cloud",
        tags: ["recurring"],
      }),
      d("credit", "2100", 1_650n, { sub: "card" }),
    ],
  }),
  entry({
    id: "e4",
    fy: FY1,
    no: 4,
    date: "2026-11-10",
    description: "事務用品（役員立替）",
    lines: [
      d("debit", "5330", 3_300n, { tax: "purchase_10", taxAmount: 300n, segment: "corporate" }),
      d("credit", "2400", 3_300n, { sub: "owner" }),
    ],
  }),
  entry({
    id: "e5",
    fy: FY1,
    no: 5,
    date: "2026-11-15",
    description: "地代家賃 11月（役員立替）",
    lines: [
      d("debit", "5300", 88_000n, {
        tax: "purchase_10",
        taxAmount: 8_000n,
        segment: "kamakura",
        partner: "realty",
      }),
      d("credit", "2400", 88_000n, { sub: "owner" }),
    ],
  }),
  entry({
    id: "e6",
    fy: FY1,
    no: 6,
    date: "2026-11-20",
    description: "月会費",
    source: "stripe",
    lines: [
      d("debit", "1150", 11_000n, { sub: "stripe2" }),
      d("credit", "4010", 11_000n, { tax: "sales_10", taxAmount: 1_000n, segment: "kamakura" }),
    ],
  }),
  entry({
    id: "e7",
    fy: FY1,
    no: 7,
    date: "2026-11-20",
    description: "Stripe 決済手数料",
    source: "stripe",
    lines: [
      d("debit", "5400", 396n, { tax: "purchase_10", taxAmount: 36n, segment: "kamakura" }),
      d("credit", "1150", 396n, { sub: "stripe2" }),
    ],
  }),
  entry({
    id: "e8",
    fy: FY1,
    no: 8,
    date: "2026-11-25",
    description: "プラットフォーム手数料",
    source: "stripe",
    lines: [
      d("debit", "1150", 5_500n, { sub: "stripe" }),
      d("credit", "4030", 5_500n, { tax: "sales_10", taxAmount: 500n, segment: "platform" }),
    ],
  }),
  entry({
    id: "e9",
    fy: FY1,
    no: 9,
    date: "2026-11-30",
    description: "Stripe からの入金",
    kind: "transfer",
    source: "wallet_txn",
    lines: [
      d("debit", "1100", 10_604n, { sub: "bank" }),
      d("credit", "1150", 10_604n, { sub: "stripe2" }),
    ],
  }),
  entry({
    id: "e10",
    fy: FY1,
    no: 10,
    date: "2026-12-01",
    description: "ドロップイン（現金）",
    lines: [
      d("debit", "1000", 2_200n, { sub: "cash", segment: "kamakura" }),
      d("credit", "4010", 2_200n, { tax: "sales_10", taxAmount: 200n, segment: "kamakura" }),
    ],
  }),
  entry({
    id: "e11",
    fy: FY1,
    no: 11,
    date: "2026-12-10",
    description: "振込手数料",
    source: "wallet_txn",
    lines: [
      d("debit", "5400", 145n, { tax: "purchase_10", taxAmount: 13n, segment: "corporate" }),
      d("credit", "1100", 145n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e12",
    fy: FY1,
    no: 12,
    date: "2026-12-15",
    description: "書籍代",
    voided: { reason: "金額の誤り", replacedById: "e14" },
    lines: [
      d("debit", "5420", 2_000n, { tax: "purchase_10", taxAmount: 181n, segment: "contract" }),
      d("credit", "1100", 2_000n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e13",
    fy: FY1,
    no: 13,
    date: "2026-12-15",
    description: "取消 No.12: 書籍代",
    kind: "reversal",
    reversalOfId: "e12",
    lines: [
      d("debit", "1100", 2_000n, { sub: "bank" }),
      d("credit", "5420", 2_000n, { tax: "purchase_10", taxAmount: 181n, segment: "contract" }),
    ],
  }),
  entry({
    id: "e14",
    fy: FY1,
    no: 14,
    date: "2026-12-15",
    description: "書籍代",
    lines: [
      d("debit", "5420", 1_980n, { tax: "purchase_10", taxAmount: 180n, segment: "contract" }),
      d("credit", "1100", 1_980n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e15",
    fy: FY1,
    no: 15,
    date: "2026-12-20",
    description: "受託開発 請求",
    source: "invoice",
    lines: [
      d("debit", "1200", 330_000n, { sub: "ar-design", partner: "design" }),
      d("credit", "4040", 330_000n, {
        tax: "sales_10",
        taxAmount: 30_000n,
        segment: "contract",
        partner: "design",
      }),
    ],
  }),
  entry({
    id: "e16",
    fy: FY1,
    no: 16,
    date: "2026-12-27",
    description: "カード引落",
    kind: "transfer",
    source: "wallet_txn",
    lines: [
      d("debit", "2100", 1_650n, { sub: "card" }),
      d("credit", "1100", 1_650n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e17",
    fy: FY1,
    no: 17,
    date: "2027-01-10",
    description: "受託開発 入金（振込手数料 先方負担分を差引）",
    source: "wallet_txn",
    lines: [
      d("debit", "1100", 329_560n, { sub: "bank" }),
      d("debit", "5400", 440n, { tax: "purchase_10", taxAmount: 40n, segment: "contract" }),
      d("credit", "1200", 330_000n, { sub: "ar-design", partner: "design" }),
    ],
  }),
  entry({
    id: "e18",
    fy: FY1,
    no: 18,
    date: "2027-01-15",
    description: "地代家賃 1月",
    source: "wallet_txn",
    lines: [
      d("debit", "5300", 88_000n, {
        tax: "purchase_10",
        taxAmount: 8_000n,
        segment: "kamakura",
        partner: "realty",
      }),
      d("credit", "1100", 88_000n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e19",
    fy: FY1,
    no: 19,
    date: "2027-01-31",
    description: "拠点のプラットフォーム利用料（内部取引）",
    lines: [
      d("debit", "9000", 3_000n, { segment: "kamakura" }),
      d("credit", "9000", 3_000n, { segment: "platform" }),
    ],
  }),
  entry({
    id: "e20",
    fy: FY1,
    no: 20,
    date: "2027-02-05",
    description: "クラウドサービス利用料",
    lines: [
      d("debit", "5320", 1_650n, {
        tax: "purchase_10",
        taxAmount: 150n,
        segment: "platform",
        partner: "cloud",
        tags: ["recurring"],
      }),
      d("credit", "2100", 1_650n, { sub: "card" }),
    ],
  }),
  entry({
    id: "e21",
    fy: FY1,
    no: 21,
    date: "2027-02-20",
    description: "月会費",
    source: "stripe",
    lines: [
      d("debit", "1150", 22_000n, { sub: "stripe2" }),
      d("credit", "4010", 22_000n, { tax: "sales_10", taxAmount: 2_000n, segment: "kamakura" }),
    ],
  }),
  entry({
    id: "e22",
    fy: FY1,
    no: 22,
    date: "2027-03-15",
    description: "地代家賃 3月",
    source: "wallet_txn",
    lines: [
      d("debit", "5300", 88_000n, {
        tax: "purchase_10",
        taxAmount: 8_000n,
        segment: "kamakura",
        partner: "realty",
      }),
      d("credit", "1100", 88_000n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e23",
    fy: FY1,
    no: 23,
    date: "2027-03-31",
    description: "水道光熱費 3月分（未払）",
    kind: "adjusting",
    lines: [
      d("debit", "5310", 9_870n, { tax: "purchase_10", taxAmount: 897n, segment: "kamakura" }),
      d("credit", "2110", 9_870n),
    ],
  }),
  entry({
    id: "e24",
    fy: FY2,
    no: 1,
    date: "2027-04-10",
    description: "ドロップイン（現金）",
    lines: [
      d("debit", "1000", 3_300n, { sub: "cash", segment: "kamakura" }),
      d("credit", "4010", 3_300n, { tax: "sales_10", taxAmount: 300n, segment: "kamakura" }),
    ],
  }),
];

export const BOOK: ReportSource = {
  company: { name: "架空商会株式会社", foundedOn: "2026-11-02" },
  fiscalYears: [FY1, FY2],
  accounts: ACCOUNTS,
  subAccounts: SUB_ACCOUNTS,
  segments: STANDARD_SEGMENTS.map((segment) => ({
    id: `seg:${segment.code}`,
    code: segment.code,
    name: segment.name,
    isActive: true,
    sortOrder: segment.sortOrder,
  })),
  partners: [
    { id: "p:cloud", name: "架空クラウド株式会社" },
    { id: "p:realty", name: "架空不動産株式会社" },
    { id: "p:design", name: "架空デザイン合同会社" },
  ],
  taxCategories: TAX_CATEGORIES.map((tax) => ({ code: tax.code, name: tax.name })),
  memoTags: [
    { id: "tag:founding", name: "設立" },
    { id: "tag:recurring", name: "定期" },
  ],
  wallets: WALLETS,
  // Deliberately out of order: the reports sort.
  entries: [...ENTRIES].reverse(),
};

export const FY1_YEAR = {
  fiscalYear: FY1,
  preset: "year",
  from: FY1.startDate,
  to: FY1.endDate,
  segmentId: null,
} as const;

export const FY1_TOTALS = {
  revenue: 370_700n,
  expenses: 283_431n,
  netIncome: 87_269n,
  bank: 210_389n,
  cash: 2_200n,
  stripePlatform: 5_500n,
  stripeKamakura: 22_000n,
  cashTotal: 240_089n,
  assets: 405_089n,
  liabilities: 267_820n,
  equity: 137_269n,
  card: 1_650n,
  owner: 256_300n,
  accrued: 9_870n,
  segments: { platform: 5_200n, kamakura: -242_066n, contract: 327_580n, corporate: -3_445n },
  months: [-76_846n, 330_075n, -88_440n, 20_350n, -97_870n],
} as const;
