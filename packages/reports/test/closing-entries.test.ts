import { describe, expect, it } from "vitest";
import {
  buildGeneralLedger,
  buildJournal,
  buildMonthlyTrend,
  buildSegmentReport,
  buildTrialBalance,
  closingEntryIdsOf,
  type ReportEntry,
  type ReportFiscalYear,
  type ReportPeriod,
  type ReportSource,
} from "../src";
import {
  BOOK,
  CLOSED_BOOK,
  FY1,
  FY1_CLOSING,
  FY1_TOTALS,
  FY2,
} from "./financial-statements/fixture";

/*
 * 決算振替 (14-reports §1): the close (#14) moves the year's P&L to 繰越利益剰余金 with a `closing`
 * entry. 試算表・月次推移・セグメント損益 leave the year's own closing entries (and their reversals)
 * out, so a closed year shows its profit as before the close; 仕訳帳 and 総勘定元帳 show them.
 */

function year(fiscalYear: ReportFiscalYear, segmentId: string | null = null): ReportPeriod {
  return {
    fiscalYear,
    preset: "year",
    from: fiscalYear.startDate,
    to: fiscalYear.endDate,
    segmentId,
  };
}

/** The close taken back (its reversal) and made again. */
function reopenedAndClosedAgain(): ReportSource {
  const voided: ReportEntry = { ...FY1_CLOSING, status: "voided", voidReason: "締めを戻す" };
  const reversal: ReportEntry = {
    ...FY1_CLOSING,
    id: "e21",
    no: 21,
    description: "取消: 決算振替",
    kind: "reversal",
    reversalOfId: FY1_CLOSING.id,
    lines: FY1_CLOSING.lines.map((line) => ({
      ...line,
      side: line.side === "debit" ? ("credit" as const) : ("debit" as const),
    })),
  };
  const again: ReportEntry = { ...FY1_CLOSING, id: "e22", no: 22 };
  return { ...BOOK, entries: [...BOOK.entries, voided, reversal, again] };
}

describe("決算振替 in the reports", () => {
  it("finds the year's closing entries and their reversals only", () => {
    const book = reopenedAndClosedAgain();
    expect([...closingEntryIdsOf(book.entries, FY1.id)].sort()).toEqual(["e20", "e21", "e22"]);
    expect(closingEntryIdsOf(book.entries, FY2.id).size).toBe(0);
  });

  it("leaves the closed year's trial balance, monthly trend and segment P&L as they were", () => {
    for (const book of [CLOSED_BOOK, reopenedAndClosedAgain()]) {
      expect(buildTrialBalance(book, year(FY1))).toEqual(buildTrialBalance(BOOK, year(FY1)));
      expect(buildMonthlyTrend(book, year(FY1))).toEqual(buildMonthlyTrend(BOOK, year(FY1)));
      expect(buildSegmentReport(book, year(FY1))).toEqual(buildSegmentReport(BOOK, year(FY1)));
      const segment = year(FY1, "seg:corporate");
      expect(buildTrialBalance(book, segment)).toEqual(buildTrialBalance(BOOK, segment));
    }
    const closed = buildTrialBalance(CLOSED_BOOK, year(FY1));
    expect(closed.incomeStatement.netIncome).toBe(FY1_TOTALS.netIncome);
    expect(closed.check.ok).toBe(true);
  });

  it("keeps the previous year's close: the next year opens with it in 繰越利益剰余金", () => {
    const open = buildTrialBalance(BOOK, year(FY2));
    const closed = buildTrialBalance(CLOSED_BOOK, year(FY2));
    expect(open.balanceSheet.priorPeriodsProfit).toBe(FY1_TOTALS.netIncome);
    expect(closed.balanceSheet.priorPeriodsProfit).toBe(0n);
    expect(closed.balanceSheet.totals.equity.balance).toBe(open.balanceSheet.totals.equity.balance);
    expect(closed.incomeStatement.netIncome).toBe(open.incomeStatement.netIncome);
    expect(closed.check.ok).toBe(true);
  });

  it("still shows the closing entry in 仕訳帳 and 総勘定元帳", () => {
    const journal = buildJournal(CLOSED_BOOK, year(FY1), { pageSize: 1000 });
    expect(journal.entries.some((entry) => entry.id === FY1_CLOSING.id)).toBe(true);
    const sales = buildGeneralLedger(CLOSED_BOOK, year(FY1), { accountId: "acc:4010" });
    expect(sales.rows.some((row) => row.entryId === FY1_CLOSING.id)).toBe(true);
    expect(sales.closing).toBe(0n);
  });
});
