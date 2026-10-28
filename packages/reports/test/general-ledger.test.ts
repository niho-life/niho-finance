import { describe, expect, it } from "vitest";
import {
  buildGeneralLedger,
  buildTrialBalance,
  csvText,
  ledgerAccountChoices,
  ledgerCsvRows,
} from "../src";
import { BOOK, FY1, FY1_TOTALS, FY1_YEAR } from "./fixtures/book";
import { expectGolden } from "./support/golden";

describe("buildGeneralLedger", () => {
  it("runs the balance line by line and ends on the trial balance's balance", () => {
    const ledger = buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:1100" });
    expect(ledger.opening).toBe(0n);
    expect(ledger.closing).toBe(FY1_TOTALS.bank);
    expect(ledger.rows.map((r) => r.no)).toEqual([1, 9, 11, 12, 13, 14, 16, 17, 18, 22]);
    expect(ledger.rows[0]).toMatchObject({
      no: 1,
      counterpart: "資本金",
      debit: 50_000n,
      credit: 0n,
      balance: 50_000n,
    });
    const receipt = ledger.rows.find((r) => r.no === 17)!;
    expect(receipt.counterpart).toBe("売掛金 / 架空デザイン合同会社");
    expect(ledger.debitTotal - ledger.creditTotal).toBe(FY1_TOTALS.bank);
    expect(ledger.subAccounts.map((s) => s.name)).toEqual(["架空銀行 普通"]);
    const tb = buildTrialBalance(BOOK, FY1_YEAR);
    const row = tb.balanceSheet.rows.find((r) => r.key === "bs:acc:1100")!;
    expect(ledger.closing).toBe(row.value.balance);
    expect(ledger.debitTotal).toBe(row.value.debit);
    expect(ledger.creditTotal).toBe(row.value.credit);
  });

  it("shows 諸口 when the other side has several accounts", () => {
    const ledger = buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:1200" });
    expect(ledger.rows.map((r) => [r.no, r.counterpart])).toEqual([
      [15, "売上高 受託開発"],
      [17, "諸口"],
    ]);
    expect(ledger.closing).toBe(0n);
  });

  it("carries the opening into a later period and narrows to a sub-account", () => {
    const december = {
      ...FY1_YEAR,
      preset: "custom" as const,
      from: "2026-12-01" as const,
      to: "2026-12-31" as const,
    };
    const bank = buildGeneralLedger(BOOK, december, { accountId: "acc:1100" });
    expect(bank.opening).toBe(60_604n);
    expect(bank.closing).toBe(56_829n);
    const stripe = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:1150",
      subAccountId: "sub:stripe2",
    });
    expect(stripe.subAccount?.name).toBe("kamakura");
    expect(stripe.closing).toBe(FY1_TOTALS.stripeKamakura);
    expect(stripe.subAccounts.map((s) => s.name)).toEqual(["platform", "kamakura"]);
  });

  it("starts P&L accounts from the year and honours the segment", () => {
    const fees = buildGeneralLedger(
      BOOK,
      { ...FY1_YEAR, segmentId: "seg:kamakura" },
      { accountId: "acc:5400" },
    );
    expect(fees.rows.map((r) => r.no)).toEqual([7]);
    expect(fees.closing).toBe(396n);
    const march = buildGeneralLedger(
      BOOK,
      { ...FY1_YEAR, preset: "custom", from: "2027-03-01", to: "2027-03-31" },
      { accountId: "acc:5300" },
    );
    expect(march.opening).toBe(176_000n);
    expect(march.closing).toBe(264_000n);
    const liability = buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:2400" });
    expect(liability.rows.map((r) => r.balance)).toEqual([165_000n, 168_300n, 256_300n]);
  });

  it("marks voided rows and offers the accounts to choose from", () => {
    const books = buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:5420" });
    expect(books.rows.map((r) => [r.no, r.stateLabel, r.balance])).toEqual([
      [12, "訂正済み（→ No. 14）", 2_000n],
      [13, "反対仕訳（No. 12 の取消）", 0n],
      [14, null, 1_980n],
    ]);
    const choices = ledgerAccountChoices(BOOK, FY1_YEAR);
    expect(choices.active.map((a) => a.code)).toEqual([
      "1000",
      "1100",
      "1150",
      "1200",
      "1700",
      "2100",
      "2110",
      "2400",
      "3000",
      "4010",
      "4030",
      "4040",
      "5300",
      "5310",
      "5320",
      "5330",
      "5400",
      "5420",
      "9000",
    ]);
    expect(choices.others.some((a) => a.code === "1000")).toBe(false);
    expect(choices.others.some((a) => a.code === "5100")).toBe(true);
    expect(
      buildGeneralLedger(BOOK, { ...FY1_YEAR, fiscalYear: FY1 }, { accountId: "acc:5100" }).empty,
    ).toBe(true);
  });

  it("narrows to a partner as 集計 decides it, the opening included (§15.3)", () => {
    // e17's 支払手数料 has no partner: it counts for the partner of the entry's 売掛金 line.
    const fee = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:5400",
      partnerId: "p:design",
    });
    expect(fee.rows.map((r) => r.no)).toEqual([17]);
    expect(fee.closing).toBe(440n);
    expect(fee.partnerFilter).toEqual({
      value: "p:design",
      name: "取引先",
      label: "架空デザイン合同会社",
    });
    const unattributed = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:5400",
      partnerId: "none",
    });
    expect(unattributed.rows.map((r) => r.no)).toEqual([7, 11]);
    expect(unattributed.partnerFilter?.label).toBe("取引先なし");
    const march = buildGeneralLedger(
      BOOK,
      { ...FY1_YEAR, preset: "custom", from: "2027-03-01", to: "2027-03-31" },
      { accountId: "acc:5300", partnerId: "p:realty" },
    );
    expect([march.opening, march.closing]).toEqual([176_000n, 264_000n]);
    // Balance-sheet lines take only their own (or their sub-account's) partner.
    const receivable = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:1200",
      partnerId: "p:design",
    });
    expect(receivable.rows.map((r) => r.no)).toEqual([15, 17]);
    const bank = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:1100",
      partnerId: "p:design",
    });
    expect(bank.empty).toBe(true);
  });

  it("narrows to a tag (or to lines without one)", () => {
    const tagged = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:5320",
      tagId: "tag:recurring",
    });
    expect(tagged.rows.map((r) => r.no)).toEqual([3, 20]);
    expect(tagged.tagFilter?.label).toBe("定期");
    expect(tagged.partnerFilter).toBeNull();
    const untagged = buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:5320", tagId: "none" });
    expect(untagged.empty).toBe(true);
    expect(untagged.tagFilter?.label).toBe("タグなし");
    const plain = buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:5320" });
    expect([plain.partnerFilter, plain.tagFilter]).toEqual([null, null]);
  });

  it("writes CSV with the opening and the totals", () => {
    const rows = ledgerCsvRows(buildGeneralLedger(BOOK, FY1_YEAR, { accountId: "acc:1100" }));
    expect(rows[1]).toEqual(["2026/11/02", "", "繰越", "", "", "", 0n]);
    expect(rows[rows.length - 1]).toEqual([
      "2027/03/31",
      "",
      "合計",
      "",
      392_164n,
      181_775n,
      FY1_TOTALS.bank,
    ]);
    expectGolden("ledger-1100.csv", csvText(rows));
  });
});
