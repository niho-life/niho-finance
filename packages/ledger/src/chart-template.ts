import type { TaxCategoryCode } from "./tax-categories";
import type { AccountGroup, AccountKind } from "./types";

export const SEGMENT_CODES = ["platform", "kamakura", "contract", "corporate"] as const;
/** ① platform ② kamakura (site) ③ contract (受託) and corporate (共通). */
export type SegmentCode = (typeof SEGMENT_CODES)[number];

export interface SegmentDefinition {
  code: SegmentCode;
  name: string;
  sortOrder: number;
}

export const STANDARD_SEGMENTS: readonly SegmentDefinition[] = [
  { code: "platform", name: "プラットフォーム", sortOrder: 10 },
  { code: "kamakura", name: "鎌倉", sortOrder: 20 },
  { code: "contract", name: "受託", sortOrder: 30 },
  { code: "corporate", name: "共通", sortOrder: 90 },
];

export interface ChartTemplateAccount {
  /** 4 digits: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx/8xxx expenses, 9xxx internal. */
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
  /** Initial value for forms and statement suggestions (`na` when out of scope). */
  defaultTaxCategoryCode: TaxCategoryCode;
  /** Counted in the cash report (cash, deposits, Stripe balance). */
  isCashLike: boolean;
  /** Hint for the segment of new lines on this account. */
  defaultSegmentCode?: SegmentCode;
  note?: string;
}

type Row = readonly [
  code: string,
  name: string,
  group: AccountGroup,
  defaultTaxCategoryCode: TaxCategoryCode,
  options?: { isCashLike?: boolean; defaultSegmentCode?: SegmentCode; note?: string },
];

function rows(kind: AccountKind, list: readonly Row[]): ChartTemplateAccount[] {
  return list.map(([code, name, group, defaultTaxCategoryCode, options]) => ({
    code,
    name,
    kind,
    group,
    defaultTaxCategoryCode,
    isCashLike: options?.isCashLike ?? false,
    ...(options?.defaultSegmentCode ? { defaultSegmentCode: options.defaultSegmentCode } : {}),
    ...(options?.note ? { note: options.note } : {}),
  }));
}

const ASSETS: readonly Row[] = [
  ["1000", "現金", "current_assets", "na", { isCashLike: true, note: "拠点ごとに補助科目" }],
  ["1100", "普通預金", "current_assets", "na", { isCashLike: true, note: "口座ごとに補助科目" }],
  [
    "1150",
    "Stripe 残高",
    "current_assets",
    "na",
    { isCashLike: true, note: "Stripe の未入金残高。アカウントごとに補助科目" },
  ],
  ["1200", "売掛金", "current_assets", "na", { note: "請求書（受託）。取引先ごとに補助科目" }],
  ["1250", "未収入金", "current_assets", "na"],
  ["1300", "前払費用", "current_assets", "na", { note: "年払いのサブスク・保険" }],
  ["1310", "前払金", "current_assets", "na"],
  ["1350", "立替金", "current_assets", "na"],
  ["1360", "仮払金", "current_assets", "na", { note: "内容不明の出金の一時置き" }],
  ["1400", "仮払消費税", "current_assets", "na", { note: "税抜経理の期だけ" }],
  ["1500", "建物附属設備", "fixed_assets", "purchase_10", { note: "拠点の内装" }],
  ["1510", "工具器具備品", "fixed_assets", "purchase_10", { note: "PC・什器" }],
  ["1520", "ソフトウェア", "fixed_assets", "purchase_10"],
  ["1590", "減価償却累計額", "fixed_assets", "na", { note: "間接法。決算書では控除表示" }],
  ["1600", "敷金・保証金", "fixed_assets", "na"],
  ["1700", "創立費", "deferred_assets", "na", { note: "設立の登録免許税・定款認証など" }],
  ["1710", "開業費", "deferred_assets", "na", { note: "設立後〜開業までの費用" }],
  ["1800", "長期前払費用", "fixed_assets", "na"],
];

const LIABILITIES: readonly Row[] = [
  ["2000", "買掛金", "current_liabilities", "na"],
  ["2100", "未払金", "current_liabilities", "na", { note: "カードごとに補助科目" }],
  ["2110", "未払費用", "current_liabilities", "na", { note: "決算整理" }],
  ["2120", "未払法人税等", "current_liabilities", "na"],
  ["2130", "未払消費税等", "current_liabilities", "na", { note: "課税事業者の期" }],
  ["2200", "前受金", "current_liabilities", "na", { note: "期をまたぐ会費・受託の前受" }],
  ["2300", "預り金", "current_liabilities", "na", { note: "源泉所得税・社会保険の本人負担" }],
  ["2310", "仮受消費税", "current_liabilities", "na", { note: "税抜経理の期だけ" }],
  [
    "2400",
    "役員借入金",
    "current_liabilities",
    "na",
    { note: "役員の立替・貸付。口座「役員立替」に紐づく" },
  ],
  ["2500", "短期借入金", "current_liabilities", "na"],
  ["2600", "長期借入金", "fixed_liabilities", "na"],
];

const EQUITY: readonly Row[] = [
  ["3000", "資本金", "shareholders_equity", "na"],
  ["3100", "資本準備金", "shareholders_equity", "na"],
  ["3200", "繰越利益剰余金", "shareholders_equity", "na", { note: "決算振替で当期純利益を加える" }],
];

const REVENUE: readonly Row[] = [
  [
    "4010",
    "売上高 会費",
    "sales",
    "sales_10",
    { defaultSegmentCode: "kamakura", note: "月会費・ドロップイン" },
  ],
  ["4020", "売上高 体験・イベント", "sales", "sales_10", { defaultSegmentCode: "kamakura" }],
  [
    "4030",
    "売上高 プラットフォーム",
    "sales",
    "sales_10",
    { defaultSegmentCode: "platform", note: "手数料・利用料" },
  ],
  [
    "4040",
    "売上高 受託開発",
    "sales",
    "sales_10",
    { defaultSegmentCode: "contract", note: "請求書" },
  ],
  ["4090", "売上高 その他", "sales", "sales_10"],
  [
    "4500",
    "受取利息",
    "non_operating_income",
    "sales_exempt",
    { defaultSegmentCode: "corporate", note: "預金利息（非課税）" },
  ],
  [
    "4510",
    "雑収入",
    "non_operating_income",
    "sales_out",
    { defaultSegmentCode: "corporate", note: "補助金・還付加算金など（内容で税区分を変える）" },
  ],
];

const EXPENSES: readonly Row[] = [
  ["5100", "外注費", "sga", "purchase_10", { note: "法人への外注。個人の業務委託は 5110" }],
  ["5110", "業務委託費", "sga", "purchase_10", { note: "個人への報酬は源泉徴収の対象になりうる" }],
  ["5200", "役員報酬", "sga", "na"],
  ["5210", "給料手当", "sga", "na"],
  ["5220", "法定福利費", "sga", "na", { note: "社会保険の会社負担" }],
  ["5230", "福利厚生費", "sga", "purchase_10"],
  ["5300", "地代家賃", "sga", "purchase_10", { note: "居住用は非課税（purchase_exempt）" }],
  ["5310", "水道光熱費", "sga", "purchase_10"],
  ["5320", "通信費", "sga", "purchase_10", { note: "回線・クラウド・SaaS" }],
  [
    "5325",
    "ソフトウェア利用料",
    "sga",
    "purchase_10",
    { note: "海外 SaaS でインボイスなしなら purchase_10_ni" },
  ],
  ["5330", "消耗品費", "sga", "purchase_10", { note: "10 万円未満の備品" }],
  ["5340", "修繕費", "sga", "purchase_10"],
  ["5350", "広告宣伝費", "sga", "purchase_10"],
  ["5360", "旅費交通費", "sga", "purchase_10", { note: "公共交通はインボイス不要の特例あり" }],
  ["5370", "会議費", "sga", "purchase_10", { note: "飲食は軽減税率の可能性（purchase_8r）" }],
  ["5380", "交際費", "sga", "purchase_10"],
  ["5400", "支払手数料", "sga", "purchase_10", { note: "振込手数料・Stripe の決済手数料" }],
  ["5410", "支払報酬料", "sga", "purchase_10", { note: "税理士・司法書士（源泉徴収あり）" }],
  ["5420", "新聞図書費", "sga", "purchase_10", { note: "書籍は 10%（軽減の対象外）" }],
  ["5430", "諸会費", "sga", "purchase_out", { note: "内容で変わる" }],
  ["5440", "租税公課", "sga", "na", { note: "印紙・登録免許税・均等割は不課税" }],
  ["5450", "保険料", "sga", "purchase_exempt"],
  ["5460", "減価償却費", "sga", "na"],
  ["5470", "創立費償却", "non_operating_expenses", "na"],
  ["5480", "開業費償却", "non_operating_expenses", "na"],
  ["5490", "雑費", "sga", "purchase_10"],
  ["5500", "支払利息", "non_operating_expenses", "purchase_exempt"],
  ["5600", "雑損失", "non_operating_expenses", "na"],
  ["8000", "法人税、住民税及び事業税", "income_taxes", "na"],
];

const INTERNAL: readonly Row[] = [
  [
    "9000",
    "内部取引",
    "internal",
    "na",
    { note: "セグメント間の手数料など。会社全体で常に 0。決算書に出さない" },
  ],
];

/** Standard chart of accounts (02-accounting-rules §2), ordered by code. */
export const CHART_TEMPLATE: readonly ChartTemplateAccount[] = [
  ...rows("asset", ASSETS),
  ...rows("liability", LIABILITIES),
  ...rows("equity", EQUITY),
  ...rows("revenue", REVENUE),
  ...rows("expense", EXPENSES),
  ...rows("internal", INTERNAL),
];

export function findTemplateAccount(code: string): ChartTemplateAccount | undefined {
  return CHART_TEMPLATE.find((account) => account.code === code);
}
