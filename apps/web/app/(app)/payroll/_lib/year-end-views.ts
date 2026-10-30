import {
  previewYearEnd,
  type PrismaClient,
  type YearEndDeclarationFormInput,
  type YearEndPreview,
} from "@niho-finance/db";
import { displayDate, formatYen, formatYenInput, type Money } from "@niho-finance/ledger";
import {
  DEPENDENT_CATEGORIES,
  DEPENDENT_CATEGORY_LABELS,
  DISABILITY_KIND_LABELS,
  DISABILITY_KINDS,
  SELF_DISABILITY_KINDS,
  SPOUSE_DEDUCTION_LABELS,
  WIDOW_STATUS_LABELS,
  WIDOW_STATUSES,
  type YearEndDeclaration,
  type YearEndResult,
} from "@niho-finance/payroll";
import { formatDateTime, formatYenDisplay } from "@/lib/format";
import type { DeclarationDraft, YearEndOptions } from "./year-end-draft";
import { toEntryView, type EntryView } from "./views";

/*
 * What the 年末調整 screens show (22-payroll §11.5), as text: bigint stays on the server, the client
 * form gets these views. Server-only (it reads the repository and the yearly tables).
 */

/** One line of the step-by-step calculation (「年末調整のしかた」 35〜40 ページの順). */
export interface YearEndStepView {
  key: string;
  /** 「1. 給与等の総額」 */
  label: string;
  amount: string;
  note: string | null;
  /** A sub-line (a deduction under 4.). */
  indent: boolean;
  strong: boolean;
}

function step(
  key: string,
  label: string,
  amount: Money,
  options: { note?: string | null; indent?: boolean; strong?: boolean } = {},
): YearEndStepView {
  return {
    key,
    label,
    amount: formatYen(amount),
    note: options.note ?? null,
    indent: options.indent ?? false,
    strong: options.strong ?? false,
  };
}

const parts = (items: readonly (readonly [string, Money])[]) =>
  items
    .filter(([, amount]) => amount !== 0n)
    .map(([label, amount]) => `${label} ${formatYen(amount)}`)
    .join(" · ") || null;

/**
 * Every step of §11.2 with the deductions' parts. Shared with the 源泉徴収簿 (page and PDF), so the
 * amounts keep `formatYen` (the ASCII `-`; none of them is negative). The views below, only for the
 * screen, use `formatYenDisplay`.
 */
export function yearEndSteps(result: YearEndResult): YearEndStepView[] {
  const { deductions } = result;
  const life = deductions.lifeInsurance;
  const dependents = deductions.dependents;
  return [
    step("totalPay", "1. 給与等の総額", result.totalPay),
    step("salaryIncome", "2. 給与所得控除後の給与等の金額", result.salaryIncome),
    step("incomeAdjustment", "3. 所得金額調整控除", result.incomeAdjustment, {
      note: result.incomeAdjustment === 0n ? "収入 850 万円以下か、要件なし" : null,
    }),
    step(
      "salaryIncomeAfterAdjustment",
      "給与所得控除後の給与等の金額（調整控除後）",
      result.salaryIncomeAfterAdjustment,
    ),
    step("totalIncome", "合計所得金額の見積額", result.totalIncome, {
      note: "給与所得と給与以外の所得の見積額。基礎控除・配偶者控除の判定に使います",
    }),
    step("socialInsurance", "社会保険料控除", deductions.socialInsurance, { indent: true }),
    step("smallBusiness", "小規模企業共済等掛金控除", deductions.smallBusinessMutualAid, {
      indent: true,
    }),
    step("life", "生命保険料控除", life.total, {
      indent: true,
      note: parts([
        ["一般", life.general],
        ["介護医療", life.medical],
        ["個人年金", life.pension],
      ]),
    }),
    step("earthquake", "地震保険料控除", deductions.earthquake, { indent: true }),
    step(
      "spouse",
      deductions.spouseKind ? SPOUSE_DEDUCTION_LABELS[deductions.spouseKind] : "配偶者（特別）控除",
      deductions.spouse,
      { indent: true },
    ),
    step("specificRelative", "特定親族特別控除", deductions.specificRelative, { indent: true }),
    step("dependents", "扶養控除・障害者等の控除", dependents.total, {
      indent: true,
      note: parts([
        ["扶養控除", dependents.dependents],
        ["障害者控除", dependents.disability],
        ["寡婦・ひとり親控除", dependents.widowOrSingleParent],
        ["勤労学生控除", dependents.workingStudent],
      ]),
    }),
    step("basic", "基礎控除", deductions.basic, { indent: true }),
    step("deductions", "4. 所得控除の合計", deductions.total, { strong: true }),
    step("taxableIncome", "5. 課税給与所得金額", result.taxableIncome, {
      note: "1,000 円未満切り捨て",
    }),
    step("computedTax", "6. 算出所得税額", result.computedTax, { note: "速算表" }),
    step("housingLoan", "7. 住宅借入金等特別控除の適用額", result.housingLoanCredit),
    step("annualIncomeTax", "年調所得税額", result.annualIncomeTax),
    step("annualTax", "8. 年調年税額", result.annualTax, {
      strong: true,
      note: "年調所得税額 × 102.1%（100 円未満切り捨て）",
    }),
    step("withheld", "徴収済み税額", result.withheld, {
      note: "給与・賞与の源泉所得税（調整後）と前職分",
    }),
  ];
}

/** 「過納 115,270 円（還付）」 / 「不足 3,000 円（徴収）」 / 「過不足なし」. */
export function settlementText(result: YearEndResult): string {
  switch (result.settlement.kind) {
    case "refund":
      return `過納 ${formatYen(result.settlement.amount)} 円（還付）`;
    case "shortfall":
      return `不足 ${formatYen(result.settlement.amount)} 円（徴収）`;
    case "none":
      return "過不足なし";
  }
}

/** The run lines of the year's totals. */
export interface YearEndRunView {
  key: string;
  label: string;
  paymentDate: string;
  pay: string;
  socialInsurance: string;
  withheld: string;
}

/** The 年末調整 of one person as the screen shows it (preview or confirmed). */
export interface YearEndPreviewView {
  steps: YearEndStepView[];
  totals: { pay: string; bonus: string; socialInsurance: string; withheld: string };
  runs: YearEndRunView[];
  eligible: boolean;
  ineligible: string[];
  warnings: string[];
  annualTax: string;
  settlement: { kind: "refund" | "shortfall" | "none"; text: string };
  /** Why 確定 is not possible now (empty: it is). */
  blockers: string[];
  /** The settlement entry it posts (or posted), `null` when nothing is posted. */
  entry: EntryView | null;
  /** The 源泉所得税 deadline the settlement goes into. */
  slot: { title: string; dueDate: string } | null;
  /** What 確定 sends back (whole yen as digits). */
  expected: { annualTax: string; difference: string };
  confirmed: {
    at: string;
    by: string;
    entry: { id: string; no: number } | null;
  } | null;
}

export function toYearEndPreviewView(preview: YearEndPreview): YearEndPreviewView {
  const { result } = preview;
  const runs = preview.confirmed?.runs ?? preview.totals.runs;
  const totals = preview.confirmed?.input.salary ?? preview.totals;
  return {
    steps: yearEndSteps(result),
    totals: {
      pay: formatYenDisplay(totals.pay),
      bonus: formatYenDisplay(totals.bonus),
      socialInsurance: formatYenDisplay(totals.socialInsurance),
      withheld: formatYenDisplay(totals.withheld),
    },
    runs: runs.map((line) => ({
      key: `${line.kind}-${line.runId}`,
      label: line.label,
      paymentDate: displayDate(line.paymentDate),
      pay: formatYenDisplay(line.pay),
      socialInsurance: formatYenDisplay(line.socialInsurance),
      withheld: formatYenDisplay(line.withheld),
    })),
    eligible: result.eligible,
    ineligible: result.ineligible.map((reason) => reason.message),
    warnings: result.warnings.map((warning) => warning.message),
    annualTax: formatYenDisplay(result.annualTax),
    settlement: { kind: result.settlement.kind, text: settlementText(result) },
    blockers: preview.blockers,
    entry: preview.settlement?.entry ? toEntryView(preview.settlement.entry) : null,
    slot: preview.settlement
      ? {
          title: preview.settlement.slot.title,
          dueDate: displayDate(preview.settlement.slot.dueDate),
        }
      : null,
    expected: { annualTax: String(result.annualTax), difference: String(result.difference) },
    confirmed: preview.confirmed
      ? {
          at: formatDateTime(preview.confirmed.confirmedAt),
          by: preview.confirmed.confirmedBy,
          entry: preview.confirmed.settlementEntry
            ? { id: preview.confirmed.settlementEntry.id, no: preview.confirmed.settlementEntry.no }
            : null,
        }
      : null,
  };
}

/** `previewYearEnd` with the form's (unsaved) declaration, as the form shows it. */
export async function loadYearEndPreview(
  db: PrismaClient,
  year: number,
  employeeId: string,
  declaration?: YearEndDeclarationFormInput,
): Promise<YearEndPreviewView> {
  return toYearEndPreviewView(
    await previewYearEnd(db, year, employeeId, declaration ? { declaration } : {}),
  );
}

const input = (amount: Money) => (amount === 0n ? "" : formatYenInput(amount));

/** A declaration as the form's text. */
export function declarationDraftOf(declaration: YearEndDeclaration): DeclarationDraft {
  const { insurance } = declaration;
  return {
    dependents: declaration.dependents.map((dependent) => ({ ...dependent })),
    self: { ...declaration.self },
    otherIncome: input(declaration.otherIncome),
    hasSpouse: declaration.spouse !== null,
    spouse: {
      totalIncome: declaration.spouse ? input(declaration.spouse.totalIncome) : "",
      elderly: declaration.spouse?.elderly ?? false,
      disability: declaration.spouse?.disability ?? "none",
    },
    specificRelatives: declaration.specificRelatives.map((relative) => ({
      totalIncome: input(relative.totalIncome),
    })),
    incomeAdjustment: declaration.incomeAdjustment,
    insurance: {
      newGeneral: input(insurance.newGeneral),
      oldGeneral: input(insurance.oldGeneral),
      medical: input(insurance.medical),
      newPension: input(insurance.newPension),
      oldPension: input(insurance.oldPension),
      under23Dependent: insurance.under23Dependent,
      earthquake: input(insurance.earthquake),
      oldLongTerm: input(insurance.oldLongTerm),
      socialInsurance: input(insurance.socialInsurance),
      smallBusinessMutualAid: input(insurance.smallBusinessMutualAid),
    },
    housingLoanCredit: input(declaration.housingLoanCredit),
    hasPreviousEmployer: declaration.previousEmployer !== null,
    previousEmployer: {
      paid: declaration.previousEmployer ? input(declaration.previousEmployer.paid) : "",
      socialInsurance: declaration.previousEmployer
        ? input(declaration.previousEmployer.socialInsurance)
        : "",
      withheld: declaration.previousEmployer ? input(declaration.previousEmployer.withheld) : "",
    },
  };
}

/** The choices of the form's selects (the labels live with the payroll core). */
export function yearEndOptions(birthDates: YearEndPreview["birthDates"]): YearEndOptions {
  const date = (value: string) => displayDate(value as Parameters<typeof displayDate>[0]);
  return {
    categories: DEPENDENT_CATEGORIES.map((value) => ({
      value,
      label: DEPENDENT_CATEGORY_LABELS[value],
    })),
    disabilities: DISABILITY_KINDS.map((value) => ({
      value,
      label: DISABILITY_KIND_LABELS[value],
    })),
    selfDisabilities: SELF_DISABILITY_KINDS.map((value) => ({
      value,
      label: DISABILITY_KIND_LABELS[value],
    })),
    widowStatuses: WIDOW_STATUSES.map((value) => ({ value, label: WIDOW_STATUS_LABELS[value] })),
    ageHelp: {
      specific: `${date(birthDates.specificFrom)}〜${date(birthDates.specificTo)} 生まれ`,
      elderly: `${date(birthDates.elderlyTo)} 以前の生まれ`,
      age16: `${date(birthDates.age16To)} 以前の生まれ（それより後は 16 歳未満）`,
      under23: `${date(birthDates.under23From)} 以後の生まれ`,
    },
  };
}
