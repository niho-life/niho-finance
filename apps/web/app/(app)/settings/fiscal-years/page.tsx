import {
  getCompany,
  listCloseOptions,
  listFiscalYears,
  proposeNextFiscalYear,
  todayInJapan,
} from "@niho-finance/db";
import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/lib/data";
import { FiscalYearsTable } from "./fiscal-years-table";

export const metadata: Metadata = { title: "会計期間" };

/** 設定 › 会計期間 (10 §4.2) with 締め (11 §7). Years are never deleted. */
export default async function FiscalYearsPage() {
  const prisma = await db();
  const fiscalYears = await listFiscalYears(prisma);
  const next = await proposeNextFiscalYear(prisma);
  const company = await getCompany(prisma);
  const today = todayInJapan();
  return (
    <>
      <PageHeader title="会計期間" back={{ href: "/settings", label: "設定" }} />
      <FiscalYearsTable
        fiscalYears={fiscalYears}
        next={next}
        fiscalYearEndMonth={company?.fiscalYearEndMonth ?? 3}
        closeOptions={Object.fromEntries(
          fiscalYears.map((year) => [year.id, listCloseOptions(year, today)]),
        )}
      />
    </>
  );
}
