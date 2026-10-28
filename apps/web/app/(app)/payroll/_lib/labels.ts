/*
 * Owner-facing words of the payroll screens (22-payroll §6). Plain constants: client components
 * import them without pulling in the yearly tables of `@niho-finance/payroll`.
 */

export const WORKER_KIND_LABELS = { officer: "役員", employee: "従業員" } as const;

export const TAX_COLUMN_LABELS = { kou: "甲欄", otsu: "乙欄" } as const;

/** 源泉の欄: 「甲欄 2 人」 / 「乙欄」 (22-payroll §6.2). */
export function taxColumnText(column: "kou" | "otsu", dependents: number): string {
  if (column === "kou") return `甲欄 ${dependents} 人`;
  return dependents > 0 ? `乙欄 ${dependents} 人` : "乙欄";
}

export const SIDE_LABELS = { debit: "借方", credit: "貸方" } as const;

/** The hint after a missing yearly table (docs/research/payroll-sources.md §7). */
export const TABLE_MISSING_HINT =
  "取り込みの手順は docs/research/payroll-sources.md の「取り込みの手順」にあります";
