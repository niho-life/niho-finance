import {
  listEmployees,
  previewPayrollPayment,
  previewPayrollRun,
  type EmployeeRecord,
  type PayrollEntryPreview,
  type PayrollPaymentInput,
  type PayrollRunInput,
  type PayrollScheduleRow,
  type PrismaClient,
} from "@niho-finance/db";
import { displayDate, formatYen, getTaxCategory, type Money } from "@niho-finance/ledger";
import {
  compareYearMonths,
  yearMonthLabel,
  yearMonthOf,
  type PayrollCoverage,
  type PayrollRunItem,
  type PayrollTableIds,
  type WorkerKind,
  type YearMonth,
} from "@niho-finance/payroll";

/*
 * What the payroll screens show, as text (amounts formatted with `formatYen`): bigint stays on the
 * server, client components get these views. Server-only (it reads the repository).
 */

export interface EntryLineView {
  key: string;
  side: "debit" | "credit";
  /** 「2300 預り金」 */
  account: string;
  /** The sub-account or the wallet. */
  sub: string | null;
  amount: string;
  /** 税区分 and 税額, `null` for 対象外. */
  tax: string | null;
}

export interface EntryView {
  description: string;
  entryDate: string;
  lines: EntryLineView[];
  debitTotal: string;
  creditTotal: string;
}

export function toEntryView(entry: PayrollEntryPreview): EntryView {
  return {
    description: entry.description,
    entryDate: displayDate(entry.entryDate),
    lines: entry.lines.map((line, index) => {
      const category =
        line.taxCategoryCode === "na"
          ? null
          : (getTaxCategory(line.taxCategoryCode)?.name ?? "税区分");
      return {
        key: `${index}`,
        side: line.side,
        account: `${line.accountCode} ${line.accountName}`,
        sub: line.subAccountName,
        amount: formatYen(line.amount),
        tax:
          category === null
            ? null
            : line.taxAmount > 0n
              ? `${category} · 税額 ${formatYen(line.taxAmount)}`
              : category,
      };
    }),
    debitTotal: formatYen(entry.debitTotal),
    creditTotal: formatYen(entry.creditTotal),
  };
}

/**
 * 「健康保険 · 介護あり（40〜64 歳） · 厚生年金 · 雇用保険」: what applies to the person in the premium
 * month (22-payroll §2.9, §6.3). `employee` (the master data) explains why something does not
 * apply; without it (a confirmed run) only the result is told.
 */
export function coverageNotes(
  coverage: PayrollCoverage,
  kind: WorkerKind,
  premiumMonth: YearMonth,
  employee: Pick<EmployeeRecord, "socialInsured" | "insuredFrom"> | null,
): string[] {
  const notes: string[] = [];
  const insuredFrom = employee?.socialInsured ? employee.insuredFrom : null;
  if (employee && !employee.socialInsured) {
    notes.push("社会保険なし");
  } else if (insuredFrom && compareYearMonths(yearMonthOf(insuredFrom), premiumMonth) > 0) {
    notes.push(
      `社会保険は ${yearMonthLabel(yearMonthOf(insuredFrom))}分から（資格取得日 ${displayDate(insuredFrom)}）`,
    );
  } else if (!coverage.health && !coverage.pension && !employee) {
    notes.push("社会保険なし");
  } else {
    notes.push(
      coverage.health ? "健康保険" : employee ? "健康保険なし（75 歳以上）" : "健康保険なし",
    );
    if (coverage.care) notes.push("介護あり（40〜64 歳）");
    notes.push(
      coverage.pension ? "厚生年金" : employee ? "厚生年金なし（70 歳以上）" : "厚生年金なし",
    );
  }
  if (kind === "employee") notes.push(coverage.employment ? "雇用保険" : "雇用保険なし");
  return notes;
}

/** The result of one person (22-payroll §6.3: 総支給 … 差引支給額). */
export interface RunItemResultView {
  employeeId: string;
  name: string;
  kind: WorkerKind;
  grossPay: string;
  /** 健保・厚年の本人分（調整後） */
  socialInsurance: string;
  /** 「健保 12,345 · 厚年 23,456 · 調整 -100」 */
  socialInsuranceDetail: string;
  /** `null`: not insured. */
  employmentInsurance: string | null;
  withholdingBase: string;
  /** 源泉所得税（調整後） */
  incomeTax: string;
  /** 「税額表 5,000 · 調整 -300」 when adjusted. */
  incomeTaxDetail: string | null;
  residentTax: string;
  totalDeductions: string;
  netPay: string;
  coverageNotes: string[];
}

function adjustmentText(amount: Money): string {
  return amount > 0n ? `+${formatYen(amount)}` : formatYen(amount);
}

export function toItemResultView(item: PayrollRunItem, notes: string[]): RunItemResultView {
  const { result } = item;
  const health = result.socialInsurance.health.employee;
  const pension = result.socialInsurance.pension.employee;
  const socialAdjustment = result.adjustments.socialInsurance;
  const taxAdjustment = result.adjustments.incomeTax;
  return {
    employeeId: item.employeeId,
    name: item.name,
    kind: item.kind,
    grossPay: formatYen(result.grossPay),
    socialInsurance: formatYen(result.socialInsuranceEmployeeTotal),
    socialInsuranceDetail: [
      `健保 ${formatYen(health)}`,
      `厚年 ${formatYen(pension)}`,
      socialAdjustment !== 0n ? `調整 ${adjustmentText(socialAdjustment)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    employmentInsurance: result.employmentInsurance
      ? formatYen(result.employmentInsurance.employee)
      : null,
    withholdingBase: formatYen(result.withholdingBase),
    incomeTax: formatYen(result.incomeTaxTotal),
    incomeTaxDetail:
      taxAdjustment !== 0n
        ? `税額表 ${formatYen(result.incomeTax)} · 調整 ${adjustmentText(taxAdjustment)}`
        : null,
    residentTax: formatYen(result.residentTax),
    totalDeductions: formatYen(result.totalDeductions),
    netPay: formatYen(result.netPay),
    coverageNotes: notes,
  };
}

export interface ScheduleItemView {
  key: string;
  categoryLabel: string;
  title: string;
  dueDate: string;
  amount: string;
  /** The deadline's total with other runs, when it is more than this run's share. */
  scheduledTotal: string | null;
}

export interface RunTotalsView {
  headcount: number;
  grossPay: string;
  totalDeductions: string;
  netPay: string;
  employerTotal: string;
}

/** 支給の計算 (§6.3): everything below the inputs, and what 確定 sends back. */
export interface RunPreviewView {
  /** 「2026 年 11 月分」 */
  premiumMonthLabel: string;
  items: RunItemResultView[];
  tableTitles: string[];
  totals: RunTotalsView;
  entries: { pay: EntryView; employer: EntryView | null };
  schedule: ScheduleItemView[];
  /** Sent back with 確定 so that it computes with the same table versions. */
  tableIds: PayrollTableIds;
  /** The totals 確定 expects (whole yen as digits). */
  expected: { grossPay: string; netPay: string; employerTotal: string };
}

export function tableTitles(tables: {
  withholding: { title: string };
  kenpo: { title: string };
  pension: { title: string };
  employment: { title: string } | null;
}): string[] {
  return [tables.withholding, tables.kenpo, tables.pension, tables.employment]
    .filter((table): table is { title: string } => table !== null)
    .map((table) => table.title);
}

/** `previewPayrollRun` as the form shows it; coverage notes from the employees' master data. */
export async function loadRunPreview(
  db: PrismaClient,
  input: PayrollRunInput,
): Promise<RunPreviewView> {
  const preview = await previewPayrollRun(db, input);
  const employees = new Map((await listEmployees(db)).map((employee) => [employee.id, employee]));
  return {
    premiumMonthLabel: `${yearMonthLabel(preview.premiumMonth)}分`,
    items: preview.items.map((item) =>
      toItemResultView(
        item,
        coverageNotes(
          item.input.coverage,
          item.kind,
          preview.premiumMonth,
          employees.get(item.employeeId) ?? null,
        ),
      ),
    ),
    tableTitles: tableTitles(preview.tables),
    totals: {
      headcount: preview.totals.headcount,
      grossPay: formatYen(preview.totals.grossPay),
      totalDeductions: formatYen(preview.totals.totalDeductions),
      netPay: formatYen(preview.totals.netPay),
      employerTotal: formatYen(preview.totals.employerTotal),
    },
    entries: {
      pay: toEntryView(preview.entries.pay),
      employer: preview.entries.employer ? toEntryView(preview.entries.employer) : null,
    },
    schedule: preview.schedule.map((row) => ({
      key: row.ruleKey,
      categoryLabel: row.categoryLabel,
      title: row.title,
      dueDate: displayDate(row.dueDate),
      amount: formatYen(row.amount),
      scheduledTotal: row.scheduledTotal !== row.amount ? formatYen(row.scheduledTotal) : null,
    })),
    tableIds: preview.tableIds,
    expected: {
      grossPay: String(preview.expected.grossPay),
      netPay: String(preview.expected.netPay),
      employerTotal: String(preview.expected.employerTotal),
    },
  };
}

/** 対象 of a deadline: the part in brackets of its title (「2026 年 12 月支給分」). */
export function scheduleTarget(title: string): string {
  return /（([^（）]+)）$/.exec(title)?.[1] ?? title;
}

/** One row of 納付の予定 (§6.6) for the client table. */
export interface ScheduleRowView {
  id: string;
  isSocialInsurance: boolean;
  categoryLabel: string;
  title: string;
  target: string;
  dueDate: string;
  /** For the 期限超過 state: `YYYY-MM-DD`. */
  dueDateValue: string;
  amount: string;
  /** 「本人分 n · 会社分 m」 for 社会保険料. */
  breakdown: string | null;
  completed: boolean;
  completedAt: string | null;
  paymentEntry: { id: string; no: number } | null;
}

export function toScheduleRowView(
  row: PayrollScheduleRow,
  formatTime: (date: Date) => string,
): ScheduleRowView {
  return {
    id: row.id,
    isSocialInsurance: row.category === "social_insurance",
    categoryLabel: row.categoryLabel,
    title: row.title,
    target: scheduleTarget(row.title),
    dueDate: displayDate(row.dueDate),
    dueDateValue: row.dueDate,
    amount: formatYen(row.amount),
    breakdown:
      row.category === "social_insurance"
        ? `本人分 ${formatYen(row.withheld)} · 会社分 ${formatYen(row.employer)}`
        : null,
    completed: row.completedAt !== null,
    completedAt: row.completedAt ? formatTime(row.completedAt) : null,
    paymentEntry: row.paymentEntry ? { id: row.paymentEntry.id, no: row.paymentEntry.no } : null,
  };
}

/** 納付を登録 の確認 (§5.4). */
export interface PaymentPreviewView {
  scheduled: string;
  paid: string;
  /** paid − scheduled when not 0 (社会保険料 only), on 5220 法定福利費. */
  difference: string | null;
  entry: EntryView;
}

export async function loadPaymentPreview(
  db: PrismaClient,
  input: PayrollPaymentInput,
): Promise<PaymentPreviewView> {
  const preview = await previewPayrollPayment(db, input);
  return {
    scheduled: formatYen(preview.item.amount),
    paid: formatYen(preview.paid),
    difference: preview.difference !== 0n ? adjustmentText(preview.difference) : null,
    entry: toEntryView(preview.entry),
  };
}
