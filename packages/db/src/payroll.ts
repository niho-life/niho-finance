/**
 * 給与 (22-payroll §5–§7): 従業員, the pay run (計算 → 確定), its payslips and the payment schedule.
 *
 * - The calculation, the journal lines, the deadlines and the scheduled amounts are pure functions
 *   of `@niho-finance/payroll`; this layer reads the master data, looks the accounts up by code and
 *   posts through the same path as 取引 (fiscal-year lock, `buildVoucherEntry`, the ledger rules,
 *   `postJournalEntryInTransaction` with `sourceKind = payroll`).
 * - Employee master data (標準報酬月額, coverage, tax column, dependents, birth date, kind) is read
 *   from the database at preview and at confirmation; the client only sends the month's amounts.
 * - A confirmed run is append-only (DB trigger). Scheduled amounts are derived from the confirmed
 *   runs, never stored (§7.2).
 */
import {
  addDays,
  buildVoucherEntry,
  CORPORATE_SEGMENT_CODE,
  dateParts,
  displayDate,
  findTemplateAccount,
  formatYen,
  INPUT_TAX_ACCOUNT_CODE,
  lastDayOfMonth,
  LedgerValidationError,
  splitTaxInclusive,
  validateEntry,
  type AccountKind,
  type CalendarDate,
  type JournalEntryInput,
  type LedgerError,
  type Money,
  type Side,
  type TaxRateRule,
  type VoucherLineInput,
} from "@niho-finance/ledger";
import {
  buildPaymentEntry,
  buildPayrollEntries,
  calculatePayroll,
  compareYearMonths,
  coverageByAge,
  findKenpoTable,
  findPensionTable,
  findTableById,
  isTableEffective,
  parseBonusRunItems,
  parsePayrollRunItems,
  parsePayrollTableIds,
  paymentCategoryOfRuleKey,
  PAYROLL_ACCOUNT_CODES,
  PAYROLL_PAYMENT_CATEGORIES,
  PAYROLL_PAYMENT_CATEGORY_LABELS,
  PAYROLL_RULE_KEY_PREFIX,
  PAYROLL_SUB_ACCOUNTS,
  payrollInputOf,
  PayrollInputError,
  PayrollTableMissingError,
  pinnedTables,
  PREMIUM_TIMING_LABELS,
  premiumMonthFor,
  runPaymentSlots,
  scheduleAmount,
  serializePayrollRunItems,
  serializePayrollTableIds,
  summarizeBonusRun,
  summarizePayrollRun,
  tableIdsOf,
  tableRef,
  yearMonthLabel,
  yearMonthOf,
  yearMonthParts,
  type PaymentAmount,
  type PayrollCoverage,
  type PayrollEntryPlan,
  type PayrollInputIssue,
  type PayrollPaymentCategory,
  type PayrollRunItem,
  type PayrollRunItemInput,
  type PayrollRunSummary,
  type PayrollTableIds,
  type PayrollTables,
  type PremiumTiming,
  type SocialInsuranceAggregate,
  type TableRef,
  type TaxColumn,
  type WorkerKind,
  type YearMonth,
} from "@niho-finance/payroll";
import type { CalendarItem, Employee, FiscalYear, PayrollRun, Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, todayInJapan, toDbDate } from "./dates";
import { loadTaxRules, lockFiscalYearOn, type EntryRef } from "./entries";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import { toFiscalYearContext } from "./queries";
import {
  activeToggleSchema,
  employeeCreateSchema,
  employeeUpdateSchema,
  payrollPaymentSchema,
  payrollRunSchema,
  type ActiveToggleInput,
  type EmployeeCreateInput,
  type EmployeeUpdateInput,
  type ParsedEmployeeInput,
  type ParsedPayrollPayment,
  type ParsedPayrollRun,
  type PayrollPaymentInput,
  type PayrollRunInput,
} from "./schemas";
import { createSubAccount, setSubAccountActive } from "./settings";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

export interface PayrollWriteOptions extends ActorOptions {
  /** 今日 (JST) for the 標準報酬月額 check and the 定期同額給与 warning; defaults to the clock. */
  today?: CalendarDate;
}

// ---------------------------------------------------------------------------------------------
// 従業員 (§5.1・§6.2)
// ---------------------------------------------------------------------------------------------

export interface EmployeeRecord {
  id: string;
  name: string;
  kind: WorkerKind;
  birthDate: CalendarDate;
  basePay: Money;
  commuteAllowance: Money;
  socialInsured: boolean;
  insuredFrom: CalendarDate | null;
  healthSmr: Money | null;
  pensionSmr: Money | null;
  employmentInsured: boolean;
  taxColumn: "kou" | "otsu";
  dependents: number;
  residentTax: Money;
  isActive: boolean;
}

export const EMPLOYEE_WARNING_CODES = [
  "OFFICER_ZERO_PAY_INSURED",
  "OFFICER_PAID_NOT_INSURED",
  "OFFICER_PAY_CHANGED_LATE",
] as const;
export type EmployeeWarningCode = (typeof EMPLOYEE_WARNING_CODES)[number];

/** A warning shown after saving (保存は止めない, 22-payroll §6.2). */
export interface EmployeeWarning {
  code: EmployeeWarningCode;
  message: string;
}

export interface EmployeeWriteResult {
  employee: EmployeeRecord;
  warnings: EmployeeWarning[];
}

export function toEmployeeRecord(row: Employee): EmployeeRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    birthDate: fromDbDate(row.birthDate),
    basePay: row.basePay,
    commuteAllowance: row.commuteAllowance,
    socialInsured: row.socialInsured,
    insuredFrom: fromDbDateOrNull(row.insuredFrom),
    healthSmr: row.healthSmr,
    pensionSmr: row.pensionSmr,
    employmentInsured: row.employmentInsured,
    taxColumn: row.taxColumn,
    dependents: row.dependents,
    residentTax: row.residentTax,
    isActive: row.isActive,
  };
}

function employeeData(data: ParsedEmployeeInput) {
  return {
    name: data.name,
    kind: data.kind,
    birthDate: toDbDate(data.birthDate),
    basePay: data.basePay,
    commuteAllowance: data.commuteAllowance,
    socialInsured: data.socialInsured,
    insuredFrom: data.insuredFrom ? toDbDate(data.insuredFrom) : null,
    healthSmr: data.healthSmr,
    pensionSmr: data.pensionSmr,
    employmentInsured: data.employmentInsured,
    taxColumn: data.taxColumn,
    dependents: data.dependents,
    residentTax: data.residentTax,
  };
}

/** 役員が先、次に追加の順。無効の従業員は後ろ. */
export function employeeOrder(a: Employee, b: Employee): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "officer" ? -1 : 1;
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);
}

/** Every employee, active ones first (the screen folds the inactive ones). */
export async function listEmployees(db: Db): Promise<EmployeeRecord[]> {
  const rows = await db.employee.findMany();
  return rows.sort(employeeOrder).map(toEmployeeRecord);
}

/**
 * The 標準報酬月額 must be a grade amount of the kenpo / pension table in force this month, when
 * such a table is registered (the run checks again against the premium month's table).
 */
function assertGradeAmounts(data: ParsedEmployeeInput, today: CalendarDate): void {
  if (!data.socialInsured) return;
  const month = yearMonthOf(today);
  const checks = [
    {
      field: "healthSmr",
      label: "健康保険",
      amount: data.healthSmr,
      grades: () => findKenpoTable(month).grades,
    },
    {
      field: "pensionSmr",
      label: "厚生年金",
      amount: data.pensionSmr,
      grades: () => findPensionTable(month).grades,
    },
  ] as const;
  for (const check of checks) {
    if (check.amount === null) continue;
    let grades: readonly { smr: Money }[];
    try {
      grades = check.grades();
    } catch (error) {
      if (error instanceof PayrollTableMissingError) continue;
      throw error;
    }
    if (!grades.some((grade) => grade.smr === check.amount)) {
      throw new SettingsError(
        `標準報酬月額（${check.label}）${formatYen(check.amount)} 円は等級表にありません。等級表の標準報酬月額を入れてください（報酬月額から求められます）`,
        { field: check.field },
      );
    }
  }
}

export function dateOf(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/**
 * 期首から 3 か月を経過する日: the day before the same day 3 months later, or the last day of that
 * month when it has no such day (民法第 143 条).
 */
export function regularPayRevisionDeadline(startDate: CalendarDate): CalendarDate {
  const { year, month, day } = dateParts(startDate);
  const index = year * 12 + (month - 1) + 3;
  const targetMonth = (index % 12) + 1;
  const targetYear = (index - (index % 12)) / 12;
  const last = lastDayOfMonth(targetYear, targetMonth);
  if (day > dateParts(last).day) return last;
  return addDays(dateOf(targetYear, targetMonth, day), -1);
}

async function employeeWarnings(
  db: Db,
  employee: EmployeeRecord,
  before: EmployeeRecord | null,
  today: CalendarDate,
): Promise<EmployeeWarning[]> {
  if (employee.kind !== "officer") return [];
  const warnings: EmployeeWarning[] = [];
  if (employee.basePay === 0n && employee.socialInsured) {
    warnings.push({
      code: "OFFICER_ZERO_PAY_INSURED",
      message:
        "役員報酬が 0 円で社会保険ありになっています。報酬のない役員は社会保険の被保険者になれません。報酬を払わないなら社会保険を「なし」にしてください",
    });
  }
  if (employee.basePay > 0n && !employee.socialInsured) {
    warnings.push({
      code: "OFFICER_PAID_NOT_INSURED",
      message:
        "役員報酬を払う役員は社会保険の強制適用です。資格取得届を出して、社会保険を「あり」にしてください",
    });
  }
  if (before?.kind === "officer" && before.basePay !== employee.basePay) {
    const day = toDbDate(today);
    const year = await db.fiscalYear.findFirst({
      where: { startDate: { lte: day }, endDate: { gte: day } },
    });
    if (year) {
      const deadline = regularPayRevisionDeadline(fromDbDate(year.startDate));
      if (today > deadline) {
        warnings.push({
          code: "OFFICER_PAY_CHANGED_LATE",
          message: `第 ${year.no} 期の期首から 3 か月（${displayDate(deadline)} まで）を過ぎて役員報酬を変えています。臨時改定事由などがなければ、定期同額給与として損金に算入できません`,
        });
      }
    }
  }
  return warnings;
}

/** 従業員の追加. Rejects an officer with 雇用保険 and a 標準報酬月額 that is not a grade amount. */
export async function createEmployee(
  db: Db,
  input: EmployeeCreateInput,
  options: PayrollWriteOptions,
): Promise<EmployeeWriteResult> {
  const data = employeeCreateSchema.parse(input);
  const today = options.today ?? todayInJapan();
  assertGradeAmounts(data, today);
  return runInTransaction(db, async (tx) => {
    const row = await tx.employee.create({ data: { id: newId(), ...employeeData(data) } });
    const employee = toEmployeeRecord(row);
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "employee.create",
      entity: "employee",
      entityId: row.id,
      after: employee,
    });
    return { employee, warnings: await employeeWarnings(tx, employee, null, today) };
  });
}

/** 従業員の変更 (every field). Nothing changes, nothing is logged, when the values are the same. */
export async function updateEmployee(
  db: Db,
  input: EmployeeUpdateInput,
  options: PayrollWriteOptions,
): Promise<EmployeeWriteResult> {
  const { id, ...data } = employeeUpdateSchema.parse(input);
  const today = options.today ?? todayInJapan();
  assertGradeAmounts(data, today);
  return runInTransaction(db, async (tx) => {
    const current = await tx.employee.findUnique({ where: { id } });
    if (!current) throw new SettingsError("従業員が見つかりません。画面を読み込み直してください");
    const before = toEmployeeRecord(current);
    const next = { ...before, ...data };
    const changed = (Object.keys(data) as (keyof typeof data)[]).some(
      (key) => before[key] !== next[key],
    );
    if (!changed)
      return { employee: before, warnings: await employeeWarnings(tx, before, before, today) };
    const row = await tx.employee.update({ where: { id }, data: employeeData(data) });
    const employee = toEmployeeRecord(row);
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "employee.update",
      entity: "employee",
      entityId: id,
      before,
      after: employee,
    });
    return { employee, warnings: await employeeWarnings(tx, employee, before, today) };
  });
}

/** 無効にする / 有効にする. An inactive employee is left out of pay runs; nobody is deleted. */
export async function setEmployeeActive(
  db: Db,
  input: ActiveToggleInput,
  options: ActorOptions,
): Promise<EmployeeRecord> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.employee.findUnique({ where: { id: data.id } });
    if (!current) throw new SettingsError("従業員が見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toEmployeeRecord(current);
    const row = await tx.employee.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: data.isActive ? "employee.activate" : "employee.deactivate",
      entity: "employee",
      entityId: row.id,
      before: { isActive: current.isActive },
      after: { isActive: row.isActive },
    });
    return toEmployeeRecord(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Stored runs
// ---------------------------------------------------------------------------------------------

export interface StoredRun {
  row: PayrollRun;
  payMonth: YearMonth;
  premiumMonth: YearMonth;
  paymentDate: CalendarDate;
  items: PayrollRunItem[];
  tableIds: PayrollTableIds;
  summary: PayrollRunSummary;
}

function toStoredRun(row: PayrollRun): StoredRun {
  const payMonth = row.payMonth as YearMonth;
  const premiumMonth = row.premiumMonth as YearMonth;
  const items = parsePayrollRunItems(row.items);
  return {
    row,
    payMonth,
    premiumMonth,
    paymentDate: fromDbDate(row.paymentDate),
    items,
    tableIds: parsePayrollTableIds(row.tableIds),
    summary: summarizePayrollRun({
      payMonth,
      premiumMonth,
      withholdingSpecialDue: row.withholdingSpecialDue,
      residentTaxSpecialDue: row.residentTaxSpecialDue,
      items,
    }),
  };
}

export async function loadRuns(db: Db): Promise<StoredRun[]> {
  const rows = await db.payrollRun.findMany({ orderBy: { payMonth: "asc" } });
  return rows.map(toStoredRun);
}

/**
 * What the confirmed bonus runs owe (22-payroll §10.4): they pay 源泉所得税 and 社会保険料 into the same
 * deadlines as the monthly runs, so every scheduled amount (§7.2) adds them.
 */
export async function loadBonusSummaries(db: Db): Promise<PayrollRunSummary[]> {
  const rows = await db.payrollBonusRun.findMany({ orderBy: { payMonth: "asc" } });
  return rows.map((row) =>
    summarizeBonusRun({
      payMonth: row.payMonth as YearMonth,
      withholdingSpecialDue: row.withholdingSpecialDue,
      items: parseBonusRunItems(row.items),
    }),
  );
}

/** The summaries of every confirmed run, monthly and bonus: what the schedule is derived from. */
async function loadSummaries(db: Db): Promise<PayrollRunSummary[]> {
  const [runs, bonuses] = await Promise.all([loadRuns(db), loadBonusSummaries(db)]);
  return [...runs.map((run) => run.summary), ...bonuses];
}

export async function entryRefs(
  db: Db,
  ids: readonly (string | null)[],
): Promise<Map<string, EntryRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db.journalEntry.findMany({
    where: { id: { in: wanted } },
    select: { id: true, no: true, entryDate: true },
  });
  return new Map(
    rows.map((row) => [row.id, { id: row.id, no: row.no, entryDate: fromDbDate(row.entryDate) }]),
  );
}

// ---------------------------------------------------------------------------------------------
// Shared shapes of the run screens
// ---------------------------------------------------------------------------------------------

export interface PayrollTableRefs {
  withholding: TableRef;
  kenpo: TableRef;
  pension: TableRef;
  employment: TableRef | null;
}

export interface PayrollRunTotals {
  headcount: number;
  grossPay: Money;
  totalDeductions: Money;
  netPay: Money;
  /** 源泉所得税（調整後） */
  incomeTax: Money;
  residentTax: Money;
  /** 健保・厚年の本人分（調整後） */
  socialInsuranceEmployee: Money;
  employmentInsuranceEmployee: Money;
  /** The employer entry (法定福利費): 0 when there is none. */
  employerTotal: Money;
}

export function totalsOf(summary: PayrollRunSummary): PayrollRunTotals {
  return {
    headcount: summary.headcount,
    grossPay: summary.grossPay,
    totalDeductions: summary.totalDeductions,
    netPay: summary.netPay,
    incomeTax: summary.incomeTax,
    residentTax: summary.residentTax,
    socialInsuranceEmployee: summary.socialInsuranceEmployee,
    employmentInsuranceEmployee: summary.employmentInsuranceEmployee,
    employerTotal: summary.socialInsuranceEmployer,
  };
}

function tableRefsOf(ids: PayrollTableIds): PayrollTableRefs {
  const ref = (id: string): TableRef => {
    const table = findTableById(id);
    if (!table) throw new Error(`payroll table ${id} is not registered`);
    return tableRef(table);
  };
  return {
    withholding: ref(ids.withholding),
    kenpo: ref(ids.kenpo),
    pension: ref(ids.pension),
    employment: ids.employment === null ? null : ref(ids.employment),
  };
}

export interface PayrollEntryPreviewLine {
  side: Side;
  accountCode: string;
  accountName: string;
  /** The sub-account (〔源泉所得税〕), or the wallet's name for the wallet line. */
  subAccountName: string | null;
  /** Set on the line of the wallet paid from. */
  walletName: string | null;
  /** As posted: without the tax in tax-exclusive years. */
  amount: Money;
  taxCategoryCode: string;
  taxAmount: Money;
}

export interface PayrollEntryPreview {
  description: string;
  entryDate: CalendarDate;
  lines: PayrollEntryPreviewLine[];
  debitTotal: Money;
  creditTotal: Money;
}

// ---------------------------------------------------------------------------------------------
// Ledger references: accounts by code, sub-accounts by name, the wallet, the tax rules
// ---------------------------------------------------------------------------------------------

interface AccountRow {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  isActive: boolean;
  defaultTaxCategoryCode: string | null;
}

interface WalletRow {
  id: string;
  name: string;
  accountId: string;
  subAccountId: string | null;
  defaultSegmentId: string | null;
  isActive: boolean;
}

export interface LedgerRefs {
  fiscalYear: FiscalYear;
  /** By code. */
  accounts: Map<string, AccountRow>;
  /** Sub-account ids by `<accountCode>:<name>` (pending ones in a preview). */
  subAccounts: Map<string, string>;
  wallet: WalletRow | null;
  /** The account of `wallet`. */
  walletAccount: AccountRow | null;
  corporateSegmentId: string | null;
  taxRules: TaxRateRule[];
}

const subKey = (accountCode: string, name: string) => `${accountCode}:${name}`;

const LEDGER_ACCOUNT_CODES = [...Object.values(PAYROLL_ACCOUNT_CODES), INPUT_TAX_ACCOUNT_CODE];

function missingAccount(code: string): LedgerValidationError {
  const name = findTemplateAccount(code)?.name ?? "";
  return new LedgerValidationError([
    {
      code: "STANDARD_ACCOUNT_MISSING",
      message: `勘定科目 ${code}（${name}）がありません。設定 › 勘定科目 で足してください`,
    },
  ]);
}

function noFiscalYear(date: CalendarDate, field: string): LedgerValidationError {
  return new LedgerValidationError([
    {
      code: "OUT_OF_FISCAL_YEAR",
      message: `${displayDate(date)} を含む会計期間がありません。会計期間の中の日付にするか、設定 › 会計期間 で期を作ってください`,
      field,
    },
  ]);
}

/** The fiscal year of `date`: locked (a write) or just read (a preview). */
async function fiscalYearOn(
  db: Db,
  date: CalendarDate,
  options: { lock: boolean; field: string },
): Promise<FiscalYear> {
  if (options.lock) {
    try {
      return await lockFiscalYearOn(db, date);
    } catch (error) {
      if (error instanceof LedgerValidationError) throw noFiscalYear(date, options.field);
      throw error;
    }
  }
  const day = toDbDate(date);
  const years = await db.fiscalYear.findMany({
    where: { startDate: { lte: day }, endDate: { gte: day } },
  });
  const [only] = years;
  if (!only || years.length > 1) throw noFiscalYear(date, options.field);
  return only;
}

export async function loadLedgerRefs(
  db: Db,
  options: {
    date: CalendarDate;
    walletId: string | null;
    lock: boolean;
    dateField: string;
    walletField: string;
  },
): Promise<LedgerRefs> {
  const fiscalYear = await fiscalYearOn(db, options.date, {
    lock: options.lock,
    field: options.dateField,
  });
  const accountRows = await db.account.findMany({
    where: { code: { in: LEDGER_ACCOUNT_CODES } },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      isActive: true,
      defaultTaxCategoryCode: true,
    },
  });
  const accounts = new Map(accountRows.map((row) => [row.code, row]));
  const subRows = await db.subAccount.findMany({
    where: { accountId: { in: accountRows.map((row) => row.id) } },
    select: { id: true, name: true, accountId: true },
  });
  const codeOf = new Map(accountRows.map((row) => [row.id, row.code]));
  const subAccounts = new Map<string, string>();
  for (const row of subRows) {
    const code = codeOf.get(row.accountId);
    if (code) subAccounts.set(subKey(code, row.name), row.id);
  }
  let wallet: WalletRow | null = null;
  let walletAccount: AccountRow | null = null;
  if (options.walletId) {
    const row = await db.wallet.findUnique({
      where: { id: options.walletId },
      include: {
        account: {
          select: {
            id: true,
            code: true,
            name: true,
            kind: true,
            isActive: true,
            defaultTaxCategoryCode: true,
          },
        },
      },
    });
    if (!row) {
      throw new SettingsError("口座が見つかりません。一覧から選んでください", {
        field: options.walletField,
      });
    }
    if (!row.isActive) {
      throw new SettingsError(`口座「${row.name}」は無効です。別の口座を選んでください`, {
        field: options.walletField,
      });
    }
    wallet = row;
    walletAccount = row.account;
  }
  const segment = await db.segment.findUnique({ where: { code: CORPORATE_SEGMENT_CODE } });
  return {
    fiscalYear,
    accounts,
    subAccounts,
    wallet,
    walletAccount,
    corporateSegmentId: segment?.id ?? null,
    taxRules: await loadTaxRules(db),
  };
}

function requireAccount(refs: LedgerRefs, code: string): AccountRow {
  const account = refs.accounts.get(code);
  if (!account) throw missingAccount(code);
  return account;
}

/**
 * Makes the sub-accounts of §5.2 (or turns them back on), each with its audit row. A bonus run adds
 * its 「賞与」 sub-accounts (§10.4).
 */
export async function ensurePayrollSubAccounts(
  tx: Tx,
  refs: LedgerRefs,
  options: ActorOptions,
  subs: readonly { accountCode: string; name: string }[] = Object.values(PAYROLL_SUB_ACCOUNTS),
): Promise<void> {
  for (const { accountCode, name } of subs) {
    const account = requireAccount(refs, accountCode);
    const existing = await tx.subAccount.findUnique({
      where: { accountId_name: { accountId: account.id, name } },
    });
    if (!existing) {
      const created = await createSubAccount(tx, { accountId: account.id, name }, options);
      refs.subAccounts.set(subKey(accountCode, name), created.id);
    } else if (!existing.isActive) {
      await setSubAccountActive(tx, { id: existing.id, isActive: true }, options);
    }
  }
}

const PROFIT_AND_LOSS: ReadonlySet<AccountKind> = new Set(["revenue", "expense", "internal"]);

/**
 * A plan of `@niho-finance/payroll` → a journal entry: accounts by code, sub-accounts by name,
 * 共通 on the profit-and-loss lines, the wallet's account for the wallet line, and the tax split of
 * 旅費交通費 as 支出 does it (税抜経理: 仮払消費税 on a line of its own). The entry goes through
 * `buildVoucherEntry` (the 伝票 path) with the split taxes, then gets `sourceKind = payroll`.
 */
export function toJournalEntry(
  plan: PayrollEntryPlan,
  refs: LedgerRefs,
  context: { date: CalendarDate; sourceId: string; pendingSubAccounts: boolean },
): { entry: JournalEntryInput; preview: PayrollEntryPreview } {
  const accountingMethod = refs.fiscalYear.accountingMethod;
  const lines: (VoucherLineInput & { taxAmount: Money })[] = [];
  const previewLines: PayrollEntryPreviewLine[] = [];
  const push = (
    line: VoucherLineInput & { taxAmount: Money },
    display: Omit<PayrollEntryPreviewLine, "side" | "amount" | "taxCategoryCode" | "taxAmount">,
  ) => {
    lines.push(line);
    previewLines.push({
      side: line.side,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxAmount: line.taxAmount,
      ...display,
    });
  };
  for (const line of plan.lines) {
    let accountId: string;
    let subAccountId: string | null = null;
    let segmentId: string | null = null;
    let display: Omit<PayrollEntryPreviewLine, "side" | "amount" | "taxCategoryCode" | "taxAmount">;
    if (line.target.kind === "wallet") {
      const { wallet, walletAccount } = refs;
      if (!wallet || !walletAccount)
        throw new Error("payroll entry: a wallet line without a wallet");
      accountId = wallet.accountId;
      subAccountId = wallet.subAccountId;
      segmentId = wallet.defaultSegmentId;
      display = {
        accountCode: walletAccount.code,
        accountName: walletAccount.name,
        subAccountName: wallet.name,
        walletName: wallet.name,
      };
    } else {
      const account = requireAccount(refs, line.target.accountCode);
      accountId = account.id;
      if (line.target.subAccountName !== null) {
        const id = refs.subAccounts.get(subKey(account.code, line.target.subAccountName));
        if (!id && !context.pendingSubAccounts) {
          throw new Error(`payroll entry: sub-account ${line.target.subAccountName} is missing`);
        }
        subAccountId = id ?? `pending:${account.code}:${line.target.subAccountName}`;
      }
      if (PROFIT_AND_LOSS.has(account.kind)) segmentId = refs.corporateSegmentId;
      display = {
        accountCode: account.code,
        accountName: account.name,
        subAccountName: line.target.subAccountName,
        walletName: null,
      };
    }
    const split = splitTaxInclusive(line.amount, line.taxCategoryCode, context.date, {
      accountingMethod,
      taxRules: refs.taxRules,
    });
    push(
      {
        side: line.side,
        accountId,
        subAccountId,
        amount: split.amount,
        taxCategoryCode: line.taxCategoryCode,
        taxAmount: split.taxAmount,
        segmentId,
        partnerId: null,
        description: null,
      },
      display,
    );
    if (split.taxLineAmount > 0n) {
      const taxAccount = requireAccount(refs, INPUT_TAX_ACCOUNT_CODE);
      push(
        {
          side: line.side,
          accountId: taxAccount.id,
          subAccountId: null,
          amount: split.taxLineAmount,
          taxCategoryCode: "na",
          taxAmount: 0n,
          segmentId: null,
          partnerId: null,
          description: null,
        },
        {
          accountCode: taxAccount.code,
          accountName: taxAccount.name,
          subAccountName: null,
          walletName: null,
        },
      );
    }
  }
  const voucher = buildVoucherEntry(
    {
      entryDate: context.date,
      description: plan.description,
      kind: "normal",
      partnerId: null,
      lines,
    },
    { accountingMethod, taxRules: refs.taxRules },
  );
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of previewLines) {
    if (line.side === "debit") debitTotal += line.amount;
    else creditTotal += line.amount;
  }
  return {
    entry: { ...voucher, sourceKind: "payroll", sourceId: context.sourceId },
    preview: {
      description: plan.description,
      entryDate: context.date,
      lines: previewLines,
      debitTotal,
      creditTotal,
    },
  };
}

/** The ledger's own checks without writing (a preview reports what the posting would). */
export function assertPostable(entry: JournalEntryInput, refs: LedgerRefs): void {
  const accounts = [...refs.accounts.values(), ...(refs.walletAccount ? [refs.walletAccount] : [])];
  const result = validateEntry(entry, {
    fiscalYear: toFiscalYearContext(refs.fiscalYear),
    accounts: new Map(accounts.map((row) => [row.id, row])),
  });
  if (!result.ok) throw new LedgerValidationError(result.errors);
}

const DATE_ERROR_CODES: ReadonlySet<LedgerError["code"]> = new Set([
  "INVALID_DATE",
  "OUT_OF_FISCAL_YEAR",
  "PERIOD_LOCKED",
  "FISCAL_YEAR_CLOSED",
  "FISCAL_YEAR_CLOSING",
]);

/** Ledger errors about the date belong to the form's date field. */
export function withDateField(error: LedgerValidationError, field: string): LedgerValidationError {
  return new LedgerValidationError(
    error.errors.map((item) =>
      DATE_ERROR_CODES.has(item.code) || item.field === "entryDate" ? { ...item, field } : item,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// 支給の計算 (§6.3): shared by the preview and the confirmation
// ---------------------------------------------------------------------------------------------

/** Coverage of a person in a premium month (22-payroll §2.9, §5.6). */
export function employeeCoverage(
  employee: EmployeeRecord,
  premiumMonth: YearMonth,
): PayrollCoverage {
  const insured =
    employee.socialInsured &&
    employee.insuredFrom !== null &&
    compareYearMonths(yearMonthOf(employee.insuredFrom), premiumMonth) <= 0;
  const age = coverageByAge(employee.birthDate, premiumMonth);
  const health = insured && age.health;
  return {
    health,
    care: health && age.care,
    pension: insured && age.pension,
    employment: employee.employmentInsured,
  };
}

export function taxColumnOf(employee: EmployeeRecord): TaxColumn {
  return employee.taxColumn === "kou"
    ? { column: "kou", dependents: employee.dependents }
    : { column: "otsu", secondaryDependents: employee.dependents };
}

/** Input fields of `calculatePayroll` → the fields of the screen (`items.<n>.…`). */
const ITEM_FIELDS: Readonly<Record<string, string>> = {
  taxablePay: "taxablePay",
  nonTaxablePay: "commuteAllowance",
  residentTax: "residentTax",
  "adjustments.incomeTax": "incomeTaxAdjustment",
  "adjustments.socialInsurance": "socialInsuranceAdjustment",
};

function itemInputError(error: PayrollInputError, index: number, name: string): PayrollInputError {
  return new PayrollInputError(
    error.issues.map((issue): PayrollInputIssue => {
      if (issue.field === "paymentDate") return issue;
      const field = ITEM_FIELDS[issue.field];
      return field
        ? { ...issue, field: `items.${index}.${field}`, message: `${name}: ${issue.message}` }
        : {
            ...issue,
            field: `items.${index}`,
            message: `${name}: ${issue.message}（従業員 › ${name} で直してください）`,
          };
    }),
  );
}

interface RunPlan {
  data: ParsedPayrollRun;
  premiumMonth: YearMonth;
  employees: EmployeeRecord[];
  items: PayrollRunItem[];
  tableIds: PayrollTableIds;
  summary: PayrollRunSummary;
  runs: StoredRun[];
  /** The confirmed bonus runs (they pay into the same deadlines). */
  bonuses: PayrollRunSummary[];
  pay: PayrollEntryPlan;
  employer: PayrollEntryPlan | null;
  socialInsurance: SocialInsuranceAggregate;
}

/** The rules of a new run that need no calculation (22-payroll §5.1, §5.5, §6.3). */
function checkRunRules(data: ParsedPayrollRun, runs: readonly StoredRun[]): YearMonth {
  if (yearMonthOf(data.paymentDate) !== data.payMonth) {
    throw new SettingsError(
      `支払日は ${yearMonthLabel(data.payMonth)}の日付にしてください（支給月は支払日の月です）`,
      { field: "paymentDate" },
    );
  }
  const confirmed = runs.find((run) => run.payMonth === data.payMonth);
  if (confirmed) {
    throw new SettingsError(
      `${yearMonthLabel(data.payMonth)}の支給は確定済みです。確定した支給は変えられません。直すときは次の支給の調整で行うか、取引で仕訳を訂正してください`,
      { field: "payMonth" },
    );
  }
  const premiumMonth = premiumMonthFor(data.payMonth, data.premiumTiming);
  const deducted = runs.find((run) => run.premiumMonth === premiumMonth);
  if (deducted) {
    throw new SettingsError(
      `${yearMonthLabel(premiumMonth)}分の社会保険料は ${yearMonthLabel(deducted.payMonth)}の支給で控除済みです。同じ対象月は 1 回だけ控除します。社会保険料の控除の月を確かめてください`,
      { field: "premiumTiming" },
    );
  }
  const first = runs[0];
  if (first && first.row.premiumTiming !== data.premiumTiming) {
    throw new SettingsError(
      `社会保険料の控除は最初の支給で「${PREMIUM_TIMING_LABELS[first.row.premiumTiming]}」に決まっています。変えると対象月が抜けるか重なるので、変えられません`,
      { field: "premiumTiming" },
    );
  }
  return premiumMonth;
}

/**
 * Client-sent table ids (the versions the preview used) must be registered versions of their kind
 * that are in force for the run's payment date and premium month; otherwise the preview is stale.
 */
function requestedTables(
  ids: PayrollTableIds | null,
  run: { paymentDate: CalendarDate; premiumMonth: YearMonth },
): Partial<PayrollTables> | undefined {
  if (!ids) return undefined;
  const kinds = {
    withholding: "withholding-monthly",
    kenpo: "kyokai-kenpo",
    pension: "pension",
    employment: "employment-insurance",
  } as const;
  for (const key of Object.keys(kinds) as (keyof typeof kinds)[]) {
    const id = ids[key];
    if (id === null) continue;
    const table = findTableById(id);
    if (table?.kind !== kinds[key]) {
      throw new SettingsError(
        `計算に使う表の版（${id}）が見つかりません。画面を読み込み直してから、もう一度計算してください`,
      );
    }
    const when = key === "withholding" ? run.paymentDate : run.premiumMonth;
    if (!isTableEffective(table, when)) {
      throw new SettingsError(
        `支払日か対象月が変わったので、計算に使う表の版（${table.title}）が変わります。もう一度計算してから確定してください`,
      );
    }
  }
  return pinnedTables(ids);
}

async function planRun(db: Db, data: ParsedPayrollRun): Promise<RunPlan> {
  const [runs, bonuses] = await Promise.all([loadRuns(db), loadBonusSummaries(db)]);
  const premiumMonth = checkRunRules(data, runs);

  const activeRows = (await db.employee.findMany({ where: { isActive: true } })).sort(
    employeeOrder,
  );
  const employees = activeRows.map(toEmployeeRecord);
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const rows = new Map<string, ParsedPayrollRun["items"][number]>();
  data.items.forEach((row, index) => {
    if (!byId.has(row.employeeId)) {
      throw new SettingsError(
        "支給の計算にない従業員か、無効にした従業員が入っています。画面を読み込み直してください",
        { field: `items.${index}.employeeId` },
      );
    }
    if (rows.has(row.employeeId)) {
      throw new SettingsError("同じ従業員が 2 回入っています。画面を読み込み直してください", {
        field: `items.${index}.employeeId`,
      });
    }
    rows.set(row.employeeId, row);
  });
  const missing = employees.find((employee) => !rows.has(employee.id));
  if (missing) {
    throw new SettingsError(
      `従業員「${missing.name}」の入力がありません。従業員が増えたときは画面を読み込み直してください`,
    );
  }

  const run = { paymentDate: data.paymentDate, premiumMonth };
  const tables = requestedTables(data.tableIds, run);
  const items = employees.map((employee): PayrollRunItem => {
    const row = rows.get(employee.id);
    const index = data.items.findIndex((item) => item.employeeId === employee.id);
    if (!row) throw new Error("unreachable: every employee has a row");
    const input: PayrollRunItemInput = {
      taxablePay: row.taxablePay,
      nonTaxablePay: row.commuteAllowance,
      residentTax: row.residentTax,
      standardRemuneration: {
        health: employee.healthSmr ?? 0n,
        pension: employee.pensionSmr ?? 0n,
      },
      coverage: employeeCoverage(employee, premiumMonth),
      taxColumn: taxColumnOf(employee),
      adjustments: {
        incomeTax: row.incomeTaxAdjustment,
        socialInsurance: row.socialInsuranceAdjustment,
      },
    };
    try {
      return {
        employeeId: employee.id,
        name: employee.name,
        kind: employee.kind,
        input,
        adjustmentNote: row.adjustmentNote,
        result: calculatePayroll(payrollInputOf(run, { kind: employee.kind, input }, tables)),
      };
    } catch (error) {
      if (error instanceof PayrollInputError) throw itemInputError(error, index, employee.name);
      throw error;
    }
  });

  const tableIds = tableIdsOf(items.map((item) => item.result));
  const summary = summarizePayrollRun({
    payMonth: data.payMonth,
    premiumMonth,
    withholdingSpecialDue: data.withholdingSpecialDue,
    residentTaxSpecialDue: data.residentTaxSpecialDue,
    items,
  });
  const commute = await db.account.findUnique({
    where: { code: PAYROLL_ACCOUNT_CODES.commute },
    select: { defaultTaxCategoryCode: true },
  });
  const entries = buildPayrollEntries({
    payMonth: data.payMonth,
    premiumMonth,
    items,
    payFrom: data.payFromWalletId ? "wallet" : "accrued",
    commuteTaxCategoryCode: commute?.defaultTaxCategoryCode ?? "purchase_10",
  });
  if (entries.pay.lines.length === 0) {
    throw new SettingsError("支給も控除もすべて 0 円です。支給する額を入れてください");
  }

  if (data.expected) {
    const differences = [
      ["総支給", data.expected.grossPay, summary.grossPay],
      ["差引支給", data.expected.netPay, summary.netPay],
      ["会社負担", data.expected.employerTotal, summary.socialInsuranceEmployer],
    ] as const;
    const changed = differences.filter(([, expected, actual]) => expected !== actual);
    if (changed.length > 0) {
      throw new SettingsError(
        `計算の結果が確認した内容と変わりました（${changed
          .map(
            ([label, expected, actual]) =>
              `${label}の合計 ${formatYen(expected)} 円 → ${formatYen(actual)} 円`,
          )
          .join("、")}）。画面を読み込み直して、もう一度確かめてください`,
      );
    }
  }

  return {
    data,
    premiumMonth,
    employees,
    items,
    tableIds,
    summary,
    runs,
    bonuses,
    pay: entries.pay,
    employer: entries.employer,
    socialInsurance: entries.socialInsurance,
  };
}

/** A deadline of the run being calculated, with this run's share and the total once confirmed. */
export interface PayrollSchedulePreviewRow {
  category: PayrollPaymentCategory;
  categoryLabel: string;
  ruleKey: string;
  title: string;
  dueDate: CalendarDate;
  /** This run's share. */
  amount: Money;
  /** The scheduled total of the deadline with this run (other runs may pay into it too). */
  scheduledTotal: Money;
}

function schedulePreview(plan: RunPlan): PayrollSchedulePreviewRow[] {
  const all = [...plan.runs.map((run) => run.summary), ...plan.bonuses, plan.summary];
  return runPaymentSlots(plan.summary).map(({ slot, amount }) => ({
    category: slot.category,
    categoryLabel: PAYROLL_PAYMENT_CATEGORY_LABELS[slot.category],
    ruleKey: slot.ruleKey,
    title: slot.title,
    dueDate: slot.dueDate,
    amount: amount.total,
    scheduledTotal: scheduleAmount(slot.ruleKey, all).total,
  }));
}

export interface PayrollPreview {
  payMonth: YearMonth;
  premiumMonth: YearMonth;
  paymentDate: CalendarDate;
  premiumTiming: PremiumTiming;
  payFromWalletId: string | null;
  withholdingSpecialDue: boolean;
  residentTaxSpecialDue: boolean;
  /** One per active employee, in the order of the employee list. */
  items: PayrollRunItem[];
  tableIds: PayrollTableIds;
  tables: PayrollTableRefs;
  socialInsurance: SocialInsuranceAggregate;
  totals: PayrollRunTotals;
  entries: { pay: PayrollEntryPreview; employer: PayrollEntryPreview | null };
  schedule: PayrollSchedulePreviewRow[];
  /** Send back as `expected` (with `tableIds`) when confirming what this preview showed. */
  expected: { grossPay: Money; netPay: Money; employerTotal: Money };
}

function previewOf(
  plan: RunPlan,
  entries: { pay: PayrollEntryPreview; employer: PayrollEntryPreview | null },
): PayrollPreview {
  return {
    payMonth: plan.data.payMonth,
    premiumMonth: plan.premiumMonth,
    paymentDate: plan.data.paymentDate,
    premiumTiming: plan.data.premiumTiming,
    payFromWalletId: plan.data.payFromWalletId,
    withholdingSpecialDue: plan.data.withholdingSpecialDue,
    residentTaxSpecialDue: plan.data.residentTaxSpecialDue,
    items: plan.items,
    tableIds: plan.tableIds,
    tables: tableRefsOf(plan.tableIds),
    socialInsurance: plan.socialInsurance,
    totals: totalsOf(plan.summary),
    entries,
    schedule: schedulePreview(plan),
    expected: {
      grossPay: plan.summary.grossPay,
      netPay: plan.summary.netPay,
      employerTotal: plan.summary.socialInsuranceEmployer,
    },
  };
}

/**
 * The results, the 2 entries and the payment deadlines of a pay run, without writing anything. It
 * runs the confirmation's checks (rules, tables, the ledger's checks of the entries), so what it
 * shows is what `confirmPayrollRun` posts.
 */
export async function previewPayrollRun(db: Db, input: PayrollRunInput): Promise<PayrollPreview> {
  const data = payrollRunSchema.parse(input);
  const plan = await planRun(db, data);
  try {
    const refs = await loadLedgerRefs(db, {
      date: data.paymentDate,
      walletId: data.payFromWalletId,
      lock: false,
      dateField: "paymentDate",
      walletField: "payFromWalletId",
    });
    const context = { date: data.paymentDate, sourceId: "preview", pendingSubAccounts: true };
    const pay = toJournalEntry(plan.pay, refs, context);
    const employer = plan.employer ? toJournalEntry(plan.employer, refs, context) : null;
    assertPostable(pay.entry, refs);
    if (employer) assertPostable(employer.entry, refs);
    return previewOf(plan, { pay: pay.preview, employer: employer?.preview ?? null });
  } catch (error) {
    if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
    throw error;
  }
}

/** A confirmed run (読み取りだけ, §6.4). */
export interface PayrollRunDetail {
  id: string;
  payMonth: YearMonth;
  premiumMonth: YearMonth;
  paymentDate: CalendarDate;
  premiumTiming: PremiumTiming;
  /** `null`: 未払金〔給与〕. */
  payFromWallet: { id: string; name: string } | null;
  withholdingSpecialDue: boolean;
  residentTaxSpecialDue: boolean;
  items: PayrollRunItem[];
  tableIds: PayrollTableIds;
  tables: PayrollTableRefs;
  totals: PayrollRunTotals;
  payEntry: EntryRef | null;
  employerEntry: EntryRef | null;
  /** The deadlines this run pays into, with their derived amounts and state. */
  schedule: PayrollScheduleRow[];
  confirmedAt: Date;
  confirmedBy: string;
}

/**
 * 確定 (§5.1): in one transaction — the payroll lock → the checks and the calculation (as the
 * preview) → the sub-accounts of §5.2 → the 2 entries → the `PayrollRun` row → the payment
 * deadlines → the audit log `payroll_run.confirm`.
 */
export async function confirmPayrollRun(
  db: Db,
  input: PayrollRunInput,
  options: ActorOptions,
): Promise<PayrollRunDetail> {
  const data = payrollRunSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "payroll");
    const plan = await planRun(tx, data);
    const runId = newId();
    let payEntryId: string;
    let employerEntryId: string | null = null;
    try {
      const refs = await loadLedgerRefs(tx, {
        date: data.paymentDate,
        walletId: data.payFromWalletId,
        lock: true,
        dateField: "paymentDate",
        walletField: "payFromWalletId",
      });
      await ensurePayrollSubAccounts(tx, refs, options);
      const context = { date: data.paymentDate, sourceId: runId, pendingSubAccounts: false };
      const pay = toJournalEntry(plan.pay, refs, context);
      payEntryId = (
        await postJournalEntryInTransaction(
          tx,
          { ...pay.entry, fiscalYearId: refs.fiscalYear.id },
          options,
        )
      ).id;
      if (plan.employer) {
        const employer = toJournalEntry(plan.employer, refs, context);
        employerEntryId = (
          await postJournalEntryInTransaction(
            tx,
            { ...employer.entry, fiscalYearId: refs.fiscalYear.id },
            options,
          )
        ).id;
      }
    } catch (error) {
      if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
      throw error;
    }

    await tx.payrollRun
      .create({
        data: {
          id: runId,
          payMonth: data.payMonth,
          paymentDate: toDbDate(data.paymentDate),
          premiumTiming: data.premiumTiming,
          premiumMonth: plan.premiumMonth,
          payFromWalletId: data.payFromWalletId,
          withholdingSpecialDue: data.withholdingSpecialDue,
          residentTaxSpecialDue: data.residentTaxSpecialDue,
          tableIds: serializePayrollTableIds(plan.tableIds) as Prisma.InputJsonValue,
          items: serializePayrollRunItems(plan.items) as Prisma.InputJsonValue,
          payEntryId,
          employerEntryId,
          confirmedBy: options.actor,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new SettingsError(
            `${yearMonthLabel(data.payMonth)}の支給か ${yearMonthLabel(plan.premiumMonth)}分の社会保険料は確定済みです。画面を読み込み直してください`,
            { field: "payMonth" },
          );
        }
        throw error;
      });

    for (const { slot } of runPaymentSlots(plan.summary)) {
      const existing = await tx.calendarItem.findFirst({
        where: { fiscalYearId: null, ruleKey: slot.ruleKey },
      });
      if (existing?.completedAt) {
        throw new SettingsError(
          `「${existing.title}」は納付済みにしています。この支給の分を同じ納付に足せないので、納期の特例の設定か支払日を確かめてください`,
          {
            field:
              slot.category === "withholding" ? "withholdingSpecialDue" : "residentTaxSpecialDue",
          },
        );
      }
      if (!existing) {
        await tx.calendarItem.create({
          data: {
            id: newId(),
            fiscalYearId: null,
            kind: "payment",
            title: slot.title,
            dueDate: toDbDate(slot.dueDate),
            ruleKey: slot.ruleKey,
          },
        });
      }
    }

    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payroll_run.confirm",
      entity: "payroll_run",
      entityId: runId,
      after: {
        payMonth: data.payMonth,
        paymentDate: data.paymentDate,
        premiumTiming: data.premiumTiming,
        premiumMonth: plan.premiumMonth,
        payFromWalletId: data.payFromWalletId,
        withholdingSpecialDue: data.withholdingSpecialDue,
        residentTaxSpecialDue: data.residentTaxSpecialDue,
        tableIds: plan.tableIds,
        payEntryId,
        employerEntryId,
        employeeIds: plan.items.map((item) => item.employeeId),
        totals: totalsOf(plan.summary),
      },
    });

    const detail = await getPayrollRun(tx, runId);
    if (!detail) throw new Error(`payroll run ${runId} disappeared`);
    return detail;
  });
}

// ---------------------------------------------------------------------------------------------
// 支給の計算の初期値 (§6.3)
// ---------------------------------------------------------------------------------------------

export interface PayrollRunItemValues {
  employeeId: string;
  taxablePay: Money;
  commuteAllowance: Money;
  residentTax: Money;
  incomeTaxAdjustment: Money;
  socialInsuranceAdjustment: Money;
  adjustmentNote: string | null;
}

/** A complete input of `previewPayrollRun` / `confirmPayrollRun`, typed. */
export interface PayrollRunValues {
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  premiumTiming: PremiumTiming;
  payFromWalletId: string | null;
  withholdingSpecialDue: boolean;
  residentTaxSpecialDue: boolean;
  items: PayrollRunItemValues[];
  tableIds?: PayrollTableIds | null;
  expected?: { grossPay: Money; netPay: Money; employerTotal: Money } | null;
}

export interface PayrollDraftEmployee {
  employee: EmployeeRecord;
  /** Coverage in the draft's premium month (介護・厚年・健保 by age, from 資格取得日). */
  coverage: PayrollCoverage;
}

export interface PayrollDraft {
  payMonth: YearMonth;
  /** Set when the month is confirmed already (the screen then opens the run). */
  confirmedRunId: string | null;
  /** The settings and the employees' defaults, ready for `previewPayrollRun`. */
  input: PayrollRunValues;
  premiumMonth: YearMonth;
  /** The premium timing is fixed by the first run. */
  premiumTimingLocked: boolean;
  employees: PayrollDraftEmployee[];
  /** The active wallets that can pay (支払元). */
  wallets: { id: string; name: string }[];
}

/**
 * The defaults of 支給の計算 for `payMonth`: the active employees with their monthly amounts, and
 * the previous run's settings (支払日 on the previous run's day of the month, 25 on the first run).
 */
export async function loadPayrollDraft(db: Db, payMonth: string): Promise<PayrollDraft> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payMonth)) {
    throw new SettingsError("支給月は 2026-12 の形にしてください", { field: "payMonth" });
  }
  const month = payMonth as YearMonth;
  const runs = await db.payrollRun.findMany({ orderBy: { payMonth: "asc" } });
  const confirmed = runs.find((run) => run.payMonth === month);
  const previous = [...runs].reverse().find((run) => run.payMonth !== month) ?? null;
  const premiumTiming: PremiumTiming = runs[0]?.premiumTiming ?? "next_month";
  const premiumMonth = premiumMonthFor(month, premiumTiming);
  const { year, month: monthNumber } = yearMonthParts(month);
  const lastDay = dateParts(lastDayOfMonth(year, monthNumber)).day;
  const previousDay = previous ? dateParts(fromDbDate(previous.paymentDate)).day : 25;
  const day = previousDay > lastDay ? lastDay : previousDay;

  const wallets = await db.wallet.findMany({
    where: { isActive: true },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, name: true },
  });
  const payFromWalletId =
    previous?.payFromWalletId && wallets.some((wallet) => wallet.id === previous.payFromWalletId)
      ? previous.payFromWalletId
      : null;
  const employees = (await db.employee.findMany({ where: { isActive: true } }))
    .sort(employeeOrder)
    .map(toEmployeeRecord);
  return {
    payMonth: month,
    confirmedRunId: confirmed?.id ?? null,
    input: {
      payMonth: month,
      paymentDate: dateOf(year, monthNumber, day),
      premiumTiming,
      payFromWalletId,
      withholdingSpecialDue: previous?.withholdingSpecialDue ?? false,
      residentTaxSpecialDue: previous?.residentTaxSpecialDue ?? false,
      items: employees.map((employee) => ({
        employeeId: employee.id,
        taxablePay: employee.basePay,
        commuteAllowance: employee.commuteAllowance,
        residentTax: employee.residentTax,
        incomeTaxAdjustment: 0n,
        socialInsuranceAdjustment: 0n,
        adjustmentNote: null,
      })),
    },
    premiumMonth,
    premiumTimingLocked: runs.length > 0,
    employees: employees.map((employee) => ({
      employee,
      coverage: employeeCoverage(employee, premiumMonth),
    })),
    wallets,
  };
}

// ---------------------------------------------------------------------------------------------
// History, detail and payslip (§6.4・§6.5・§6.6)
// ---------------------------------------------------------------------------------------------

export interface PayrollRunListRow {
  id: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  premiumMonth: YearMonth;
  totals: PayrollRunTotals;
  payEntry: EntryRef | null;
  employerEntry: EntryRef | null;
  confirmedAt: Date;
}

/** 支給の履歴, newest first. */
export async function listPayrollRuns(db: Db): Promise<PayrollRunListRow[]> {
  const runs = (await loadRuns(db)).reverse();
  const refs = await entryRefs(
    db,
    runs.flatMap((run) => [run.row.payEntryId, run.row.employerEntryId]),
  );
  return runs.map((run) => ({
    id: run.row.id,
    payMonth: run.payMonth,
    paymentDate: run.paymentDate,
    premiumMonth: run.premiumMonth,
    totals: totalsOf(run.summary),
    payEntry: refs.get(run.row.payEntryId) ?? null,
    employerEntry: run.row.employerEntryId ? (refs.get(run.row.employerEntryId) ?? null) : null,
    confirmedAt: run.row.confirmedAt,
  }));
}

/** A confirmed run, or `null` when there is none with this id. */
export async function getPayrollRun(db: Db, id: string): Promise<PayrollRunDetail | null> {
  const row = await db.payrollRun.findUnique({ where: { id } });
  if (!row) return null;
  const run = toStoredRun(row);
  const [refs, wallet, schedule] = await Promise.all([
    entryRefs(db, [row.payEntryId, row.employerEntryId]),
    row.payFromWalletId
      ? db.wallet.findUnique({
          where: { id: row.payFromWalletId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    listPayrollSchedule(db),
  ]);
  const ruleKeys = new Set(runPaymentSlots(run.summary).map(({ slot }) => slot.ruleKey));
  return {
    id: row.id,
    payMonth: run.payMonth,
    premiumMonth: run.premiumMonth,
    paymentDate: run.paymentDate,
    premiumTiming: row.premiumTiming,
    payFromWallet: wallet,
    withholdingSpecialDue: row.withholdingSpecialDue,
    residentTaxSpecialDue: row.residentTaxSpecialDue,
    items: run.items,
    tableIds: run.tableIds,
    tables: tableRefsOf(run.tableIds),
    totals: totalsOf(run.summary),
    payEntry: refs.get(row.payEntryId) ?? null,
    employerEntry: row.employerEntryId ? (refs.get(row.employerEntryId) ?? null) : null,
    schedule: schedule.filter((item) => ruleKeys.has(item.ruleKey)),
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
  };
}

/** 給与明細 (§6.5): A4 一枚の項目. */
export interface Payslip {
  runId: string;
  companyName: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  employee: { id: string; name: string; kind: WorkerKind };
  pay: { taxablePay: Money; commuteAllowance: Money; grossPay: Money };
  deductions: {
    /** 健康保険（介護・子ども・子育て支援金を含む）の本人負担 */
    health: Money;
    pension: Money;
    employmentInsurance: Money;
    /** 所得税 of the table (the adjustment is separate) */
    incomeTax: Money;
    residentTax: Money;
    adjustments: { incomeTax: Money; socialInsurance: Money };
    total: Money;
  };
  netPay: Money;
  reference: {
    /** `null` when not covered in the premium month. */
    healthSmr: Money | null;
    pensionSmr: Money | null;
    taxColumn: TaxColumn;
    premiumMonth: YearMonth;
    coverage: PayrollCoverage;
    adjustmentNote: string | null;
  };
}

/** The payslip of one person of a confirmed run, or `null`. Names are as at confirmation. */
export async function loadPayslip(
  db: Db,
  runId: string,
  employeeId: string,
): Promise<Payslip | null> {
  const row = await db.payrollRun.findUnique({ where: { id: runId } });
  if (!row) return null;
  const run = toStoredRun(row);
  const item = run.items.find((candidate) => candidate.employeeId === employeeId);
  if (!item) return null;
  const company = await db.company.findFirst({ select: { name: true } });
  const { input, result } = item;
  return {
    runId: row.id,
    companyName: company?.name ?? "",
    payMonth: run.payMonth,
    paymentDate: run.paymentDate,
    employee: { id: item.employeeId, name: item.name, kind: item.kind },
    pay: {
      taxablePay: input.taxablePay,
      commuteAllowance: input.nonTaxablePay,
      grossPay: result.grossPay,
    },
    deductions: {
      health: result.socialInsurance.health.employee,
      pension: result.socialInsurance.pension.employee,
      employmentInsurance: result.employmentInsurance?.employee ?? 0n,
      incomeTax: result.incomeTax,
      residentTax: result.residentTax,
      adjustments: result.adjustments,
      total: result.totalDeductions,
    },
    netPay: result.netPay,
    reference: {
      healthSmr: input.coverage.health ? input.standardRemuneration.health : null,
      pensionSmr: input.coverage.pension ? input.standardRemuneration.pension : null,
      taxColumn: input.taxColumn,
      premiumMonth: run.premiumMonth,
      coverage: input.coverage,
      adjustmentNote: item.adjustmentNote,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 納付の予定 (§7) and 納付 (§5.4)
// ---------------------------------------------------------------------------------------------

export interface PayrollScheduleRow {
  /** The calendar item. */
  id: string;
  category: PayrollPaymentCategory;
  categoryLabel: string;
  ruleKey: string;
  title: string;
  dueDate: CalendarDate;
  /** Derived from the confirmed runs (§7.2). */
  amount: Money;
  /** 預り金 part (all of it for 源泉所得税・住民税; the employee share for 社会保険料). */
  withheld: Money;
  /** 未払費用〔社会保険料〕 part (社会保険料 only). */
  employer: Money;
  /** The pay months of the monthly runs paying into it. */
  payMonths: YearMonth[];
  /** The pay months of the bonus runs paying into it (22-payroll §10.4). */
  bonusMonths: YearMonth[];
  completedAt: Date | null;
  completedBy: string | null;
  /** The entry `postPayrollPayment` made, when it was registered here. */
  paymentEntry: EntryRef | null;
}

export function scheduleRowOf(
  item: CalendarItem,
  runs: readonly PayrollRunSummary[],
  paymentEntry: EntryRef | null,
): PayrollScheduleRow | null {
  const category = item.ruleKey ? paymentCategoryOfRuleKey(item.ruleKey) : null;
  if (!category || !item.ruleKey) return null;
  const amount = scheduleAmount(item.ruleKey, runs);
  return {
    id: item.id,
    category,
    categoryLabel: PAYROLL_PAYMENT_CATEGORY_LABELS[category],
    ruleKey: item.ruleKey,
    title: item.title,
    dueDate: fromDbDate(item.dueDate),
    amount: amount.total,
    withheld: amount.withheld,
    employer: amount.employer,
    payMonths: amount.payMonths,
    bonusMonths: amount.bonusMonths,
    completedAt: item.completedAt,
    completedBy: item.completedBy,
    paymentEntry,
  };
}

/** 納付の予定: every deadline made by the pay runs, by due date, with derived amounts and state. */
export async function listPayrollSchedule(db: Db): Promise<PayrollScheduleRow[]> {
  const [items, summaries] = await Promise.all([
    db.calendarItem.findMany({
      where: { fiscalYearId: null, ruleKey: { startsWith: PAYROLL_RULE_KEY_PREFIX } },
      orderBy: [{ dueDate: "asc" }, { ruleKey: "asc" }],
    }),
    loadSummaries(db),
  ]);
  const entries = await db.journalEntry.findMany({
    where: {
      sourceKind: "payroll",
      sourceId: { in: items.map((item) => item.id) },
      status: "posted",
      reversalOfId: null,
    },
    select: { id: true, no: true, entryDate: true, sourceId: true },
    orderBy: { createdAt: "desc" },
  });
  const paymentEntries = new Map<string, EntryRef>();
  for (const entry of entries) {
    if (entry.sourceId && !paymentEntries.has(entry.sourceId)) {
      paymentEntries.set(entry.sourceId, {
        id: entry.id,
        no: entry.no,
        entryDate: fromDbDate(entry.entryDate),
      });
    }
  }
  return items
    .map((item) => scheduleRowOf(item, summaries, paymentEntries.get(item.id) ?? null))
    .filter((row): row is PayrollScheduleRow => row !== null)
    .sort(
      (a, b) =>
        (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
        PAYROLL_PAYMENT_CATEGORIES.indexOf(a.category) -
          PAYROLL_PAYMENT_CATEGORIES.indexOf(b.category),
    );
}

interface PaymentPlan {
  item: CalendarItem;
  category: PayrollPaymentCategory;
  scheduled: PaymentAmount;
  paid: Money;
  plan: PayrollEntryPlan;
  data: ParsedPayrollPayment;
}

async function lockCalendarItem(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "calendar_item" WHERE "id" = ${id} FOR UPDATE`;
}

/** The open payroll deadline `id`, or an owner-facing error. */
async function openPayrollItem(db: Db, id: string, field: string): Promise<CalendarItem> {
  const item = await db.calendarItem.findUnique({ where: { id } });
  const category = item?.ruleKey ? paymentCategoryOfRuleKey(item.ruleKey) : null;
  if (!item || !category || item.fiscalYearId !== null) {
    throw new SettingsError("納付の予定が見つかりません。画面を読み込み直してください", { field });
  }
  if (item.completedAt) {
    throw new SettingsError(`「${item.title}」は納付済みです`, { field });
  }
  return item;
}

async function planPayment(db: Db, data: ParsedPayrollPayment): Promise<PaymentPlan> {
  const item = await openPayrollItem(db, data.calendarItemId, "calendarItemId");
  const category = paymentCategoryOfRuleKey(item.ruleKey ?? "");
  if (!category) throw new Error("unreachable: checked by openPayrollItem");
  const {
    payMonths: _payMonths,
    bonusMonths: _bonusMonths,
    ...scheduled
  } = scheduleAmount(item.ruleKey ?? "", await loadSummaries(db));
  if (scheduled.total <= 0n) {
    throw new SettingsError(
      `「${item.title}」の納付予定の額は ${formatYen(scheduled.total)} 円です。納付する額がないので「納付済みにする」で片付けてください`,
    );
  }
  const label = PAYROLL_PAYMENT_CATEGORY_LABELS[category];
  if (category !== "social_insurance" && data.amount !== null && data.amount !== scheduled.total) {
    throw new SettingsError(
      `${label}は納付予定の額（${formatYen(scheduled.total)} 円）で登録します。実際に払った額が違うときは、登録した後に取引で直してください`,
      { field: "amount" },
    );
  }
  const paid = data.amount ?? scheduled.total;
  return {
    item,
    category,
    scheduled,
    paid,
    plan: buildPaymentEntry({ category, description: item.title, scheduled, paid }),
    data,
  };
}

export interface PayrollPaymentPreview {
  item: PayrollScheduleRow;
  paid: Money;
  /** 社会保険料: paid − scheduled, booked on 5220 法定福利費 (0 for the others). */
  difference: Money;
  entry: PayrollEntryPreview;
}

/** What `postPayrollPayment` would post (the 法定福利費 line of a 社会保険料 difference included). */
export async function previewPayrollPayment(
  db: Db,
  input: PayrollPaymentInput,
): Promise<PayrollPaymentPreview> {
  const payment = await planPayment(db, payrollPaymentSchema.parse(input));
  try {
    const refs = await loadLedgerRefs(db, {
      date: payment.data.paymentDate,
      walletId: payment.data.walletId,
      lock: false,
      dateField: "paymentDate",
      walletField: "walletId",
    });
    const { entry, preview } = toJournalEntry(payment.plan, refs, {
      date: payment.data.paymentDate,
      sourceId: payment.item.id,
      pendingSubAccounts: true,
    });
    assertPostable(entry, refs);
    const row = scheduleRowOf(payment.item, await loadSummaries(db), null);
    if (!row) throw new Error("unreachable: a payroll deadline");
    return {
      item: row,
      paid: payment.paid,
      difference: payment.paid - payment.scheduled.total,
      entry: preview,
    };
  } catch (error) {
    if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
    throw error;
  }
}

export interface PayrollPaymentResult {
  item: PayrollScheduleRow;
  entry: EntryRef;
}

/**
 * 納付を登録 (§5.4): posts 預り金 (+ 未払費用〔社会保険料〕, + the difference on 法定福利費) against the
 * wallet on the chosen date and marks the deadline paid, in one transaction. 源泉所得税・住民税 are
 * paid at the scheduled amount; 社会保険料 at the 納入告知額 given (default: the scheduled amount).
 */
export async function postPayrollPayment(
  db: Db,
  input: PayrollPaymentInput,
  options: ActorOptions,
): Promise<PayrollPaymentResult> {
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "payroll");
    const data = payrollPaymentSchema.parse(input);
    await lockCalendarItem(tx, data.calendarItemId);
    const payment = await planPayment(tx, data);
    let entryRef: EntryRef;
    try {
      const refs = await loadLedgerRefs(tx, {
        date: payment.data.paymentDate,
        walletId: payment.data.walletId,
        lock: true,
        dateField: "paymentDate",
        walletField: "walletId",
      });
      await ensurePayrollSubAccounts(tx, refs, options);
      const { entry } = toJournalEntry(payment.plan, refs, {
        date: payment.data.paymentDate,
        sourceId: payment.item.id,
        pendingSubAccounts: false,
      });
      const posted = await postJournalEntryInTransaction(
        tx,
        { ...entry, fiscalYearId: refs.fiscalYear.id },
        options,
      );
      entryRef = { id: posted.id, no: posted.no, entryDate: posted.entryDate };
    } catch (error) {
      if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
      throw error;
    }
    const completedAt = new Date();
    const updated = await tx.calendarItem.update({
      where: { id: payment.item.id },
      data: { completedAt, completedBy: options.actor },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payroll_payment.post",
      entity: "calendar_item",
      entityId: payment.item.id,
      before: { completedAt: null },
      after: {
        completedAt,
        completedBy: options.actor,
        journalEntryId: entryRef.id,
        walletId: payment.data.walletId,
        paymentDate: payment.data.paymentDate,
        paid: payment.paid,
        scheduled: payment.scheduled,
      },
    });
    const row = scheduleRowOf(updated, await loadSummaries(tx), entryRef);
    if (!row) throw new Error("unreachable: a payroll deadline");
    return { item: row, entry: entryRef };
  });
}

/**
 * 納付済みにする: completes the deadline without posting (the payment was registered from the
 * wallet's statement, S5). Audit log `calendar_item.complete`.
 */
export async function markPayrollPaymentDone(
  db: Db,
  calendarItemId: string,
  options: ActorOptions,
): Promise<PayrollScheduleRow> {
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "payroll");
    if (typeof calendarItemId !== "string" || calendarItemId === "" || calendarItemId.length > 64) {
      throw new SettingsError("納付の予定が見つかりません。画面を読み込み直してください");
    }
    await lockCalendarItem(tx, calendarItemId);
    const item = await openPayrollItem(tx, calendarItemId, "calendarItemId");
    const completedAt = new Date();
    const updated = await tx.calendarItem.update({
      where: { id: item.id },
      data: { completedAt, completedBy: options.actor },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "calendar_item.complete",
      entity: "calendar_item",
      entityId: item.id,
      before: { completedAt: null, completedBy: null },
      after: { completedAt, completedBy: options.actor },
    });
    const row = scheduleRowOf(updated, await loadSummaries(tx), null);
    if (!row) throw new Error("unreachable: a payroll deadline");
    return row;
  });
}
