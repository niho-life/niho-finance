import { describe, expect, it } from "vitest";
import {
  balanceSheetSides,
  buildFinancialStatements,
  buildHot010Files,
  buildTrialBalance,
  formatStatementAmount,
  fiscalYearPeriodLabel,
  type FinancialStatementsReport,
  type ReportEntry,
  type StatementLine,
} from "../../src";
import {
  BOOK,
  CLOSED_BOOK,
  entry,
  FY1,
  FY1_CLOSING,
  FY1_ENTRIES,
  FY1_TOTALS,
  FY2,
  FY2_ENTRIES,
  FY2_TOTALS,
  withSource,
} from "./fixture";

function line(lines: readonly StatementLine[], code: string): StatementLine {
  const found = lines.find((l) => l.code === code);
  if (!found) throw new Error(`line ${code} not found in ${lines.map((l) => l.code).join(", ")}`);
  return found;
}

function amountOf(lines: readonly StatementLine[], code: string): bigint | null {
  return line(lines, code).amount;
}

/** Everything a user can see or download, without the fields that may differ by design. */
function observable(report: FinancialStatementsReport) {
  return {
    balanceSheet: report.balanceSheet,
    incomeStatement: report.incomeStatement,
    openingBalanceSheet: report.openingBalanceSheet,
    equityStatement: report.equityStatement,
    notes: report.notes,
    businessReport: report.businessReport,
    schedules: report.schedules,
    checks: report.checks,
    issues: report.issues,
    codeViews: report.codeViews,
    hot010: buildHot010Files(report).map((file) => [file.fileName, file.text]),
  };
}

describe("buildFinancialStatements — 第 1 期", () => {
  const report = buildFinancialStatements(BOOK, FY1.id);
  const bs = report.balanceSheet;
  const pl = report.incomeStatement;

  it("balances: 資産合計 = 負債純資産合計", () => {
    expect(bs.assets).toBe(FY1_TOTALS.assets);
    expect(bs.liabilities).toBe(FY1_TOTALS.liabilities);
    expect(bs.netAssets).toBe(FY1_TOTALS.netAssets);
    expect(bs.liabilitiesAndNetAssets).toBe(bs.assets);
    expect(amountOf(bs.lines, "10A000020")).toBe(FY1_TOTALS.assets);
    expect(amountOf(bs.lines, "10C000040")).toBe(FY1_TOTALS.assets);
    expect(report.checks.balanceSheetBalanced).toBe(true);
  });

  it("has the trial balance's net income", () => {
    const tb = buildTrialBalance(BOOK, {
      fiscalYear: FY1,
      preset: "year",
      from: FY1.startDate,
      to: FY1.endDate,
      segmentId: null,
    });
    expect(pl.netIncome).toBe(FY1_TOTALS.netIncome);
    expect(pl.netIncome).toBe(tb.incomeStatement.netIncome);
    expect(report.checks.trialBalanceNetIncome).toBe(FY1_TOTALS.netIncome);
    expect(report.checks.netIncomeMatchesTrialBalance).toBe(true);
    expect(amountOf(pl.lines, "10F000160")).toBe(FY1_TOTALS.netIncome);
    expect(amountOf(pl.lines, "10D100030")).toBe(FY1_TOTALS.sales);
    expect(amountOf(pl.lines, "10E201330")).toBe(FY1_TOTALS.sga);
  });

  it("ends 株主資本等変動計算書 at the balance sheet's net assets", () => {
    const ss = report.equityStatement;
    expect(ss.netAssetsTotal.closing).toBe(bs.netAssets);
    expect(report.checks.equityMatchesBalanceSheet).toBe(true);
    const ssLine = (code: string) => ss.lines.find((l) => l.code === code)?.amount;
    expect(ssLine("SS3199")).toBe(FY1_TOTALS.netAssets);
    expect(ssLine("SS2099")).toBe(amountOf(bs.lines, "10C130370"));
  });

  it("opens with the balance sheet of 成立の日", () => {
    const opening = report.openingBalanceSheet!;
    expect(report.isFoundingYear).toBe(true);
    expect(opening.asOf).toBe(FY1.startDate);
    expect(opening.assets).toBe(FY1_TOTALS.openingAssets);
    expect(opening.liabilities).toBe(FY1_TOTALS.openingLiabilities);
    expect(opening.netAssets).toBe(FY1_TOTALS.openingNetAssets);
    expect(report.checks.openingBalanceSheetBalanced).toBe(true);
    // 開業費 was booked after the founding date: a movement of the year, not 成立の日.
    expect(opening.lines.some((l) => l.code === "10A300030")).toBe(false);
    expect(amountOf(opening.lines, "10A300020")).toBe(165_000n);

    const ss = report.equityStatement;
    expect(ss.netAssetsTotal.opening).toBe(opening.netAssets);
    expect(ss.capital).toMatchObject({ opening: 50_000n, issuance: 0n, closing: 50_000n });
    // 資本金 did not move: 当期首残高 and 当期末残高 only.
    const codes = ss.lines.map((l) => l.code);
    expect(codes).toContain("SS0201");
    expect(codes).toContain("SS0299");
    expect(codes).not.toContain("SS0202");
    expect(codes).not.toContain("SS0203");
    // 資本剰余金 is 0 throughout: left out. その他利益剰余金 is a heading only.
    expect(codes.some((code) => code.startsWith("SS03") || code.startsWith("SS04"))).toBe(false);
    expect(codes).toContain("SS0900");
    expect(codes.filter((code) => code > "SS0900" && code <= "SS0999")).toEqual([]);
  });

  it("has nothing to confirm in the closed first year", () => {
    expect(report.issues).toEqual([]);
    expect(report.stateNote).toBeNull();
    expect(report.empty).toBe(false);
    expect(report.periodLabel).toBe("第1期　自 2026年11月2日　至 2027年3月31日");
    expect(fiscalYearPeriodLabel(FY2)).toBe("第2期　自 2027年4月1日　至 2028年3月31日");
  });

  it("lays the lines out in the order of the code table", () => {
    const codes = pl.lines.map((l) => l.code);
    // The custom item (5325 ソフトウェア利用料) closes 販売費及び一般管理費, before its total.
    const custom = line(pl.lines, "10E200010-1");
    expect(custom.label).toBe("ソフトウェア利用料");
    expect(custom.depth).toBe(3);
    expect(custom.amount).toBe(2_200n);
    expect(codes.indexOf("10E200010-1")).toBe(codes.indexOf("10E201330") - 1);
    // 1 account → its own name; the total keeps the table's name.
    expect(line(bs.lines, "10A100020").label).toBe("普通預金");
    expect(line(pl.lines, "10D100030").label).toBe("売上高");
    expect(line(bs.lines, "10C130380").label).toBe("その他利益剰余金合計");
    // 減価償却累計額 is a negative line at the end of 有形固定資産.
    expect(amountOf(bs.lines, "10A210920")).toBe(-27_500n);
    const bsCodes = bs.lines.map((l) => l.code);
    expect(bsCodes.indexOf("10A210920")).toBe(bsCodes.indexOf("10A210950") - 1);
    // Internal accounts never show.
    expect([...bs.lines, ...pl.lines].some((l) => l.accountIds.includes("acc:9000"))).toBe(false);
  });

  it("shows section headings only (and folds 売上高 into its single line)", () => {
    expect(line(bs.lines, "10A100010").visible).toBe(true);
    expect(line(bs.lines, "10B100620").visible).toBe(false);
    expect(line(bs.lines, "10B100730").visible).toBe(false);
    expect(line(pl.lines, "10D100010").visible).toBe(false);
    expect(line(pl.lines, "10D100020").visible).toBe(false);
    expect(line(pl.lines, "10E200010").visible).toBe(true);
    // Hidden titles do not indent: 役員借入金 sits with the other current liabilities.
    expect(line(bs.lines, "10B100930").indent).toBe(line(bs.lines, "10B100630").indent);
    expect(line(bs.lines, "10A100020").indent).toBe(2);
  });

  it("splits the balance sheet for the 勘定式", () => {
    const sides = balanceSheetSides(bs, report.edition);
    expect(sides.assets.every((l) => l.code.startsWith("10A"))).toBe(true);
    expect(sides.liabilitiesAndNetAssets.every((l) => !l.code.startsWith("10A"))).toBe(true);
    expect(sides.assetsTotal?.amount).toBe(FY1_TOTALS.assets);
    expect(sides.liabilitiesAndNetAssetsTotal?.amount).toBe(FY1_TOTALS.assets);
    expect(sides.assets.some((l) => !l.visible)).toBe(false);
  });

  it("formats amounts the 会社法 way", () => {
    expect(formatStatementAmount(1_234_567n)).toBe("1,234,567");
    expect(formatStatementAmount(-71_884n)).toBe("△ 71,884");
    expect(formatStatementAmount(0n)).toBe("0");
  });
});

describe("決算振替 (closing entries)", () => {
  it("does not change any output of the year it closes", () => {
    const before = buildFinancialStatements(BOOK, FY1.id);
    const after = buildFinancialStatements(CLOSED_BOOK, FY1.id);
    expect(after.excludedClosingEntries).toBe(1);
    expect(before.excludedClosingEntries).toBe(0);
    expect(observable(after)).toEqual(observable(before));
  });

  it("leaves out a 決算振替 taken back (its reversal) and the one made again", () => {
    const reopened: ReportEntry = {
      ...FY1_CLOSING,
      status: "voided",
      voidReason: "締めを戻す",
    };
    const reversal: ReportEntry = {
      ...FY1_CLOSING,
      id: "e21",
      no: 21,
      description: "取消: 決算振替",
      kind: "reversal",
      reversalOfId: FY1_CLOSING.id,
      lines: FY1_CLOSING.lines.map((l) => ({
        ...l,
        side: l.side === "debit" ? ("credit" as const) : ("debit" as const),
      })),
    };
    const again: ReportEntry = { ...FY1_CLOSING, id: "e22", no: 22 };
    const book = withSource({ entries: [...BOOK.entries, reopened, reversal, again] });
    const report = buildFinancialStatements(book, FY1.id);
    expect(report.excludedClosingEntries).toBe(3);
    expect(observable(report)).toEqual(observable(buildFinancialStatements(BOOK, FY1.id)));
    expect(observable(buildFinancialStatements(book, FY2.id))).toEqual(
      observable(buildFinancialStatements(BOOK, FY2.id)),
    );
  });

  it("is kept for the next year, which opens with the same 繰越利益剰余金", () => {
    const before = buildFinancialStatements(BOOK, FY2.id);
    const after = buildFinancialStatements(CLOSED_BOOK, FY2.id);
    expect(observable(after)).toEqual(observable(before));
    expect(after.equityStatement.carriedForward.opening).toBe(FY1_TOTALS.netIncome);
  });

  it("would zero the year in a plain trial balance (why it is left out)", () => {
    const tb = buildTrialBalance(CLOSED_BOOK, {
      fiscalYear: FY1,
      preset: "year",
      from: FY1.startDate,
      to: FY1.endDate,
      segmentId: null,
    });
    expect(tb.incomeStatement.netIncome).toBe(0n);
    expect(buildFinancialStatements(CLOSED_BOOK, FY1.id).incomeStatement.netIncome).toBe(
      FY1_TOTALS.netIncome,
    );
  });
});

describe("buildFinancialStatements — 第 2 期", () => {
  const first = buildFinancialStatements(BOOK, FY1.id);
  const report = buildFinancialStatements(BOOK, FY2.id);

  it("opens with the previous year's closing balances", () => {
    const ss = report.equityStatement;
    expect(report.isFoundingYear).toBe(false);
    expect(report.openingBalanceSheet).toBeNull();
    expect(ss.capital.opening).toBe(first.equityStatement.capital.closing);
    expect(ss.carriedForward.opening).toBe(first.equityStatement.carriedForward.closing);
    expect(ss.netAssetsTotal.opening).toBe(first.balanceSheet.netAssets);
  });

  it("holds the identities", () => {
    expect(report.balanceSheet.assets).toBe(FY2_TOTALS.assets);
    expect(report.balanceSheet.liabilities).toBe(FY2_TOTALS.liabilities);
    expect(report.balanceSheet.netAssets).toBe(FY2_TOTALS.netAssets);
    expect(report.balanceSheet.liabilitiesAndNetAssets).toBe(FY2_TOTALS.assets);
    expect(report.incomeStatement.netIncome).toBe(FY2_TOTALS.netIncome);
    expect(report.incomeStatement.sales).toBe(FY2_TOTALS.sales);
    expect(report.checks).toMatchObject({
      balanceSheetBalanced: true,
      netIncomeMatchesTrialBalance: true,
      equityMatchesBalanceSheet: true,
      openingBalanceSheetBalanced: null,
      sgaScheduleMatches: true,
    });
    expect(report.equityStatement.netAssetsTotal.closing).toBe(FY2_TOTALS.netAssets);
  });

  it("asks for the settings of an open year and shows its state", () => {
    expect(report.stateNote).toBe("期末前の数字です。決算整理と締めの後に確定します");
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "notesTemplate",
      "businessReportTemplate",
    ]);
    // 発行済株式の総数 defaults to the previous year's.
    expect(report.settings.issuedShares).toBe(10000);
    expect(report.settings.issuedSharesFromEarlierYear).toBe(true);
  });

  it("warns about 仮受・仮払消費税 left before the settlement", () => {
    const unsettled = withSource({ entries: BOOK.entries.filter((e) => e.id !== "f15") });
    const kinds = buildFinancialStatements(unsettled, FY2.id).issues.map((issue) => issue.kind);
    expect(kinds).toContain("taxBalance");
  });
});

describe("成立の日 with a corrected opening entry", () => {
  const reversal: ReportEntry = entry({
    id: "e2r",
    fy: FY1,
    no: 21,
    date: "2026-11-20",
    description: "取消 No.2: 設立費用（役員立替）",
    kind: "reversal",
    reversalOfId: "e2",
    lines: [
      { side: "credit", account: "1700", amount: 165_000n },
      { side: "debit", account: "2400", amount: 165_000n, sub: "owner" },
    ],
  });
  const replacement: ReportEntry = entry({
    id: "e2b",
    fy: FY1,
    no: 22,
    date: "2026-11-20",
    description: "設立費用（役員立替）",
    kind: "opening",
    lines: [
      { side: "debit", account: "1700", amount: 160_000n },
      { side: "credit", account: "2400", amount: 160_000n, sub: "owner" },
    ],
  });
  const corrected = FY1_ENTRIES.map((e) =>
    e.id === "e2"
      ? { ...e, status: "voided" as const, replacedById: "e2b", voidReason: "金額の誤り" }
      : e,
  );
  const source = withSource({ entries: [...corrected, reversal, replacement, ...FY2_ENTRIES] });
  const report = buildFinancialStatements(source, FY1.id);

  it("includes the reversal and the replacement of a 成立の日 entry", () => {
    const opening = report.openingBalanceSheet!;
    expect(amountOf(opening.lines, "10A300020")).toBe(160_000n);
    expect(opening.assets).toBe(210_000n);
    expect(opening.liabilities).toBe(160_000n);
    expect(report.checks.openingBalanceSheetBalanced).toBe(true);
    expect(report.equityStatement.netAssetsTotal.opening).toBe(50_000n);
  });
});

describe("株主資本等変動計算書 movements", () => {
  it("shows 剰余金の配当 and warns about other credits to 繰越利益剰余金", () => {
    const dividend = entry({
      id: "f90",
      fy: FY2,
      no: 90,
      date: "2027-06-30",
      description: "剰余金の配当",
      lines: [
        { side: "debit", account: "3200", amount: 10_000n },
        { side: "credit", account: "1100", amount: 10_000n, sub: "bank" },
      ],
    });
    const credit = entry({
      id: "f91",
      fy: FY2,
      no: 91,
      date: "2027-07-31",
      description: "繰越利益剰余金への貸方",
      lines: [
        { side: "debit", account: "1100", amount: 1_000n, sub: "bank" },
        { side: "credit", account: "3200", amount: 1_000n },
      ],
    });
    const source = withSource({ entries: [...BOOK.entries, dividend, credit] });
    const report = buildFinancialStatements(source, FY2.id);
    const ss = report.equityStatement;
    expect(ss.carriedForward.dividends).toBe(-10_000n);
    expect(ss.carriedForward.other).toBe(1_000n);
    expect(ss.lines.find((l) => l.code === "SS2005")?.amount).toBe(-10_000n);
    expect(ss.lines.find((l) => l.code === "SS3105")?.amount).toBe(-10_000n);
    expect(ss.lines.find((l) => l.code === "SS2098")?.amount).toBe(
      FY2_TOTALS.netIncome - 10_000n + 1_000n,
    );
    expect(report.checks.equityMatchesBalanceSheet).toBe(true);
    expect(report.issues.map((issue) => issue.kind)).toContain("equity");
  });

  it("shows 新株の発行 under 資本金 and 資本準備金", () => {
    const issue = entry({
      id: "f92",
      fy: FY2,
      no: 92,
      date: "2027-12-01",
      description: "増資",
      lines: [
        { side: "debit", account: "1100", amount: 100_000n, sub: "bank" },
        { side: "credit", account: "3000", amount: 50_000n },
        { side: "credit", account: "3100", amount: 50_000n },
      ],
    });
    const report = buildFinancialStatements(
      withSource({ entries: [...BOOK.entries, issue] }),
      FY2.id,
    );
    const ss = report.equityStatement;
    const amount = (code: string) => ss.lines.find((l) => l.code === code)?.amount;
    expect(amount("SS0203")).toBe(50_000n);
    expect(amount("SS0403")).toBe(50_000n);
    expect(amount("SS0603")).toBe(50_000n);
    expect(amount("SS2303")).toBe(100_000n);
    expect(amount("SS3199")).toBe(report.balanceSheet.netAssets);
    expect(amountOf(report.balanceSheet.lines, "10C120020")).toBe(50_000n);
    expect(amountOf(report.balanceSheet.lines, "10C120040")).toBe(50_000n);
    expect(report.checks.equityMatchesBalanceSheet).toBe(true);
  });
});

describe("勘定科目コード in the statements", () => {
  it("puts an unmapped account under its group's title and reports it", () => {
    const account = {
      ...BOOK.accounts[0]!,
      id: "acc:5800",
      code: "5800",
      name: "架空研修費",
      kind: "expense" as const,
      group: "sga" as const,
      isCashLike: false,
      sortOrder: 5800,
    };
    const spend = entry({
      id: "f93",
      fy: FY2,
      no: 93,
      date: "2027-08-15",
      description: "研修",
      lines: [
        { side: "debit", account: "5800", amount: 5_000n },
        { side: "credit", account: "1100", amount: 5_000n, sub: "bank" },
      ],
    });
    const source = withSource({
      accounts: [...BOOK.accounts, account],
      entries: [...BOOK.entries, spend],
    });
    const report = buildFinancialStatements(source, FY2.id);
    const pl = report.incomeStatement.lines;
    // 5325 is -1 (code order), 5800 is -2.
    expect(line(pl, "10E200010-1").label).toBe("ソフトウェア利用料");
    expect(line(pl, "10E200010-2").label).toBe("架空研修費");
    expect(report.codes.get("acc:5800")?.origin).toBe("fallback");
    const issue = report.issues.find((i) => i.kind === "etaxCode");
    expect(issue?.message).toContain("5800 架空研修費");
    expect(report.codeViews.find((v) => v.accountId === "acc:5800")?.displayCode).toBe(
      "10E200010-2",
    );
  });

  it("places custom items before the title's total, or after its subtree", () => {
    const base = BOOK.accounts[0]!;
    const sales = {
      ...base,
      id: "acc:4100",
      code: "4100",
      name: "架空売上",
      kind: "revenue" as const,
      group: "sales" as const,
      isCashLike: false,
    };
    const tax = {
      ...base,
      id: "acc:8100",
      code: "8100",
      name: "架空税",
      kind: "expense" as const,
      group: "income_taxes" as const,
      isCashLike: false,
    };
    const lines = entry({
      id: "f98",
      fy: FY2,
      no: 98,
      date: "2027-12-31",
      description: "独自科目",
      lines: [
        { side: "debit", account: "1100", amount: 1_000n, sub: "bank" },
        { side: "credit", account: "4100", amount: 1_500n },
        { side: "debit", account: "8100", amount: 500n },
      ],
    });
    const report = buildFinancialStatements(
      withSource({ accounts: [...BOOK.accounts, sales, tax], entries: [...BOOK.entries, lines] }),
      FY2.id,
    );
    const pl = report.incomeStatement.lines;
    const codes = pl.map((l) => l.code);
    // 売上高 (a title whose subtree ends with its total 売上高).
    expect(codes.indexOf("10D100020-1")).toBe(codes.indexOf("10D100030") - 1);
    expect(amountOf(pl, "10D100030")).toBe(FY2_TOTALS.sales + 1_500n);
    expect(line(pl, "10D100020").visible).toBe(true);
    // 法人税等合計 has no total below it: after its subtree, before 当期純利益.
    expect(line(pl, "10F100060-1")).toMatchObject({ label: "架空税", depth: 3, amount: 500n });
    expect(codes.indexOf("10F100060-1")).toBe(codes.indexOf("10F000160") - 1);
    expect(amountOf(pl, "10F100060")).toBe(70_500n);
    expect(report.incomeStatement.netIncome).toBe(FY2_TOTALS.netIncome + 1_000n);
    expect(report.checks.balanceSheetBalanced).toBe(true);
  });

  it("uses a valid override and falls back on an unusable one", () => {
    const accounts = BOOK.accounts.map((account) => {
      if (account.code === "5320") return { ...account, eTaxCode: "10E201220" };
      if (account.code === "5450") return { ...account, eTaxCode: "10E999999" };
      if (account.code === "5330") return { ...account, eTaxCode: "10E300020" };
      return account;
    });
    const report = buildFinancialStatements(withSource({ accounts }), FY1.id);
    const pl = report.incomeStatement.lines;
    expect(line(pl, "10E201220").label).toBe("通信費");
    expect(report.codes.get("acc:5320")?.origin).toBe("override");
    // Not in the table: back to the standard code.
    expect(line(pl, "10E200240").label).toBe("保険料");
    expect(report.codes.get("acc:5450")?.problem).toBe("override_unusable");
    // Another group's section: a custom item under 販売費及び一般管理費.
    expect(report.codes.get("acc:5330")).toMatchObject({
      code: "10E200010",
      branch: true,
      origin: "fallback",
    });
    expect(pl.find((l) => l.label === "消耗品費")?.code).toMatch(/^10E200010-\d$/);
    expect(report.issues.filter((i) => i.kind === "etaxCode")).toHaveLength(2);
    expect(report.incomeStatement.netIncome).toBe(FY1_TOTALS.netIncome);
  });

  it("reports internal transactions that do not net to 0", () => {
    const leak = entry({
      id: "f94",
      fy: FY2,
      no: 94,
      date: "2027-09-15",
      description: "内部取引（片側だけ）",
      lines: [
        { side: "debit", account: "9000", amount: 1_000n, segment: "kamakura" },
        { side: "credit", account: "1100", amount: 1_000n, sub: "bank" },
      ],
    });
    const report = buildFinancialStatements(
      withSource({ entries: [...BOOK.entries, leak] }),
      FY2.id,
    );
    const kinds = report.issues.map((issue) => issue.kind);
    expect(kinds).toContain("internal");
    expect(kinds).toContain("identity");
  });
});

describe("an empty year", () => {
  it("is flagged and still balances", () => {
    const report = buildFinancialStatements(withSource({ entries: FY1_ENTRIES }), FY2.id);
    expect(report.empty).toBe(true);
    expect(report.balanceSheet.assets).toBe(FY1_TOTALS.assets);
    expect(report.incomeStatement.netIncome).toBe(0n);
    expect(report.checks.balanceSheetBalanced).toBe(true);
  });
});
