import { describe, expect, it } from "vitest";
import { assertTrialBalanceIdentity, computeBalances, trialBalance } from "../src";
import { ACCOUNT_LIST, ACCOUNTS, entry, FISCAL_YEAR, line } from "./fixtures";

const entries = [
  entry([line("debit", ACCOUNTS.bank, 50_000n), line("credit", ACCOUNTS.capital, 50_000n)], {
    entryDate: "2026-11-02",
  }),
  entry(
    [
      line("debit", ACCOUNTS.bank, 11_000n, { subAccountId: "sub_bank_a" }),
      line("credit", ACCOUNTS.sales, 11_000n, {
        segmentId: "seg_kamakura",
        taxCategoryCode: "sales_10",
        taxAmount: 1_000n,
      }),
    ],
    { entryDate: "2026-11-20" },
  ),
  entry(
    [
      line("debit", ACCOUNTS.fees, 396n, {
        segmentId: "seg_kamakura",
        taxCategoryCode: "purchase_10",
        taxAmount: 36n,
      }),
      line("debit", ACCOUNTS.fees, 145n, {
        segmentId: "seg_corporate",
        taxCategoryCode: "purchase_10",
        taxAmount: 13n,
      }),
      line("credit", ACCOUNTS.bank, 541n, { subAccountId: "sub_bank_b" }),
    ],
    { entryDate: "2026-12-10" },
  ),
];

describe("computeBalances", () => {
  it("groups by account", () => {
    const rows = computeBalances(entries, { groupBy: "account" });
    expect(rows.find((r) => r.accountId === ACCOUNTS.bank.id)).toEqual({
      accountId: ACCOUNTS.bank.id,
      subAccountId: null,
      segmentId: null,
      debit: 61_000n,
      credit: 541n,
      net: 60_459n,
    });
  });

  it("groups by sub-account and by segment", () => {
    const bySub = computeBalances(entries, { groupBy: "subAccount" }).filter(
      (r) => r.accountId === ACCOUNTS.bank.id,
    );
    expect(bySub.map((r) => [r.subAccountId, r.net])).toEqual([
      [null, 50_000n],
      ["sub_bank_a", 11_000n],
      ["sub_bank_b", -541n],
    ]);
    const bySegment = computeBalances(entries, { groupBy: "segment" }).filter(
      (r) => r.accountId === ACCOUNTS.fees.id,
    );
    expect(bySegment.map((r) => [r.segmentId, r.net])).toEqual([
      ["seg_corporate", 145n],
      ["seg_kamakura", 396n],
    ]);
  });

  it("filters by date (inclusive)", () => {
    const rows = computeBalances(entries, {
      groupBy: "account",
      from: "2026-11-20",
      asOf: "2026-11-30",
    });
    expect(rows.map((r) => [r.accountId, r.net])).toEqual([
      [ACCOUNTS.bank.id, 11_000n],
      [ACCOUNTS.sales.id, -11_000n],
    ]);
  });
});

describe("trialBalance", () => {
  it("computes BS and PL totals and net income", () => {
    const tb = trialBalance(entries, ACCOUNT_LIST, FISCAL_YEAR);
    expect(tb.totals).toMatchObject({
      assets: 60_459n,
      liabilities: 0n,
      equity: 50_000n,
      revenue: 11_000n,
      expenses: 541n,
      netIncome: 10_459n,
      internal: 0n,
      priorPeriodsProfit: 0n,
      debit: 61_541n,
      credit: 61_541n,
    });
    expect(tb.rows.map((r) => [r.code, r.balance])).toEqual([
      ["1100", 60_459n],
      ["3000", 50_000n],
      ["4010", 11_000n],
      ["5400", 541n],
    ]);
    expect(() => assertTrialBalanceIdentity(tb)).not.toThrow();
  });

  it("carries earlier years' unclosed profit in net assets", () => {
    const nextYear = { startDate: "2027-04-01", endDate: "2028-03-31" } as const;
    const later = entry(
      [
        line("debit", ACCOUNTS.cash, 2_200n),
        line("credit", ACCOUNTS.sales, 2_200n, { segmentId: "seg_kamakura" }),
      ],
      {
        entryDate: "2027-04-10",
      },
    );
    const tb = trialBalance([...entries, later], ACCOUNT_LIST, nextYear);
    expect(tb.totals.priorPeriodsProfit).toBe(10_459n);
    expect(tb.totals.equity).toBe(60_459n);
    expect(tb.totals.netIncome).toBe(2_200n);
    expect(tb.totals.assets).toBe(62_659n);
    expect(() => assertTrialBalanceIdentity(tb)).not.toThrow();
  });

  it("throws on an account that is not in the chart", () => {
    const stray = entry([
      line("debit", { id: "acc_unknown", code: "1999", kind: "asset" }, 1n),
      line("credit", ACCOUNTS.bank, 1n),
    ]);
    expect(() => trialBalance([stray], ACCOUNT_LIST, FISCAL_YEAR)).toThrow(/UNKNOWN_ACCOUNT/);
  });
});
