import { dateParts, isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import pension2020 from "../data/2020/pension.json";
import employment2026 from "../data/2026/employment-insurance.json";
import kenpo2026 from "../data/2026/kyokai-kenpo-kanagawa.json";
import bonusWithholding2026 from "../data/2026/withholding-bonus.json";
import withholding2026 from "../data/2026/withholding-monthly.json";
import pension2027 from "../data/2027/pension.json";
import bonusWithholding2027 from "../data/2027/withholding-bonus.json";
import withholding2027 from "../data/2027/withholding-monthly.json";
import { PayrollInputError, PayrollTableMissingError } from "./errors";
import { isYearMonth, yearMonthParts, type YearMonth } from "./month";
import {
  parseBonusWithholdingTable,
  parseEmploymentInsuranceTable,
  parseKenpoTable,
  parsePensionTable,
  parseWithholdingTable,
  type BonusWithholdingTable,
  type EmploymentInsuranceTable,
  type KenpoTable,
  type PayrollTable,
  type PensionTable,
  type WithholdingTable,
} from "./tables";

/**
 * The registered table versions (22-payroll §3.2). To add a version, put its JSON under
 * `data/<year>/`, import it here and append it to its list. The numbers of a registered version
 * never change: a correction or revision is a new version from the month it applies.
 */

/**
 * Sorts one kind's versions by start and rejects overlaps. `effectiveTo: null` runs until the
 * next version starts; a stated end must come before the next start.
 */
function versions<T extends PayrollTable>(tables: readonly T[]): readonly T[] {
  const sorted = [...tables].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const table = sorted[index]!;
    if (
      table.effectiveFrom === previous.effectiveFrom ||
      (previous.effectiveTo !== null && previous.effectiveTo >= table.effectiveFrom)
    ) {
      throw new RangeError(`${previous.id} and ${table.id} overlap`);
    }
  }
  return sorted;
}

const WITHHOLDING_TABLES = versions([
  parseWithholdingTable(withholding2026),
  parseWithholdingTable(withholding2027),
]);
const KENPO_TABLES = versions([parseKenpoTable(kenpo2026)]);
const PENSION_TABLES = versions([parsePensionTable(pension2020), parsePensionTable(pension2027)]);
const EMPLOYMENT_INSURANCE_TABLES = versions([parseEmploymentInsuranceTable(employment2026)]);
const BONUS_WITHHOLDING_TABLES = versions([
  parseBonusWithholdingTable(bonusWithholding2026),
  parseBonusWithholdingTable(bonusWithholding2027),
]);

/** Rejects an id registered twice (ids are what a payroll run stores). */
function uniqueIds(tables: readonly PayrollTable[]): readonly PayrollTable[] {
  const ids = new Set<string>();
  for (const table of tables) {
    if (ids.has(table.id)) throw new RangeError(`table id ${table.id} is registered twice`);
    ids.add(table.id);
  }
  return tables;
}

/** Every registered version of every table kind. */
export const REGISTERED_TABLES: readonly PayrollTable[] = uniqueIds([
  ...WITHHOLDING_TABLES,
  ...KENPO_TABLES,
  ...PENSION_TABLES,
  ...EMPLOYMENT_INSURANCE_TABLES,
  ...BONUS_WITHHOLDING_TABLES,
]);

/** The version in force at `when`: the latest one starting on or before it, unless it has ended. */
function select<T extends PayrollTable>(tables: readonly T[], when: string): T | undefined {
  let chosen: T | undefined;
  for (const table of tables) if (table.effectiveFrom <= when) chosen = table;
  if (!chosen || (chosen.effectiveTo !== null && when > chosen.effectiveTo)) return undefined;
  return chosen;
}

/** A registered version by its `id` (e.g. the id a payroll run stored), or `undefined`. */
export function findTableById(id: string): PayrollTable | undefined {
  return REGISTERED_TABLES.find((table) => table.id === id);
}

function checkDate(paymentDate: CalendarDate): void {
  if (!isCalendarDate(paymentDate)) {
    throw new PayrollInputError([
      {
        code: "INVALID_DATE",
        field: "paymentDate",
        message: `支払日「${String(paymentDate)}」が正しくありません（YYYY-MM-DD）`,
      },
    ]);
  }
}

function checkMonth(premiumMonth: YearMonth): { year: number; month: number } {
  if (!isYearMonth(premiumMonth)) {
    throw new PayrollInputError([
      {
        code: "INVALID_PREMIUM_MONTH",
        field: "premiumMonth",
        message: `対象月「${String(premiumMonth)}」が正しくありません（YYYY-MM）`,
      },
    ]);
  }
  return yearMonthParts(premiumMonth);
}

/** 源泉徴収税額表 月額表 of the year the payment date belongs to (年分). */
export function findWithholdingTable(paymentDate: CalendarDate): WithholdingTable {
  checkDate(paymentDate);
  const table = select(WITHHOLDING_TABLES, paymentDate);
  if (table) return table;
  const { year } = dateParts(paymentDate);
  throw new PayrollTableMissingError(
    "withholding-monthly",
    paymentDate,
    `支払日 ${paymentDate} に使う源泉徴収税額表（月額表）の ${year} 年分が登録されていません。国税庁の ${year} 年分の税額表を取り込んでください`,
  );
}

/** 賞与に対する源泉徴収税額の算出率の表 of the year the payment date belongs to (年分, 22-payroll §10.1). */
export function findBonusWithholdingTable(paymentDate: CalendarDate): BonusWithholdingTable {
  checkDate(paymentDate);
  const table = select(BONUS_WITHHOLDING_TABLES, paymentDate);
  if (table) return table;
  const { year } = dateParts(paymentDate);
  throw new PayrollTableMissingError(
    "withholding-bonus",
    paymentDate,
    `支払日 ${paymentDate} に使う賞与に対する源泉徴収税額の算出率の表の ${year} 年分が登録されていません。国税庁の ${year} 年分の算出率の表を取り込んでください`,
  );
}

/** 協会けんぽ（神奈川支部）の料率と健康保険の等級表 of the premium month (年度: 3 月分〜翌年 2 月分). */
export function findKenpoTable(premiumMonth: YearMonth): KenpoTable {
  const { year, month } = checkMonth(premiumMonth);
  const table = select(KENPO_TABLES, premiumMonth);
  if (table) return table;
  const fiscalYear = month >= 3 ? year : year - 1;
  throw new PayrollTableMissingError(
    "kyokai-kenpo",
    premiumMonth,
    `対象月 ${year} 年 ${month} 月分の協会けんぽ（神奈川支部）の保険料率・等級表（${fiscalYear} 年度）が登録されていません。${fiscalYear} 年度の保険料額表を取り込んでください`,
  );
}

/** 厚生年金の料率・拠出金率・等級表 of the premium month. */
export function findPensionTable(premiumMonth: YearMonth): PensionTable {
  const { year, month } = checkMonth(premiumMonth);
  const table = select(PENSION_TABLES, premiumMonth);
  if (table) return table;
  throw new PayrollTableMissingError(
    "pension",
    premiumMonth,
    `対象月 ${year} 年 ${month} 月分の厚生年金保険の料率・等級表が登録されていません。${year} 年 ${month} 月分の保険料額表を取り込んでください`,
  );
}

/** 雇用保険料率（一般の事業）of the premium month (年度: 4 月〜翌年 3 月). */
export function findEmploymentInsuranceTable(premiumMonth: YearMonth): EmploymentInsuranceTable {
  const { year, month } = checkMonth(premiumMonth);
  const table = select(EMPLOYMENT_INSURANCE_TABLES, premiumMonth);
  if (table) return table;
  const fiscalYear = month >= 4 ? year : year - 1;
  throw new PayrollTableMissingError(
    "employment-insurance",
    premiumMonth,
    `対象月 ${year} 年 ${month} 月分の雇用保険料率（${fiscalYear} 年度）が登録されていません。${fiscalYear} 年度の雇用保険料率を取り込んでください`,
  );
}
