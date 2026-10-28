import { loadFinancialStatementsSource, todayInJapan } from "@niho-finance/db";
import {
  buildHot010Files,
  EtaxCharacterError,
  type FinancialStatementsReport,
} from "@niho-finance/reports";
import { cache } from "react";
import { db } from "@/lib/data";

/** The book and today, read once per request. */
export const loadStatementsBook = cache(async () => {
  const prisma = await db();
  const source = await loadFinancialStatementsSource(prisma);
  return { prisma, source, today: todayInJapan() };
});

/**
 * The characters e-Tax would refuse (17 §5.1, §5.4), found before the download: the message to show,
 * or `null` when the four CSV files can be written.
 */
export function etaxCharacterProblem(report: FinancialStatementsReport): string | null {
  try {
    buildHot010Files(report);
    return null;
  } catch (error) {
    if (error instanceof EtaxCharacterError) return error.message;
    throw error;
  }
}
