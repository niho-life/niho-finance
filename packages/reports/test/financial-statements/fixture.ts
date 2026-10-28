/**
 * A fictional company for the statements tests (17-financial-statements §11): 第 1 期 from the founding
 * date (exempt, tax-inclusive) and 第 2 期 (general, tax-exclusive). Nothing here is a real company,
 * person, address or number.
 *
 * Hand-checked figures:
 *   第 1 期 (2026-11-02 – 2027-03-31)
 *     revenue 33,012 (会費 33,000 + 受取利息 12) / 販管費 42,796 / 創立費償却 33,000 / 法人税等 29,100
 *     net income △71,884
 *     assets 537,716 = 普通預金 73,216 + 工具器具備品 330,000 − 減価償却累計額 27,500 + 創立費 132,000
 *       + 開業費 30,000; liabilities 559,600 (未払金 5,500 + 未払法人税等 29,100 + 役員借入金 525,000)
 *     net assets △21,884 (資本金 50,000 + 繰越利益剰余金 △71,884)
 *     成立の日: 普通預金 50,000 + 創立費 165,000 = 役員借入金 165,000 + 資本金 50,000
 *   第 2 期 (2027-04-01 – 2028-03-31, tax-exclusive)
 *     売上高 509,000 / 受取利息 15 / 販管費 158,420 / 創立費償却 33,000 / 法人税等 70,000
 *     net income 247,595; assets 750,434; liabilities 524,723; net assets 225,711
 *     消費税: 課税売上 509,000 (tax 50,900), 課税仕入 90,360 (tax 9,037) + 経過措置 2,060 (tax 140)
 */
import {
  CHART_TEMPLATE,
  STANDARD_SEGMENTS,
  STANDARD_TAX_RATE_RULES,
  TAX_CATEGORIES,
  type CalendarDate,
  type EntryKind,
  type Money,
  type Side,
  type SourceKind,
} from "@niho-finance/ledger";
import {
  DEFAULT_DEPRECIATION_POLICY,
  DEFAULT_REVENUE_RECOGNITION_POLICY,
  type FinancialStatementsAccount,
  type FinancialStatementsFiscalYear,
  type FinancialStatementsSource,
  type FinancialStatementsSubAccount,
  type ReportEntry,
  type ReportLine,
  type StatementSettings,
} from "../../src";

export const FY1_SETTINGS: StatementSettings = {
  issuedShares: 10000,
  shareholdersMeetingOn: "2027-05-28",
  announcementPublishedOn: "2027-06-01",
  announcementUrl: "https://example.com/koukoku/",
  notes: {
    depreciation: DEFAULT_DEPRECIATION_POLICY,
    revenueRecognition: DEFAULT_REVENUE_RECOGNITION_POLICY,
    otherSignificant:
      "消費税等の会計処理は、税込方式によっています。\n創立費及び開業費は、5年間で均等額を償却しています。",
    accountingPolicyChanges: null,
    presentationChanges: null,
    errorCorrections: null,
    otherNotes: [
      { title: "重要な後発事象", body: "該当事項はありません。" },
      {
        title: "関連当事者との取引",
        body: "代表取締役からの借入金があります。\n利息は付けていません。",
      },
    ],
  },
  businessReport: {
    progress: "当事業年度は会社の設立と開業の準備を進めました。",
    issues: "会員の獲得と拠点の稼働率の向上です。",
    otherMatters: "特記すべき事項はありません。",
  },
  simplifiedTaxClass: 5,
};

export const FY1: FinancialStatementsFiscalYear = {
  id: "fy1",
  no: 1,
  startDate: "2026-11-02",
  endDate: "2027-03-31",
  lockedThrough: null,
  status: "closed",
  consumptionTax: "exempt",
  accountingMethod: "tax_inclusive",
  statementSettings: FY1_SETTINGS,
};

export const FY2: FinancialStatementsFiscalYear = {
  id: "fy2",
  no: 2,
  startDate: "2027-04-01",
  endDate: "2028-03-31",
  lockedThrough: null,
  status: "open",
  consumptionTax: "general",
  accountingMethod: "tax_exclusive",
  statementSettings: null,
};

export const ACCOUNTS: FinancialStatementsAccount[] = CHART_TEMPLATE.map((account) => ({
  id: `acc:${account.code}`,
  code: account.code,
  name: account.name,
  kind: account.kind,
  group: account.group,
  isCashLike: account.isCashLike,
  isActive: true,
  sortOrder: Number(account.code),
  eTaxCode: null,
}));

export const SUB_ACCOUNTS: FinancialStatementsSubAccount[] = [
  {
    id: "sub:bank",
    accountId: "acc:1100",
    name: "架空銀行 普通",
    isActive: true,
    sortOrder: 0,
    partnerId: null,
  },
  {
    id: "sub:stripe",
    accountId: "acc:1150",
    name: "架空ストライプ",
    isActive: true,
    sortOrder: 0,
    partnerId: null,
  },
  {
    id: "sub:card",
    accountId: "acc:2100",
    name: "架空カード",
    isActive: true,
    sortOrder: 0,
    partnerId: "p:card",
  },
  {
    id: "sub:owner",
    accountId: "acc:2400",
    name: "役員立替",
    isActive: true,
    sortOrder: 0,
    partnerId: "p:owner",
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
}

interface EntrySpec {
  id: string;
  fy: FinancialStatementsFiscalYear;
  no: number;
  date: CalendarDate;
  description: string;
  kind?: EntryKind;
  source?: SourceKind;
  lines: LineSpec[];
  voided?: { reason: string; replacedById: string | null };
  reversalOfId?: string;
}

const PROFIT_AND_LOSS = /^[4589]/;

function line(spec: LineSpec, lineNo: number): ReportLine {
  return {
    lineNo,
    side: spec.side,
    accountId: `acc:${spec.account}`,
    subAccountId: spec.sub ? `sub:${spec.sub}` : null,
    amount: spec.amount,
    taxCategoryCode: spec.tax ?? "na",
    taxAmount: spec.taxAmount ?? 0n,
    segmentId: spec.segment
      ? `seg:${spec.segment}`
      : PROFIT_AND_LOSS.test(spec.account)
        ? "seg:corporate"
        : null,
    partnerId: spec.partner ? `p:${spec.partner}` : null,
    description: spec.description ?? null,
    memoTagIds: [],
  };
}

export function entry(spec: EntrySpec): ReportEntry {
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
    lines: spec.lines.map((lineSpec, i) => line(lineSpec, i + 1)),
  };
}

const d = (
  side: Side,
  account: string,
  amount: Money,
  rest: Omit<LineSpec, "side" | "account" | "amount"> = {},
): LineSpec => ({ side, account, amount, ...rest });

export const FY1_ENTRIES: ReportEntry[] = [
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
      d("debit", "1700", 150_000n, { tax: "purchase_out", description: "登録免許税" }),
      d("debit", "1700", 15_000n, { tax: "purchase_exempt", description: "定款認証" }),
      d("credit", "2400", 165_000n, { sub: "owner" }),
    ],
  }),
  entry({
    id: "e3",
    fy: FY1,
    no: 3,
    date: "2026-12-01",
    description: "開業費（役員立替）",
    kind: "opening",
    lines: [d("debit", "1710", 30_000n), d("credit", "2400", 30_000n, { sub: "owner" })],
  }),
  entry({
    id: "e4",
    fy: FY1,
    no: 4,
    date: "2026-12-10",
    description: "月会費",
    source: "stripe",
    lines: [
      d("debit", "1150", 11_000n, { sub: "stripe" }),
      d("credit", "4010", 11_000n, { tax: "sales_10", taxAmount: 1_000n, segment: "kamakura" }),
    ],
  }),
  entry({
    id: "e5",
    fy: FY1,
    no: 5,
    date: "2026-12-10",
    description: "Stripe 決済手数料",
    source: "stripe",
    lines: [
      d("debit", "5400", 396n, { tax: "purchase_10", taxAmount: 36n, segment: "kamakura" }),
      d("credit", "1150", 396n, { sub: "stripe" }),
    ],
  }),
  entry({
    id: "e6",
    fy: FY1,
    no: 6,
    date: "2026-12-20",
    description: "預金利息",
    source: "wallet_txn",
    lines: [
      d("debit", "1100", 12n, { sub: "bank" }),
      d("credit", "4500", 12n, { tax: "sales_exempt" }),
    ],
  }),
  entry({
    id: "e7",
    fy: FY1,
    no: 7,
    date: "2027-01-05",
    description: "クラウドサービス利用料",
    lines: [
      d("debit", "5320", 3_300n, { tax: "purchase_10", taxAmount: 300n, partner: "cloud" }),
      d("credit", "2100", 3_300n, { sub: "card" }),
    ],
  }),
  entry({
    id: "e8",
    fy: FY1,
    no: 8,
    date: "2027-01-10",
    description: "海外 SaaS 利用料（登録番号なし）",
    lines: [
      d("debit", "5325", 2_200n, { tax: "purchase_10_ni", taxAmount: 200n }),
      d("credit", "2100", 2_200n, { sub: "card" }),
    ],
  }),
  entry({
    id: "e9",
    fy: FY1,
    no: 9,
    date: "2027-01-15",
    description: "保険料",
    source: "wallet_txn",
    lines: [
      d("debit", "5450", 5_000n, { tax: "purchase_exempt" }),
      d("credit", "1100", 5_000n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e10",
    fy: FY1,
    no: 10,
    date: "2027-01-20",
    description: "PC の購入（役員立替）",
    lines: [
      d("debit", "1510", 330_000n, { tax: "purchase_10", taxAmount: 30_000n }),
      d("credit", "2400", 330_000n, { sub: "owner" }),
    ],
  }),
  entry({
    id: "e11",
    fy: FY1,
    no: 11,
    date: "2027-02-01",
    description: "事務用品",
    voided: { reason: "金額の誤り", replacedById: "e13" },
    lines: [
      d("debit", "5330", 5_500n, { tax: "purchase_10", taxAmount: 500n }),
      d("credit", "1100", 5_500n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e12",
    fy: FY1,
    no: 12,
    date: "2027-02-01",
    description: "取消 No.11: 事務用品",
    kind: "reversal",
    reversalOfId: "e11",
    lines: [
      d("debit", "1100", 5_500n, { sub: "bank" }),
      d("credit", "5330", 5_500n, { tax: "purchase_10", taxAmount: 500n }),
    ],
  }),
  entry({
    id: "e13",
    fy: FY1,
    no: 13,
    date: "2027-02-01",
    description: "事務用品",
    lines: [
      d("debit", "5330", 4_400n, { tax: "purchase_10", taxAmount: 400n }),
      d("credit", "1100", 4_400n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "e14",
    fy: FY1,
    no: 14,
    date: "2027-02-10",
    description: "拠点のプラットフォーム利用料（内部取引）",
    lines: [
      d("debit", "9000", 3_000n, { segment: "kamakura" }),
      d("credit", "9000", 3_000n, { segment: "platform" }),
    ],
  }),
  entry({
    id: "e15",
    fy: FY1,
    no: 15,
    date: "2027-02-20",
    description: "月会費",
    source: "stripe",
    lines: [
      d("debit", "1150", 22_000n, { sub: "stripe" }),
      d("credit", "4010", 22_000n, { tax: "sales_10", taxAmount: 2_000n, segment: "kamakura" }),
    ],
  }),
  entry({
    id: "e16",
    fy: FY1,
    no: 16,
    date: "2027-02-28",
    description: "Stripe からの入金",
    kind: "transfer",
    source: "wallet_txn",
    lines: [
      d("debit", "1100", 32_604n, { sub: "bank" }),
      d("credit", "1150", 32_604n, { sub: "stripe" }),
    ],
  }),
  entry({
    id: "e17",
    fy: FY1,
    no: 17,
    date: "2027-03-31",
    description: "減価償却費",
    kind: "adjusting",
    source: "fixed_asset",
    lines: [d("debit", "5460", 27_500n), d("credit", "1590", 27_500n)],
  }),
  entry({
    id: "e18",
    fy: FY1,
    no: 18,
    date: "2027-03-31",
    description: "創立費の償却",
    kind: "adjusting",
    lines: [d("debit", "5470", 33_000n), d("credit", "1700", 33_000n)],
  }),
  entry({
    id: "e19",
    fy: FY1,
    no: 19,
    date: "2027-03-31",
    description: "法人税等の計上",
    kind: "adjusting",
    lines: [d("debit", "8000", 29_100n), d("credit", "2120", 29_100n)],
  }),
];

/** 決算振替 of 第 1 期 (revenue / expenses → 繰越利益剰余金), as #14 makes it at the close. */
export const FY1_CLOSING: ReportEntry = entry({
  id: "e20",
  fy: FY1,
  no: 20,
  date: "2027-03-31",
  description: "決算振替",
  kind: "closing",
  source: "system",
  lines: [
    d("debit", "4010", 33_000n),
    d("debit", "4500", 12n),
    d("debit", "3200", 71_884n),
    d("credit", "5320", 3_300n),
    d("credit", "5325", 2_200n),
    d("credit", "5330", 4_400n),
    d("credit", "5400", 396n),
    d("credit", "5450", 5_000n),
    d("credit", "5460", 27_500n),
    d("credit", "5470", 33_000n),
    d("credit", "8000", 29_100n),
  ],
});

export const FY2_ENTRIES: ReportEntry[] = [
  entry({
    id: "f1",
    fy: FY2,
    no: 1,
    date: "2027-04-10",
    description: "月会費",
    source: "stripe",
    lines: [
      d("debit", "1150", 11_000n, { sub: "stripe" }),
      d("credit", "4010", 10_000n, { tax: "sales_10", taxAmount: 1_000n, segment: "kamakura" }),
      d("credit", "2310", 1_000n),
    ],
  }),
  entry({
    id: "f2",
    fy: FY2,
    no: 2,
    date: "2027-04-10",
    description: "Stripe 決済手数料",
    source: "stripe",
    lines: [
      d("debit", "5400", 360n, { tax: "purchase_10", taxAmount: 36n, segment: "kamakura" }),
      d("debit", "1400", 36n),
      d("credit", "1150", 396n, { sub: "stripe" }),
    ],
  }),
  entry({
    id: "f3",
    fy: FY2,
    no: 3,
    date: "2027-04-25",
    description: "地代家賃 4月（役員立替）",
    lines: [
      d("debit", "5300", 80_000n, {
        tax: "purchase_10",
        taxAmount: 8_000n,
        segment: "kamakura",
        partner: "realty",
      }),
      d("debit", "1400", 8_000n),
      d("credit", "2400", 88_000n, { sub: "owner" }),
    ],
  }),
  // A voucher: two taxable rows and one 仮払消費税 row written by hand (1 円 more than the rows' tax).
  entry({
    id: "f4",
    fy: FY2,
    no: 4,
    date: "2027-05-10",
    description: "事務用品と回線工事",
    lines: [
      d("debit", "5330", 3_000n, { tax: "purchase_10", taxAmount: 300n }),
      d("debit", "5320", 7_000n, { tax: "purchase_10", taxAmount: 700n }),
      d("debit", "1400", 1_001n),
      d("credit", "2100", 11_001n, { sub: "card" }),
    ],
  }),
  entry({
    id: "f5",
    fy: FY2,
    no: 5,
    date: "2027-05-31",
    description: "法人税等の納付",
    source: "wallet_txn",
    lines: [d("debit", "2120", 29_100n), d("credit", "1100", 29_100n, { sub: "bank" })],
  }),
  entry({
    id: "f6",
    fy: FY2,
    no: 6,
    date: "2027-06-15",
    description: "海外 SaaS 利用料（登録番号なし）",
    lines: [
      d("debit", "5325", 2_060n, { tax: "purchase_10_ni", taxAmount: 200n }),
      d("debit", "1400", 140n),
      d("credit", "2100", 2_200n, { sub: "card" }),
    ],
  }),
  entry({
    id: "f7",
    fy: FY2,
    no: 7,
    date: "2027-07-01",
    description: "預金利息",
    source: "wallet_txn",
    lines: [
      d("debit", "1100", 15n, { sub: "bank" }),
      d("credit", "4500", 15n, { tax: "sales_exempt" }),
    ],
  }),
  entry({
    id: "f8",
    fy: FY2,
    no: 8,
    date: "2027-08-01",
    description: "月会費の返金",
    source: "stripe",
    lines: [
      d("debit", "4010", 1_000n, { tax: "sales_10", taxAmount: 100n, segment: "kamakura" }),
      d("debit", "2310", 100n),
      d("credit", "1150", 1_100n, { sub: "stripe" }),
    ],
  }),
  entry({
    id: "f9",
    fy: FY2,
    no: 9,
    date: "2027-09-01",
    description: "年会費",
    source: "stripe",
    lines: [
      d("debit", "1150", 550_000n, { sub: "stripe" }),
      d("credit", "4010", 500_000n, { tax: "sales_10", taxAmount: 50_000n, segment: "kamakura" }),
      d("credit", "2310", 50_000n),
    ],
  }),
  entry({
    id: "f10",
    fy: FY2,
    no: 10,
    date: "2027-09-30",
    description: "Stripe からの入金",
    kind: "transfer",
    source: "wallet_txn",
    lines: [
      d("debit", "1100", 559_504n, { sub: "bank" }),
      d("credit", "1150", 559_504n, { sub: "stripe" }),
    ],
  }),
  entry({
    id: "f11",
    fy: FY2,
    no: 11,
    date: "2027-10-27",
    description: "カード引落",
    kind: "transfer",
    source: "wallet_txn",
    lines: [
      d("debit", "2100", 18_701n, { sub: "card" }),
      d("credit", "1100", 18_701n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "f12",
    fy: FY2,
    no: 12,
    date: "2027-11-01",
    description: "役員への返済",
    lines: [
      d("debit", "2400", 200_000n, { sub: "owner" }),
      d("credit", "1100", 200_000n, { sub: "bank" }),
    ],
  }),
  entry({
    id: "f13",
    fy: FY2,
    no: 13,
    date: "2028-03-31",
    description: "減価償却費",
    kind: "adjusting",
    source: "fixed_asset",
    lines: [d("debit", "5460", 66_000n), d("credit", "1590", 66_000n)],
  }),
  entry({
    id: "f14",
    fy: FY2,
    no: 14,
    date: "2028-03-31",
    description: "創立費の償却",
    kind: "adjusting",
    lines: [d("debit", "5470", 33_000n), d("credit", "1700", 33_000n)],
  }),
  // The year-end settlement: 2310 / 1400 without taxable lines (left out of the tax summary).
  entry({
    id: "f15",
    fy: FY2,
    no: 15,
    date: "2028-03-31",
    description: "消費税の精算",
    kind: "adjusting",
    lines: [d("debit", "2310", 50_900n), d("credit", "1400", 9_177n), d("credit", "2130", 41_723n)],
  }),
  entry({
    id: "f16",
    fy: FY2,
    no: 16,
    date: "2028-03-31",
    description: "法人税等の計上",
    kind: "adjusting",
    lines: [d("debit", "8000", 70_000n), d("credit", "2120", 70_000n)],
  }),
];

export const COMPANY = {
  name: "架空商事株式会社",
  foundedOn: "2026-11-02",
  address: "神奈川県架空市四丁目4番4号",
  representative: "架空 太郎",
  invoiceRegisteredOn: "2027-04-01",
} as const satisfies FinancialStatementsSource["company"];

export const BOOK: FinancialStatementsSource = {
  company: COMPANY,
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
    { id: "p:card", name: "架空カード株式会社", address: "東京都架空区一丁目1番1号" },
    { id: "p:owner", name: "架空 太郎", address: "神奈川県架空市二丁目2番2号" },
    { id: "p:realty", name: "架空不動産株式会社", address: "神奈川県架空市三丁目3番3号" },
    { id: "p:cloud", name: "架空クラウド株式会社", address: null },
  ],
  taxCategories: TAX_CATEGORIES.map((tax) => ({ code: tax.code, name: tax.name })),
  memoTags: [],
  wallets: [],
  // Deliberately out of order: the reports sort.
  entries: [...FY1_ENTRIES, ...FY2_ENTRIES].reverse(),
  taxRules: STANDARD_TAX_RATE_RULES,
};

/** The same book after 第 1 期 was closed (its 決算振替 added). */
export const CLOSED_BOOK: FinancialStatementsSource = {
  ...BOOK,
  entries: [...BOOK.entries, FY1_CLOSING],
};

export function withSource(
  changes: Partial<FinancialStatementsSource>,
  base: FinancialStatementsSource = BOOK,
): FinancialStatementsSource {
  return { ...base, ...changes };
}

export const FY1_TOTALS = {
  revenue: 33_012n,
  sales: 33_000n,
  sga: 42_796n,
  netIncome: -71_884n,
  assets: 537_716n,
  liabilities: 559_600n,
  netAssets: -21_884n,
  bank: 73_216n,
  card: 5_500n,
  owner: 525_000n,
  openingAssets: 215_000n,
  openingLiabilities: 165_000n,
  openingNetAssets: 50_000n,
} as const;

export const FY2_TOTALS = {
  sales: 509_000n,
  sga: 158_420n,
  netIncome: 247_595n,
  assets: 750_434n,
  liabilities: 524_723n,
  netAssets: 225_711n,
  bank: 384_934n,
  owner: 413_000n,
  rent: 80_000n,
} as const;
