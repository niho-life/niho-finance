/**
 * 決算のチェックリストの「決算書」(17-financial-statements §10, #14): done when the year is closed,
 * the 確認 of the statements is empty and 発行済株式の総数 is entered (a missing number is one of the
 * 確認 rows).
 */
import type { FinancialStatementsReport } from "./report";

export interface FinancialStatementsReadiness {
  done: boolean;
  /** What is left, owner-facing (the year's state first, then the 確認 rows). */
  issues: string[];
}

export const NOT_CLOSED_MESSAGE = "期が締め済みではありません。決算整理の後に期を締めます";

export function financialStatementsReadiness(
  report: FinancialStatementsReport,
): FinancialStatementsReadiness {
  const issues: string[] = [];
  if (report.fiscalYear.status !== "closed") issues.push(NOT_CLOSED_MESSAGE);
  for (const issue of report.issues) issues.push(issue.message);
  return { done: issues.length === 0, issues };
}
