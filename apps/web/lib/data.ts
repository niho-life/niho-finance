import {
  getCompany,
  getPrismaClient,
  getSetupProgress,
  loadCurrentFiscalYear,
  todayInJapan,
  type PrismaClient,
} from "@niho-finance/db";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

/**
 * Server-side reads for pages and layouts. Everything here renders per request: the book changes
 * with every write, and nothing may be read from the database at build time.
 */
export async function db(): Promise<PrismaClient> {
  await connection();
  return getPrismaClient();
}

export const loadSetupProgress = cache(async () => getSetupProgress(await db()));

/** The app needs the setup's steps 1–3 (事業所・会計期間・勘定科目); otherwise the wizard opens. */
export async function requireSetupReady(): Promise<void> {
  const progress = await loadSetupProgress();
  if (!progress.ready) redirect("/setup");
}

export interface ShellContext {
  today: ReturnType<typeof todayInJapan>;
  companyName: string | null;
  /** 第 n 期 of today. */
  fiscalYearNo: number | null;
}

export const loadShell = cache(async (): Promise<ShellContext> => {
  const prisma = await db();
  const today = todayInJapan();
  const company = await getCompany(prisma);
  const fiscalYear = await loadCurrentFiscalYear(prisma, today);
  return { today, companyName: company?.name ?? null, fiscalYearNo: fiscalYear?.no ?? null };
});
