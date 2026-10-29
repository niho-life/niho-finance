import type { BonusPayslip, Payslip } from "@niho-finance/db";
import { displayDate, formatYen, type Money } from "@niho-finance/ledger";
import {
  BONUS_WITHHOLDING_METHOD_LABELS,
  yearMonthLabel,
  yearMonthParts,
} from "@niho-finance/payroll";
import type { PayslipData } from "@/lib/pdf/payslip";
import { taxColumnText, WORKER_KIND_LABELS } from "./labels";

function signed(amount: Money): string {
  return amount > 0n ? `+${formatYen(amount)}` : formatYen(amount);
}

function smrText(amount: Money | null): string {
  return amount === null ? "対象外" : `${formatYen(amount)} 円`;
}

/** 給与明細 (22-payroll §6.5) as text: the same lines on the printable page and in the PDF. */
export function payslipData(payslip: Payslip): PayslipData {
  const { deductions, reference } = payslip;
  const { incomeTax: taxAdjustment, socialInsurance: socialAdjustment } = deductions.adjustments;
  const adjustmentParts = [
    taxAdjustment !== 0n ? `所得税 ${signed(taxAdjustment)}` : null,
    socialAdjustment !== 0n ? `社会保険料 ${signed(socialAdjustment)}` : null,
  ].filter((part): part is string => part !== null);
  const dependents =
    reference.taxColumn.column === "kou"
      ? reference.taxColumn.dependents
      : (reference.taxColumn.secondaryDependents ?? 0);
  return {
    companyName: payslip.companyName,
    payMonthLabel: `${yearMonthLabel(payslip.payMonth)}支給`,
    paymentDate: displayDate(payslip.paymentDate),
    employeeName: payslip.employee.name,
    kindLabel: WORKER_KIND_LABELS[payslip.employee.kind],
    pay: [
      { label: "課税支給", amount: formatYen(payslip.pay.taxablePay) },
      { label: "通勤手当", amount: formatYen(payslip.pay.commuteAllowance) },
    ],
    grossPay: formatYen(payslip.pay.grossPay),
    deductions: [
      { label: "健康保険（介護・支援金を含む）", amount: formatYen(deductions.health) },
      { label: "厚生年金", amount: formatYen(deductions.pension) },
      { label: "雇用保険", amount: formatYen(deductions.employmentInsurance) },
      { label: "所得税", amount: formatYen(deductions.incomeTax) },
      { label: "住民税", amount: formatYen(deductions.residentTax) },
      {
        label: "調整",
        amount: formatYen(taxAdjustment + socialAdjustment),
        note: adjustmentParts.length > 0 ? adjustmentParts.join("・") : null,
      },
    ],
    totalDeductions: formatYen(deductions.total),
    netPay: formatYen(payslip.netPay),
    reference: [
      { label: "標準報酬月額（健康保険）", value: smrText(reference.healthSmr) },
      { label: "標準報酬月額（厚生年金）", value: smrText(reference.pensionSmr) },
      {
        label: "扶養親族等の数",
        value: taxColumnText(reference.taxColumn.column, dependents),
      },
      { label: "社会保険料の対象月", value: `${yearMonthLabel(reference.premiumMonth)}分` },
      ...(reference.adjustmentNote
        ? [{ label: "調整のメモ", value: reference.adjustmentNote }]
        : []),
    ],
  };
}

/** Characters a file name cannot hold on common systems become `_`. */
function fileSafe(text: string): string {
  const safe = [...text]
    .map((char) => (char < " " || '\\/:*?"<>|'.includes(char) ? "_" : char))
    .join("")
    .trim();
  return safe === "" ? "_" : safe;
}

/**
 * `payslip_202612_9k3f2a7q.pdf` (the employee id's random tail, so the payslips of one run differ)
 * and 「給与明細_2026年12月_<氏名>.pdf」.
 */
export function payslipFileNames(payslip: Payslip): { ascii: string; utf8: string } {
  const { year, month } = yearMonthParts(payslip.payMonth);
  const ym = `${year}${String(month).padStart(2, "0")}`;
  return {
    ascii: `payslip_${ym}_${payslip.employee.id.slice(-8).toLowerCase()}.pdf`,
    utf8: `給与明細_${year}年${month}月_${fileSafe(payslip.employee.name)}.pdf`,
  };
}

/** 賞与明細 (22-payroll §10.5) as text: the printable page and the PDF draw the same lines. */
export function bonusPayslipData(payslip: BonusPayslip): PayslipData {
  const { deductions, reference } = payslip;
  const dependents =
    reference.taxColumn.column === "kou"
      ? reference.taxColumn.dependents
      : (reference.taxColumn.secondaryDependents ?? 0);
  const { withholding } = reference;
  const method =
    withholding.method === "rate"
      ? `${BONUS_WITHHOLDING_METHOD_LABELS.rate} ${withholding.ratePercent ?? ""}%`
      : `${BONUS_WITHHOLDING_METHOD_LABELS[withholding.method]}（${withholding.divisor ?? 6} 倍）`;
  return {
    title: "賞与明細",
    companyName: payslip.companyName,
    payMonthLabel: `${payslip.title} · ${yearMonthLabel(payslip.payMonth)}支給`,
    paymentDate: displayDate(payslip.paymentDate),
    employeeName: payslip.employee.name,
    kindLabel: WORKER_KIND_LABELS[payslip.employee.kind],
    pay: [{ label: "賞与", amount: formatYen(payslip.bonus) }],
    grossPay: formatYen(payslip.bonus),
    deductions: [
      { label: "健康保険（介護・支援金を含む）", amount: formatYen(deductions.health) },
      { label: "厚生年金", amount: formatYen(deductions.pension) },
      { label: "雇用保険", amount: formatYen(deductions.employmentInsurance) },
      { label: "所得税", amount: formatYen(deductions.incomeTax) },
    ],
    totalDeductions: formatYen(deductions.total),
    netPay: formatYen(payslip.netPay),
    reference: [
      { label: "標準賞与額", value: `${formatYen(reference.standardBonus)} 円` },
      { label: "標準賞与額（健康保険）", value: smrText(reference.healthStandardBonus) },
      { label: "標準賞与額（厚生年金）", value: smrText(reference.pensionStandardBonus) },
      { label: "扶養親族等の数", value: taxColumnText(reference.taxColumn.column, dependents) },
      {
        label: "社会保険料等控除後の賞与の額",
        value: `${formatYen(reference.withholdingBase)} 円`,
      },
      {
        label: "前月の給与（社会保険料等控除後）",
        value:
          reference.previousMonthPay === null
            ? "なし"
            : `${formatYen(reference.previousMonthPay)} 円`,
      },
      { label: "源泉所得税の求め方", value: method },
    ],
  };
}

/** `payslip-bonus_202607_9k3f2a7q.pdf` and 「賞与明細_2026年7月_<氏名>.pdf」. */
export function bonusPayslipFileNames(payslip: BonusPayslip): { ascii: string; utf8: string } {
  const { year, month } = yearMonthParts(payslip.payMonth);
  const ym = `${year}${String(month).padStart(2, "0")}`;
  return {
    ascii: `payslip-bonus_${ym}_${payslip.employee.id.slice(-8).toLowerCase()}.pdf`,
    utf8: `賞与明細_${year}年${month}月_${fileSafe(payslip.employee.name)}.pdf`,
  };
}
