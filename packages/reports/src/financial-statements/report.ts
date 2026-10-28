/**
 * 決算書 of one fiscal year (17-financial-statements §1, §3): the balance sheet, the income
 * statement, 株主資本等変動計算書, 個別注記表, 事業報告 and 附属明細書, derived from the posted
 * entries on every request. On top of the trial balance's aggregation, the year's own closing
 * entries (決算振替) are left out — the profit they move is added to 繰越利益剰余金 anyway, so the
 * statements are the same before and after the close — and the first year opens with the balance
 * sheet of 成立の日 (the opening entries on the founding date).
 */
import {
  formatYen,
  INPUT_TAX_ACCOUNT_CODE,
  OUTPUT_TAX_ACCOUNT_CODE,
  type CalendarDate,
  type FiscalYearStatus,
  type Money,
} from "@niho-finance/ledger";
import { indexSource } from "../source";
import { buildTrialBalance } from "../trial-balance";
import { buildBusinessReport, type BusinessReport } from "./business-report";
import { buildEquityStatement, equityItem, type EquityStatement } from "./equity-statement";
import { editionForFiscalYear, filingDateOf, type EtaxEdition } from "./etax/editions";
import {
  accountEtaxCodeViews,
  etaxCodeSection,
  resolveAccountEtaxCodes,
  type AccountEtaxCode,
  type AccountEtaxCodeView,
  type EtaxCodeProblem,
} from "./etax/mapping";
import { fiscalYearPeriodLabel } from "./format";
import { buildNotes, type StatementNotes } from "./notes";
import {
  buildFixedAssetSchedule,
  buildProvisionSchedule,
  buildSgaSchedule,
  type FixedAssetScheduleRow,
  type SupplementarySchedules,
} from "./schedules";
import {
  resolveStatementSettings,
  statementSettingsDefaults,
  type ResolvedStatementSettings,
  type StatementSettingsDefaults,
} from "./settings";
import {
  isFirstFiscalYear,
  netByAccount,
  previousFiscalYear,
  requireFiscalYear,
  sidesByAccount,
  yearClosingEntryIds,
  yearEntries,
  type FinancialStatementsAccount,
  type FinancialStatementsCompany,
  type FinancialStatementsFiscalYear,
  type FinancialStatementsSource,
} from "./source";
import {
  buildBalanceSheet,
  buildIncomeStatement,
  normalAmount,
  RETAINED_EARNINGS_ACCOUNT_CODE,
  type FinancialBalanceSheet,
  type FinancialIncomeStatement,
} from "./statements";

/** What a 確認 row is about; the screen links each kind to where it is fixed (17 §3 item 1). */
export type StatementIssueKind =
  /** 恒等式の不一致 (→ 試算表・監査ログ) */
  | "identity"
  /** 勘定科目コードの未設定・区分の食い違い (→ 設定 › 勘定科目) */
  | "etaxCode"
  /** 仮払消費税・仮受消費税の残高 (→ 決算整理) */
  | "taxBalance"
  /** 内部取引の残高 (→ 試算表) */
  | "internal"
  /** 純資産の想定外の動き・扱えない科目 (→ 総勘定元帳) */
  | "equity"
  /** 開始仕訳の損益の行 (→ 仕訳帳) */
  | "openingEntries"
  /** 固定資産の明細の不一致 (→ 固定資産台帳) */
  | "fixedAssets"
  /** 発行済株式数が未入力 (→ 決算書の設定) */
  | "issuedShares"
  /** 注記が雛形のまま (→ 決算書の設定) */
  | "notesTemplate"
  /** 事業報告の本文が雛形のまま (→ 決算書の設定) */
  | "businessReportTemplate";

export interface StatementIssue {
  kind: StatementIssueKind;
  message: string;
}

/** The note under the heading by the year's state (17 §1). */
export const FISCAL_YEAR_STATE_NOTES: Readonly<Record<FiscalYearStatus, string | null>> = {
  open: "期末前の数字です。決算整理と締めの後に確定します",
  closing: "決算整理の途中です",
  closed: null,
};

export const NO_ENTRIES_MESSAGE = "この期の仕訳がありません。取引から登録します";

export interface FinancialStatementsOptions {
  /** The editions to choose from (tests add a newer one). Defaults to every edition. */
  editions?: readonly EtaxEdition[];
  /** 固定資産台帳 (#14) as schedule rows; `null` / omitted until it is connected. */
  fixedAssets?: readonly FixedAssetScheduleRow[] | null;
}

export interface FinancialStatementsChecks {
  /** 資産合計 = 負債純資産合計 */
  balanceSheetBalanced: boolean;
  /** The trial balance's net income for the year (closing entries left out). */
  trialBalanceNetIncome: Money;
  netIncomeMatchesTrialBalance: boolean;
  /** 株主資本等変動計算書の純資産の当期末残高 = 貸借対照表の純資産合計 */
  equityMatchesBalanceSheet: boolean;
  /** The opening balance sheet balances (`null` when there is none). */
  openingBalanceSheetBalanced: boolean | null;
  sgaScheduleMatches: boolean;
}

export interface FinancialStatementsReport {
  company: FinancialStatementsCompany;
  fiscalYear: FinancialStatementsFiscalYear;
  previousFiscalYear: FinancialStatementsFiscalYear | null;
  /** The company's first year (期首 = 設立日): it has 開始貸借対照表. */
  isFoundingYear: boolean;
  /** 「第1期 自 2026年11月2日 至 2027年3月31日」 */
  periodLabel: string;
  /** The note under the heading, or `null` for a closed year. */
  stateNote: string | null;
  edition: EtaxEdition;
  filingDate: CalendarDate;
  /** Each account's e-Tax code (internal accounts left out). */
  codes: ReadonlyMap<string, AccountEtaxCode>;
  /** The 勘定科目コード table (17 §3 item 5). */
  codeViews: AccountEtaxCodeView[];
  balanceSheet: FinancialBalanceSheet;
  incomeStatement: FinancialIncomeStatement;
  /** 貸借対照表（成立の日）: the founding year only. */
  openingBalanceSheet: FinancialBalanceSheet | null;
  equityStatement: EquityStatement;
  settings: ResolvedStatementSettings;
  /** The defaults the settings form shows before the first save. */
  settingsDefaults: StatementSettingsDefaults;
  notes: StatementNotes;
  businessReport: BusinessReport;
  schedules: SupplementarySchedules;
  checks: FinancialStatementsChecks;
  /** 確認 (17 §3 item 1): empty when nothing needs attention. */
  issues: StatementIssue[];
  /** No entry in the year. */
  empty: boolean;
  /** The year's closing entries left out of the statements. */
  excludedClosingEntries: number;
}

function addNet(...maps: ReadonlyMap<string, Money>[]): Map<string, Money> {
  const total = new Map<string, Money>();
  for (const map of maps) {
    for (const [id, value] of map) total.set(id, (total.get(id) ?? 0n) + value);
  }
  return total;
}

function accountTag(account: FinancialStatementsAccount): string {
  return `${account.code} ${account.name}`;
}

/** The latest 発行済株式の総数 saved for an earlier year. */
function earlierIssuedShares(
  source: FinancialStatementsSource,
  fiscalYear: FinancialStatementsFiscalYear,
): number | null {
  const earlier = source.fiscalYears
    .filter((year) => year.no < fiscalYear.no)
    .sort((a, b) => b.no - a.no);
  for (const year of earlier) {
    const shares = year.statementSettings?.issuedShares ?? null;
    if (shares !== null) return shares;
  }
  return null;
}

const CODE_PROBLEM_MESSAGES: Readonly<Record<EtaxCodeProblem, string>> = {
  default_missing: "勘定科目コードが決まっていない科目があります（区分の独自科目として出します）",
  default_section:
    "標準の勘定科目コードが科目の区分と合わない科目があります（独自科目として出します）",
  override_section:
    "個別に設定した勘定科目コードが科目の区分と合わない科目があります（独自科目として出します）",
  override_unusable:
    "個別に設定した勘定科目コードがこの期のコード表で使えない科目があります（標準のコードで出します）",
};

export function buildFinancialStatements(
  source: FinancialStatementsSource,
  fiscalYearId: string,
  options: FinancialStatementsOptions = {},
): FinancialStatementsReport {
  const fiscalYear = requireFiscalYear(source, fiscalYearId);
  const edition = editionForFiscalYear(fiscalYear, options.editions);
  const index = indexSource(source);
  for (const entry of source.entries) {
    for (const line of entry.lines) {
      if (!index.accountsById.has(line.accountId)) {
        throw new Error(`reports: account ${line.accountId} is not in the source`);
      }
    }
  }
  const accounts = source.accounts;
  const codes = resolveAccountEtaxCodes(accounts, edition);
  const parts = yearEntries(source, fiscalYear);
  const isFirst = isFirstFiscalYear(source, fiscalYear);
  const isFoundingYear = isFirst && fiscalYear.startDate === source.company.foundedOn;
  const beforeNet = netByAccount(parts.before);
  const yearNet = netByAccount(parts.year);
  const endNet = addNet(beforeNet, yearNet);
  const openingNet = netByAccount(parts.opening);

  let priorProfit: Money = 0n;
  for (const account of accounts) {
    if (account.kind === "revenue" || account.kind === "expense") {
      priorProfit -= beforeNet.get(account.id) ?? 0n;
    }
  }

  const incomeStatement = buildIncomeStatement({
    edition,
    from: fiscalYear.startDate,
    to: fiscalYear.endDate,
    accounts,
    codes,
    net: yearNet,
  });
  const netIncome = incomeStatement.netIncome;
  const balanceSheet = buildBalanceSheet({
    edition,
    asOf: fiscalYear.endDate,
    accounts,
    codes,
    net: endNet,
    profit: priorProfit + netIncome,
  });
  const openingBalanceSheet = isFoundingYear
    ? buildBalanceSheet({
        edition,
        asOf: fiscalYear.startDate,
        accounts,
        codes,
        net: openingNet,
        profit: 0n,
      })
    : null;

  // 株主資本等変動計算書 (17 §4.3).
  const issues: StatementIssue[] = [];
  const startNet = isFirst ? openingNet : beforeNet;
  const movements = sidesByAccount(isFirst ? parts.during : parts.year);
  const movementOf = (id: string) => movements.get(id) ?? { debit: 0n, credit: 0n };
  let capitalOpening: Money = 0n;
  let capitalIssued: Money = 0n;
  let reserveOpening: Money = 0n;
  let reserveIssued: Money = 0n;
  let carriedOpening: Money = isFirst ? 0n : priorProfit;
  let dividends: Money = 0n;
  let otherCredits: Money = 0n;
  const unsupported: FinancialStatementsAccount[] = [];
  for (const account of accounts) {
    if (account.kind !== "equity") continue;
    const code = codes.get(account.id);
    const opening = normalAmount(account, startNet.get(account.id) ?? 0n);
    const { debit, credit } = movementOf(account.id);
    if (account.code === RETAINED_EARNINGS_ACCOUNT_CODE) {
      carriedOpening += opening;
      dividends -= debit;
      otherCredits += credit;
    } else if (
      code &&
      !code.branch &&
      etaxCodeSection(code.code) === edition.layout.capitalSection
    ) {
      capitalOpening += opening;
      capitalIssued += credit - debit;
    } else if (code && !code.branch && code.code === edition.layout.capitalReserveCode) {
      reserveOpening += opening;
      reserveIssued += credit - debit;
    } else if (opening !== 0n || debit !== 0n || credit !== 0n) {
      unsupported.push(account);
    }
  }
  const equityStatement = buildEquityStatement(edition, {
    capital: equityItem(capitalOpening, { issuance: capitalIssued }),
    capitalReserve: equityItem(reserveOpening, { issuance: reserveIssued }),
    carriedForward: equityItem(carriedOpening, {
      dividends,
      netIncome,
      other: otherCredits,
    }),
  });

  // 決算書の設定 with its defaults.
  const hasDeferredAssets = accounts.some(
    (account) =>
      account.group === "deferred_assets" &&
      ((endNet.get(account.id) ?? 0n) !== 0n || (yearNet.get(account.id) ?? 0n) !== 0n),
  );
  const settingsDefaults = statementSettingsDefaults({
    accountingMethod: fiscalYear.accountingMethod,
    hasDeferredAssets,
    previousIssuedShares: earlierIssuedShares(source, fiscalYear),
    sales: incomeStatement.sales,
    netIncome,
  });
  const settings = resolveStatementSettings(fiscalYear.statementSettings, settingsDefaults);
  const notes = buildNotes(edition, settings);
  const businessReport = buildBusinessReport({
    company: source.company,
    fiscalYear,
    segments: source.segments,
    settings,
  });
  const sgaOnStatement =
    incomeStatement.lines.find((line) => line.code === edition.layout.keyTotals.sga)?.amount ??
    incomeStatement.groupTotals.sga;
  const schedules: SupplementarySchedules = {
    fixedAssets: buildFixedAssetSchedule(options.fixedAssets ?? null),
    provisions: buildProvisionSchedule({
      edition,
      accounts,
      codes,
      openingNet: startNet,
      entries: isFirst ? parts.during : parts.year,
    }),
    sga: buildSgaSchedule(accounts, yearNet, sgaOnStatement),
  };

  // 恒等式 (17 §1): against the trial balance of the year without its closing entries.
  const closingIds = yearClosingEntryIds(source, fiscalYear);
  const trialBalance = buildTrialBalance(
    { ...source, entries: source.entries.filter((entry) => !closingIds.has(entry.id)) },
    {
      fiscalYear,
      preset: "year",
      from: fiscalYear.startDate,
      to: fiscalYear.endDate,
      segmentId: null,
    },
  );
  const trialBalanceNetIncome = trialBalance.incomeStatement.netIncome;
  const checks: FinancialStatementsChecks = {
    balanceSheetBalanced: balanceSheet.assets === balanceSheet.liabilitiesAndNetAssets,
    trialBalanceNetIncome,
    netIncomeMatchesTrialBalance: trialBalanceNetIncome === netIncome,
    equityMatchesBalanceSheet: equityStatement.netAssetsTotal.closing === balanceSheet.netAssets,
    openingBalanceSheetBalanced: openingBalanceSheet
      ? openingBalanceSheet.assets === openingBalanceSheet.liabilitiesAndNetAssets
      : null,
    sgaScheduleMatches: schedules.sga.matchesIncomeStatement,
  };
  if (!checks.balanceSheetBalanced) {
    issues.push({
      kind: "identity",
      message: `資産合計と負債純資産合計が ${formatYen(balanceSheet.assets - balanceSheet.liabilitiesAndNetAssets)} 円合いません。監査ログを確かめてください`,
    });
  }
  if (trialBalance.balanceSheet.totals.assets.balance !== balanceSheet.assets) {
    issues.push({
      kind: "identity",
      message: "貸借対照表の資産合計が試算表と合いません。監査ログを確かめてください",
    });
  }
  if (!checks.netIncomeMatchesTrialBalance) {
    issues.push({
      kind: "identity",
      message: `損益計算書の当期純利益が試算表と ${formatYen(netIncome - trialBalanceNetIncome)} 円合いません。監査ログを確かめてください`,
    });
  }
  if (!checks.equityMatchesBalanceSheet) {
    issues.push({
      kind: "identity",
      message: `株主資本等変動計算書の純資産の当期末残高が貸借対照表と ${formatYen(equityStatement.netAssetsTotal.closing - balanceSheet.netAssets)} 円合いません`,
    });
  }
  if (checks.openingBalanceSheetBalanced === false && openingBalanceSheet) {
    issues.push({
      kind: "identity",
      message: `開始貸借対照表の資産合計と負債純資産合計が ${formatYen(openingBalanceSheet.assets - openingBalanceSheet.liabilitiesAndNetAssets)} 円合いません`,
    });
  }
  if (!checks.sgaScheduleMatches) {
    issues.push({
      kind: "identity",
      message: "販売費及び一般管理費の明細の合計が損益計算書と合いません",
    });
  }

  // 勘定科目コード of the accounts on this year's statements.
  const used = new Set<string>();
  for (const line of [...balanceSheet.lines, ...incomeStatement.lines]) {
    for (const id of line.accountIds) used.add(id);
  }
  const byProblem = new Map<EtaxCodeProblem, string[]>();
  for (const account of accounts) {
    const code = codes.get(account.id);
    if (!code?.problem || !used.has(account.id)) continue;
    const list = byProblem.get(code.problem) ?? [];
    list.push(accountTag(account));
    byProblem.set(code.problem, list);
  }
  for (const [problem, list] of byProblem) {
    issues.push({
      kind: "etaxCode",
      message: `${CODE_PROBLEM_MESSAGES[problem]}: ${list.join("、")}`,
    });
  }

  if (fiscalYear.accountingMethod === "tax_exclusive") {
    const taxBalances = accounts.filter(
      (account) =>
        (account.code === INPUT_TAX_ACCOUNT_CODE || account.code === OUTPUT_TAX_ACCOUNT_CODE) &&
        (endNet.get(account.id) ?? 0n) !== 0n,
    );
    if (taxBalances.length > 0) {
      issues.push({
        kind: "taxBalance",
        message: `${taxBalances.map((account) => account.name).join("・")}の残高が残っています。消費税の精算を決算整理で登録します`,
      });
    }
  }
  let internal: Money = 0n;
  for (const account of accounts) {
    if (account.kind === "internal") internal += endNet.get(account.id) ?? 0n;
  }
  if (internal !== 0n) {
    issues.push({
      kind: "internal",
      message: `内部取引の残高が ${formatYen(internal)} 円あります。内部取引の仕訳を確かめてください`,
    });
  }
  if (otherCredits !== 0n) {
    issues.push({
      kind: "equity",
      message: `繰越利益剰余金に決算振替以外の貸方の動きが ${formatYen(otherCredits)} 円あります。仕訳を確かめてください`,
    });
  }
  if (unsupported.length > 0) {
    issues.push({
      kind: "equity",
      message: `株主資本等変動計算書に出せない純資産の科目があります: ${unsupported.map(accountTag).join("、")}`,
    });
  }
  const openingProfitLines = parts.opening.some((entry) =>
    entry.lines.some((line) => {
      const kind = index.accountsById.get(line.accountId)?.kind;
      return kind === "revenue" || kind === "expense";
    }),
  );
  if (openingProfitLines) {
    issues.push({
      kind: "openingEntries",
      message:
        "設立日の開始仕訳に損益の科目があります。開始貸借対照表には入れず、期中の損益として扱います",
    });
  }
  if (schedules.fixedAssets.inconsistentRows.length > 0) {
    issues.push({
      kind: "fixedAssets",
      message: `固定資産の明細の金額が合いません: ${schedules.fixedAssets.inconsistentRows.join("、")}`,
    });
  }
  if (settings.issuedShares === null) {
    issues.push({
      kind: "issuedShares",
      message: "発行済株式の総数が未入力です。決算書の設定で入力します",
    });
  }
  if (settings.notesFromTemplate) {
    issues.push({
      kind: "notesTemplate",
      message: "注記が雛形のままです。会社の実態に合わせて決算書の設定で直します",
    });
  }
  if (settings.businessReportFromTemplate) {
    issues.push({
      kind: "businessReportTemplate",
      message: "事業報告の本文が雛形のままです。決算書の設定で直します",
    });
  }

  const branchCodes = new Map([...balanceSheet.branchCodes, ...incomeStatement.branchCodes]);
  return {
    company: source.company,
    fiscalYear,
    previousFiscalYear: previousFiscalYear(source, fiscalYear),
    isFoundingYear,
    periodLabel: fiscalYearPeriodLabel(fiscalYear),
    stateNote: FISCAL_YEAR_STATE_NOTES[fiscalYear.status],
    edition,
    filingDate: filingDateOf(fiscalYear),
    codes,
    codeViews: accountEtaxCodeViews(accounts, edition, branchCodes),
    balanceSheet,
    incomeStatement,
    openingBalanceSheet,
    equityStatement,
    settings,
    settingsDefaults,
    notes,
    businessReport,
    schedules,
    checks,
    issues,
    empty: parts.year.length === 0,
    excludedClosingEntries: parts.excludedClosing,
  };
}
