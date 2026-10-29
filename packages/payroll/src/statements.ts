import { dateParts, type CalendarDate, type Money } from "@niho-finance/ledger";
import type { WorkerKind } from "./payroll";
import type { YearEndTable } from "./tables";
import type { DisabilityKind, YearEndDeclaration, YearEndPerson, YearEndResult } from "./year-end";

/**
 * 法定調書 (22-payroll §12): 給与所得の源泉徴収票 / 給与支払報告書（個人別明細書）as one object with
 * every field of the form (国税庁「令和８年分 給与所得の源泉徴収票等の法定調書の作成と提出の手引」第 2 章
 * の記載要領), built from the year's confirmed pay, the confirmed 年末調整 and the saved declaration,
 * and 給与所得の源泉徴収票合計表 の元データ. Pure: never a マイナンバー (the CSV takes those as options).
 */

/** 支払者 (the company) as the reports print it. */
export interface StatementPayer {
  name: string;
  address: string;
  /** 電話番号 (`null` = not recorded). */
  phone: string | null;
  /** 法人番号 (13 digits; public). Not printed on 受給者交付用. */
  corporateNumber: string | null;
}

/** A relative on the slip: the declared name and the CSV's 区分. */
export interface SlipRelative {
  name: string;
  furigana: string;
  nonResident: boolean;
  /**
   * The 区分 of the unified CSV (別紙): 控除対象扶養親族 `00` / 非居住者 `01`; 特定親族 `10`〜`90`
   * (非居住者 `11`〜`91`); 16 歳未満 `00` / 国外 `01`; 配偶者 "" / 非居住者 `01`.
   */
  code: string;
  /** 「特定扶養親族」「同居老親等」「特定親族」… (for the PDF). */
  label: string;
}

/** 中途就・退職. */
export interface SlipEmploymentChange {
  kind: "joined" | "left";
  date: CalendarDate;
}

/** 給与所得の源泉徴収票 of one person and year (every field of the form, §12.2). */
export interface WithholdingSlip {
  year: number;
  /** 年末調整をした (確定した年末調整がある): the deduction fields are filled. */
  adjusted: boolean;
  recipient: {
    employeeId: string;
    name: string;
    /** As declared; "" when missing. */
    furigana: string;
    /** 住所又は居所 (翌年 1 月 1 日現在、退職者は退職時); "" when missing. */
    address: string;
    /** 受給者番号. */
    recipientNo: string;
    /** 提出先市町村コード; "" when missing. */
    municipalityCode: string;
    kind: WorkerKind;
    /** 役職名 (not recorded: ""). */
    title: string;
  };
  /** 種別: 給料 / 給料・賞与 / 役員報酬 / 役員報酬・賞与. */
  kindLabel: string;
  /** 支払金額 (前職分を通算した年末調整ではその分を含む) and 内 未払金額. */
  paid: Money;
  unpaid: Money;
  /** 給与所得控除後の金額（調整控除後）; `null` = 年末調整をしていない. */
  salaryIncomeAfterAdjustment: Money | null;
  /** 所得控除の額の合計額. */
  totalDeductions: Money | null;
  /** 源泉徴収税額 (年末調整をした人は年調年税額) and 内 未徴収税額. */
  withheld: Money;
  notWithheld: Money;
  /** (源泉) 控除対象配偶者の有無等: `null` = not stated (乙欄・申告なし). */
  spouse: { has: boolean; secondary: boolean; elderly: boolean } | null;
  /** 配偶者（特別）控除の額. */
  spouseDeduction: Money | null;
  /** 控除対象扶養親族の数（配偶者を除く）: 主たる給与の分 (従たる給与の分は 0). `null` = not stated. */
  dependents: {
    specific: number;
    elderly: number;
    /** 老人のうち同居老親等 (内書き). */
    elderlyCohabiting: number;
    other: number;
    /** 特定親族 (特親). */
    specificRelative: number;
    secondary: { specific: number; elderly: number; other: number; specificRelative: number };
  } | null;
  /** 16 歳未満扶養親族の数. */
  minors: number | null;
  /** 障害者の数（本人を除く）: 特別障害者 (内 同居) とその他. */
  disabled: { special: number; specialCohabiting: number; other: number } | null;
  /** 非居住者である親族の数. */
  nonResidentRelatives: number | null;
  /** 社会保険料等の金額 (小規模企業共済等掛金を含む) and its 内訳. */
  socialInsurance: Money;
  smallBusinessMutualAid: Money;
  lifeInsurance: Money | null;
  earthquake: Money | null;
  housingLoan: Money | null;
  /** 生命保険料の金額の内訳 (申告書の保険料). */
  lifeInsuranceBreakdown: {
    newLife: Money;
    oldLife: Money;
    medical: Money;
    newPension: Money;
    oldPension: Money;
  } | null;
  /** 住宅借入金等特別控除の額の内訳: only 可能額 is recorded (居住開始年月日・区分・年末残高 are not). */
  housingLoanBreakdown: { possible: Money } | null;
  /** (源泉・特別) 控除対象配偶者 and its 合計所得, 国民年金保険料等の金額, 旧長期損害保険料の金額. */
  spousePerson: SlipRelative | null;
  spouseTotalIncome: Money | null;
  nationalPension: Money | null;
  oldLongTerm: Money | null;
  basicDeduction: Money | null;
  incomeAdjustment: Money | null;
  specificRelativeDeduction: Money | null;
  /** 控除対象扶養親族 (特定親族を含む), all of them (the form prints 4; the rest go to 摘要). */
  dependentPersons: SlipRelative[];
  /** 16 歳未満の扶養親族, all of them. */
  minorPersons: SlipRelative[];
  /** 本人の区分 etc. */
  flags: {
    minor: boolean;
    foreigner: boolean;
    deceasedRetirement: boolean;
    disaster: boolean;
    otsu: boolean;
    specialDisabled: boolean;
    otherDisabled: boolean;
    widow: boolean;
    singleParent: boolean;
    workingStudent: boolean;
  };
  employmentChange: SlipEmploymentChange | null;
  /** 前職（他の支払者）: when 前職分 is included in the 年末調整. */
  previousEmployer: {
    address: string;
    name: string;
    paid: Money;
    withheld: Money;
    socialInsurance: Money;
    leftOn: CalendarDate | null;
  } | null;
  birthDate: CalendarDate;
  /** 摘要, line by line. */
  remarks: string[];
  payer: StatementPayer;
}

/** What `buildWithholdingSlip` reads (the database layer collects it). */
export interface WithholdingSlipInput {
  year: number;
  payer: StatementPayer;
  employee: {
    id: string;
    name: string;
    kind: WorkerKind;
    birthDate: CalendarDate;
    /** 甲欄 / 乙欄 at the year's last pay. */
    taxColumn: "kou" | "otsu";
    leftOn: CalendarDate | null;
    /** 就職の日 when it falls in the year (資格取得日 as recorded), else `null`. */
    joinedOn: CalendarDate | null;
  };
  /** This employer's 給与・賞与 paid in the year (確定した支給と賞与). */
  totals: { pay: Money; bonus: Money; socialInsurance: Money; withheld: Money };
  /** The saved declaration (names included), `null` = none. */
  declaration: YearEndDeclaration | null;
  /**
   * The declaration's 申告 was saved (default). `false`: the row holds the 法定調書 fields only, and
   * the counts of the 扶養控除等申告書 are not stated.
   */
  declared?: boolean;
  /** The confirmed 年末調整, `null` = not adjusted (乙欄・中途退職・対象外). */
  yearEnd: YearEndResult | null;
  table: YearEndTable;
}

/** 受給者番号 by default: the employee id's last 25 characters (the CSV's 半角 25). */
export function defaultRecipientNo(employeeId: string): string {
  return employeeId.slice(-25);
}

/** The age reached on `on` of someone born on `birthDate`. */
function ageOn(birthDate: CalendarDate, on: CalendarDate): number {
  const birth = dateParts(birthDate);
  const day = dateParts(on);
  const before = day.month < birth.month || (day.month === birth.month && day.day < birth.day);
  return day.year - birth.year - (before ? 1 : 0);
}

const relativeOf = (person: YearEndPerson | undefined) => ({
  name: person?.name ?? "",
  furigana: person?.furigana ?? "",
  nonResident: person?.nonResident ?? false,
});

const DEPENDENT_LABELS = {
  general: "一般",
  specific: "特定扶養親族",
  elderly: "老人扶養親族",
  elderly_cohabiting: "同居老親等",
  minor: "16 歳未満",
} as const;

const isSpecialDisability = (kind: DisabilityKind) =>
  kind === "special" || kind === "special_cohabiting";

/** The CSV 区分 of a 特定親族 by 合計所得金額: the bracket's number × 10 (+1 for 非居住者). */
export function specificRelativeCode(
  table: YearEndTable,
  totalIncome: Money,
  nonResident: boolean,
): string | null {
  if (totalIncome <= table.specificRelative.incomeOver) return null;
  const index = table.specificRelative.brackets.findIndex((bracket) => totalIncome <= bracket.upTo);
  if (index < 0) return null;
  return String((index + 1) * 10 + (nonResident ? 1 : 0));
}

/** The counts and persons of the declaration (年末調整をした人は確定した結果で、しない人は申告書で). */
function relativesOf(
  table: YearEndTable,
  declaration: YearEndDeclaration,
): {
  dependents: NonNullable<WithholdingSlip["dependents"]>;
  minors: number;
  disabled: NonNullable<WithholdingSlip["disabled"]>;
  nonResident: number;
  dependentPersons: SlipRelative[];
  minorPersons: SlipRelative[];
} {
  const dependents = {
    specific: 0,
    elderly: 0,
    elderlyCohabiting: 0,
    other: 0,
    specificRelative: 0,
    secondary: { specific: 0, elderly: 0, other: 0, specificRelative: 0 },
  };
  const disabled = { special: 0, specialCohabiting: 0, other: 0 };
  let minors = 0;
  let nonResident = 0;
  const dependentPersons: SlipRelative[] = [];
  const minorPersons: SlipRelative[] = [];
  const countDisability = (kind: DisabilityKind) => {
    if (isSpecialDisability(kind)) disabled.special += 1;
    if (kind === "special_cohabiting") disabled.specialCohabiting += 1;
    if (kind === "general") disabled.other += 1;
  };
  for (const dependent of declaration.dependents) {
    const person = relativeOf(dependent.person);
    if (person.nonResident) nonResident += 1;
    countDisability(dependent.disability);
    switch (dependent.category) {
      case "minor":
        minors += 1;
        minorPersons.push({
          ...person,
          code: person.nonResident ? "01" : "00",
          label: DEPENDENT_LABELS.minor,
        });
        continue;
      case "specific":
        dependents.specific += 1;
        break;
      case "elderly":
        dependents.elderly += 1;
        break;
      case "elderly_cohabiting":
        dependents.elderly += 1;
        dependents.elderlyCohabiting += 1;
        break;
      case "general":
        dependents.other += 1;
        break;
    }
    dependentPersons.push({
      ...person,
      code: person.nonResident ? "01" : "00",
      label: DEPENDENT_LABELS[dependent.category],
    });
  }
  for (const relative of declaration.specificRelatives) {
    const person = relativeOf(relative.person);
    const code = specificRelativeCode(table, relative.totalIncome, person.nonResident);
    if (code === null) continue;
    dependents.specificRelative += 1;
    if (person.nonResident) nonResident += 1;
    dependentPersons.push({ ...person, code, label: "特定親族" });
  }
  const spouse = declaration.spouse;
  if (spouse) {
    if (spouse.person?.nonResident) nonResident += 1;
    // 障害者控除 counts the 同一生計配偶者 only (合計所得金額 62 万円以下).
    if (spouse.totalIncome <= table.dependents.incomeLimit) countDisability(spouse.disability);
  }
  return { dependents, minors, disabled, nonResident, dependentPersons, minorPersons };
}

/** 源泉控除対象配偶者 (年末調整をしない人の欄): 合計所得金額が 配偶者特別控除 38 万円の上限以下. */
function withholdingSpouseLimit(table: YearEndTable): Money {
  return table.spouse.special[0]?.upTo ?? table.spouse.deductionIncomeLimit;
}

function kindLabelOf(kind: WorkerKind, totals: { pay: Money; bonus: Money }): string {
  const base = kind === "officer" ? "役員報酬" : "給料";
  if (totals.bonus > 0n && totals.pay > 0n) return `${base}・賞与`;
  if (totals.bonus > 0n) return "賞与";
  return base;
}

const yen = (amount: Money) => amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * 給与所得の源泉徴収票 (§12.2) of one person. With a confirmed 年末調整 every field is filled from it
 * (支払金額 and 社会保険料等 include 前職分; 源泉徴収税額 is the 年調年税額). Without one (乙欄・中途退職・
 * 対象外) only 支払金額・源泉徴収税額・社会保険料等 and, for 甲欄 with a declaration, the counts and
 * names of the 扶養控除等申告書 are filled; the deduction amounts stay empty.
 */
export function buildWithholdingSlip(input: WithholdingSlipInput): WithholdingSlip {
  const { employee, totals, table, year } = input;
  const declaration = input.declaration;
  const result = input.yearEnd;
  const adjusted = result !== null;
  const yearEndDay = `${String(year).padStart(4, "0")}-12-31` as CalendarDate;
  const statedDeclaration =
    employee.taxColumn === "kou" && input.declared !== false ? declaration : null;
  const relatives = statedDeclaration ? relativesOf(table, statedDeclaration) : null;
  const previous = adjusted ? (declaration?.previousEmployer ?? null) : null;

  // 配偶者.
  let spouse: WithholdingSlip["spouse"] = null;
  let spousePerson: SlipRelative | null = null;
  let spouseTotalIncome: Money | null = null;
  const declaredSpouse = statedDeclaration?.spouse ?? null;
  if (statedDeclaration) {
    if (adjusted) {
      const deducted = result.deductions.spouse > 0n;
      const has = result.deductions.spouseKind === "spouse";
      spouse = { has, secondary: false, elderly: has && (declaredSpouse?.elderly ?? false) };
      if (declaredSpouse && deducted) {
        spouseTotalIncome = declaredSpouse.totalIncome;
      }
      if (declaredSpouse && deducted) {
        const person = relativeOf(declaredSpouse.person);
        spousePerson = { ...person, code: person.nonResident ? "01" : "", label: "配偶者" };
      }
    } else {
      const has =
        declaredSpouse !== null && declaredSpouse.totalIncome <= withholdingSpouseLimit(table);
      spouse = { has, secondary: false, elderly: has && (declaredSpouse?.elderly ?? false) };
      if (declaredSpouse && has) {
        const person = relativeOf(declaredSpouse.person);
        spousePerson = { ...person, code: person.nonResident ? "01" : "", label: "配偶者" };
      }
    }
  }

  // 本人の区分.
  const self = statedDeclaration?.self ?? null;
  const flags: WithholdingSlip["flags"] = {
    minor: ageOn(employee.birthDate, yearEndDay) < 18,
    foreigner: false,
    deceasedRetirement: false,
    disaster: false,
    otsu: employee.taxColumn === "otsu",
    specialDisabled: self?.disability === "special",
    otherDisabled: self?.disability === "general",
    widow: adjusted
      ? self?.widowStatus === "widow" && result.deductions.dependents.widowOrSingleParent > 0n
      : self?.widowStatus === "widow",
    singleParent: adjusted
      ? self?.widowStatus === "single_parent" &&
        result.deductions.dependents.widowOrSingleParent > 0n
      : self?.widowStatus === "single_parent",
    workingStudent: adjusted
      ? (self?.workingStudent ?? false) && result.deductions.dependents.workingStudent > 0n
      : (self?.workingStudent ?? false),
  };

  // 中途就・退職: leaving in the year wins (the CSV has one 区分).
  let employmentChange: SlipEmploymentChange | null = null;
  if (employee.leftOn !== null && dateParts(employee.leftOn).year === year) {
    employmentChange = { kind: "left", date: employee.leftOn };
  } else if (employee.joinedOn !== null && dateParts(employee.joinedOn).year === year) {
    employmentChange = { kind: "joined", date: employee.joinedOn };
  }

  // 摘要.
  const remarks: string[] = [];
  if (previous) {
    const payer = previous.payer;
    const who =
      payer && (payer.name !== "" || payer.address !== "")
        ? `${payer.address}${payer.address !== "" && payer.name !== "" ? " " : ""}${payer.name}`
        : "前職の支払者";
    const left = payer?.leftOn
      ? `（${dateParts(payer.leftOn).year} 年 ${dateParts(payer.leftOn).month} 月 ${dateParts(payer.leftOn).day} 日退職）`
      : "";
    remarks.push(
      `前職分を含む。${who}${left} 支払金額 ${yen(previous.paid)} 円・源泉徴収税額 ${yen(previous.withheld)} 円・社会保険料等 ${yen(previous.socialInsurance)} 円`,
    );
  }
  if (adjusted && declaration && declaration.housingLoanCredit > result.housingLoanCredit) {
    remarks.push(`住宅借入金等特別控除可能額 ${yen(declaration.housingLoanCredit)} 円`);
  }
  if (relatives) {
    const extraDependents = relatives.dependentPersons.slice(4);
    if (extraDependents.length > 0) {
      remarks.push(
        `5 人目以降の控除対象扶養親族: ${extraDependents.map((person) => person.name || "（氏名未入力）").join("、")}`,
      );
    }
    const extraMinors = relatives.minorPersons.slice(4);
    if (extraMinors.length > 0) {
      remarks.push(
        `5 人目以降の 16 歳未満の扶養親族: ${extraMinors.map((person) => person.name || "（氏名未入力）").join("、")}`,
      );
    }
  }
  if (
    statedDeclaration &&
    declaredSpouse &&
    spousePerson === null &&
    declaredSpouse.totalIncome <= table.dependents.incomeLimit &&
    declaredSpouse.disability !== "none"
  ) {
    // 同一生計配偶者（障害者控除の対象）で控除対象配偶者でない人の氏名 (手引の摘要).
    remarks.push(`同一生計配偶者: ${declaredSpouse.person?.name || "（氏名未入力）"}`);
  }

  const recipient = declaration?.recipient;
  const insurance = statedDeclaration?.insurance ?? null;
  return {
    year,
    adjusted,
    recipient: {
      employeeId: employee.id,
      name: employee.name,
      furigana: recipient?.furigana ?? "",
      address: recipient?.address ?? "",
      recipientNo:
        recipient && recipient.recipientNo !== ""
          ? recipient.recipientNo
          : defaultRecipientNo(employee.id),
      municipalityCode: recipient?.municipalityCode ?? "",
      kind: employee.kind,
      title: "",
    },
    kindLabel: kindLabelOf(employee.kind, totals),
    paid: adjusted ? result.totalPay : totals.pay + totals.bonus,
    unpaid: 0n,
    salaryIncomeAfterAdjustment: adjusted ? result.salaryIncomeAfterAdjustment : null,
    totalDeductions: adjusted ? result.deductions.total : null,
    withheld: adjusted ? result.annualTax : totals.withheld,
    notWithheld: 0n,
    spouse,
    spouseDeduction: adjusted ? result.deductions.spouse : null,
    dependents: relatives?.dependents ?? null,
    minors: relatives?.minors ?? null,
    disabled: relatives?.disabled ?? null,
    nonResidentRelatives: relatives?.nonResident ?? null,
    socialInsurance: adjusted
      ? result.deductions.socialInsurance + result.deductions.smallBusinessMutualAid
      : totals.socialInsurance,
    smallBusinessMutualAid: adjusted ? result.deductions.smallBusinessMutualAid : 0n,
    lifeInsurance: adjusted ? result.deductions.lifeInsurance.total : null,
    earthquake: adjusted ? result.deductions.earthquake : null,
    housingLoan: adjusted ? result.housingLoanCredit : null,
    lifeInsuranceBreakdown:
      adjusted && insurance
        ? {
            newLife: insurance.newGeneral,
            oldLife: insurance.oldGeneral,
            medical: insurance.medical,
            newPension: insurance.newPension,
            oldPension: insurance.oldPension,
          }
        : null,
    housingLoanBreakdown:
      adjusted && declaration && declaration.housingLoanCredit > 0n
        ? { possible: declaration.housingLoanCredit }
        : null,
    spousePerson,
    spouseTotalIncome: adjusted ? spouseTotalIncome : null,
    nationalPension: adjusted && insurance ? insurance.socialInsurance : null,
    oldLongTerm: adjusted && insurance ? insurance.oldLongTerm : null,
    basicDeduction: adjusted ? result.deductions.basic : null,
    incomeAdjustment: adjusted ? result.incomeAdjustment : null,
    specificRelativeDeduction: adjusted ? result.deductions.specificRelative : null,
    dependentPersons: relatives?.dependentPersons ?? [],
    minorPersons: relatives?.minorPersons ?? [],
    flags,
    employmentChange,
    previousEmployer: previous
      ? {
          address: previous.payer?.address ?? "",
          name: previous.payer?.name ?? "",
          paid: previous.paid,
          withheld: previous.withheld,
          socialInsurance: previous.socialInsurance,
          leftOn: previous.payer?.leftOn ?? null,
        }
      : null,
    birthDate: employee.birthDate,
    remarks,
    payer: input.payer,
  };
}

// ---------------------------------------------------------------------------------------------
// 提出の範囲 (§12.1)
// ---------------------------------------------------------------------------------------------

/** 給与支払報告書の提出範囲から外れる、年の中途の退職者の支払金額の上限 (30 万円以下). */
export const SALARY_REPORT_LEAVER_LIMIT = 300_000n;

/**
 * Whether 給与支払報告書 goes to the municipality (§12.1): everyone paid in the year except those who
 * left in the year with 支払金額 ≤ 30 万円. (受給者交付用 goes to everyone paid.)
 */
export function inSalaryReportRange(
  slip: Pick<WithholdingSlip, "paid" | "employmentChange">,
): boolean {
  if (slip.employmentChange?.kind === "left" && slip.paid <= SALARY_REPORT_LEAVER_LIMIT) {
    return false;
  }
  return true;
}

/**
 * 源泉徴収票の税務署への提出範囲 (所得税法施行規則第 93 条; 2027 年 1 月以後は給与支払報告書の提出で
 * みなし提出): 年末調整をした 役員 150 万円超・その他 500 万円超; しなかった 乙欄 50 万円超・中途退職
 * 役員 150 万円超・その他 250 万円超・2,000 万円超は全員.
 */
export function inTaxOfficeRange(
  slip: Pick<WithholdingSlip, "adjusted" | "paid" | "flags" | "employmentChange"> & {
    recipient: Pick<WithholdingSlip["recipient"], "kind">;
  },
): boolean {
  const officer = slip.recipient.kind === "officer";
  if (slip.adjusted) return slip.paid > (officer ? 1_500_000n : 5_000_000n);
  if (slip.paid > 20_000_000n) return true;
  if (slip.flags.otsu) return slip.paid > 500_000n;
  if (slip.employmentChange?.kind === "left") {
    return slip.paid > (officer ? 1_500_000n : 2_500_000n);
  }
  return slip.paid > (officer ? 1_500_000n : 5_000_000n);
}

// ---------------------------------------------------------------------------------------------
// 法定調書合計表 (給与) の元データ (§12.2)
// ---------------------------------------------------------------------------------------------

export interface SalaryTotalsRow {
  people: number;
  paid: Money;
  withheld: Money;
}

/** 給与所得の源泉徴収票合計表 (375) の元データ. */
export interface AnnualSalaryTotals {
  /** 俸給、給与、賞与等の総額. */
  all: SalaryTotalsRow & { peopleWithoutTax: number };
  /** うち 年末調整をしたもの / しないもの. */
  adjusted: SalaryTotalsRow;
  notAdjusted: SalaryTotalsRow;
  /** うち 役員. */
  officers: SalaryTotalsRow;
  /** 源泉徴収票を提出するもの (税務署の提出範囲). */
  taxOffice: SalaryTotalsRow;
  /** 給与支払報告書を提出するもの (市区町村). */
  salaryReport: SalaryTotalsRow;
}

const emptyRow = (): SalaryTotalsRow => ({ people: 0, paid: 0n, withheld: 0n });

function addTo(row: SalaryTotalsRow, slip: Pick<WithholdingSlip, "paid" | "withheld">): void {
  row.people += 1;
  row.paid += slip.paid;
  row.withheld += slip.withheld;
}

/** Sums the slips of the year (everyone paid) into the 合計表's rows. */
export function annualSalaryTotals(slips: readonly WithholdingSlip[]): AnnualSalaryTotals {
  const totals: AnnualSalaryTotals = {
    all: { ...emptyRow(), peopleWithoutTax: 0 },
    adjusted: emptyRow(),
    notAdjusted: emptyRow(),
    officers: emptyRow(),
    taxOffice: emptyRow(),
    salaryReport: emptyRow(),
  };
  for (const slip of slips) {
    addTo(totals.all, slip);
    if (slip.withheld === 0n) totals.all.peopleWithoutTax += 1;
    addTo(slip.adjusted ? totals.adjusted : totals.notAdjusted, slip);
    if (slip.recipient.kind === "officer") addTo(totals.officers, slip);
    if (inTaxOfficeRange(slip)) addTo(totals.taxOffice, slip);
    if (inSalaryReportRange(slip)) addTo(totals.salaryReport, slip);
  }
  return totals;
}
