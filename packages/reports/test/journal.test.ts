import { describe, expect, it } from "vitest";
import { buildJournal, csvText, journalCsvRows, journalEntries } from "../src";
import { BOOK, FY1_YEAR } from "./fixtures/book";
import { expectGolden } from "./support/golden";

describe("buildJournal", () => {
  it("lists the entries of the period in date and number order with their lines", () => {
    const journal = buildJournal(BOOK, FY1_YEAR);
    expect(journal.total).toBe(23);
    expect(journal.entries.map((e) => e.no)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(journal.debitTotal).toBe(journal.creditTotal);
    expect(journal.pageCount).toBe(1);
    const voucher = journal.entries.find((e) => e.id === "e17")!;
    expect(voucher.amount).toBe(330_000n);
    expect(voucher.lines.map((l) => [l.side, l.accountName, l.subAccountName])).toEqual([
      ["debit", "普通預金", "架空銀行 普通"],
      ["debit", "支払手数料", null],
      ["credit", "売掛金", "架空デザイン合同会社"],
    ]);
    expect(voucher.lines[1]).toMatchObject({ taxName: "課税仕入 10%", segmentName: "受託" });
    expect(journal.entries.find((e) => e.id === "e3")!.lines[0]!.memoTagNames).toEqual(["定期"]);
  });

  it("labels voided entries, reversals and corrections", () => {
    const journal = buildJournal(BOOK, FY1_YEAR);
    const byId = new Map(journal.entries.map((e) => [e.id, e]));
    expect(byId.get("e12")!.stateLabel).toBe("訂正済み（→ No. 14）");
    expect(byId.get("e13")!.stateLabel).toBe("反対仕訳（No. 12 の取消）");
    expect(byId.get("e14")!.stateLabel).toBeNull();
    expect(byId.get("e13")!.kindLabel).toBe("反対仕訳");
    expect(byId.get("e1")!.sourceLabel).toBe("初期設定");
  });

  it("can leave out voided entries and reversals, filter by segment and page", () => {
    const posted = buildJournal(BOOK, FY1_YEAR, { status: "posted" });
    expect(posted.total).toBe(21);
    expect(posted.entries.some((e) => e.id === "e12" || e.id === "e13")).toBe(false);

    const kamakura = buildJournal(BOOK, { ...FY1_YEAR, segmentId: "seg:kamakura" });
    expect(kamakura.entries.map((e) => e.id)).toEqual([
      "e5",
      "e6",
      "e7",
      "e10",
      "e18",
      "e19",
      "e21",
      "e22",
      "e23",
    ]);

    const page2 = buildJournal(BOOK, FY1_YEAR, { pageSize: 10, page: 2 });
    expect(page2.pageCount).toBe(3);
    expect(page2.entries.map((e) => e.no)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(buildJournal(BOOK, FY1_YEAR, { pageSize: 10, page: 9 }).page).toBe(3);
    expect(page2.debitTotal).toBe(buildJournal(BOOK, FY1_YEAR).debitTotal);
  });

  it("is empty outside the entries", () => {
    const empty = buildJournal(BOOK, {
      ...FY1_YEAR,
      preset: "custom",
      from: "2027-03-20",
      to: "2027-03-25",
    });
    expect(empty.empty).toBe(true);
    expect(empty.pageCount).toBe(1);
  });

  it("writes one CSV row per line", () => {
    const rows = journalCsvRows(journalEntries(BOOK, FY1_YEAR));
    const lineCount = BOOK.entries
      .filter((e) => e.fiscalYearId === "fy1")
      .reduce((sum, e) => sum + e.lines.length, 0);
    expect(rows).toHaveLength(lineCount + 1);
    expect(rows[1]).toEqual([
      "2026/11/02",
      1,
      "資本金の払込",
      "開始",
      "",
      1,
      "借方",
      "1100",
      "普通預金",
      "架空銀行 普通",
      50_000n,
      "対象外",
      0n,
      "",
      "",
      "",
    ]);
    expectGolden("journal.csv", csvText(rows));
  });
});
