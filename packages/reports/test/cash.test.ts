import { describe, expect, it } from "vitest";
import { buildCashReport, buildTrialBalance, type WalletStatus } from "../src";
import { BOOK, FY1_TOTALS, FY1_YEAR } from "./fixtures/book";

describe("buildCashReport", () => {
  const report = buildCashReport(BOOK, FY1_YEAR);

  it("totals the cash-like accounts like the trial balance", () => {
    expect(report.total).toBe(FY1_TOTALS.cashTotal);
    const tb = buildTrialBalance(BOOK, FY1_YEAR);
    const cashRows = tb.balanceSheet.rows.filter(
      (row) => row.kind === "account" && ["1000", "1100", "1150"].includes(row.code ?? ""),
    );
    expect(cashRows.reduce((sum, row) => sum + row.value.balance, 0n)).toBe(report.total);
  });

  it("lists the wallets with their balances, cash-like ones first", () => {
    expect(report.wallets.map((w) => [w.name, w.balance])).toEqual([
      ["架空銀行 普通", FY1_TOTALS.bank],
      ["現金", FY1_TOTALS.cash],
      ["Stripe platform", FY1_TOTALS.stripePlatform],
      ["Stripe kamakura", FY1_TOTALS.stripeKamakura],
    ]);
    expect(report.otherWallets.map((w) => [w.name, w.balance])).toEqual([
      ["架空カード", FY1_TOTALS.card],
      ["役員立替", FY1_TOTALS.owner],
    ]);
    expect(report.unassigned).toEqual([]);
  });

  it("gives daily balances whose last point is the total", () => {
    expect(report.series.dates[0]).toBe("2026-11-02");
    expect(report.series.dates[report.series.dates.length - 1]).toBe("2027-03-31");
    expect(report.series.dates).toHaveLength(150);
    expect(report.series.total[report.series.total.length - 1]).toBe(FY1_TOTALS.cashTotal);
    const bank = report.series.wallets.find((w) => w.key === "w:bank")!;
    expect(bank.balances[0]).toBe(50_000n);
    expect(bank.balances[28]).toBe(60_604n); // 2026-11-30
    expect(bank.balances[bank.balances.length - 1]).toBe(FY1_TOTALS.bank);
  });

  it("gives month-end balances", () => {
    expect(report.monthEnds.columns.map((c) => c.label)).toEqual([
      "2026/11",
      "2026/12",
      "2027/01",
      "2027/02",
      "2027/03",
    ]);
    const bank = report.monthEnds.rows.find((r) => r.key === "w:bank")!;
    expect(bank.balances).toEqual([60_604n, 56_829n, 298_389n, 298_389n, FY1_TOTALS.bank]);
    expect(report.monthEnds.total[4]).toBe(FY1_TOTALS.cashTotal);
  });

  it("compares the statement balance with the book balance on that day", () => {
    const status: WalletStatus[] = [
      {
        walletId: "w:bank",
        pendingCount: 3,
        lastSyncedAt: null,
        lastImportedAt: new Date("2027-03-16T01:00:00Z"),
        lastStatement: { date: "2027-03-15", balanceAfter: 210_000n },
      },
      {
        walletId: "w:stripe2",
        pendingCount: 0,
        lastSyncedAt: new Date("2027-03-31T21:00:00Z"),
        lastImportedAt: null,
        lastStatement: { date: "2027-02-20", balanceAfter: 22_000n },
      },
    ];
    const withStatus = buildCashReport(BOOK, FY1_YEAR, status);
    const bank = withStatus.wallets.find((w) => w.walletId === "w:bank")!;
    expect(bank.pendingCount).toBe(3);
    expect(bank.lastActivityAt?.toISOString()).toBe("2027-03-16T01:00:00.000Z");
    expect(bank.statement).toEqual({
      date: "2027-03-15",
      balanceAfter: 210_000n,
      bookBalance: 210_389n,
      difference: -389n,
    });
    const stripe = withStatus.wallets.find((w) => w.walletId === "w:stripe2")!;
    expect(stripe.statement?.difference).toBe(0n);
    expect(withStatus.wallets.find((w) => w.walletId === "w:cash")!.statement).toBeNull();
  });

  it("reports cash that no active wallet owns", () => {
    const noStripeWallets = buildCashReport(
      { ...BOOK, wallets: BOOK.wallets.filter((w) => w.kind !== "stripe") },
      FY1_YEAR,
    );
    expect(noStripeWallets.total).toBe(FY1_TOTALS.cashTotal);
    expect(noStripeWallets.unassigned.map((u) => [u.subAccountName, u.balance])).toEqual([
      ["platform", FY1_TOTALS.stripePlatform],
      ["kamakura", FY1_TOTALS.stripeKamakura],
    ]);
  });
});
