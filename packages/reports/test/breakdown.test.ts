import type { CalendarDate, Money, Side } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  breakdownCsvRows,
  buildBreakdown,
  buildGeneralLedger,
  buildPartnerSummary,
  buildTrialBalance,
  csvText,
  indexSource,
  partnerOfLine,
  shareText,
  type BreakdownOptions,
  type BreakdownReport,
  type ReportEntry,
  type ReportFiscalYear,
  type ReportLine,
  type ReportPeriod,
  type ReportSource,
} from "../src";
import { BOOK, FY1, FY1_TOTALS, FY1_YEAR, FY2 } from "./fixtures/book";
import { expectGolden } from "./support/golden";

/*
 * 集計 (14-reports §15): revenue / expenses by 取引先・タグ・科目・セグメント × month. The fixture's
 * first year: revenue 370,700 (架空デザイン 330,000; the rest has no partner), expenses 283,431
 * (架空不動産 264,000 / 架空クラウド 3,300 / 架空デザイン 440 — e17's fee, from the 売掛金 line —
 * and 15,691 without a partner).
 */

const OPTIONS: BreakdownOptions = { axis: "partner", side: "revenue", top: "10", sort: "amount" };

function breakdown(
  options: Partial<BreakdownOptions> = {},
  period: ReportPeriod = FY1_YEAR,
  source: ReportSource = BOOK,
): BreakdownReport {
  return buildBreakdown(source, period, { ...OPTIONS, ...options });
}

/** The income statement's revenue and expenses (試算表, 14 §3). */
function incomeTotals(period: ReportPeriod, source: ReportSource = BOOK) {
  const tb = buildTrialBalance(source, period);
  const kinds = new Map(source.accounts.map((account) => [account.id, account.kind]));
  let revenue = 0n;
  let expense = 0n;
  for (const row of tb.incomeStatement.rows) {
    if (row.kind !== "account" || !row.accountId) continue;
    if (kinds.get(row.accountId) === "revenue") revenue += row.value.period;
    if (kinds.get(row.accountId) === "expense") expense += row.value.period;
  }
  return { revenue, expense };
}

function rowsOf(report: BreakdownReport) {
  return report.rows.map((row) => [row.label, row.values[row.values.length - 1]]);
}

function total(report: BreakdownReport): Money {
  return report.totals[report.totals.length - 1] ?? 0n;
}

interface LineSpec {
  side: Side;
  account: string;
  amount: Money;
  sub?: string;
  segment?: string;
  partner?: string;
  tags?: string[];
}

let extraNo = 100;

/** An extra posted entry (the fixture's entries stay as they are). */
function extra(
  date: CalendarDate,
  lines: LineSpec[],
  fy: ReportFiscalYear = date < FY2.startDate ? FY1 : FY2,
  kind: ReportEntry["kind"] = "normal",
): ReportEntry {
  extraNo += 1;
  return {
    id: `x${extraNo}`,
    fiscalYearId: fy.id,
    no: extraNo,
    entryDate: date,
    description: "追加の仕訳",
    kind,
    sourceKind: "manual",
    status: "posted",
    reversalOfId: null,
    replacedById: null,
    voidReason: null,
    lines: lines.map((spec, i): ReportLine => ({
      lineNo: i + 1,
      side: spec.side,
      accountId: `acc:${spec.account}`,
      subAccountId: spec.sub ? `sub:${spec.sub}` : null,
      amount: spec.amount,
      taxCategoryCode: "na",
      taxAmount: 0n,
      segmentId: spec.segment ? `seg:${spec.segment}` : null,
      partnerId: spec.partner ? `p:${spec.partner}` : null,
      description: null,
      memoTagIds: (spec.tags ?? []).map((tag) => `tag:${tag}`),
    })),
  };
}

function withEntries(entries: ReportEntry[], source: ReportSource = BOOK): ReportSource {
  return { ...source, entries: [...source.entries, ...entries] };
}

describe("buildBreakdown: totals agree with the income statement", () => {
  const { revenue, expense } = incomeTotals(FY1_YEAR);

  it("matches the fixture's hand-checked totals", () => {
    expect(revenue).toBe(370_700n);
    expect(expense).toBe(283_431n);
    expect(revenue - expense).toBe(FY1_TOTALS.netIncome);
  });

  it.each(["partner", "account", "segment", "tag"] as const)(
    "%s: the total row is the income statement's revenue and expenses",
    (axis) => {
      for (const [side, expected] of [
        ["revenue", revenue],
        ["expense", expense],
      ] as const) {
        const report = breakdown({ axis, side, top: "all" });
        expect(total(report)).toBe(expected);
        // Without overlap (no line has 2 tags in the fixture) the rows add up to the total.
        const sum = report.rows
          .filter((row) => row.kind !== "total")
          .reduce((acc, row) => acc + (row.values[row.values.length - 1] ?? 0n), 0n);
        expect(sum).toBe(expected);
        expect(report.hasOverlap).toBe(false);
      }
    },
  );

  it("agrees month by month with 月次推移's columns, the 決算振替 excluded", () => {
    const report = breakdown({ axis: "account", side: "expense" });
    expect(report.columns.map((column) => column.label)).toEqual([
      "2026/11",
      "2026/12",
      "2027/01",
      "2027/02",
      "2027/03",
    ]);
    report.columns.forEach((column, i) => {
      const month = incomeTotals({
        ...FY1_YEAR,
        preset: "custom",
        from: column.from,
        to: column.to,
      });
      expect(report.totals[i]).toBe(month.expense);
    });
    const closing = extra(
      "2027-03-31",
      [
        { side: "debit", account: "4010", amount: 35_200n },
        { side: "credit", account: "3200", amount: 35_200n },
      ],
      FY1,
      "closing",
    );
    const closed = breakdown({ axis: "account" }, FY1_YEAR, withEntries([closing]));
    expect(closed.rows).toEqual(breakdown({ axis: "account" }).rows);
  });

  it("honours the segment, and the segment axis ignores it", () => {
    const kamakura = { ...FY1_YEAR, segmentId: "seg:kamakura" };
    const narrowed = breakdown({ axis: "partner", side: "expense" }, kamakura);
    expect(total(narrowed)).toBe(incomeTotals(kamakura).expense);
    expect(rowsOf(narrowed)).toEqual([
      ["架空不動産株式会社", 264_000n],
      ["取引先なし", 10_266n],
      ["合計", 274_266n],
    ]);
    const bySegment = breakdown({ axis: "segment", side: "expense" }, kamakura);
    expect(bySegment.segmentId).toBeNull();
    expect(total(bySegment)).toBe(expense);
  });
});

describe("buildBreakdown: rows by axis", () => {
  it("partner: rows by amount with 取引先なし last, and the share of each", () => {
    const report = breakdown({ side: "expense" });
    expect(report.rows.map((row) => [row.label, row.kind, row.values.at(-1), row.share])).toEqual([
      ["架空不動産株式会社", "item", 264_000n, "93.1%"],
      ["架空クラウド株式会社", "item", 3_300n, "1.2%"],
      ["架空デザイン合同会社", "item", 440n, "0.2%"],
      ["取引先なし", "none", 15_691n, "5.5%"],
      ["合計", "total", 283_431n, "100.0%"],
    ]);
    const realty = report.rows[0]!;
    expect(realty.values).toEqual([88_000n, 0n, 88_000n, 0n, 88_000n, 264_000n]);
    expect(realty.drill).toEqual({ axis: "account", partnerId: "p:realty" });
    expect(report.rows[3]?.drill).toEqual({ axis: "account", partnerId: "none" });
    expect(report.rows[4]?.drill).toBeNull();
    expect(report.title).toBe("集計（取引先別・費用）");
    expect(report.empty).toBe(false);
  });

  it("partner: revenue of the invoice, the rest without a partner", () => {
    expect(rowsOf(breakdown())).toEqual([
      ["架空デザイン合同会社", 330_000n],
      ["取引先なし", 40_700n],
      ["合計", 370_700n],
    ]);
  });

  it("account: by amount or by code, with the code and the ledger as the drill", () => {
    const report = breakdown({ axis: "account", side: "expense" });
    expect(report.rows.map((row) => [row.code, row.values.at(-1)])).toEqual([
      ["5300", 264_000n],
      ["5310", 9_870n],
      ["5320", 3_300n],
      ["5330", 3_300n],
      ["5420", 1_980n],
      ["5400", 981n],
      [undefined, 283_431n],
    ]);
    expect(report.rows[0]?.drill).toEqual({ axis: "account", accountId: "acc:5300" });
    const byCode = breakdown({ axis: "account", side: "expense", sort: "name" });
    expect(byCode.rows.map((row) => row.code ?? "合計")).toEqual([
      "5300",
      "5310",
      "5320",
      "5330",
      "5400",
      "5420",
      "合計",
    ]);
  });

  it("segment: numbered names, 未設定 last without a link, sortOrder for name order", () => {
    const report = breakdown({ axis: "segment", side: "expense" });
    expect(rowsOf(report)).toEqual([
      ["② 鎌倉", 274_266n],
      ["共通", 3_445n],
      ["① プラットフォーム", 3_300n],
      ["③ 受託", 2_420n],
      ["合計", 283_431n],
    ]);
    expect(report.rows[0]?.drill).toEqual({ axis: "account", segmentId: "seg:kamakura" });
    const byOrder = breakdown({ axis: "segment", side: "expense", sort: "name" });
    expect(byOrder.rows.map((row) => row.label)).toEqual([
      "① プラットフォーム",
      "② 鎌倉",
      "③ 受託",
      "共通",
      "合計",
    ]);
    const unassigned = extra("2027-02-10", [
      { side: "debit", account: "5330", amount: 500n },
      { side: "credit", account: "1000", amount: 500n, sub: "cash" },
    ]);
    const withUnassigned = breakdown(
      { axis: "segment", side: "expense", top: "10" },
      FY1_YEAR,
      withEntries([unassigned]),
    );
    const none = withUnassigned.rows.at(-2)!;
    expect([none.label, none.kind, none.values.at(-1), none.drill]).toEqual([
      "未設定",
      "none",
      500n,
      null,
    ]);
  });

  it("tag: タグなし, and a line with 2 tags counted under each with the overlap", () => {
    expect(rowsOf(breakdown({ axis: "tag", side: "expense" }))).toEqual([
      ["定期", 3_300n],
      ["タグなし", 280_131n],
      ["合計", 283_431n],
    ]);
    const both = extra("2027-01-20", [
      {
        side: "debit",
        account: "5320",
        amount: 2_000n,
        partner: "cloud",
        tags: ["recurring", "founding"],
      },
      { side: "credit", account: "2100", amount: 2_000n, sub: "card" },
    ]);
    const source = withEntries([both]);
    const report = breakdown({ axis: "tag", side: "expense" }, FY1_YEAR, source);
    expect(rowsOf(report)).toEqual([
      ["定期", 5_300n],
      ["設立", 2_000n],
      ["タグなし", 280_131n],
      ["合計", 285_431n],
    ]);
    expect(report.hasOverlap).toBe(true);
    expect(report.overlap).toEqual([0n, 0n, 2_000n, 0n, 0n, 2_000n]);
    // The total row counts each line once: it is still the income statement's expenses.
    expect(total(report)).toBe(incomeTotals(FY1_YEAR, source).expense);
    expect(report.rows[0]?.drill).toEqual({ axis: "account", tagId: "tag:recurring" });
    expect(report.rows[2]?.drill).toEqual({ axis: "account", tagId: "none" });
  });

  it("is empty without lines of the side", () => {
    const january: ReportPeriod = {
      ...FY1_YEAR,
      preset: "custom",
      from: "2027-01-01",
      to: "2027-01-31",
    };
    const report = breakdown({ side: "revenue" }, january);
    expect(report.empty).toBe(true);
    expect(report.columns.map((column) => column.key)).toEqual(["2027-01"]);
    expect(rowsOf(report)).toEqual([["合計", 0n]]);
    expect(report.rows[0]?.share).toBe("—");
  });
});

describe("buildBreakdown: top n and order", () => {
  // 12 vendors of 1,000 … 12,000 and two of the same amount (name order breaks the tie).
  const names = Array.from({ length: 12 }, (_, i) => `仕入先${String(i + 1).padStart(2, "0")}`);
  const partners = [
    ...BOOK.partners,
    ...names.map((name, i) => ({ id: `p:v${i + 1}`, name })),
    { id: "p:tieB", name: "同額B" },
    { id: "p:tieA", name: "同額A" },
  ];
  const entries = [
    ...names.map((_, i) =>
      extra("2027-02-01", [
        { side: "debit", account: "5330", amount: BigInt((i + 1) * 1_000), partner: `v${i + 1}` },
        { side: "credit", account: "1100", amount: BigInt((i + 1) * 1_000), sub: "bank" },
      ]),
    ),
    extra("2027-02-02", [
      { side: "debit", account: "5330", amount: 7_500n, partner: "tieB" },
      { side: "debit", account: "5330", amount: 7_500n, partner: "tieA" },
      { side: "credit", account: "1100", amount: 15_000n, sub: "bank" },
    ]),
  ];
  const source: ReportSource = { ...withEntries(entries), partners };

  it("shows the top 10 and puts the rest into その他 after 取引先なし", () => {
    const report = breakdown({ side: "expense", top: "10" }, FY1_YEAR, source);
    const labels = report.rows.map((row) => row.label);
    expect(labels).toEqual([
      "架空不動産株式会社",
      "仕入先12",
      "仕入先11",
      "仕入先10",
      "仕入先09",
      "仕入先08",
      "同額A",
      "同額B",
      "仕入先07",
      "仕入先06",
      "取引先なし",
      "その他（7 件）",
      "合計",
    ]);
    const other = report.rows.at(-2)!;
    expect(other.kind).toBe("other");
    expect(other.drill).toBeNull();
    // 1,000 … 5,000 + 架空クラウド 3,300 + 架空デザイン 440
    expect(other.values.at(-1)).toBe(15_000n + 3_300n + 440n);
    expect(total(report)).toBe(incomeTotals(FY1_YEAR, source).expense);
    const sum = report.rows
      .filter((row) => row.kind !== "total")
      .reduce((acc, row) => acc + (row.values.at(-1) ?? 0n), 0n);
    expect(sum).toBe(total(report));
  });

  it("orders by name and leaves nothing out with すべて", () => {
    const report = breakdown({ side: "expense", top: "all", sort: "name" }, FY1_YEAR, source);
    expect(report.rows.map((row) => row.label)).toEqual([
      ...names,
      "同額A",
      "同額B",
      "架空クラウド株式会社",
      "架空デザイン合同会社",
      "架空不動産株式会社",
      "取引先なし",
      "合計",
    ]);
    expect(report.rows.some((row) => row.kind === "other")).toBe(false);
  });
});

describe("partnerOfLine (§15.1)", () => {
  const withSubPartner: ReportSource = {
    ...BOOK,
    subAccounts: BOOK.subAccounts.map((sub) =>
      sub.id === "sub:ar-design" ? { ...sub, partnerId: "p:design" } : sub,
    ),
  };

  it("takes the line's partner, then the sub-account's, then the other lines' one partner", () => {
    const sale = extra("2027-02-15", [
      { side: "debit", account: "1200", amount: 50_000n, sub: "ar-design" },
      { side: "credit", account: "4040", amount: 50_000n, segment: "contract" },
    ]);
    const own = extra("2027-02-16", [
      { side: "debit", account: "1200", amount: 1_000n, sub: "ar-design", partner: "cloud" },
      { side: "credit", account: "4040", amount: 1_000n, segment: "contract" },
    ]);
    const source = withEntries([sale, own], withSubPartner);
    const index = indexSource(source);
    const [receivable, revenue] = sale.lines as [ReportLine, ReportLine];
    expect(partnerOfLine(sale, receivable, index, { fromOtherLines: false })).toBe("p:design");
    expect(partnerOfLine(sale, revenue, index, { fromOtherLines: true })).toBe("p:design");
    expect(partnerOfLine(sale, revenue, index, { fromOtherLines: false })).toBeNull();
    // The line's own partner wins over its sub-account's.
    expect(partnerOfLine(own, own.lines[0]!, index, { fromOtherLines: false })).toBe("p:cloud");
    expect(partnerOfLine(own, own.lines[1]!, index, { fromOtherLines: true })).toBe("p:cloud");
    expect(rowsOf(breakdown({}, FY1_YEAR, source))).toEqual([
      ["架空デザイン合同会社", 380_000n],
      ["架空クラウド株式会社", 1_000n],
      ["取引先なし", 40_700n],
      ["合計", 421_700n],
    ]);
  });

  it("counts e17's 支払手数料 (no partner) for the partner of its 売掛金 line", () => {
    const e17 = BOOK.entries.find((entry) => entry.id === "e17")!;
    const index = indexSource(BOOK);
    const fee = e17.lines.find((line) => line.accountId === "acc:5400")!;
    const bank = e17.lines.find((line) => line.accountId === "acc:1100")!;
    expect(partnerOfLine(e17, fee, index, { fromOtherLines: true })).toBe("p:design");
    // Balance-sheet lines never take the partner from other lines.
    expect(partnerOfLine(e17, bank, index, { fromOtherLines: false })).toBeNull();
  });

  it("leaves the line without a partner when the other lines name two", () => {
    const shared = extra("2027-02-20", [
      { side: "debit", account: "5400", amount: 300n },
      { side: "debit", account: "2000", amount: 10_000n, partner: "realty" },
      { side: "debit", account: "2000", amount: 5_000n, partner: "cloud" },
      { side: "credit", account: "1100", amount: 15_300n, sub: "bank" },
    ]);
    const index = indexSource(withEntries([shared]));
    expect(partnerOfLine(shared, shared.lines[0]!, index, { fromOtherLines: true })).toBeNull();
  });
});

describe("filters (§15.3)", () => {
  it("narrows to a partner (or none) and labels the chip", () => {
    const report = breakdown({ axis: "account", side: "expense", partnerId: "p:design" });
    expect(rowsOf(report)).toEqual([
      ["支払手数料", 440n],
      ["合計", 440n],
    ]);
    expect(report.partnerFilter).toEqual({
      value: "p:design",
      name: "取引先",
      label: "架空デザイン合同会社",
    });
    const none = breakdown({ axis: "account", side: "expense", partnerId: "none" });
    expect(total(none)).toBe(15_691n);
    expect(none.partnerFilter?.label).toBe("取引先なし");
  });

  it("narrows to a tag (or none)", () => {
    const tagged = breakdown({ axis: "account", side: "expense", tagId: "tag:recurring" });
    expect(rowsOf(tagged)).toEqual([
      ["通信費", 3_300n],
      ["合計", 3_300n],
    ]);
    expect(tagged.tagFilter?.label).toBe("定期");
    const untagged = breakdown({ axis: "partner", side: "expense", tagId: "none" });
    expect(total(untagged)).toBe(280_131n);
    expect(untagged.tagFilter?.label).toBe("タグなし");
  });

  it("the general ledger narrowed the same way moves by the breakdown's cell", () => {
    const cases: { partnerId?: string; tagId?: string }[] = [
      { partnerId: "p:design" },
      { partnerId: "p:realty" },
      { partnerId: "none" },
      { tagId: "tag:recurring" },
      { tagId: "none" },
    ];
    for (const filter of cases) {
      const report = breakdown({ axis: "account", side: "expense", top: "all", ...filter });
      for (const row of report.rows) {
        if (row.kind !== "item") continue;
        const ledger = buildGeneralLedger(BOOK, FY1_YEAR, {
          accountId: row.drill!.accountId!,
          ...filter,
        });
        expect(ledger.closing - ledger.opening).toBe(row.values.at(-1));
      }
    }
    const fee = buildGeneralLedger(BOOK, FY1_YEAR, {
      accountId: "acc:5400",
      partnerId: "p:design",
    });
    expect(fee.rows.map((row) => row.no)).toEqual([17]);
    expect(fee.partnerFilter?.label).toBe("架空デザイン合同会社");
    expect(fee.tagFilter).toBeNull();
  });
});

describe("buildPartnerSummary (§15.5)", () => {
  it("adds the whole year's revenue and expenses and the receivables as of today", () => {
    const summary = buildPartnerSummary(BOOK, "p:design", { today: "2027-01-05" });
    expect(summary.fiscalYear?.no).toBe(1);
    expect(summary.partner?.name).toBe("架空デザイン合同会社");
    // The fee of 2027-01-10 is after today but in the year.
    expect([summary.revenue, summary.expense]).toEqual([330_000n, 440n]);
    expect(summary.receivables.total).toBe(330_000n);
    expect(summary.receivables.rows.map((row) => [row.account.code, row.balance])).toEqual([
      ["1200", 330_000n],
    ]);
    expect(summary.payables).toEqual({ total: 0n, rows: [] });
    const paid = buildPartnerSummary(BOOK, "p:design", { today: "2027-02-01" });
    expect(paid.receivables).toEqual({ total: 0n, rows: [] });
  });

  it("counts a vendor's 未払費用 but not the card's 未払金", () => {
    const accrued = extra("2027-03-20", [
      { side: "debit", account: "5320", amount: 1_100n },
      { side: "credit", account: "2110", amount: 1_100n, partner: "cloud" },
    ]);
    const source = withEntries([accrued]);
    const summary = buildPartnerSummary(source, "p:cloud", { today: "2027-03-31" });
    expect([summary.revenue, summary.expense]).toEqual([0n, 4_400n]);
    // e3 / e20 were paid by card: 未払金 / 架空カード is owed to the card company.
    expect(summary.payables.rows.map((row) => [row.account.code, row.balance])).toEqual([
      ["2110", 1_100n],
    ]);
    expect(summary.payables.total).toBe(1_100n);
  });

  it("shows zeros for a partner without lines and takes the year of today", () => {
    const summary = buildPartnerSummary(BOOK, "p:none-yet", { today: "2027-05-01" });
    expect(summary.partner).toBeNull();
    expect(summary.fiscalYear?.no).toBe(2);
    expect([
      summary.revenue,
      summary.expense,
      summary.receivables.total,
      summary.payables.total,
    ]).toEqual([0n, 0n, 0n, 0n]);
    expect(buildPartnerSummary(BOOK, "p:design", { today: "2026-10-01" }).fiscalYear?.no).toBe(1);
  });
});

describe("shareText", () => {
  it("rounds to one decimal in integers", () => {
    expect(shareText(1n, 3n)).toBe("33.3%");
    expect(shareText(2n, 3n)).toBe("66.7%");
    expect(shareText(1n, 2_000n)).toBe("0.1%");
    expect(shareText(-1n, 3n)).toBe("-33.3%");
    expect(shareText(5n, 0n)).toBe("—");
    expect(shareText(5n, -10n)).toBe("—");
  });
});

describe("breakdownCsvRows (§15.4)", () => {
  it("writes the axis, the months, 合計 and 構成比 with 取引先なし and 合計", () => {
    const rows = breakdownCsvRows(breakdown({ side: "expense" }));
    expect(rows[0]).toEqual([
      "取引先",
      "2026/11",
      "2026/12",
      "2027/01",
      "2027/02",
      "2027/03",
      "合計",
      "構成比",
    ]);
    expectGolden("breakdown-partner-expense.csv", csvText(rows));
  });

  it("adds 科目コード on the account axis", () => {
    const rows = breakdownCsvRows(breakdown({ axis: "account", side: "revenue" }));
    expect(rows[0]?.slice(0, 2)).toEqual(["科目", "科目コード"]);
    expect(rows.at(-1)).toEqual([
      "合計",
      "",
      16_500n,
      332_200n,
      0n,
      22_000n,
      0n,
      370_700n,
      "100.0%",
    ]);
  });
});
