import {
  addDays,
  dateParts,
  displayDate,
  lastDayOfMonth,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import { type PayrollFilingSlot } from "./bonus";
import { compareYearMonths, shiftYearMonth, yearMonthOf, type YearMonth } from "./month";
import { PAYROLL_RULE_KEY_PREFIX, type PremiumTiming } from "./run";

/**
 * 退職 (22-payroll §12.3・§12.4) as pure rules: the 資格喪失日 and the premium months it ends, who a
 * run of a month includes, the second premium month of a final pay under 翌月控除, whether a leaver
 * is in 年末調整, and the filing deadlines leaving adds to the calendar.
 */

/** 社会保険の資格喪失日 = 退職日の翌日. */
export function socialInsuranceLossDate(leftOn: CalendarDate): CalendarDate {
  return addDays(leftOn, 1);
}

/** 資格喪失月: the month of the 資格喪失日 (a month-end leaver's is the next month). */
export function lossMonthOf(leftOn: CalendarDate): YearMonth {
  return yearMonthOf(socialInsuranceLossDate(leftOn));
}

/**
 * Whether 社会保険料 are due for `premiumMonth` given the 退職日: premiums are due for the months
 * before the 資格喪失月 (so a month-end leaver owes the leaving month, a mid-month leaver does not).
 */
export function premiumDueForMonth(leftOn: CalendarDate | null, premiumMonth: YearMonth): boolean {
  return leftOn === null || compareYearMonths(premiumMonth, lossMonthOf(leftOn)) < 0;
}

/**
 * Whether a person is in the runs of `payMonth` (monthly and bonus): not after leaving, i.e. no
 * 退職日 or one in `payMonth` or later.
 */
export function employedInPayMonth(leftOn: CalendarDate | null, payMonth: YearMonth): boolean {
  return leftOn === null || compareYearMonths(yearMonthOf(leftOn), payMonth) >= 0;
}

/**
 * The second premium month of a final pay (§12.3): with 翌月控除 the pay of `payMonth` deducts the
 * previous month's premium; when the person leaves in `payMonth` and the 資格喪失月 is the next month
 * (a month-end leaver), the leaving month's premium is due too and no later run includes the person,
 * so this pay deducts it as well. `null` otherwise (当月控除, a mid-month leaver, not leaving).
 */
export function finalPayExtraPremiumMonth(input: {
  payMonth: YearMonth;
  premiumTiming: PremiumTiming;
  leftOn: CalendarDate | null;
}): YearMonth | null {
  if (input.premiumTiming !== "next_month" || input.leftOn === null) return null;
  if (yearMonthOf(input.leftOn) !== input.payMonth) return null;
  return lossMonthOf(input.leftOn) === shiftYearMonth(input.payMonth, 1) ? input.payMonth : null;
}

/**
 * 年末調整 of a leaver (§11.2・§12.3): a person who left in the year before the year's last pay is
 * not adjusted (源泉徴収票 only). Eligible again when the 退職日 is after the December run's payment
 * date (12 月の給与の支払後の退職). Without a December run yet, a 退職日 before December rules it out.
 * Returns the owner-facing reason, or `null` when leaving does not rule it out.
 */
export function yearEndRetirementReason(
  leftOn: CalendarDate | null,
  year: number,
  decemberPaymentDate: CalendarDate | null,
): string | null {
  if (leftOn === null) return null;
  const { year: leftYear } = dateParts(leftOn);
  if (leftYear > year) return null;
  const cutoff = decemberPaymentDate ?? (`${String(year).padStart(4, "0")}-11-30` as CalendarDate);
  if (leftYear === year && leftOn > cutoff) return null;
  return `${displayDate(leftOn)} に退職した人は、${year} 年分の年末調整の対象外です（最後の給与の支払の前の退職）。源泉徴収票は 給与 › 法定調書 で出します`;
}

// ---------------------------------------------------------------------------------------------
// The calendar (§12.3・§12.4)
// ---------------------------------------------------------------------------------------------

export const LEAVE_FILING_TYPES = [
  "social_insurance_loss",
  "employment_insurance_loss",
  "resident_tax_change",
  "withholding_slip",
] as const;
export type LeaveFilingType = (typeof LEAVE_FILING_TYPES)[number];

/** `payroll.leave.<employeeId>.<type>`: one filing per person and type (kept when leftOn changes). */
export function leaveFilingRuleKey(employeeId: string, type: LeaveFilingType): string {
  return `${PAYROLL_RULE_KEY_PREFIX}leave.${employeeId}.${type}`;
}

/** The same day `months` months later, or that month's last day when it has no such day. */
export function addMonthsClamped(date: CalendarDate, months: number): CalendarDate {
  const { year, month, day } = dateParts(date);
  const index = year * 12 + (month - 1) + months;
  const targetMonth = (index % 12) + 1;
  const targetYear = (index - (targetMonth - 1)) / 12;
  const last = lastDayOfMonth(targetYear, targetMonth);
  if (day > dateParts(last).day) return last;
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/** The 10th of the month after `date`'s month. */
function tenthOfNextMonth(date: CalendarDate): CalendarDate {
  const { year, month } = dateParts(addMonthsClamped(date, 1));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-10` as CalendarDate;
}

export interface LeaveFilingSlot extends PayrollFilingSlot {
  type: LeaveFilingType;
}

/**
 * The filings of a person leaving on `leftOn` (§12.3・§12.4), in due-date order:
 * - 健康保険・厚生年金保険 被保険者資格喪失届: 資格喪失日から 5 日以内 (社会保険の被保険者だけ);
 * - 雇用保険 被保険者資格喪失届: 資格喪失日の翌日から 10 日以内 (雇用保険の被保険者だけ);
 * - 給与所得者異動届出書: 退職した月の翌月 10 日 (住民税の特別徴収がある人だけ);
 * - 源泉徴収票の交付: 退職日から 1 か月以内 (everyone).
 * The legal dates, not moved off weekends (like the payment deadlines, §7.1).
 */
export function leaveFilingSlots(person: {
  employeeId: string;
  name: string;
  leftOn: CalendarDate;
  socialInsured: boolean;
  employmentInsured: boolean;
  residentTax: Money;
}): LeaveFilingSlot[] {
  const loss = socialInsuranceLossDate(person.leftOn);
  const who = `${person.name}さん・${displayDate(person.leftOn)} 退職`;
  const slots: LeaveFilingSlot[] = [];
  const push = (type: LeaveFilingType, title: string, dueDate: CalendarDate) =>
    slots.push({
      type,
      ruleKey: leaveFilingRuleKey(person.employeeId, type),
      title: `${title}（${who}）`,
      dueDate,
    });
  if (person.socialInsured) {
    push(
      "social_insurance_loss",
      "健康保険・厚生年金保険 被保険者資格喪失届の提出",
      addDays(loss, 5),
    );
  }
  if (person.employmentInsured) {
    push("employment_insurance_loss", "雇用保険 被保険者資格喪失届の提出", addDays(loss, 10));
  }
  if (person.residentTax > 0n) {
    push(
      "resident_tax_change",
      "給与所得者異動届出書（住民税）の提出",
      tenthOfNextMonth(person.leftOn),
    );
  }
  push("withholding_slip", "源泉徴収票の交付", addMonthsClamped(person.leftOn, 1));
  return slots.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

/** 0 = Sunday … 6 = Saturday. */
function weekday(date: CalendarDate): number {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * 給与支払報告書・法定調書合計表の提出期限 of `year` (§12.1): 1 月 31 日 of the next year, moved to the
 * Monday when it falls on a weekend (2026 年分 → 2027-02-01).
 */
export function annualReportDueDate(year: number): CalendarDate {
  const due = `${String(year + 1).padStart(4, "0")}-01-31` as CalendarDate;
  const day = weekday(due);
  return day === 6 ? addDays(due, 2) : day === 0 ? addDays(due, 1) : due;
}

/** `payroll.annual_report.<year>`: 給与支払報告書・法定調書合計表の提出 (§12.4). */
export function annualReportSlot(year: number): PayrollFilingSlot {
  return {
    ruleKey: `${PAYROLL_RULE_KEY_PREFIX}annual_report.${year}`,
    title: `給与支払報告書（市区町村）・法定調書合計表（税務署）の提出（${year} 年分）`,
    dueDate: annualReportDueDate(year),
  };
}
