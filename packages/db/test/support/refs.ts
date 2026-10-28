import type { CalendarDate, FiscalYearStatus } from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { toDbDate } from "../../src/dates";
import { newId } from "../../src/ids";

export interface SeededRefs {
  account(code: string): string;
  segment(code: string): string;
  subAccount(name: string): string;
  fiscalYear1: FiscalYear;
}

/** IDs of the seeded master data, looked up by code / name. */
export async function seededRefs(prisma: PrismaClient): Promise<SeededRefs> {
  const accounts = new Map(
    (await prisma.account.findMany()).map((account) => [account.code, account.id]),
  );
  const segments = new Map(
    (await prisma.segment.findMany()).map((segment) => [segment.code, segment.id]),
  );
  const subAccounts = new Map(
    (await prisma.subAccount.findMany()).map((sub) => [sub.name, sub.id]),
  );
  const fiscalYear1 = await prisma.fiscalYear.findFirstOrThrow({ where: { no: 1 } });
  const must = (map: Map<string, string>, key: string) => {
    const id = map.get(key);
    if (!id) throw new Error(`not seeded: ${key}`);
    return id;
  };
  return {
    account: (code) => must(accounts, code),
    segment: (code) => must(segments, code),
    subAccount: (name) => must(subAccounts, name),
    fiscalYear1,
  };
}

/** Adds a fiscal year to the seeded company (tests use their own years so they do not disturb year 1). */
export async function createFiscalYear(
  prisma: PrismaClient,
  options: {
    no: number;
    startDate: CalendarDate;
    endDate: CalendarDate;
    lockedThrough?: CalendarDate;
    status?: FiscalYearStatus;
  },
): Promise<FiscalYear> {
  const company = await prisma.company.findFirstOrThrow();
  return prisma.fiscalYear.create({
    data: {
      id: newId(),
      companyId: company.id,
      no: options.no,
      startDate: toDbDate(options.startDate),
      endDate: toDbDate(options.endDate),
      lockedThrough: options.lockedThrough ? toDbDate(options.lockedThrough) : null,
      status: options.status ?? "open",
      consumptionTax: "exempt",
      accountingMethod: "tax_inclusive",
    },
  });
}
