import { amountKey } from "./preview-key";

/*
 * The 年末調整の申告 as the form holds it (22-payroll §11.5): text fields and checkboxes, shared by
 * the server page (which fills it) and the client form (which sends it). Plain data: no import of
 * the yearly tables.
 */

export interface DependentDraft {
  /** 一般 / 特定 / 老人 / 同居老親等 / 16 歳未満. */
  category: string;
  disability: string;
  /** 一般 only: 23 歳未満 (16〜18 歳). */
  under23: boolean;
}

export interface DeclarationDraft {
  dependents: DependentDraft[];
  self: { disability: string; widowStatus: string; workingStudent: boolean };
  otherIncome: string;
  hasSpouse: boolean;
  spouse: { totalIncome: string; elderly: boolean; disability: string };
  specificRelatives: { totalIncome: string }[];
  incomeAdjustment: boolean;
  insurance: {
    newGeneral: string;
    oldGeneral: string;
    medical: string;
    newPension: string;
    oldPension: string;
    under23Dependent: boolean;
    earthquake: string;
    oldLongTerm: string;
    socialInsurance: string;
    smallBusinessMutualAid: string;
  };
  housingLoanCredit: string;
  hasPreviousEmployer: boolean;
  previousEmployer: { paid: string; socialInsurance: string; withheld: string };
}

export interface YearEndOption {
  value: string;
  label: string;
}

/** The selects' choices and the year's birth-date ranges (from the server). */
export interface YearEndOptions {
  categories: YearEndOption[];
  disabilities: YearEndOption[];
  selfDisabilities: YearEndOption[];
  widowStatuses: YearEndOption[];
  ageHelp: { specific: string; elderly: string; age16: string; under23: string };
}

/** What `saveYearEndDeclaration` / `previewYearEnd` take: 配偶者・前職 are `null` when not checked. */
export function declarationInput(draft: DeclarationDraft) {
  return {
    dependents: draft.dependents.map((dependent) => ({ ...dependent })),
    self: { ...draft.self },
    otherIncome: draft.otherIncome,
    spouse: draft.hasSpouse ? { ...draft.spouse } : null,
    specificRelatives: draft.specificRelatives.map((relative) => ({ ...relative })),
    incomeAdjustment: draft.incomeAdjustment,
    insurance: { ...draft.insurance },
    housingLoanCredit: draft.housingLoanCredit,
    previousEmployer: draft.hasPreviousEmployer ? { ...draft.previousEmployer } : null,
  };
}

/** What a preview was computed for: amounts by value (the fields reformat themselves on blur). */
export function declarationKey(draft: DeclarationDraft): string {
  const input = declarationInput(draft);
  return JSON.stringify({
    ...input,
    otherIncome: amountKey(input.otherIncome),
    spouse: input.spouse
      ? { ...input.spouse, totalIncome: amountKey(input.spouse.totalIncome) }
      : null,
    specificRelatives: input.specificRelatives.map((relative) => amountKey(relative.totalIncome)),
    insurance: Object.fromEntries(
      Object.entries(input.insurance).map(([key, value]) => [
        key,
        typeof value === "string" ? amountKey(value) : value,
      ]),
    ),
    housingLoanCredit: amountKey(input.housingLoanCredit),
    previousEmployer: input.previousEmployer
      ? {
          paid: amountKey(input.previousEmployer.paid),
          socialInsurance: amountKey(input.previousEmployer.socialInsurance),
          withheld: amountKey(input.previousEmployer.withheld),
        }
      : null,
  });
}
