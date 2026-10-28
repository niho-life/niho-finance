import {
  trialBalance,
  type AccountRef,
  type CalendarDate,
  type FiscalYearContext,
  type LedgerEntry,
  type TrialBalance,
} from "@niho-finance/ledger";
import type { FiscalYear } from "@prisma/client";
import type { Db } from "./audit";
import { fromDbDate, toDbDate } from "./dates";

export function toFiscalYearContext(row: FiscalYear): FiscalYearContext {
  return {
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    lockedThrough: row.lockedThrough ? fromDbDate(row.lockedThrough) : null,
    status: row.status,
    consumptionTax: row.consumptionTax,
    accountingMethod: row.accountingMethod,
  };
}

export async function loadAccountRefs(db: Db): Promise<AccountRef[]> {
  return db.account.findMany({
    select: { id: true, code: true, kind: true, isActive: true },
    orderBy: { code: "asc" },
  });
}

/** Every posted line dated on or before `through`, grouped by entry (voided entries included). */
export async function loadLedgerEntries(
  db: Db,
  options: { through: CalendarDate },
): Promise<LedgerEntry[]> {
  const lines = await db.journalLine.findMany({
    where: { journalEntry: { entryDate: { lte: toDbDate(options.through) } } },
    select: {
      journalEntryId: true,
      side: true,
      accountId: true,
      subAccountId: true,
      segmentId: true,
      amount: true,
      journalEntry: { select: { entryDate: true } },
    },
    orderBy: [{ journalEntryId: "asc" }, { lineNo: "asc" }],
  });
  const entries = new Map<
    string,
    { entryDate: CalendarDate; lines: LedgerEntry["lines"][number][] }
  >();
  for (const line of lines) {
    let entry = entries.get(line.journalEntryId);
    if (!entry) {
      entry = { entryDate: fromDbDate(line.journalEntry.entryDate), lines: [] };
      entries.set(line.journalEntryId, entry);
    }
    entry.lines.push({
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId,
      segmentId: line.segmentId,
      amount: line.amount,
    });
  }
  return [...entries.values()];
}

/** Trial balance of a fiscal year from the stored entries (`ledger.trialBalance`). */
export async function loadTrialBalance(
  db: Db,
  fiscalYearId: string,
  options: { asOf?: CalendarDate } = {},
): Promise<TrialBalance> {
  const fiscalYear = toFiscalYearContext(
    await db.fiscalYear.findUniqueOrThrow({ where: { id: fiscalYearId } }),
  );
  const asOf = options.asOf ?? fiscalYear.endDate;
  const [entries, accounts] = [
    await loadLedgerEntries(db, { through: asOf }),
    await loadAccountRefs(db),
  ];
  return trialBalance(entries, accounts, fiscalYear, { asOf });
}
