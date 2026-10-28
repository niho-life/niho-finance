import { describe, expect, it } from "vitest";
import {
  balanceOn,
  buildTrialBalance,
  indexSource,
  type ReportPeriod,
  type StatementRow,
  type TrialBalanceCell,
} from "../src";
import { BOOK, FY1, FY1_TOTALS, FY1_YEAR, FY2 } from "./fixtures/book";

function row(rows: StatementRow<TrialBalanceCell>[], key: string): StatementRow<TrialBalanceCell> {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`row ${key} not found in ${rows.map((r) => r.key).join(", ")}`);
  return found;
}

describe("buildTrialBalance", () => {
  const year = buildTrialBalance(BOOK, FY1_YEAR);

  it("holds assets = liabilities + equity + net income and passes the ledger check", () => {
    expect(year.check.ok).toBe(true);
    expect(year.check.messages).toEqual([]);
    expect(year.check.debit).toBe(year.check.credit);
    expect(year.check.internal).toBe(0n);
    expect(year.balanceSheet.totals.assets.balance).toBe(FY1_TOTALS.assets);
    expect(year.balanceSheet.totals.liabilities.balance).toBe(FY1_TOTALS.liabilities);
    expect(year.balanceSheet.totals.equity.balance).toBe(FY1_TOTALS.equity);
    expect(year.balanceSheet.totals.liabilitiesAndEquity.balance).toBe(FY1_TOTALS.assets);
    expect(year.balanceSheet.netIncome).toBe(FY1_TOTALS.netIncome);
    expect(year.balanceSheet.priorPeriodsProfit).toBe(0n);
    expect(year.incomeStatement.netIncome).toBe(FY1_TOTALS.netIncome);
    expect(year.empty).toBe(false);
  });

  it("lays out the balance sheet with sections, groups, accounts and sub-accounts", () => {
    const rows = year.balanceSheet.rows;
    expect(rows.map((r) => r.kind).filter((k) => k === "section")).toHaveLength(3);
    expect(row(rows, "bs:acc:1100").value).toEqual({
      opening: 0n,
      debit: 50_000n + 10_604n + 2_000n + 329_560n,
      credit: 145n + 2_000n + 1_980n + 1_650n + 88_000n + 88_000n,
      period: FY1_TOTALS.bank,
      balance: FY1_TOTALS.bank,
    });
    expect(row(rows, "bs:acc:1150:sub:stripe").value.balance).toBe(FY1_TOTALS.stripePlatform);
    expect(row(rows, "bs:acc:1150:sub:stripe2").value.balance).toBe(FY1_TOTALS.stripeKamakura);
    // 売掛金 was invoiced and received: no balance, but the movement keeps the row.
    expect(row(rows, "bs:acc:1200").value).toEqual({
      opening: 0n,
      debit: 330_000n,
      credit: 330_000n,
      period: 0n,
      balance: 0n,
    });
    expect(rows.find((r) => r.key === "bs:acc:5100")).toBeUndefined();
    expect(row(rows, "bs:acc:2400").value.balance).toBe(FY1_TOTALS.owner);
    expect(row(rows, "equity:netIncome").value.balance).toBe(FY1_TOTALS.netIncome);
    expect(rows.find((r) => r.key === "equity:priorPeriodsProfit")).toBeUndefined();
    expect(row(rows, "total:assets").value.balance).toBe(FY1_TOTALS.assets);
    expect(row(rows, "total:liabilitiesAndEquity").value.balance).toBe(FY1_TOTALS.assets);
    // Internal accounts are not on the balance sheet.
    expect(rows.find((r) => r.accountId === "acc:9000")).toBeUndefined();
  });

  it("lays out the income statement with the five subtotals", () => {
    const rows = year.incomeStatement.rows;
    expect(row(rows, "group:sales").value.balance).toBe(FY1_TOTALS.revenue);
    expect(row(rows, "group:sga").value.balance).toBe(FY1_TOTALS.expenses);
    expect(row(rows, "subtotal:grossProfit").value.balance).toBe(FY1_TOTALS.revenue);
    expect(row(rows, "subtotal:operatingIncome").value.balance).toBe(FY1_TOTALS.netIncome);
    expect(row(rows, "subtotal:ordinaryIncome").value.balance).toBe(FY1_TOTALS.netIncome);
    expect(row(rows, "subtotal:pretaxIncome").value.balance).toBe(FY1_TOTALS.netIncome);
    expect(row(rows, "subtotal:netIncome").kind).toBe("total");
    // The voided 書籍代 and its reversal net out; the corrected entry stays.
    expect(row(rows, "pl:acc:5420").value).toEqual({
      opening: 0n,
      debit: 3_980n,
      credit: 2_000n,
      period: 1_980n,
      balance: 1_980n,
    });
    expect(rows.find((r) => r.accountId === "acc:9000")).toBeUndefined();
  });

  it("splits a month into opening and period while the balance sheet stays cumulative", () => {
    const december: ReportPeriod = {
      fiscalYear: FY1,
      preset: "custom",
      from: "2026-12-01",
      to: "2026-12-31",
      segmentId: null,
    };
    const tb = buildTrialBalance(BOOK, december);
    expect(tb.check.ok).toBe(true);
    const bank = row(tb.balanceSheet.rows, "bs:acc:1100").value;
    expect(bank.opening).toBe(60_604n);
    // The identity holds on the opening too: 当期純利益 opens with November's profit.
    const assets = row(tb.balanceSheet.rows, "total:assets").value;
    const right = row(tb.balanceSheet.rows, "total:liabilitiesAndEquity").value;
    expect(right.opening).toBe(assets.opening);
    expect(right.balance).toBe(assets.balance);
    expect(row(tb.balanceSheet.rows, "equity:netIncome").value).toMatchObject({
      opening: FY1_TOTALS.months[0],
      period: FY1_TOTALS.months[1],
      balance: FY1_TOTALS.months[0] + FY1_TOTALS.months[1],
    });
    expect(bank.balance).toBe(56_829n);
    const sales = row(tb.incomeStatement.rows, "group:sales").value;
    expect(sales.opening).toBe(16_500n);
    expect(sales.balance).toBe(16_500n + 332_200n);
    expect(sales.period).toBe(332_200n);
    expect(tb.incomeStatement.netIncome).toBe(FY1_TOTALS.months[1]);
    expect(tb.incomeStatement.netIncomeToDate).toBe(FY1_TOTALS.months[0] + FY1_TOTALS.months[1]);
    expect(tb.balanceSheet.netIncome).toBe(FY1_TOTALS.months[0] + FY1_TOTALS.months[1]);
  });

  it("filters the income statement by segment and keeps the balance sheet company-wide", () => {
    const tb = buildTrialBalance(BOOK, { ...FY1_YEAR, segmentId: "seg:kamakura" });
    expect(tb.incomeStatement.filteredBySegment).toBe(true);
    // Internal transactions are not part of the income statement (14-reports §3).
    expect(tb.incomeStatement.netIncome).toBe(FY1_TOTALS.segments.kamakura + 3_000n);
    expect(tb.balanceSheet.netIncome).toBe(FY1_TOTALS.netIncome);
    expect(tb.balanceSheet.totals.assets.balance).toBe(FY1_TOTALS.assets);
    expect(tb.check.ok).toBe(true);
  });

  it("carries the profit of earlier years as equity until it is transferred", () => {
    const tb = buildTrialBalance(BOOK, {
      fiscalYear: FY2,
      preset: "year",
      from: FY2.startDate,
      to: FY2.endDate,
      segmentId: null,
    });
    expect(tb.check.ok).toBe(true);
    expect(tb.balanceSheet.priorPeriodsProfit).toBe(FY1_TOTALS.netIncome);
    expect(row(tb.balanceSheet.rows, "equity:priorPeriodsProfit").value).toMatchObject({
      opening: FY1_TOTALS.netIncome,
      period: 0n,
      balance: FY1_TOTALS.netIncome,
    });
    const assets = row(tb.balanceSheet.rows, "total:assets").value;
    expect(row(tb.balanceSheet.rows, "total:liabilitiesAndEquity").value.opening).toBe(
      assets.opening,
    );
    expect(tb.balanceSheet.netIncome).toBe(3_300n);
    expect(tb.balanceSheet.totals.assets.balance).toBe(FY1_TOTALS.assets + 3_300n);
    expect(row(tb.balanceSheet.rows, "bs:acc:1000").value.opening).toBe(2_200n);
    expect(tb.incomeStatement.netIncome).toBe(3_300n);
  });

  it("is empty before any entry", () => {
    const tb = buildTrialBalance({ ...BOOK, entries: [] }, FY1_YEAR);
    expect(tb.empty).toBe(true);
    expect(tb.check.ok).toBe(true);
  });
});

describe("balanceOn", () => {
  it("gives the balance of an account or sub-account on a date", () => {
    const index = indexSource(BOOK);
    expect(balanceOn(index, "acc:1100", "sub:bank", "2026-11-30")).toBe(60_604n);
    expect(balanceOn(index, "acc:1100", undefined, "2027-03-31")).toBe(FY1_TOTALS.bank);
    expect(balanceOn(index, "acc:2400", undefined, "2027-03-31")).toBe(FY1_TOTALS.owner);
    expect(balanceOn(index, "acc:4010", undefined, "2027-03-31", { since: "2026-12-01" })).toBe(
      2_200n + 22_000n,
    );
  });
});
