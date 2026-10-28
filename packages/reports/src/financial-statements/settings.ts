/**
 * 決算書の設定 (17-financial-statements §3.1): saved per fiscal year (`FiscalYear.statementSettings`)
 * and changing only the words and dates of the statements, never the numbers. A text left `null` has
 * never been saved and takes its 雛形 (§4.4, §4.6); the 確認 reports it as 「雛形のまま」. An empty
 * string is a deliberate blank: the item is left out.
 */
import {
  formatYen,
  isCalendarDate,
  type AccountingMethod,
  type CalendarDate,
} from "@niho-finance/ledger";

export const SIMPLIFIED_TAX_CLASSES = [1, 2, 3, 4, 5, 6] as const;
/** 簡易課税の事業区分 (第 1 種〜第 6 種). */
export type SimplifiedTaxClass = (typeof SIMPLIFIED_TAX_CLASSES)[number];

export const SIMPLIFIED_TAX_CLASS_LABELS: Readonly<Record<SimplifiedTaxClass, string>> = {
  1: "第1種（卸売業）",
  2: "第2種（小売業等）",
  3: "第3種（製造業等）",
  4: "第4種（その他の事業）",
  5: "第5種（サービス業等）",
  6: "第6種（不動産業）",
};

/** みなし仕入率 (percent) by 事業区分. */
export const DEEMED_PURCHASE_PERCENT: Readonly<Record<SimplifiedTaxClass, number>> = {
  1: 90,
  2: 80,
  3: 70,
  4: 60,
  5: 50,
  6: 40,
};

export const DEFAULT_SIMPLIFIED_TAX_CLASS: SimplifiedTaxClass = 5;

/** Texts are stored up to this many characters (17 §11). */
export const STATEMENT_TEXT_MAX_LENGTH = 2000;
export const STATEMENT_OTHER_NOTES_MAX = 20;

export interface StatementNote {
  /** 項目名 */
  title: string;
  /** 内容 */
  body: string;
}

export interface StatementNotesSettings {
  /** 固定資産の減価償却の方法 */
  depreciation: string | null;
  /** 収益及び費用の計上基準 */
  revenueRecognition: string | null;
  /** その他計算書類の作成のための基本となる重要な事項 */
  otherSignificant: string | null;
  /** 会計処理の原則又は手続の変更 (empty: not shown) */
  accountingPolicyChanges: string | null;
  /** 表示方法の変更 (empty: not shown) */
  presentationChanges: string | null;
  /** 誤謬の訂正 (shown under その他の注記) */
  errorCorrections: string | null;
  /** その他の注記, one item each. */
  otherNotes: readonly StatementNote[];
}

export interface BusinessReportSettings {
  /** 事業の経過及びその成果 */
  progress: string | null;
  /** 対処すべき課題 */
  issues: string | null;
  /** その他の重要な事項 */
  otherMatters: string | null;
}

export interface StatementSettings {
  /** 発行済株式の総数 (株) */
  issuedShares: number | null;
  /** 株主総会の日 (計算書類の承認) */
  shareholdersMeetingOn: CalendarDate | null;
  /** 決算公告の掲載日 */
  announcementPublishedOn: CalendarDate | null;
  /** 決算公告の URL (shown on the screen only, never in the HTML). */
  announcementUrl: string | null;
  notes: StatementNotesSettings;
  businessReport: BusinessReportSettings;
  /** 簡易課税の事業区分 (`null` = 第 5 種). */
  simplifiedTaxClass: SimplifiedTaxClass | null;
}

export const EMPTY_STATEMENT_SETTINGS: StatementSettings = {
  issuedShares: null,
  shareholdersMeetingOn: null,
  announcementPublishedOn: null,
  announcementUrl: null,
  notes: {
    depreciation: null,
    revenueRecognition: null,
    otherSignificant: null,
    accountingPolicyChanges: null,
    presentationChanges: null,
    errorCorrections: null,
    otherNotes: [],
  },
  businessReport: { progress: null, issues: null, otherMatters: null },
  simplifiedTaxClass: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.length > STATEMENT_TEXT_MAX_LENGTH
    ? normalized.slice(0, STATEMENT_TEXT_MAX_LENGTH)
    : normalized;
}

function date(value: unknown): CalendarDate | null {
  return isCalendarDate(value) ? value : null;
}

function shares(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function taxClass(value: unknown): SimplifiedTaxClass | null {
  const number = typeof value === "string" ? Number(value) : value;
  return (SIMPLIFIED_TAX_CLASSES as readonly unknown[]).includes(number)
    ? (number as SimplifiedTaxClass)
    : null;
}

function otherNotes(value: unknown): StatementNote[] {
  if (!Array.isArray(value)) return [];
  const notes: StatementNote[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const title = text(item.title)?.trim() ?? "";
    const body = text(item.body) ?? "";
    if (title === "" && body.trim() === "") continue;
    notes.push({ title, body });
    if (notes.length >= STATEMENT_OTHER_NOTES_MAX) break;
  }
  return notes;
}

/**
 * Reads stored settings of any shape without throwing: unknown or malformed fields become `null`
 * (the default). The db layer validates the input with zod before saving; this guards the reads.
 */
export function normalizeStatementSettings(value: unknown): StatementSettings {
  if (!isRecord(value)) return EMPTY_STATEMENT_SETTINGS;
  const notes = isRecord(value.notes) ? value.notes : {};
  const report = isRecord(value.businessReport) ? value.businessReport : {};
  const url = text(value.announcementUrl)?.trim() ?? "";
  return {
    issuedShares: shares(value.issuedShares),
    shareholdersMeetingOn: date(value.shareholdersMeetingOn),
    announcementPublishedOn: date(value.announcementPublishedOn),
    announcementUrl: url === "" ? null : url,
    notes: {
      depreciation: text(notes.depreciation),
      revenueRecognition: text(notes.revenueRecognition),
      otherSignificant: text(notes.otherSignificant),
      accountingPolicyChanges: text(notes.accountingPolicyChanges),
      presentationChanges: text(notes.presentationChanges),
      errorCorrections: text(notes.errorCorrections),
      otherNotes: otherNotes(notes.otherNotes),
    },
    businessReport: {
      progress: text(report.progress),
      issues: text(report.issues),
      otherMatters: text(report.otherMatters),
    },
    simplifiedTaxClass: taxClass(value.simplifiedTaxClass),
  };
}

// ---------------------------------------------------------------------------
// 雛形 (17 §4.4, §4.6)
// ---------------------------------------------------------------------------

/** 重要な会計方針に係る事項に関する注記の冒頭の 1 文. */
export const ACCOUNTING_STANDARD_SENTENCE =
  "この計算書類は、『中小企業の会計に関する基本要領』によって作成しています。";

export const DEFAULT_DEPRECIATION_POLICY =
  "有形固定資産は定率法（ただし、平成28年4月1日以後に取得した建物附属設備は定額法）、無形固定資産（自社利用のソフトウェア）は社内における利用可能期間（5年）に基づく定額法によっています。";

export const DEFAULT_REVENUE_RECOGNITION_POLICY =
  "会費・利用料は決済日に、受託開発は検収の日に収益を計上しています。";

export const DEFERRED_ASSETS_POLICY = "創立費及び開業費は、5年間で均等額を償却しています。";

/** 対処すべき課題 and その他の重要な事項 until written. */
export const BUSINESS_REPORT_PLACEHOLDER = "（記入する）";

export function consumptionTaxPolicy(accountingMethod: AccountingMethod): string {
  return accountingMethod === "tax_exclusive"
    ? "消費税等の会計処理は、税抜方式によっています。"
    : "消費税等の会計処理は、税込方式によっています。";
}

/** 事業の経過及びその成果: the year's figures in a sentence. */
export function businessProgressSentence(sales: bigint, netIncome: bigint): string {
  const result =
    netIncome < 0n
      ? `当期純損失は${formatYen(-netIncome)}円`
      : `当期純利益は${formatYen(netIncome)}円`;
  return `当事業年度の売上高は${formatYen(sales)}円、${result}となりました。`;
}

/** What the defaults depend on (the fiscal year and its figures). */
export interface StatementSettingsContext {
  accountingMethod: AccountingMethod;
  /** 繰延資産の残高か期中の動きがある. */
  hasDeferredAssets: boolean;
  /** The latest 発行済株式の総数 of an earlier year (`null` in the first year). */
  previousIssuedShares: number | null;
  /** 売上高 of the income statement. */
  sales: bigint;
  netIncome: bigint;
}

/** The defaults of every item: what the form shows before the first save. */
export interface StatementSettingsDefaults {
  issuedShares: number | null;
  notes: {
    depreciation: string;
    revenueRecognition: string;
    otherSignificant: string;
  };
  businessReport: { progress: string; issues: string; otherMatters: string };
  simplifiedTaxClass: SimplifiedTaxClass;
}

export function statementSettingsDefaults(
  context: StatementSettingsContext,
): StatementSettingsDefaults {
  const otherSignificant = [consumptionTaxPolicy(context.accountingMethod)];
  if (context.hasDeferredAssets) otherSignificant.push(DEFERRED_ASSETS_POLICY);
  return {
    issuedShares: context.previousIssuedShares,
    notes: {
      depreciation: DEFAULT_DEPRECIATION_POLICY,
      revenueRecognition: DEFAULT_REVENUE_RECOGNITION_POLICY,
      otherSignificant: otherSignificant.join("\n"),
    },
    businessReport: {
      progress: businessProgressSentence(context.sales, context.netIncome),
      issues: BUSINESS_REPORT_PLACEHOLDER,
      otherMatters: BUSINESS_REPORT_PLACEHOLDER,
    },
    simplifiedTaxClass: DEFAULT_SIMPLIFIED_TAX_CLASS,
  };
}

/** The settings with the defaults filled in, and which texts are still the 雛形. */
export interface ResolvedStatementSettings {
  issuedShares: number | null;
  /** `issuedShares` came from an earlier year (not saved for this one). */
  issuedSharesFromEarlierYear: boolean;
  shareholdersMeetingOn: CalendarDate | null;
  announcementPublishedOn: CalendarDate | null;
  announcementUrl: string | null;
  notes: {
    depreciation: string;
    revenueRecognition: string;
    otherSignificant: string;
    accountingPolicyChanges: string;
    presentationChanges: string;
    errorCorrections: string;
    otherNotes: readonly StatementNote[];
  };
  businessReport: { progress: string; issues: string; otherMatters: string };
  simplifiedTaxClass: SimplifiedTaxClass;
  /** Notes never saved (固定資産の減価償却の方法 / 収益及び費用の計上基準 / その他の重要な事項). */
  notesFromTemplate: boolean;
  /** Business report texts never saved. */
  businessReportFromTemplate: boolean;
}

export function resolveStatementSettings(
  stored: StatementSettings | null,
  defaults: StatementSettingsDefaults,
): ResolvedStatementSettings {
  const settings = stored ?? EMPTY_STATEMENT_SETTINGS;
  const { notes, businessReport } = settings;
  return {
    issuedShares: settings.issuedShares ?? defaults.issuedShares,
    issuedSharesFromEarlierYear: settings.issuedShares === null && defaults.issuedShares !== null,
    shareholdersMeetingOn: settings.shareholdersMeetingOn,
    announcementPublishedOn: settings.announcementPublishedOn,
    announcementUrl: settings.announcementUrl,
    notes: {
      depreciation: notes.depreciation ?? defaults.notes.depreciation,
      revenueRecognition: notes.revenueRecognition ?? defaults.notes.revenueRecognition,
      otherSignificant: notes.otherSignificant ?? defaults.notes.otherSignificant,
      accountingPolicyChanges: notes.accountingPolicyChanges ?? "",
      presentationChanges: notes.presentationChanges ?? "",
      errorCorrections: notes.errorCorrections ?? "",
      otherNotes: notes.otherNotes,
    },
    businessReport: {
      progress: businessReport.progress ?? defaults.businessReport.progress,
      issues: businessReport.issues ?? defaults.businessReport.issues,
      otherMatters: businessReport.otherMatters ?? defaults.businessReport.otherMatters,
    },
    simplifiedTaxClass: settings.simplifiedTaxClass ?? defaults.simplifiedTaxClass,
    notesFromTemplate:
      notes.depreciation === null ||
      notes.revenueRecognition === null ||
      notes.otherSignificant === null,
    businessReportFromTemplate:
      businessReport.progress === null ||
      businessReport.issues === null ||
      businessReport.otherMatters === null,
  };
}

/** 掲載期限: 株主総会の日の 5 年後の日 (会社法 440 条 3 項・940 条 1 項 2 号). */
export function announcementDeadline(
  shareholdersMeetingOn: CalendarDate | null,
): CalendarDate | null {
  if (!shareholdersMeetingOn) return null;
  const [year, rest] = [shareholdersMeetingOn.slice(0, 4), shareholdersMeetingOn.slice(4)];
  const shifted = `${String(Number(year) + 5).padStart(4, "0")}${rest}`;
  // 2/29 → 2/28 when the fifth year is not a leap year.
  return isCalendarDate(shifted)
    ? shifted
    : (`${String(Number(year) + 5).padStart(4, "0")}-02-28` as CalendarDate);
}
