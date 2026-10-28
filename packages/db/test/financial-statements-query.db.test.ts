import {
  buildFinancialStatements,
  DEFAULT_DEPRECIATION_POLICY,
  STATEMENT_TEXT_MAX_LENGTH,
} from "@niho-finance/reports";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  createAccount,
  loadFinancialStatementsSource,
  loadStatementsExportStatus,
  recordExport,
  saveStatementSettings,
  SettingsError,
  STATEMENTS_UPDATE_ACTION,
  updateAccount,
} from "../src";
import { SEED_COMPANY, SEED_FISCAL_YEAR } from "../src/seed";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear } from "./support/refs";

const actor = "tester@example.com";

/** 決算書と申告用データ on the seeded book. Each test uses its own fiscal year (61–63) or account. */
describe.skipIf(!hasTestDatabase)("financial statements queries", () => {
  let prisma: PrismaClient;
  let year: FiscalYear;

  beforeAll(async () => {
    prisma = testPrisma();
    year = await createFiscalYear(prisma, {
      no: 61,
      startDate: "2061-04-01",
      endDate: "2062-03-31",
    });
  });

  async function statementAudits(fiscalYearId: string) {
    return prisma.auditLog.findMany({
      where: { action: STATEMENTS_UPDATE_ACTION, entityId: fiscalYearId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
  }

  it("loads the book with the company, the accounts' codes, the settings and the tax rules", async () => {
    const source = await loadFinancialStatementsSource(prisma);
    expect(source.company.name).toBe(SEED_COMPANY.name);
    expect(source.company.address).toBe(SEED_COMPANY.address);
    expect(source.company.representative).toBe(SEED_COMPANY.representative);
    expect(source.accounts).toHaveLength(await prisma.account.count());
    for (const account of source.accounts) expect(account).toHaveProperty("eTaxCode");
    expect(source.partners).toHaveLength(await prisma.partner.count());
    expect(source.subAccounts).toHaveLength(await prisma.subAccount.count());
    expect(source.taxRules).toHaveLength(await prisma.taxRateRule.count());
    expect(source.entries).toHaveLength(await prisma.journalEntry.count());
    expect(source.fiscalYears.find((row) => row.id === year.id)?.statementSettings).toBeNull();

    // The seeded first year: the statements balance and agree with the trial balance.
    const first = source.fiscalYears.find((row) => row.no === SEED_FISCAL_YEAR.no);
    expect(first).toBeDefined();
    const report = buildFinancialStatements(source, first!.id);
    expect(report.empty).toBe(false);
    expect(report.checks.balanceSheetBalanced).toBe(true);
    expect(report.checks.netIncomeMatchesTrialBalance).toBe(true);
    expect(report.checks.equityMatchesBalanceSheet).toBe(true);
    expect(report.isFoundingYear).toBe(true);
    expect(report.openingBalanceSheet).not.toBeNull();
  });

  it("saves 決算書の設定 with only the changed keys in the audit log", async () => {
    const saved = await saveStatementSettings(
      prisma,
      year.id,
      {
        issuedShares: "１０,０００",
        shareholdersMeetingOn: "2062-05-28",
        announcementPublishedOn: "",
        notes: {
          depreciation: `  ${DEFAULT_DEPRECIATION_POLICY}\r\n  `,
          accountingPolicyChanges: "",
          otherNotes: [
            { title: "重要な後発事象", body: "該当事項はありません。" },
            { title: "", body: "" },
          ],
        },
        businessReport: { progress: "架空の事業を始めました。" },
        simplifiedTaxClass: "3",
      },
      { actor },
    );
    expect(saved.issuedShares).toBe(10000);
    expect(saved.shareholdersMeetingOn).toBe("2062-05-28");
    expect(saved.notes.depreciation).toBe(DEFAULT_DEPRECIATION_POLICY);
    // An empty text is kept as "" (left out on purpose); a text never sent stays null (雛形).
    expect(saved.notes.accountingPolicyChanges).toBe("");
    expect(saved.notes.revenueRecognition).toBeNull();
    expect(saved.notes.otherNotes).toEqual([
      { title: "重要な後発事象", body: "該当事項はありません。" },
    ]);
    expect(saved.simplifiedTaxClass).toBe(3);

    const row = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: year.id } });
    expect(row.statementSettings).toMatchObject({ issuedShares: 10000, simplifiedTaxClass: 3 });
    const source = await loadFinancialStatementsSource(prisma);
    expect(source.fiscalYears.find((fy) => fy.id === year.id)?.statementSettings).toEqual(saved);

    const audits = await statementAudits(year.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor, entity: "fiscal_year" });
    expect(audits[0]?.before).toEqual({
      issuedShares: null,
      shareholdersMeetingOn: null,
      simplifiedTaxClass: null,
      notes: { depreciation: null, accountingPolicyChanges: null, otherNotes: [] },
      businessReport: { progress: null },
    });
    expect(audits[0]?.after).toEqual({
      issuedShares: 10000,
      shareholdersMeetingOn: "2062-05-28",
      simplifiedTaxClass: 3,
      notes: {
        depreciation: DEFAULT_DEPRECIATION_POLICY,
        accountingPolicyChanges: "",
        otherNotes: [{ title: "重要な後発事象", body: "該当事項はありません。" }],
      },
      businessReport: { progress: "架空の事業を始めました。" },
    });

    // The same values again: nothing is written.
    await saveStatementSettings(prisma, year.id, { issuedShares: 10000 }, { actor });
    expect(await statementAudits(year.id)).toHaveLength(1);

    // A missing key keeps the stored value; null puts the 雛形 back.
    const next = await saveStatementSettings(
      prisma,
      year.id,
      { issuedShares: "12000", notes: { depreciation: null } },
      { actor },
    );
    expect(next.issuedShares).toBe(12000);
    expect(next.notes.depreciation).toBeNull();
    expect(next.notes.otherNotes).toHaveLength(1);
    expect(next.businessReport.progress).toBe("架空の事業を始めました。");
    const second = (await statementAudits(year.id))[1];
    expect(second?.before).toEqual({
      issuedShares: 10000,
      notes: { depreciation: DEFAULT_DEPRECIATION_POLICY },
    });
    expect(second?.after).toEqual({ issuedShares: 12000, notes: { depreciation: null } });
  });

  it("rejects malformed settings and dates that do not fit the year", async () => {
    const zodMessage = async (input: Parameters<typeof saveStatementSettings>[2]) => {
      const error = await rejectionOf(saveStatementSettings(prisma, year.id, input, { actor }));
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map((issue) => issue.message);
    };
    expect(await zodMessage({ issuedShares: "0" })).toEqual([
      "発行済株式の総数は 1 株以上の整数にしてください",
    ]);
    expect(await zodMessage({ issuedShares: "1万" })).toEqual([
      "発行済株式の総数は株数の整数で入力してください",
    ]);
    expect(await zodMessage({ shareholdersMeetingOn: "2062/05/28" })).toEqual([
      "株主総会の日は 2026-11-02 の形の日付にしてください",
    ]);
    expect(await zodMessage({ simplifiedTaxClass: "7" })).toEqual([
      "簡易課税の事業区分は第 1 種〜第 6 種から選んでください",
    ]);
    expect(await zodMessage({ announcementUrl: "example.com/koukoku" })).toEqual([
      "決算公告の URL は https:// から始まる形で入力してください",
    ]);
    expect(
      await zodMessage({ notes: { depreciation: "あ".repeat(STATEMENT_TEXT_MAX_LENGTH + 1) } }),
    ).toEqual([`固定資産の減価償却の方法は ${STATEMENT_TEXT_MAX_LENGTH} 文字以内にしてください`]);
    expect(await zodMessage({ notes: { otherNotes: [{ title: "", body: "内容だけ" }] } })).toEqual([
      "その他の注記の項目名を入力してください",
    ]);

    const beforeEnd = await rejectionOf(
      saveStatementSettings(prisma, year.id, { shareholdersMeetingOn: "2062-03-31" }, { actor }),
    );
    expect(beforeEnd).toBeInstanceOf(SettingsError);
    expect((beforeEnd as SettingsError).field).toBe("shareholdersMeetingOn");
    expect((beforeEnd as SettingsError).message).toBe(
      "株主総会の日は期末日（2062/03/31）より後の日にしてください",
    );
    const beforeMeeting = await rejectionOf(
      saveStatementSettings(
        prisma,
        year.id,
        { shareholdersMeetingOn: "2062-05-28", announcementPublishedOn: "2062-05-27" },
        { actor },
      ),
    );
    expect(beforeMeeting).toBeInstanceOf(SettingsError);
    expect((beforeMeeting as SettingsError).field).toBe("announcementPublishedOn");

    const missing = await rejectionOf(
      saveStatementSettings(prisma, "no-such-year", { issuedShares: 1 }, { actor }),
    );
    expect(missing).toBeInstanceOf(SettingsError);
  });

  it("tells whether 計算書類 and 財務諸表 CSV were downloaded for the year", async () => {
    const own = await createFiscalYear(prisma, {
      no: 62,
      startDate: "2062-04-01",
      endDate: "2063-03-31",
    });
    const range = { from: "2062-04-01", to: "2063-03-31" } as const;
    expect(await loadStatementsExportStatus(prisma, own.id)).toEqual({
      financialStatementsAt: null,
      etaxCsvAt: null,
      done: false,
    });
    // Another year's download does not count.
    await recordExport(
      prisma,
      { kind: "financial-statements", format: "pdf", fiscalYearNo: 63, ...range },
      { actor },
    );
    await recordExport(
      prisma,
      { kind: "financial-statements", format: "pdf", fiscalYearNo: 62, ...range },
      { actor },
    );
    const half = await loadStatementsExportStatus(prisma, own.id);
    expect(half.financialStatementsAt).toBeInstanceOf(Date);
    expect(half.etaxCsvAt).toBeNull();
    expect(half.done).toBe(false);
    await recordExport(
      prisma,
      { kind: "etax-csv", format: "zip", fiscalYearNo: 62, encoding: "sjis", ...range },
      { actor },
    );
    const done = await loadStatementsExportStatus(prisma, own.id);
    expect(done.etaxCsvAt).toBeInstanceOf(Date);
    expect(done.done).toBe(true);
  });

  it("checks and normalizes 勘定科目コード on 設定 › 勘定科目", async () => {
    const account = await createAccount(
      prisma,
      { code: "5497", name: "架空の通信費", kind: "expense", group: "sga" },
      { actor },
    );
    expect(account.eTaxCode).toBeNull();

    // Full-width input is stored half-width.
    const saved = await updateAccount(
      prisma,
      { id: account.id, eTaxCode: "１０ｅ２００１８０" },
      {
        actor,
      },
    );
    expect(saved.eTaxCode).toBe("10E200180");
    const source = await loadFinancialStatementsSource(prisma);
    expect(source.accounts.find((row) => row.id === account.id)?.eTaxCode).toBe("10E200180");

    const wrongSection = await rejectionOf(
      updateAccount(prisma, { id: account.id, eTaxCode: "10E300020" }, { actor }),
    );
    expect(wrongSection).toBeInstanceOf(SettingsError);
    expect((wrongSection as SettingsError).field).toBe("eTaxCode");
    expect((wrongSection as SettingsError).message).toContain(
      "科目の区分（販売費及び一般管理費）に合いません",
    );

    const otherStatement = await rejectionOf(
      updateAccount(prisma, { id: account.id, eTaxCode: "10A100020" }, { actor }),
    );
    expect((otherStatement as SettingsError).message).toContain("貸借対照表のコードです");
    const unknown = await rejectionOf(
      updateAccount(prisma, { id: account.id, eTaxCode: "10E999999" }, { actor }),
    );
    expect((unknown as SettingsError).message).toContain("コード表にありません");
    const branch = await rejectionOf(
      updateAccount(prisma, { id: account.id, eTaxCode: "10E200010-1" }, { actor }),
    );
    expect((branch as SettingsError).message).toContain("枝番");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).eTaxCode).toBe(
      "10E200180",
    );

    const reset = await updateAccount(prisma, { id: account.id, eTaxCode: "" }, { actor });
    expect(reset.eTaxCode).toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { entityId: account.id, action: "account.update" },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(audits.map((row) => (row.after as { eTaxCode: string | null }).eTaxCode)).toEqual([
      "10E200180",
      null,
    ]);
  });
});
