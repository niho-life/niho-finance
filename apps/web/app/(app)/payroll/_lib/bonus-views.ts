import {
  listEmployees,
  previewBonusRun,
  type BonusTableRefs,
  type PayrollBonusRunInput,
  type PrismaClient,
} from "@niho-finance/db";
import { displayDate } from "@niho-finance/ledger";
import {
  BONUS_WITHHOLDING_METHOD_LABELS,
  type PayrollBonusItem,
  type PayrollBonusTableIds,
  type WorkerKind,
  type YearMonth,
} from "@niho-finance/payroll";
import { formatAmountDisplay, formatYenDisplay } from "@/lib/format";
import {
  coverageNotes,
  toEntryView,
  type EntryView,
  type RunTotalsView,
  type ScheduleItemView,
} from "./views";

/*
 * What the bonus screens show (22-payroll §10.5), as text: bigint stays on the server, client
 * components get these views. Server-only (it reads the repository).
 */

/** The result of one person's bonus (標準賞与額 … 差引支給額). */
export interface BonusItemResultView {
  employeeId: string;
  name: string;
  kind: WorkerKind;
  bonus: string;
  /** 標準賞与額 (1,000 円未満切り捨て). */
  standardBonus: string;
  /** 「健保 730,000 · 厚年 1,500,000」 when a cap applies or a side is not covered. */
  standardBonusDetail: string | null;
  /** 健保・厚年の本人分 */
  socialInsurance: string;
  /** 「健保 12,345 · 厚年 23,456」 */
  socialInsuranceDetail: string;
  /** `null`: not insured. */
  employmentInsurance: string | null;
  /** 対象額 (社会保険料等控除後の賞与の額) */
  withholdingBase: string;
  /** 「算出率の表 4.084%」 / 「月額表（前月の給与なし）」 */
  method: string;
  /** How the tax came out of the monthly table (the exceptions), or the rate's basis. */
  methodDetail: string;
  incomeTax: string;
  totalDeductions: string;
  netPay: string;
  coverageNotes: string[];
}

export function toBonusItemView(item: PayrollBonusItem, notes: string[]): BonusItemResultView {
  const { result } = item;
  const { standardBonus, withholding } = result;
  const capped =
    (item.input.coverage.health && standardBonus.health !== standardBonus.amount) ||
    (item.input.coverage.pension && standardBonus.pension !== standardBonus.amount);
  const yen = formatAmountDisplay;
  let methodDetail: string;
  switch (withholding.method) {
    case "rate":
      methodDetail = `前月の給与 ${yen(item.input.previousMonth?.pay ?? null)} 円の行の率`;
      break;
    case "monthly_no_prev":
      methodDetail = `${yen(withholding.monthlyAmount)} 円の月額表の税額 ${yen(withholding.monthlyTax)} 円 × ${withholding.divisor ?? 6}`;
      break;
    case "monthly_10x":
      methodDetail = `（${yen(withholding.monthlyAmount)} 円の月額表の税額 ${yen(withholding.monthlyTax)} 円 − 前月の税額 ${yen(withholding.previousMonthTax)} 円）× ${withholding.divisor ?? 6}`;
      break;
  }
  return {
    employeeId: item.employeeId,
    name: item.name,
    kind: item.kind,
    bonus: formatYenDisplay(result.bonus),
    standardBonus: formatYenDisplay(standardBonus.amount),
    standardBonusDetail: capped
      ? [
          item.input.coverage.health ? `健保 ${formatYenDisplay(standardBonus.health)}` : null,
          item.input.coverage.pension ? `厚年 ${formatYenDisplay(standardBonus.pension)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null,
    socialInsurance: formatYenDisplay(result.socialInsurance.employeeTotal),
    socialInsuranceDetail: `健保 ${formatYenDisplay(result.socialInsurance.health.employee)} · 厚年 ${formatYenDisplay(result.socialInsurance.pension.employee)}`,
    employmentInsurance: result.employmentInsurance
      ? formatYenDisplay(result.employmentInsurance.employee)
      : null,
    withholdingBase: formatYenDisplay(result.withholdingBase),
    method:
      withholding.method === "rate"
        ? `${BONUS_WITHHOLDING_METHOD_LABELS.rate} ${withholding.ratePercent ?? ""}%`
        : BONUS_WITHHOLDING_METHOD_LABELS[withholding.method],
    methodDetail,
    incomeTax: formatYenDisplay(result.incomeTax),
    totalDeductions: formatYenDisplay(result.totalDeductions),
    netPay: formatYenDisplay(result.netPay),
    coverageNotes: notes,
  };
}

export function bonusTableTitles(tables: BonusTableRefs): string[] {
  return [
    tables.bonusWithholding,
    tables.withholding,
    tables.kenpo,
    tables.pension,
    tables.employment,
  ]
    .filter((table): table is NonNullable<typeof table> => table !== null)
    .map((table) => table.title);
}

/** 賞与の計算 (§10.5): everything below the inputs, and what 確定 sends back. */
export interface BonusPreviewView {
  /** The people with a bonus. */
  items: BonusItemResultView[];
  /** 事前確定届出給与 (§10.3), by person. */
  warnings: { employeeId: string; message: string }[];
  tableTitles: string[];
  totals: RunTotalsView;
  entries: { pay: EntryView; employer: EntryView | null };
  schedule: ScheduleItemView[];
  /** 被保険者賞与支払届. */
  filing: { title: string; dueDate: string } | null;
  /** Sent back with 確定 so that it computes with the same table versions. */
  tableIds: PayrollBonusTableIds;
  /** The totals 確定 expects (whole yen as digits). */
  expected: { grossPay: string; netPay: string; employerTotal: string };
}

/** `previewBonusRun` as the form shows it; coverage notes from the employees' master data. */
export async function loadBonusPreview(
  db: PrismaClient,
  input: PayrollBonusRunInput,
): Promise<BonusPreviewView> {
  const preview = await previewBonusRun(db, input);
  const employees = new Map((await listEmployees(db)).map((employee) => [employee.id, employee]));
  return {
    items: preview.items.map((item) =>
      toBonusItemView(
        item,
        coverageNotes(
          item.input.coverage,
          item.kind,
          preview.payMonth,
          employees.get(item.employeeId) ?? null,
        ),
      ),
    ),
    warnings: preview.warnings.map(({ employeeId, message }) => ({ employeeId, message })),
    tableTitles: bonusTableTitles(preview.tables),
    totals: {
      headcount: preview.totals.headcount,
      grossPay: formatYenDisplay(preview.totals.grossPay),
      totalDeductions: formatYenDisplay(preview.totals.totalDeductions),
      netPay: formatYenDisplay(preview.totals.netPay),
      employerTotal: formatYenDisplay(preview.totals.employerTotal),
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
      amount: formatYenDisplay(row.amount),
      scheduledTotal:
        row.scheduledTotal !== row.amount ? formatYenDisplay(row.scheduledTotal) : null,
    })),
    filing: preview.filing
      ? { title: preview.filing.title, dueDate: displayDate(preview.filing.dueDate) }
      : null,
    tableIds: preview.tableIds,
    expected: {
      grossPay: String(preview.expected.grossPay),
      netPay: String(preview.expected.netPay),
      employerTotal: String(preview.expected.employerTotal),
    },
  };
}

/** Coverage notes of a stored item (no master data: only the result is told). */
export function storedBonusNotes(item: PayrollBonusItem, payMonth: YearMonth): string[] {
  return coverageNotes(item.input.coverage, item.kind, payMonth, null);
}
