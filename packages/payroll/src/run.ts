import { lastDayOfMonth, type CalendarDate, type Money, type Side } from "@niho-finance/ledger";
import { PayrollSnapshotError } from "./errors";
import { parseYearMonth, shiftYearMonth, yearMonthParts, type YearMonth } from "./month";
import type {
  PayrollAdjustments,
  PayrollCoverage,
  PayrollInput,
  PayrollResult,
  PayrollTables,
  WorkerKind,
} from "./payroll";
import { findTableById } from "./registry";
import {
  child,
  fail,
  money,
  nonNegativeMoney,
  readCoverage,
  readEmploymentInsurance,
  readSocialInsurance,
  readTableRef,
  readTaxColumn,
  record,
  text,
  toSnapshotJson,
  type SnapshotJson,
} from "./snapshot";
import { aggregateSocialInsurance, type SocialInsuranceAggregate } from "./social-insurance";
import type { TaxColumn } from "./withholding";

/**
 * A confirmed pay run (22-payroll §5・§7) as pure data: the premium month of a pay month, the
 * journal lines of the pay entry, the employer entry and the payments (by account code and
 * sub-account name: the database layer only looks the ids up), the payment deadlines with their
 * rule keys, the scheduled amounts derived from the confirmed runs (derive, don't sync) and the
 * snapshot of the run's items (bigint ↔ string) with its strict reader.
 */

// ---------------------------------------------------------------------------------------------
// Months and labels
// ---------------------------------------------------------------------------------------------

/** 社会保険料の控除の月: 翌月控除 (the previous month's premium, the default) or 当月控除. */
export const PREMIUM_TIMINGS = ["next_month", "same_month"] as const;
export type PremiumTiming = (typeof PREMIUM_TIMINGS)[number];

export const PREMIUM_TIMING_LABELS: Readonly<Record<PremiumTiming, string>> = {
  next_month: "翌月控除",
  same_month: "当月控除",
};

/** 対象月 of the premiums deducted from the pay of `payMonth`: the month before for 翌月控除. */
export function premiumMonthFor(payMonth: YearMonth, timing: PremiumTiming): YearMonth {
  const month = parseYearMonth(payMonth);
  switch (timing) {
    case "next_month":
      return shiftYearMonth(month, -1);
    case "same_month":
      return month;
  }
  throw new RangeError(`premiumMonthFor: "${String(timing)}" is not a premium timing`);
}

/** `"2026-12"` → 「2026 年 12 月」. */
export function yearMonthLabel(value: YearMonth): string {
  const { year, month } = yearMonthParts(value);
  return `${year} 年 ${month} 月`;
}

function dateOf(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/** The 10th of the month after `month` (源泉所得税・住民税の納期). */
function tenthOfNextMonth(month: YearMonth): CalendarDate {
  const { year, month: m } = yearMonthParts(shiftYearMonth(month, 1));
  return dateOf(year, m, 10);
}

// ---------------------------------------------------------------------------------------------
// Payment deadlines (§7.1)
// ---------------------------------------------------------------------------------------------

export const PAYROLL_PAYMENT_CATEGORIES = [
  "withholding",
  "resident_tax",
  "social_insurance",
] as const;
export type PayrollPaymentCategory = (typeof PAYROLL_PAYMENT_CATEGORIES)[number];

export const PAYROLL_PAYMENT_CATEGORY_LABELS: Readonly<Record<PayrollPaymentCategory, string>> = {
  withholding: "源泉所得税",
  resident_tax: "住民税",
  social_insurance: "社会保険料",
};

/** Calendar items made by pay runs have rule keys starting with this (07 §4 keeps clear of it). */
export const PAYROLL_RULE_KEY_PREFIX = "payroll.";

/** One payment deadline: the calendar item a pay run adds to. */
export interface PayrollPaymentSlot {
  category: PayrollPaymentCategory;
  /** e.g. `payroll.withholding.2026-12`, `payroll.resident_tax.2026-12to2027-05`. */
  ruleKey: string;
  /** e.g. 「源泉所得税の納付（2026 年 12 月支給分）」. */
  title: string;
  /** The legal date, not moved off weekends or holidays (paying early is never late). */
  dueDate: CalendarDate;
  /** What the payment covers, e.g. 「2026 年 12 月支給分」「2026 年 11 月分」. */
  periodLabel: string;
}

/**
 * 源泉所得税: by the 10th of the month after the pay month; with 納期の特例, pay months January to
 * June by 10 July and July to December by 20 January of the next year.
 */
export function withholdingSlot(payMonth: YearMonth, specialDue: boolean): PayrollPaymentSlot {
  const { year, month } = yearMonthParts(payMonth);
  if (!specialDue) {
    const periodLabel = `${yearMonthLabel(payMonth)}支給分`;
    return {
      category: "withholding",
      ruleKey: `${PAYROLL_RULE_KEY_PREFIX}withholding.${payMonth}`,
      title: `源泉所得税の納付（${periodLabel}）`,
      dueDate: tenthOfNextMonth(payMonth),
      periodLabel,
    };
  }
  const firstHalf = month <= 6;
  const periodLabel = firstHalf ? `${year} 年 1〜6 月支給分` : `${year} 年 7〜12 月支給分`;
  return {
    category: "withholding",
    ruleKey: `${PAYROLL_RULE_KEY_PREFIX}withholding.${year}-${firstHalf ? "H1" : "H2"}`,
    title: `源泉所得税の納付（${periodLabel}・納期の特例）`,
    dueDate: firstHalf ? dateOf(year, 7, 10) : dateOf(year + 1, 1, 20),
    periodLabel,
  };
}

function monthRangeLabel(from: YearMonth, to: YearMonth): string {
  const start = yearMonthParts(from);
  const end = yearMonthParts(to);
  return start.year === end.year
    ? `${start.year} 年 ${start.month}〜${end.month} 月分`
    : `${start.year} 年 ${start.month} 月〜${end.year} 年 ${end.month} 月分`;
}

/**
 * 住民税（特別徴収）: by the 10th of the month after the pay month; with 納期の特例, June to
 * November by 10 December and December to May by 10 June.
 */
export function residentTaxSlot(payMonth: YearMonth, specialDue: boolean): PayrollPaymentSlot {
  const { year, month } = yearMonthParts(payMonth);
  if (!specialDue) {
    const periodLabel = `${yearMonthLabel(payMonth)}分`;
    return {
      category: "resident_tax",
      ruleKey: `${PAYROLL_RULE_KEY_PREFIX}resident_tax.${payMonth}`,
      title: `住民税の納付（${periodLabel}）`,
      dueDate: tenthOfNextMonth(payMonth),
      periodLabel,
    };
  }
  const summer = month >= 6 && month <= 11;
  const startYear = summer || month === 12 ? year : year - 1;
  const from = parseYearMonth(`${String(startYear).padStart(4, "0")}-${summer ? "06" : "12"}`);
  const to = shiftYearMonth(from, 5);
  const dueYear = yearMonthParts(to).year;
  const periodLabel = monthRangeLabel(from, to);
  return {
    category: "resident_tax",
    ruleKey: `${PAYROLL_RULE_KEY_PREFIX}resident_tax.${from}to${to}`,
    title: `住民税の納付（${periodLabel}・納期の特例）`,
    dueDate: summer ? dateOf(dueYear, 12, 10) : dateOf(dueYear, 6, 10),
    periodLabel,
  };
}

/** 社会保険料: by the last day of the month after the premium month. */
export function socialInsuranceSlot(premiumMonth: YearMonth): PayrollPaymentSlot {
  const { year, month } = yearMonthParts(shiftYearMonth(premiumMonth, 1));
  const periodLabel = `${yearMonthLabel(premiumMonth)}分`;
  return {
    category: "social_insurance",
    ruleKey: `${PAYROLL_RULE_KEY_PREFIX}social_insurance.${parseYearMonth(premiumMonth)}`,
    title: `社会保険料の納付（${periodLabel}）`,
    dueDate: lastDayOfMonth(year, month),
    periodLabel,
  };
}

/** The settings of a run that decide its payment deadlines. */
export interface PayrollRunSettings {
  payMonth: YearMonth;
  premiumMonth: YearMonth;
  withholdingSpecialDue: boolean;
  residentTaxSpecialDue: boolean;
}

export function paymentSlotFor(
  category: PayrollPaymentCategory,
  run: PayrollRunSettings,
): PayrollPaymentSlot {
  switch (category) {
    case "withholding":
      return withholdingSlot(run.payMonth, run.withholdingSpecialDue);
    case "resident_tax":
      return residentTaxSlot(run.payMonth, run.residentTaxSpecialDue);
    case "social_insurance":
      return socialInsuranceSlot(run.premiumMonth);
  }
}

/** The category of a pay run's calendar item, or `null` for a rule key not made by pay runs. */
export function paymentCategoryOfRuleKey(ruleKey: string): PayrollPaymentCategory | null {
  if (!ruleKey.startsWith(PAYROLL_RULE_KEY_PREFIX)) return null;
  const rest = ruleKey.slice(PAYROLL_RULE_KEY_PREFIX.length);
  return PAYROLL_PAYMENT_CATEGORIES.find((category) => rest.startsWith(`${category}.`)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Scheduled amounts (§7.2): derived from the confirmed runs
// ---------------------------------------------------------------------------------------------

/** What a confirmed run owes, by category (22-payroll §7.2). */
export interface PayrollRunSummary extends PayrollRunSettings {
  /**
   * `bonus` for a 賞与 run (22-payroll §10.4: its premium month is its pay month, no 住民税);
   * `year_end` for the settlement of a 年末調整 (§11.4: `incomeTax` is the 過不足, + 不足 / − 過納,
   * added to the 源泉所得税 of the last pay run's month). Left out for a monthly run.
   */
  kind?: "monthly" | "bonus" | "year_end";
  headcount: number;
  grossPay: Money;
  totalDeductions: Money;
  netPay: Money;
  /** 源泉所得税（調整後）の合計. */
  incomeTax: Money;
  residentTax: Money;
  /** 健保・厚年の本人分（調整後）の合計 (預り金〔社会保険料〕). */
  socialInsuranceEmployee: Money;
  /** The employer entry's amount (未払費用〔社会保険料〕): `aggregateSocialInsurance().employerTotal`. */
  socialInsuranceEmployer: Money;
  /** 雇用保険の本人分の合計 (預り金〔雇用保険料〕, paid through 年度更新; no deadline here). */
  employmentInsuranceEmployee: Money;
}

export function summarizePayrollRun(
  run: PayrollRunSettings & { items: readonly { result: PayrollResult }[] },
): PayrollRunSummary {
  let grossPay = 0n;
  let totalDeductions = 0n;
  let netPay = 0n;
  let incomeTax = 0n;
  let residentTax = 0n;
  let socialInsuranceEmployee = 0n;
  let employmentInsuranceEmployee = 0n;
  for (const { result } of run.items) {
    grossPay += result.grossPay;
    totalDeductions += result.totalDeductions;
    netPay += result.netPay;
    incomeTax += result.incomeTaxTotal;
    residentTax += result.residentTax;
    socialInsuranceEmployee += result.socialInsuranceEmployeeTotal;
    employmentInsuranceEmployee += result.employmentInsurance?.employee ?? 0n;
  }
  return {
    payMonth: run.payMonth,
    premiumMonth: run.premiumMonth,
    withholdingSpecialDue: run.withholdingSpecialDue,
    residentTaxSpecialDue: run.residentTaxSpecialDue,
    headcount: run.items.length,
    grossPay,
    totalDeductions,
    netPay,
    incomeTax,
    residentTax,
    socialInsuranceEmployee,
    socialInsuranceEmployer: aggregateSocialInsurance(
      run.items.map(({ result }) => result.socialInsurance),
    ).employerTotal,
    employmentInsuranceEmployee,
  };
}

/** A scheduled payment's amount and how it splits between the accounts it clears. */
export interface PaymentAmount {
  total: Money;
  /** The withheld part (預り金): everything for 源泉所得税・住民税, the employee share for 社会保険料. */
  withheld: Money;
  /** The employer part (未払費用〔社会保険料〕): 0 except for 社会保険料. */
  employer: Money;
}

function runAmount(category: PayrollPaymentCategory, run: PayrollRunSummary): PaymentAmount {
  switch (category) {
    case "withholding":
      return { total: run.incomeTax, withheld: run.incomeTax, employer: 0n };
    case "resident_tax":
      return { total: run.residentTax, withheld: run.residentTax, employer: 0n };
    case "social_insurance":
      return {
        total: run.socialInsuranceEmployee + run.socialInsuranceEmployer,
        withheld: run.socialInsuranceEmployee,
        employer: run.socialInsuranceEmployer,
      };
  }
}

function isNonZero(amount: PaymentAmount): boolean {
  return amount.total !== 0n || amount.withheld !== 0n || amount.employer !== 0n;
}

/** The deadlines one run adds to, with that run's own amounts; categories of 0 円 are left out. */
export function runPaymentSlots(
  run: PayrollRunSummary,
): { slot: PayrollPaymentSlot; amount: PaymentAmount }[] {
  return PAYROLL_PAYMENT_CATEGORIES.map((category) => ({
    slot: paymentSlotFor(category, run),
    amount: runAmount(category, run),
  })).filter(({ amount }) => isNonZero(amount));
}

/** What the runs paying into one deadline add up to, and which runs they are. */
export interface ScheduleAmount extends PaymentAmount {
  /** The pay months of the monthly runs that pay into it. */
  payMonths: YearMonth[];
  /** The pay months of the bonus runs that pay into it (22-payroll §10.4). */
  bonusMonths: YearMonth[];
  /** The pay months of the 年末調整 settlements in it (§11.4: the last pay run's month). */
  yearEndMonths: YearMonth[];
}

/**
 * The derived amount of the payment `ruleKey` (22-payroll §7.2): the sum over the confirmed runs
 * that pay into it (a 年末調整's refund makes a 源泉所得税 sum smaller, even negative: see
 * `scheduledPayments` for the carry-over). 0 for a rule key no run pays into (or one not made by
 * pay runs).
 */
export function scheduleAmount(
  ruleKey: string,
  runs: readonly PayrollRunSummary[],
): ScheduleAmount {
  const category = paymentCategoryOfRuleKey(ruleKey);
  const amount: ScheduleAmount = {
    total: 0n,
    withheld: 0n,
    employer: 0n,
    payMonths: [],
    bonusMonths: [],
    yearEndMonths: [],
  };
  if (!category) return amount;
  for (const run of runs) {
    if (paymentSlotFor(category, run).ruleKey !== ruleKey) continue;
    const own = runAmount(category, run);
    // A bonus run or a settlement pays only into the deadlines it has an amount for.
    if (run.kind !== undefined && run.kind !== "monthly" && !isNonZero(own)) continue;
    amount.total += own.total;
    amount.withheld += own.withheld;
    amount.employer += own.employer;
    (run.kind === "bonus"
      ? amount.bonusMonths
      : run.kind === "year_end"
        ? amount.yearEndMonths
        : amount.payMonths
    ).push(run.payMonth);
  }
  amount.payMonths.sort();
  amount.bonusMonths.sort();
  amount.yearEndMonths.sort();
  return amount;
}

/**
 * The settlement of a confirmed 年末調整 (22-payroll §11.4) in the shape of a run's summary, so that
 * the schedule adds it: `difference` (年調年税額 − 徴収済み税額; + 不足, − 過納) goes to the 源泉所得税
 * deadline of the last pay run's month (its half year with 納期の特例).
 */
export function summarizeYearEndSettlement(settlement: {
  payMonth: YearMonth;
  withholdingSpecialDue: boolean;
  difference: Money;
}): PayrollRunSummary {
  return {
    kind: "year_end",
    payMonth: settlement.payMonth,
    premiumMonth: settlement.payMonth,
    withholdingSpecialDue: settlement.withholdingSpecialDue,
    residentTaxSpecialDue: false,
    headcount: 1,
    grossPay: 0n,
    totalDeductions: 0n,
    netPay: 0n,
    incomeTax: settlement.difference,
    residentTax: 0n,
    socialInsuranceEmployee: 0n,
    socialInsuranceEmployer: 0n,
    employmentInsuranceEmployee: 0n,
  };
}

/** A deadline as the calendar holds it: what the carry-over needs to order them. */
export interface PayrollScheduleSlotRef {
  ruleKey: string;
  dueDate: CalendarDate;
}

/** The scheduled amount of a deadline after the carry-over of refunds (§11.4). */
export interface ScheduledPayment extends ScheduleAmount {
  /** What the runs add up to before the carry-over (源泉所得税 may be negative after a refund). */
  derived: Money;
  /** 源泉所得税: the refund (過納) of earlier deadlines taken off this one (充当). */
  refundApplied: Money;
  /** 源泉所得税: the refund still left after this deadline, carried to the next ones. */
  refundCarried: Money;
}

const byDueDate = (a: PayrollScheduleSlotRef, b: PayrollScheduleSlotRef) =>
  (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
  (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0);

/**
 * The scheduled amounts of the deadlines `slots` (22-payroll §7.2・§11.4). 住民税 and 社会保険料 are
 * their derived sums. 源泉所得税 deadlines are taken in due-date order: a deadline whose sum would
 * be negative (a 年末調整's refund larger than what was withheld for it) is 0 — 「納付なし」 — and the
 * rest of the refund is taken off the next 源泉所得税 deadlines (翌月以降の源泉所得税から充当), as
 * far as they go; `refundCarried` of the last one is what is still to be applied. The sum of the
 * amounts minus that last carry is always the sum of what the runs withheld.
 */
export function scheduledPayments(
  slots: readonly PayrollScheduleSlotRef[],
  runs: readonly PayrollRunSummary[],
): Map<string, ScheduledPayment> {
  const result = new Map<string, ScheduledPayment>();
  for (const slot of slots) {
    const amount = scheduleAmount(slot.ruleKey, runs);
    result.set(slot.ruleKey, {
      ...amount,
      derived: amount.total,
      refundApplied: 0n,
      refundCarried: 0n,
    });
  }
  const withholding = [...new Map(slots.map((slot) => [slot.ruleKey, slot])).values()]
    .filter((slot) => paymentCategoryOfRuleKey(slot.ruleKey) === "withholding")
    .sort(byDueDate);
  let carry = 0n;
  for (const slot of withholding) {
    const payment = result.get(slot.ruleKey);
    if (!payment) continue;
    const net = payment.derived - carry;
    if (net >= 0n) {
      payment.refundApplied = carry;
      payment.refundCarried = 0n;
      payment.total = net;
      carry = 0n;
    } else {
      payment.refundApplied = payment.derived > 0n ? payment.derived : 0n;
      payment.refundCarried = -net;
      payment.total = 0n;
      carry = -net;
    }
    payment.withheld = payment.total;
  }
  return result;
}

export interface PayrollScheduleEntry extends PayrollPaymentSlot, ScheduledPayment {}

/**
 * Every deadline the runs pay into (a run's 0 円 categories make none), with the scheduled amounts
 * (after the carry-over of refunds), by due date and then 源泉所得税 → 住民税 → 社会保険料.
 */
export function payrollSchedule(runs: readonly PayrollRunSummary[]): PayrollScheduleEntry[] {
  const slots = new Map<string, PayrollPaymentSlot>();
  for (const run of runs) {
    for (const { slot } of runPaymentSlots(run)) slots.set(slot.ruleKey, slot);
  }
  const amounts = scheduledPayments([...slots.values()], runs);
  return [...slots.values()]
    .map((slot): PayrollScheduleEntry => {
      const amount = amounts.get(slot.ruleKey);
      if (!amount) throw new Error(`payrollSchedule: no amount for ${slot.ruleKey}`);
      return { ...slot, ...amount };
    })
    .sort(
      (a, b) =>
        (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
        PAYROLL_PAYMENT_CATEGORIES.indexOf(a.category) -
          PAYROLL_PAYMENT_CATEGORIES.indexOf(b.category) ||
        (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0),
    );
}

// ---------------------------------------------------------------------------------------------
// Journal lines (§5.3・§5.4)
// ---------------------------------------------------------------------------------------------

/** The accounts of the pay run entries, by code (標準の勘定科目). */
export const PAYROLL_ACCOUNT_CODES = {
  /** 役員報酬 */
  officerPay: "5200",
  /** 給料手当 */
  salaries: "5210",
  /** 法定福利費 */
  welfare: "5220",
  /** 旅費交通費 (通勤手当) */
  commute: "5360",
  /** 預り金 */
  withheld: "2300",
  /** 未払金 */
  accruedPay: "2100",
  /** 未払費用 */
  accruedExpenses: "2110",
} as const;

/** The sub-accounts the first confirmation makes (22-payroll §5.2). */
export const PAYROLL_SUB_ACCOUNTS = {
  withholdingTax: { accountCode: "2300", name: "源泉所得税" },
  residentTax: { accountCode: "2300", name: "住民税" },
  socialInsurance: { accountCode: "2300", name: "社会保険料" },
  employmentInsurance: { accountCode: "2300", name: "雇用保険料" },
  pay: { accountCode: "2100", name: "給与" },
  employerSocialInsurance: { accountCode: "2110", name: "社会保険料" },
} as const;
export type PayrollSubAccountKey = keyof typeof PAYROLL_SUB_ACCOUNTS;

/** A line's account: by code and sub-account name, or the wallet the money is paid from. */
export type PayrollLineTarget =
  { kind: "account"; accountCode: string; subAccountName: string | null } | { kind: "wallet" };

export interface PayrollEntryLine {
  side: Side;
  target: PayrollLineTarget;
  /** Positive. Tax-inclusive: the database layer splits the tax per the fiscal year. */
  amount: Money;
  taxCategoryCode: string;
}

export interface PayrollEntryPlan {
  description: string;
  lines: PayrollEntryLine[];
}

const NOT_TAXED = "na";

function account(code: string, subAccountName: string | null = null): PayrollLineTarget {
  return { kind: "account", accountCode: code, subAccountName };
}

function sub(key: PayrollSubAccountKey): PayrollLineTarget {
  const { accountCode, name } = PAYROLL_SUB_ACCOUNTS[key];
  return account(accountCode, name);
}

/** Adds a line: 0 is left out, a negative total goes to the other side (22-payroll §5.3). */
function place(
  lines: PayrollEntryLine[],
  side: Side,
  target: PayrollLineTarget,
  amount: Money,
  taxCategoryCode: string = NOT_TAXED,
): void {
  if (amount === 0n) return;
  const flipped = amount < 0n;
  lines.push({
    side: flipped ? (side === "debit" ? "credit" : "debit") : side,
    target,
    amount: flipped ? -amount : amount,
    taxCategoryCode,
  });
}

export interface PayrollEntryItem {
  kind: WorkerKind;
  input: { taxablePay: Money; nonTaxablePay: Money };
  result: PayrollResult;
}

export interface BuildPayrollEntriesInput {
  payMonth: YearMonth;
  premiumMonth: YearMonth;
  items: readonly PayrollEntryItem[];
  /** `wallet`: paid from the run's wallet on the payment date; `accrued`: 未払金〔給与〕. */
  payFrom: "wallet" | "accrued";
  /** 5360 旅費交通費's default tax category (課税仕入 for commuting). */
  commuteTaxCategoryCode: string;
}

export interface PayrollEntries {
  /** 1 本目「給与 2026 年 12 月支給」 (本人分). */
  pay: PayrollEntryPlan;
  /** 2 本目「法定福利費 2026 年 11 月分」 (会社負担), `null` when it is 0. */
  employer: PayrollEntryPlan | null;
  /** The office's premiums of the premium month (納入告知額 and the employer share). */
  socialInsurance: SocialInsuranceAggregate;
}

/**
 * The two entries of a confirmed run (22-payroll §5.3). Pay entry: 役員報酬 / 給料手当 / 旅費交通費
 * against 預り金〔源泉所得税・住民税・社会保険料・雇用保険料〕 and 未払金〔給与〕 (or the wallet).
 * Employer entry: 法定福利費 / 未払費用〔社会保険料〕 for the employer share and 拠出金. Lines of 0 円
 * are left out; a negative total (an adjustment) goes to the other side. The pay entry balances
 * because every person's gross pay = deductions + net pay.
 */
export function buildPayrollEntries(input: BuildPayrollEntriesInput): PayrollEntries {
  let officerPay = 0n;
  let salaries = 0n;
  let commute = 0n;
  let incomeTax = 0n;
  let residentTax = 0n;
  let socialInsurance = 0n;
  let employmentInsurance = 0n;
  let netPay = 0n;
  for (const item of input.items) {
    if (item.kind === "officer") officerPay += item.input.taxablePay;
    else salaries += item.input.taxablePay;
    commute += item.input.nonTaxablePay;
    incomeTax += item.result.incomeTaxTotal;
    residentTax += item.result.residentTax;
    socialInsurance += item.result.socialInsuranceEmployeeTotal;
    employmentInsurance += item.result.employmentInsurance?.employee ?? 0n;
    netPay += item.result.netPay;
  }
  const pay: PayrollEntryLine[] = [];
  place(pay, "debit", account(PAYROLL_ACCOUNT_CODES.officerPay), officerPay);
  place(pay, "debit", account(PAYROLL_ACCOUNT_CODES.salaries), salaries);
  place(
    pay,
    "debit",
    account(PAYROLL_ACCOUNT_CODES.commute),
    commute,
    input.commuteTaxCategoryCode,
  );
  place(pay, "credit", sub("withholdingTax"), incomeTax);
  place(pay, "credit", sub("residentTax"), residentTax);
  place(pay, "credit", sub("socialInsurance"), socialInsurance);
  place(pay, "credit", sub("employmentInsurance"), employmentInsurance);
  place(pay, "credit", input.payFrom === "wallet" ? { kind: "wallet" } : sub("pay"), netPay);

  const aggregate = aggregateSocialInsurance(
    input.items.map(({ result }) => result.socialInsurance),
  );
  const employer: PayrollEntryLine[] = [];
  place(employer, "debit", account(PAYROLL_ACCOUNT_CODES.welfare), aggregate.employerTotal);
  place(employer, "credit", sub("employerSocialInsurance"), aggregate.employerTotal);

  return {
    pay: { description: `給与 ${yearMonthLabel(input.payMonth)}支給`, lines: pay },
    employer:
      employer.length > 0
        ? { description: `法定福利費 ${yearMonthLabel(input.premiumMonth)}分`, lines: employer }
        : null,
    socialInsurance: aggregate,
  };
}

export interface PayrollPaymentPlanInput {
  category: PayrollPaymentCategory;
  /** The entry's description (the deadline's title). */
  description: string;
  scheduled: PaymentAmount;
  /**
   * The amount paid from the wallet. 源泉所得税・住民税: the scheduled total. 社会保険料: the
   * 納入告知額; the difference from the schedule goes to 法定福利費.
   */
  paid: Money;
}

/**
 * The entry of a payment (22-payroll §5.4): 預り金 (and for 社会保険料 未払費用〔社会保険料〕) against
 * the wallet. Throws `RangeError` when 源泉所得税・住民税 are paid with another amount than scheduled
 * or nothing is paid.
 */
export function buildPaymentEntry(input: PayrollPaymentPlanInput): PayrollEntryPlan {
  if (input.paid <= 0n) throw new RangeError("buildPaymentEntry: the amount paid must be positive");
  const lines: PayrollEntryLine[] = [];
  switch (input.category) {
    case "withholding":
    case "resident_tax": {
      if (input.paid !== input.scheduled.total) {
        throw new RangeError(
          `buildPaymentEntry: ${input.category} is paid as scheduled (${input.scheduled.total})`,
        );
      }
      place(
        lines,
        "debit",
        sub(input.category === "withholding" ? "withholdingTax" : "residentTax"),
        input.scheduled.withheld,
      );
      break;
    }
    case "social_insurance": {
      place(lines, "debit", sub("socialInsurance"), input.scheduled.withheld);
      place(lines, "debit", sub("employerSocialInsurance"), input.scheduled.employer);
      place(
        lines,
        "debit",
        account(PAYROLL_ACCOUNT_CODES.welfare),
        input.paid - input.scheduled.withheld - input.scheduled.employer,
      );
      break;
    }
  }
  place(lines, "credit", { kind: "wallet" }, input.paid);
  return { description: input.description, lines };
}

// ---------------------------------------------------------------------------------------------
// Snapshot of a run (§5.5)
// ---------------------------------------------------------------------------------------------

/** The `calculatePayroll` input of one person, without the run's dates and pinned tables. */
export interface PayrollRunItemInput {
  taxablePay: Money;
  nonTaxablePay: Money;
  residentTax: Money;
  standardRemuneration: { health: Money; pension: Money };
  coverage: PayrollCoverage;
  taxColumn: TaxColumn;
  adjustments: PayrollAdjustments;
}

/** One person of a confirmed run: what was entered and what was calculated. */
export interface PayrollRunItem {
  employeeId: string;
  /** The name at confirmation (the payslip shows this one). */
  name: string;
  kind: WorkerKind;
  input: PayrollRunItemInput;
  /** Why the adjustments were made; `null` without adjustments. */
  adjustmentNote: string | null;
  result: PayrollResult;
}

/** The table versions a run used (`PayrollRun.tableIds`). */
export interface PayrollTableIds {
  withholding: string;
  kenpo: string;
  pension: string;
  /** `null` when nobody was insured by 雇用保険. */
  employment: string | null;
}

/** The full `calculatePayroll` input of a stored item (tables pinned separately). */
export function payrollInputOf(
  run: { paymentDate: CalendarDate; premiumMonth: YearMonth },
  item: Pick<PayrollRunItem, "kind" | "input">,
  tables?: Partial<PayrollTables>,
): PayrollInput {
  return {
    paymentDate: run.paymentDate,
    premiumMonth: run.premiumMonth,
    worker: item.kind,
    ...item.input,
    ...(tables ? { tables } : {}),
  };
}

/** The table ids of a run's results; every result of one run uses the same versions. */
export function tableIdsOf(results: readonly PayrollResult[]): PayrollTableIds {
  const [first] = results;
  if (!first) throw new RangeError("tableIdsOf: a run has at least one result");
  const employment = results.find((result) => result.tables.employment !== null)?.tables.employment;
  const ids: PayrollTableIds = {
    withholding: first.tables.withholding.id,
    kenpo: first.tables.kenpo.id,
    pension: first.tables.pension.id,
    employment: employment?.id ?? null,
  };
  for (const result of results) {
    if (
      result.tables.withholding.id !== ids.withholding ||
      result.tables.kenpo.id !== ids.kenpo ||
      result.tables.pension.id !== ids.pension ||
      (result.tables.employment !== null && result.tables.employment.id !== ids.employment)
    ) {
      throw new RangeError("tableIdsOf: the results of one run use different table versions");
    }
  }
  return ids;
}

/**
 * The registered tables of stored ids, to pin a recalculation to the versions a run used. Throws
 * `PayrollSnapshotError` for an id that is not registered or of another kind.
 */
export function pinnedTables(ids: PayrollTableIds): Partial<PayrollTables> {
  const pick = <K extends keyof PayrollTables>(
    key: K,
    kind: PayrollTables[K]["kind"],
    id: string,
  ): PayrollTables[K] => {
    const table = findTableById(id);
    if (!table || table.kind !== kind) {
      throw new PayrollSnapshotError(
        `tableIds.${key}`,
        `"${id}" is not a registered ${kind} table`,
      );
    }
    return table as PayrollTables[K];
  };
  return {
    withholding: pick("withholding", "withholding-monthly", ids.withholding),
    kenpo: pick("kenpo", "kyokai-kenpo", ids.kenpo),
    pension: pick("pension", "pension", ids.pension),
    ...(ids.employment === null
      ? {}
      : { employment: pick("employment", "employment-insurance", ids.employment) }),
  };
}

export type { SnapshotJson } from "./snapshot";

/** `PayrollRun.items`: every amount (and rational) as a decimal string, no floating point. */
export function serializePayrollRunItems(items: readonly PayrollRunItem[]): SnapshotJson {
  return toSnapshotJson(items, "");
}

export function serializePayrollTableIds(ids: PayrollTableIds): SnapshotJson {
  return toSnapshotJson(ids, "");
}

// Strict reader: exact keys, exact types, normalized rationals, consistent totals.

function adjustmentsOf(value: unknown, path: string): PayrollAdjustments {
  const data = record(value, path, ["incomeTax", "socialInsurance"]);
  return {
    incomeTax: money(data.incomeTax, child(path, "incomeTax")),
    socialInsurance: money(data.socialInsurance, child(path, "socialInsurance")),
  };
}

function itemInputOf(value: unknown, path: string): PayrollRunItemInput {
  const data = record(value, path, [
    "taxablePay",
    "nonTaxablePay",
    "residentTax",
    "standardRemuneration",
    "coverage",
    "taxColumn",
    "adjustments",
  ]);
  const smrPath = child(path, "standardRemuneration");
  const smr = record(data.standardRemuneration, smrPath, ["health", "pension"]);
  return {
    taxablePay: nonNegativeMoney(data.taxablePay, child(path, "taxablePay")),
    nonTaxablePay: nonNegativeMoney(data.nonTaxablePay, child(path, "nonTaxablePay")),
    residentTax: nonNegativeMoney(data.residentTax, child(path, "residentTax")),
    standardRemuneration: {
      health: nonNegativeMoney(smr.health, child(smrPath, "health")),
      pension: nonNegativeMoney(smr.pension, child(smrPath, "pension")),
    },
    coverage: readCoverage(data.coverage, child(path, "coverage")),
    taxColumn: readTaxColumn(data.taxColumn, child(path, "taxColumn")),
    adjustments: adjustmentsOf(data.adjustments, child(path, "adjustments")),
  };
}

function resultOf(value: unknown, path: string): PayrollResult {
  const data = record(value, path, [
    "grossPay",
    "socialInsurance",
    "employmentInsurance",
    "withholdingBase",
    "incomeTax",
    "residentTax",
    "adjustments",
    "incomeTaxTotal",
    "socialInsuranceEmployeeTotal",
    "totalDeductions",
    "netPay",
    "tables",
  ]);
  const tablesPath = child(path, "tables");
  const tables = record(data.tables, tablesPath, ["withholding", "kenpo", "pension", "employment"]);

  const result: PayrollResult = {
    grossPay: nonNegativeMoney(data.grossPay, child(path, "grossPay")),
    socialInsurance: readSocialInsurance(data.socialInsurance, child(path, "socialInsurance")),
    employmentInsurance: readEmploymentInsurance(
      data.employmentInsurance,
      child(path, "employmentInsurance"),
    ),
    withholdingBase: money(data.withholdingBase, child(path, "withholdingBase")),
    incomeTax: nonNegativeMoney(data.incomeTax, child(path, "incomeTax")),
    residentTax: nonNegativeMoney(data.residentTax, child(path, "residentTax")),
    adjustments: adjustmentsOf(data.adjustments, child(path, "adjustments")),
    incomeTaxTotal: money(data.incomeTaxTotal, child(path, "incomeTaxTotal")),
    socialInsuranceEmployeeTotal: money(
      data.socialInsuranceEmployeeTotal,
      child(path, "socialInsuranceEmployeeTotal"),
    ),
    totalDeductions: money(data.totalDeductions, child(path, "totalDeductions")),
    netPay: money(data.netPay, child(path, "netPay")),
    tables: {
      withholding: readTableRef(tables.withholding, child(tablesPath, "withholding")),
      kenpo: readTableRef(tables.kenpo, child(tablesPath, "kenpo")),
      pension: readTableRef(tables.pension, child(tablesPath, "pension")),
      employment:
        tables.employment === null
          ? null
          : readTableRef(tables.employment, child(tablesPath, "employment")),
    },
  };
  // The totals the entries are made from must add up (22-payroll §8.5).
  if (result.grossPay - result.totalDeductions !== result.netPay) {
    fail(child(path, "netPay"), "is not grossPay − totalDeductions");
  }
  if (result.incomeTax + result.adjustments.incomeTax !== result.incomeTaxTotal) {
    fail(child(path, "incomeTaxTotal"), "is not incomeTax + adjustments.incomeTax");
  }
  if (
    result.socialInsurance.employeeTotal + result.adjustments.socialInsurance !==
    result.socialInsuranceEmployeeTotal
  ) {
    fail(
      child(path, "socialInsuranceEmployeeTotal"),
      "is not socialInsurance.employeeTotal + adjustments.socialInsurance",
    );
  }
  return result;
}

/**
 * Reads `PayrollRun.items` back. Strict: every key must be there and nothing else, amounts must be
 * whole-number strings, rationals normalized and the totals consistent. Throws
 * `PayrollSnapshotError` naming the path of the first problem.
 */
export function parsePayrollRunItems(json: unknown): PayrollRunItem[] {
  if (!Array.isArray(json)) fail("", "is not an array");
  return json.map((value: unknown, index) => {
    const path = child("", index);
    const data = record(value, path, [
      "employeeId",
      "name",
      "kind",
      "input",
      "adjustmentNote",
      "result",
    ]);
    if (data.kind !== "officer" && data.kind !== "employee") {
      fail(child(path, "kind"), "is neither officer nor employee");
    }
    return {
      employeeId: text(data.employeeId, child(path, "employeeId")),
      name: text(data.name, child(path, "name")),
      kind: data.kind,
      input: itemInputOf(data.input, child(path, "input")),
      adjustmentNote:
        data.adjustmentNote === null
          ? null
          : text(data.adjustmentNote, child(path, "adjustmentNote")),
      result: resultOf(data.result, child(path, "result")),
    };
  });
}

/** Reads `PayrollRun.tableIds` back (strict, like `parsePayrollRunItems`). */
export function parsePayrollTableIds(json: unknown): PayrollTableIds {
  const data = record(json, "tableIds", ["withholding", "kenpo", "pension", "employment"]);
  return {
    withholding: text(data.withholding, "tableIds.withholding"),
    kenpo: text(data.kenpo, "tableIds.kenpo"),
    pension: text(data.pension, "tableIds.pension"),
    employment: data.employment === null ? null : text(data.employment, "tableIds.employment"),
  };
}
