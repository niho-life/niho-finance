import { describe, expect, it } from "vitest";
import {
  accountDetailsCsv,
  accountDetailsCsvRows,
  announcementDeadline,
  balanceOn,
  buildAccountDetails,
  buildAnnouncementHtml,
  buildFinancialStatements,
  buildFixedAssetSchedule,
  businessProgressSentence,
  EMPTY_STATEMENT_SETTINGS,
  financialStatementsReadiness,
  indexSource,
  normalizeStatementSettings,
  NOT_CLOSED_MESSAGE,
  STATEMENT_TEXT_MAX_LENGTH,
  statementSettingsDefaults,
  toFinancialStatementsSource,
  type AccountDetailRow,
  type FixedAssetRegisterRow,
  type FixedAssetScheduleRow,
  type ReportSource,
} from "../../src";
import { BOOK, entry, FY1, FY1_SETTINGS, FY1_TOTALS, FY2, FY2_TOTALS, withSource } from "./fixture";

describe("決算書の設定", () => {
  it("normalizes stored JSON without throwing", () => {
    expect(normalizeStatementSettings(null)).toEqual(EMPTY_STATEMENT_SETTINGS);
    expect(normalizeStatementSettings("x")).toEqual(EMPTY_STATEMENT_SETTINGS);
    expect(normalizeStatementSettings([1, 2])).toEqual(EMPTY_STATEMENT_SETTINGS);
    const settings = normalizeStatementSettings({
      issuedShares: "10000",
      shareholdersMeetingOn: "2027-02-30",
      announcementPublishedOn: "2027-06-01",
      announcementUrl: "  ",
      notes: {
        depreciation: "x".repeat(STATEMENT_TEXT_MAX_LENGTH + 10),
        revenueRecognition: 12,
        accountingPolicyChanges: "",
        otherNotes: [
          { title: " 項目 ", body: "内容" },
          { title: "", body: " " },
          "bad",
          { title: 1 },
        ],
      },
      businessReport: { progress: "経過\r\n成果" },
      simplifiedTaxClass: "3",
    });
    expect(settings.issuedShares).toBe(10000);
    expect(settings.shareholdersMeetingOn).toBeNull();
    expect(settings.announcementPublishedOn).toBe("2027-06-01");
    expect(settings.announcementUrl).toBeNull();
    expect(settings.notes.depreciation).toHaveLength(STATEMENT_TEXT_MAX_LENGTH);
    expect(settings.notes.revenueRecognition).toBeNull();
    expect(settings.notes.accountingPolicyChanges).toBe("");
    expect(settings.notes.otherNotes).toEqual([{ title: "項目", body: "内容" }]);
    expect(settings.businessReport.progress).toBe("経過\n成果");
    expect(settings.simplifiedTaxClass).toBe(3);
    expect(normalizeStatementSettings({ issuedShares: -1, simplifiedTaxClass: 7 })).toMatchObject({
      issuedShares: null,
      simplifiedTaxClass: null,
    });
    expect(normalizeStatementSettings({ issuedShares: 1.5 }).issuedShares).toBeNull();
  });

  it("derives the defaults from the year", () => {
    const inclusive = statementSettingsDefaults({
      accountingMethod: "tax_inclusive",
      hasDeferredAssets: true,
      previousIssuedShares: null,
      sales: 33_000n,
      netIncome: -71_884n,
    });
    expect(inclusive.notes.otherSignificant).toBe(
      "消費税等の会計処理は、税込方式によっています。\n創立費及び開業費は、5年間で均等額を償却しています。",
    );
    expect(inclusive.businessReport.progress).toBe(
      "当事業年度の売上高は33,000円、当期純損失は71,884円となりました。",
    );
    expect(inclusive.simplifiedTaxClass).toBe(5);
    const exclusive = statementSettingsDefaults({
      accountingMethod: "tax_exclusive",
      hasDeferredAssets: false,
      previousIssuedShares: 10000,
      sales: 0n,
      netIncome: 0n,
    });
    expect(exclusive.notes.otherSignificant).toBe("消費税等の会計処理は、税抜方式によっています。");
    expect(exclusive.issuedShares).toBe(10000);
    expect(businessProgressSentence(509_000n, 247_595n)).toBe(
      "当事業年度の売上高は509,000円、当期純利益は247,595円となりました。",
    );
  });

  it("asks for what was never saved", () => {
    const fresh = withSource({
      fiscalYears: [{ ...FY1, statementSettings: null }, FY2],
    });
    const report = buildFinancialStatements(fresh, FY1.id);
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "issuedShares",
      "notesTemplate",
      "businessReportTemplate",
    ]);
    expect(report.settings.notes.otherSignificant).toBe(
      "消費税等の会計処理は、税込方式によっています。\n創立費及び開業費は、5年間で均等額を償却しています。",
    );
    // No share count: the note is left out.
    expect(report.notes.sections.map((section) => section.code)).toEqual(["NT0201"]);
  });

  it("puts the announcement deadline 5 years after the meeting", () => {
    expect(announcementDeadline("2027-05-28")).toBe("2032-05-28");
    expect(announcementDeadline("2028-02-29")).toBe("2033-02-28");
    expect(announcementDeadline(null)).toBeNull();
  });
});

describe("toFinancialStatementsSource", () => {
  it("fills the extra columns on S7's source", () => {
    const base: ReportSource = {
      ...BOOK,
      company: { name: BOOK.company.name, foundedOn: BOOK.company.foundedOn },
      fiscalYears: BOOK.fiscalYears.map(({ statementSettings: _s, ...year }) => year),
      accounts: BOOK.accounts.map(({ eTaxCode: _e, ...account }) => account),
      subAccounts: BOOK.subAccounts.map(({ partnerId: _p, ...sub }) => sub),
      partners: BOOK.partners.map(({ address: _a, ...partner }) => partner),
    };
    const source = toFinancialStatementsSource(base, {
      company: { address: " ", representative: "架空 太郎", invoiceRegisteredOn: null },
      accountETaxCodes: { "acc:5320": "10E201220", "acc:5330": "" },
      partnerAddresses: { "p:card": "東京都架空区一丁目1番1号" },
      subAccountPartners: { "sub:card": "p:card" },
      statementSettings: { fy1: { issuedShares: 10000 }, fy2: null },
      taxRules: BOOK.taxRules,
    });
    expect(source.company).toMatchObject({ address: null, representative: "架空 太郎" });
    expect(source.accounts.find((a) => a.id === "acc:5320")?.eTaxCode).toBe("10E201220");
    expect(source.accounts.find((a) => a.id === "acc:5330")?.eTaxCode).toBeNull();
    expect(source.subAccounts.find((s) => s.id === "sub:card")?.partnerId).toBe("p:card");
    expect(source.partners.find((p) => p.id === "p:card")?.address).toBe(
      "東京都架空区一丁目1番1号",
    );
    expect(source.fiscalYears[0]?.statementSettings?.issuedShares).toBe(10000);
    expect(source.fiscalYears[1]?.statementSettings).toBeNull();
  });

  it("keeps the representative's name without the title the statements add", () => {
    const representative = (value: string) =>
      toFinancialStatementsSource(BOOK, {
        company: { address: null, representative: value, invoiceRegisteredOn: null },
        taxRules: BOOK.taxRules,
      }).company.representative;
    expect(representative("代表取締役 架空 太郎")).toBe("架空 太郎");
    expect(representative("代表取締役　架空 太郎")).toBe("架空 太郎");
    expect(representative("架空 太郎")).toBe("架空 太郎");
    expect(representative("代表取締役")).toBeNull();
  });
});

describe("個別注記表", () => {
  const report = buildFinancialStatements(BOOK, FY1.id);

  it("shows the policies, the share count and その他の注記", () => {
    const [policies, equity, other] = report.notes.sections;
    expect(policies).toMatchObject({
      code: "NT0201",
      title: "重要な会計方針に係る事項に関する注記",
      body: "この計算書類は、『中小企業の会計に関する基本要領』によって作成しています。",
    });
    expect(policies!.items.map((item) => item.code)).toEqual(["NT0205", "NT0207", "NT0208"]);
    expect(equity).toMatchObject({
      code: "NT0501",
      body: "当事業年度の末日における発行済株式の数　普通株式　10,000株",
    });
    expect(other!.items.map((item) => item.title)).toEqual([
      "重要な後発事象",
      "関連当事者との取引",
    ]);
  });

  it("adds 会計方針の変更 and 誤謬の訂正 when written", () => {
    const settings = {
      ...FY1_SETTINGS,
      notes: {
        ...FY1_SETTINGS.notes,
        accountingPolicyChanges: "減価償却の方法を変更しました。",
        errorCorrections: "前期の未払費用の計上漏れを訂正しました。",
      },
    };
    const changed = buildFinancialStatements(
      withSource({ fiscalYears: [{ ...FY1, statementSettings: settings }, FY2] }),
      FY1.id,
    );
    const [policies, , other] = changed.notes.sections;
    expect(policies!.items.map((item) => item.code)).toEqual([
      "NT0205",
      "NT0207",
      "NT0208",
      "NT0213",
    ]);
    expect(other!.items[0]).toMatchObject({ title: "誤謬の訂正" });
  });
});

describe("事業報告", () => {
  it("fills the sections from the company and the settings", () => {
    const report = buildFinancialStatements(BOOK, FY1.id).businessReport;
    expect(report.title).toBe("事業報告");
    expect(report.periodLabel).toBe("第1期　自 2026年11月2日　至 2027年3月31日");
    expect(report.sections.map((section) => section.heading)).toEqual([
      "1. 会社の現況",
      "2. 株式の状況",
      "3. 会社役員の状況",
      "4. その他の重要な事項",
    ]);
    expect(report.sections[0]!.items[0]).toEqual({
      label: "事業の内容",
      body: "プラットフォーム、鎌倉、受託",
    });
    expect(report.sections[1]!.items).toEqual([
      { label: "発行済株式の総数", body: "10,000株" },
      { label: "株主数", body: "1名" },
    ]);
    expect(report.sections[2]!.items[0]).toEqual({ label: "代表取締役", body: "架空 太郎" });
    expect(report.createdOn).toBe("2027-05-28");
  });

  it("writes the year's figures by default", () => {
    const report = buildFinancialStatements(BOOK, FY2.id).businessReport;
    expect(report.sections[0]!.items[1]!.body).toBe(
      "当事業年度の売上高は509,000円、当期純利益は247,595円となりました。",
    );
    expect(report.sections[0]!.items[2]!.body).toBe("（記入する）");
    expect(report.createdOn).toBeNull();
  });
});

describe("附属明細書", () => {
  it("matches 販売費及び一般管理費 of the income statement", () => {
    const report = buildFinancialStatements(BOOK, FY1.id);
    const sga = report.schedules.sga;
    expect(sga.total).toBe(FY1_TOTALS.sga);
    expect(sga.matchesIncomeStatement).toBe(true);
    expect(sga.rows.map((row) => row.code)).toEqual([
      "5320",
      "5325",
      "5330",
      "5400",
      "5450",
      "5460",
    ]);
  });

  it("waits for the fixed asset register, then totals it", () => {
    const report = buildFinancialStatements(BOOK, FY1.id);
    expect(report.schedules.fixedAssets).toMatchObject({
      rows: [],
      message: "固定資産台帳の反映後に出ます",
    });
    const row: FixedAssetScheduleRow = {
      assetType: "工具、器具及び備品",
      kind: "tangible",
      openingBookValue: 0n,
      increase: 330_000n,
      decrease: 0n,
      depreciation: 27_500n,
      closingBookValue: 302_500n,
      accumulatedDepreciation: 27_500n,
      closingAcquisitionCost: 330_000n,
    };
    const schedule = buildFixedAssetSchedule([row]);
    expect(schedule.message).toBeNull();
    expect(schedule.tangible.closingBookValue).toBe(302_500n);
    expect(schedule.intangible.closingBookValue).toBe(0n);
    expect(schedule.inconsistentRows).toEqual([]);
    const register: FixedAssetRegisterRow = {
      accountId: "acc:1510",
      indirect: true,
      openingBookValue: 0n,
      increase: 330_000n,
      decrease: 0n,
      depreciation: 27_500n,
      closingBookValue: 302_500n,
      accumulatedDepreciation: 27_500n,
    };
    const connected = buildFinancialStatements(BOOK, FY1.id, { fixedAssets: [register] });
    expect(connected.schedules.fixedAssets.rows).toEqual([{ ...row, assetType: "工具器具備品" }]);
    expect(connected.issues.map((issue) => issue.kind)).not.toContain("fixedAssets");
    const wrong = buildFinancialStatements(BOOK, FY1.id, {
      fixedAssets: [{ ...register, closingBookValue: 300_000n }],
    });
    expect(wrong.issues.map((issue) => issue.kind)).toContain("fixedAssets");
  });

  it("shows 無形固定資産 net of the amortisation #14 credits to 減価償却累計額", () => {
    const software = entry({
      id: "sw1",
      fy: FY1,
      no: 91,
      date: "2026-12-01",
      description: "ソフトウェアの取得",
      lines: [
        { side: "debit", account: "1520", amount: 120_000n },
        { side: "credit", account: "2400", amount: 120_000n },
      ],
    });
    const amortisation = entry({
      id: "sw2",
      fy: FY1,
      no: 92,
      date: "2027-03-31",
      description: "減価償却",
      kind: "adjusting",
      lines: [
        { side: "debit", account: "5460", amount: 8_000n },
        { side: "credit", account: "1590", amount: 8_000n },
      ],
    });
    const book = withSource({ entries: [...BOOK.entries, software, amortisation] });
    const asset = (accountId: string, cost: bigint, depreciation: bigint) => ({
      accountId,
      indirect: true,
      openingBookValue: 0n,
      increase: cost,
      decrease: 0n,
      depreciation,
      closingBookValue: cost - depreciation,
      accumulatedDepreciation: depreciation,
    });
    const report = buildFinancialStatements(book, FY1.id, {
      fixedAssets: [asset("acc:1510", 330_000n, 27_500n), asset("acc:1520", 120_000n, 8_000n)],
    });
    const lines = report.balanceSheet.lines;
    const amount = (code: string) => lines.find((l) => l.code === code)?.amount;
    expect(amount("10A220110")).toBe(112_000n); // ソフトウエア, net
    expect(amount("10A220330")).toBe(112_000n); // 無形固定資産合計
    expect(amount("10A210920")).toBe(-27_500n); // 減価償却累計額 of 有形固定資産 only
    expect(amount("10A210950")).toBe(302_500n); // 有形固定資産合計
    expect(amount("10A000020")).toBe(buildFinancialStatements(book, FY1.id).balanceSheet.assets);
    expect(report.checks.balanceSheetBalanced).toBe(true);
    expect(report.schedules.fixedAssets.intangible.closingBookValue).toBe(112_000n);
    expect(report.schedules.fixedAssets.intangible.closingAcquisitionCost).toBe(120_000n);
  });

  it("lists provisions under the provision titles", () => {
    expect(buildFinancialStatements(BOOK, FY2.id).schedules.provisions).toEqual({
      rows: [],
      message: "該当がありません",
    });
    const provision = {
      ...BOOK.accounts.find((a) => a.code === "2110")!,
      id: "acc:2150",
      code: "2150",
      name: "賞与引当金",
      eTaxCode: "10B100320",
    };
    const accrue = entry({
      id: "f97",
      fy: FY2,
      no: 97,
      date: "2028-03-31",
      description: "賞与引当金の繰入",
      kind: "adjusting",
      lines: [
        { side: "debit", account: "5210", amount: 30_000n },
        { side: "credit", account: "2150", amount: 30_000n },
      ],
    });
    const report = buildFinancialStatements(
      withSource({ accounts: [...BOOK.accounts, provision], entries: [...BOOK.entries, accrue] }),
      FY2.id,
    );
    expect(report.schedules.provisions.rows).toEqual([
      {
        accountId: "acc:2150",
        label: "賞与引当金",
        opening: 0n,
        increase: 30_000n,
        usedForPurpose: 0n,
        otherDecrease: 0n,
        closing: 30_000n,
      },
    ]);
  });
});

describe("勘定科目内訳の元データ", () => {
  const index = indexSource(BOOK);

  function closingByAccount(rows: readonly AccountDetailRow[]) {
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      if (row.total || !row.accountId) continue;
      const value = row.closing ?? row.periodAmount ?? 0n;
      totals.set(row.accountId, (totals.get(row.accountId) ?? 0n) + value);
    }
    return totals;
  }

  it("matches the balance sheet (第 1 期)", () => {
    const details = buildAccountDetails(BOOK, FY1.id);
    const byAccount = closingByAccount(details.rows);
    expect(byAccount.get("acc:1100")).toBe(FY1_TOTALS.bank);
    expect(byAccount.get("acc:2100")).toBe(FY1_TOTALS.card);
    expect(byAccount.get("acc:2400")).toBe(FY1_TOTALS.owner);
    for (const [accountId, value] of byAccount) {
      expect(value, accountId).toBe(balanceOn(index, accountId, undefined, FY1.endDate));
    }
    // Stripe is 0 at the end: left out.
    expect(details.rows.some((row) => row.accountCode === "1150")).toBe(false);
    const card = details.rows.find((row) => row.accountCode === "2100")!;
    expect(card).toMatchObject({
      schedule: "買掛金（未払金・未払費用）の内訳書",
      subAccountName: "架空カード",
      partnerName: "架空カード株式会社",
      partnerAddress: "東京都架空区一丁目1番1号",
      opening: 0n,
      credit: 5_500n,
      closing: 5_500n,
      lineCount: 2,
    });
  });

  it("matches the balance sheet and the income statement (第 2 期)", () => {
    const details = buildAccountDetails(BOOK, FY2.id);
    const byAccount = closingByAccount(details.rows);
    expect(byAccount.get("acc:1100")).toBe(FY2_TOTALS.bank);
    expect(byAccount.get("acc:2400")).toBe(FY2_TOTALS.owner);
    expect(byAccount.get("acc:5300")).toBe(FY2_TOTALS.rent);
    const rent = details.rows.find((row) => row.accountCode === "5300")!;
    expect(rent).toMatchObject({
      schedule: "地代家賃等の内訳書",
      partnerName: "架空不動産株式会社",
      partnerAddress: "神奈川県架空市三丁目3番3号",
      opening: null,
      closing: null,
      periodAmount: 80_000n,
      lineCount: 1,
    });
    const bank = details.rows.find((row) => row.accountCode === "1100")!;
    expect(bank).toMatchObject({
      opening: FY1_TOTALS.bank,
      closing: FY2_TOTALS.bank,
      lineCount: 5,
    });
    // Paid-off card: 0 at the end, left out with its 内訳書.
    expect(details.rows.some((row) => row.schedule === "買掛金（未払金・未払費用）の内訳書")).toBe(
      false,
    );
  });

  it("leaves the year's closing entries out", () => {
    const closing = entry({
      id: "f99",
      fy: FY2,
      no: 99,
      date: "2028-03-31",
      description: "決算振替",
      kind: "closing",
      lines: [
        { side: "debit", account: "3200", amount: 80_000n },
        { side: "credit", account: "5300", amount: 80_000n },
      ],
    });
    const closed = buildAccountDetails(withSource({ entries: [...BOOK.entries, closing] }), FY2.id);
    expect(closed.rows).toEqual(buildAccountDetails(BOOK, FY2.id).rows);
  });

  it("closes each 内訳書 with a total row", () => {
    const details = buildAccountDetails(BOOK, FY2.id);
    const schedules = [...new Set(details.rows.map((row) => row.schedule))];
    expect(schedules).toEqual([
      "預貯金等の内訳書",
      "借入金及び支払利子の内訳書",
      "地代家賃等の内訳書",
    ]);
    for (const schedule of schedules) {
      const rows = details.rows.filter((row) => row.schedule === schedule);
      const total = rows[rows.length - 1]!;
      expect(total).toMatchObject({ total: true, partnerName: "合計" });
      const items = rows.filter((row) => !row.total);
      const sum = (pick: (row: AccountDetailRow) => bigint | null) =>
        items
          .map(pick)
          .filter((v): v is bigint => v !== null)
          .reduce((a, b) => a + b, 0n);
      if (total.closing !== null) expect(total.closing).toBe(sum((row) => row.closing));
      if (total.periodAmount !== null)
        expect(total.periodAmount).toBe(sum((row) => row.periodAmount));
    }
  });

  it("writes a UTF-8 CSV with a BOM", () => {
    const details = buildAccountDetails(BOOK, FY2.id);
    const csv = accountDetailsCsv(details);
    expect(csv.fileName).toBe("account-details_20270401-20280331.csv");
    expect([...csv.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(csv.bytes.slice(3));
    expect(text.split("\r\n")[0]).toBe(
      "内訳書,科目コード,科目,補助科目,取引先,取引先の所在地,期首残高,期中の借方,期中の貸方,期末残高,期中の金額,件数",
    );
    expect(accountDetailsCsvRows(details)).toHaveLength(details.rows.length + 1);
  });
});

describe("決算公告", () => {
  it("is one self-contained HTML file with the full balance sheet", () => {
    const { fileName, html } = buildAnnouncementHtml(buildFinancialStatements(BOOK, FY1.id));
    expect(fileName).toBe("kessan-koukoku_20270331.html");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toMatch(/http/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).toContain("<title>第1期決算公告</title>");
    expect(html).toContain("掲載日: 2027年6月1日");
    expect(html).toContain("神奈川県架空市四丁目4番4号");
    expect(html).toContain("代表取締役　架空 太郎");
    expect(html).toContain("貸借対照表（2027年3月31日現在）");
    expect(html).toContain("（単位：円）");
    for (const label of ["流動資産", "普通預金", "繰越利益剰余金", "負債純資産合計"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain("△ 71,884");
    expect(html).toContain("537,716");
    expect(html).toContain("重要な会計方針に係る事項に関する注記");
    expect(html).toContain("当期純損失　71,884円");
    expect(html).toContain("@media (max-width:640px)");
  });

  it("escapes every text and leaves the date blank until it is set", () => {
    const source = withSource({
      company: { ...BOOK.company, name: "架空<商事>&株式会社", representative: null },
      fiscalYears: [
        { ...FY1, statementSettings: { ...FY1_SETTINGS, announcementPublishedOn: null } },
        FY2,
      ],
    });
    const { html } = buildAnnouncementHtml(buildFinancialStatements(source, FY1.id));
    expect(html).toContain("架空&lt;商事&gt;&amp;株式会社");
    expect(html).not.toContain("<商事>");
    expect(html).toContain("掲載日: 　　年　　月　　日");
    expect(html).not.toContain("代表取締役");
  });

  it("states a profit as 当期純利益", () => {
    const { html } = buildAnnouncementHtml(buildFinancialStatements(BOOK, FY2.id));
    expect(html).toContain("当期純利益　247,595円");
  });
});

describe("financialStatementsReadiness", () => {
  it("is done for a closed year with nothing to confirm", () => {
    expect(financialStatementsReadiness(buildFinancialStatements(BOOK, FY1.id))).toEqual({
      done: true,
      issues: [],
    });
  });

  it("lists what is left otherwise", () => {
    const readiness = financialStatementsReadiness(buildFinancialStatements(BOOK, FY2.id));
    expect(readiness.done).toBe(false);
    expect(readiness.issues[0]).toBe(NOT_CLOSED_MESSAGE);
    expect(readiness.issues).toHaveLength(3);
    const noShares = withSource({
      fiscalYears: [{ ...FY1, statementSettings: { ...FY1_SETTINGS, issuedShares: null } }, FY2],
    });
    const missing = financialStatementsReadiness(buildFinancialStatements(noShares, FY1.id));
    expect(missing).toEqual({
      done: false,
      issues: ["発行済株式の総数が未入力です。決算書の設定で入力します"],
    });
  });
});
