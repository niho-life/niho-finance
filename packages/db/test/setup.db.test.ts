import {
  assertSequence,
  assertTrialBalanceIdentity,
  CHART_TEMPLATE,
  STANDARD_SEGMENTS,
  STANDARD_TAX_RATE_RULES,
  TAX_CATEGORIES,
} from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  bootstrapStandardData,
  createCompany,
  createFirstFiscalYear,
  createNextFiscalYear,
  createWallets,
  getCompany,
  getSettingsSummary,
  getSetupProgress,
  listFiscalYears,
  listWallets,
  loadCashPosition,
  loadOpeningEntries,
  loadTrialBalance,
  postOpeningEntries,
  previewOpeningEntries,
  proposeFirstFiscalYear,
  SettingsError,
  skipSetupStep,
  updateCompany,
  updateFiscalYear,
  type CompanyInput,
  type OpeningInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber, rejectionOf } from "./support/fictional";
import { emptyTestPrisma } from "./support/prisma";

const actor = "owner@example.com";

/** What the owner types in Step 1 (form values are strings). Everything is fictional. */
const COMPANY: CompanyInput = {
  name: "架空商会株式会社",
  nameKana: "カクウショウカイ",
  representative: "代表取締役 架空 太郎",
  address: "東京都架空区見本町 1-2-3",
  foundedOn: "2026-11-02",
  fiscalYearEndMonth: "3",
  corporateNumber: "",
  invoiceRegistrationNumber: "",
  invoiceRegisteredOn: "",
};

function issues(error: unknown): Record<string, string> {
  expect(error).toBeInstanceOf(ZodError);
  return Object.fromEntries(
    (error as ZodError).issues.map((issue) => [issue.path.join("."), issue.message]),
  );
}

/**
 * The whole setup on an empty book, in order (one test depends on the previous ones):
 * 1 事業所 → 2 会計期間 → 3 勘定科目 → 4 口座 → 5 開始仕訳 → 完了.
 */
describe.skipIf(!hasTestDatabase)("setup wizard on an empty database", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = emptyTestPrisma();
  });

  async function auditCount(action: string): Promise<number> {
    return prisma.auditLog.count({ where: { action } });
  }

  it("starts at the company step", async () => {
    const progress = await getSetupProgress(prisma);
    expect(progress.current).toBe("company");
    expect(progress.ready).toBe(false);
    expect(await getCompany(prisma)).toBeNull();
  });

  it("Step 1 validates the company with owner-facing messages", async () => {
    const error = await rejectionOf(
      createCompany(
        prisma,
        {
          ...COMPANY,
          name: " ",
          foundedOn: "2026-02-30",
          fiscalYearEndMonth: "13",
          corporateNumber: "1999999999999",
        },
        { actor },
      ),
    );
    expect(issues(error)).toEqual({
      name: "商号を入力してください",
      foundedOn: "設立日は 2026-11-02 の形の日付にしてください",
      fiscalYearEndMonth: "決算月は 1〜12 にしてください",
      corporateNumber: "法人番号の検査用数字（先頭の 1 桁）が合いません。番号を確かめてください",
    });

    const mismatch = await rejectionOf(
      createCompany(
        prisma,
        {
          ...COMPANY,
          corporateNumber: fictionalCorporateNumber(),
          invoiceRegistrationNumber: `T${fictionalCorporateNumber("999999999998")}`,
        },
        { actor },
      ),
    );
    expect(Object.keys(issues(mismatch))).toEqual(["invoiceRegistrationNumber"]);
    expect(await prisma.company.count()).toBe(0);
  });

  it("Step 1 registers the company once, normalizing the numbers", async () => {
    const number = fictionalCorporateNumber();
    const company = await createCompany(
      prisma,
      {
        ...COMPANY,
        corporateNumber: `${number.slice(0, 4)}-${number.slice(4, 8)}-${number.slice(8)}`,
        invoiceRegistrationNumber: `t${number}`,
        invoiceRegisteredOn: "2026-11-02",
      },
      { actor },
    );
    expect(company).toMatchObject({
      name: "架空商会株式会社",
      foundedOn: "2026-11-02",
      fiscalYearEndMonth: 3,
      corporateNumber: number,
      invoiceRegistrationNumber: `T${number}`,
      invoiceRegisteredOn: "2026-11-02",
    });
    expect(await prisma.company.findFirstOrThrow()).toMatchObject({ fiscalYearStartMonth: 4 });
    expect((await getSetupProgress(prisma)).current).toBe("fiscal_year");
    expect(await auditCount("company.create")).toBe(1);

    await expect(createCompany(prisma, COMPANY, { actor })).rejects.toThrow(SettingsError);
    expect(await prisma.company.count()).toBe(1);
  });

  it("Step 1 can still change 決算月 before a fiscal year exists", async () => {
    const changed = await updateCompany(prisma, { ...COMPANY, fiscalYearEndMonth: 12 }, { actor });
    expect(changed.fiscalYearEndMonth).toBe(12);
    const restored = await updateCompany(prisma, COMPANY, { actor });
    expect(restored).toMatchObject({ fiscalYearEndMonth: 3, corporateNumber: null });
    expect(await auditCount("company.update")).toBe(2);
    // Saving the same values again writes nothing.
    await updateCompany(prisma, COMPANY, { actor });
    expect(await auditCount("company.update")).toBe(2);
  });

  it("Step 2 proposes 第 1 期 and checks the end date", async () => {
    const company = await getCompany(prisma);
    if (!company) throw new Error("company missing");
    expect(proposeFirstFiscalYear(company)).toEqual({
      startDate: "2026-11-02",
      endDate: "2027-03-31",
    });

    const wrongMonth = await rejectionOf(
      createFirstFiscalYear(prisma, { endDate: "2027-02-28", consumptionTax: "exempt" }, { actor }),
    );
    expect(wrongMonth).toBeInstanceOf(SettingsError);
    expect((wrongMonth as SettingsError).field).toBe("endDate");
    expect((wrongMonth as SettingsError).message).toContain("決算月（3 月）");

    const tooLong = await rejectionOf(
      createFirstFiscalYear(prisma, { endDate: "2028-03-31", consumptionTax: "exempt" }, { actor }),
    );
    expect((tooLong as SettingsError).message).toContain("1 年以内");
    expect(await prisma.fiscalYear.count()).toBe(0);
  });

  it("Step 2 creates 第 1 期; an exempt year is always tax-inclusive", async () => {
    const year = await createFirstFiscalYear(
      prisma,
      { endDate: "2027-03-31", consumptionTax: "exempt", accountingMethod: "tax_exclusive" },
      { actor },
    );
    expect(year).toMatchObject({
      no: 1,
      startDate: "2026-11-02",
      endDate: "2027-03-31",
      status: "open",
      consumptionTax: "exempt",
      accountingMethod: "tax_inclusive",
      entryCount: 0,
    });
    expect((await getSetupProgress(prisma)).current).toBe("accounts");
    await expect(
      createFirstFiscalYear(prisma, { endDate: "2027-03-31", consumptionTax: "exempt" }, { actor }),
    ).rejects.toThrow(SettingsError);
  });

  it("fixes the founding date and 決算月 once a fiscal year exists", async () => {
    const endMonth = await rejectionOf(
      updateCompany(prisma, { ...COMPANY, fiscalYearEndMonth: "12" }, { actor }),
    );
    expect(endMonth).toMatchObject({
      field: "fiscalYearEndMonth",
      message: "決算月は会計期間を作った後は変えられません",
    });
    const foundedOn = await rejectionOf(
      updateCompany(prisma, { ...COMPANY, foundedOn: "2026-11-05" }, { actor }),
    );
    expect(foundedOn).toMatchObject({ field: "foundedOn" });
    const renamed = await updateCompany(
      prisma,
      { ...COMPANY, representative: "代表取締役 架空 花子" },
      { actor },
    );
    expect(renamed.representative).toBe("代表取締役 架空 花子");
  });

  it("Step 3 creates the standard data once (idempotent)", async () => {
    const first = await bootstrapStandardData(prisma, { actor });
    expect(first).toEqual({
      taxCategories: TAX_CATEGORIES.length,
      taxRateRules: STANDARD_TAX_RATE_RULES.length,
      segments: STANDARD_SEGMENTS.length,
      accounts: CHART_TEMPLATE.length,
    });
    const second = await bootstrapStandardData(prisma, { actor });
    expect(second).toEqual({ taxCategories: 0, taxRateRules: 0, segments: 0, accounts: 0 });
    expect(await prisma.account.count()).toBe(CHART_TEMPLATE.length);
    expect(await prisma.subAccount.count()).toBe(0);
    expect(await auditCount("standard_data.bootstrap")).toBe(1);

    const revenue = await prisma.account.findUniqueOrThrow({
      where: { code: "4030" },
      include: { defaultSegment: true },
    });
    expect(revenue.defaultSegment?.code).toBe("platform");
    expect((await getSetupProgress(prisma)).current).toBe("wallets");
  });

  it("Step 4 can be postponed and resumed", async () => {
    const skipped = await skipSetupStep(prisma, "wallets", { actor });
    expect(skipped.current).toBe("opening");
    expect(skipped.skipped.wallets).toBe(true);
    expect(await auditCount("setup.skip")).toBe(1);
  });

  it("Step 4 rejects a bad row without creating any wallet", async () => {
    const other = await rejectionOf(
      createWallets(
        prisma,
        [
          { name: "架空銀行 普通", kind: "bank" },
          { name: "預け金", kind: "other" },
        ],
        { actor },
      ),
    );
    expect(other).toMatchObject({ field: "wallets.1.accountId" });
    const duplicate = await rejectionOf(
      createWallets(
        prisma,
        [
          { name: "架空銀行 普通", kind: "bank" },
          { name: "架空銀行 普通", kind: "bank" },
        ],
        { actor },
      ),
    );
    expect(duplicate).toMatchObject({ field: "wallets.1.name" });
    expect(await prisma.wallet.count()).toBe(0);
    expect(await prisma.subAccount.count()).toBe(0);
  });

  it("Step 4 links each wallet to the account of its kind with a sub-account of its name", async () => {
    const created = await createWallets(
      prisma,
      [
        { name: "架空銀行 普通", kind: "bank", openingBalance: "" },
        { name: "役員立替", kind: "owner" },
      ],
      { actor },
    );
    expect(created.map((wallet) => [wallet.accountCode, wallet.subAccountName])).toEqual([
      ["1100", "架空銀行 普通"],
      ["2400", "役員立替"],
    ]);
    expect(created[0]).toMatchObject({ openingBalance: null, openingBalanceDate: null });
    expect(await auditCount("wallet.create")).toBe(2);
    expect(await auditCount("sub_account.create")).toBe(2);
    const progress = await getSetupProgress(prisma);
    expect(progress.skipped.wallets).toBe(false);
    expect(progress.current).toBe("opening");
  });

  async function walletId(name: string): Promise<string> {
    const wallet = (await listWallets(prisma)).find((item) => item.name === name);
    if (!wallet) throw new Error(`wallet ${name} missing`);
    return wallet.id;
  }

  async function openingInput(): Promise<OpeningInput> {
    return {
      capital: { date: "2026-11-02", amount: "50,000", walletId: await walletId("架空銀行 普通") },
      formationCosts: [
        {
          description: "登録免許税",
          amount: "150,000",
          date: "2026-11-02",
          paidFromWalletId: await walletId("役員立替"),
          taxCategoryCode: "purchase_out",
        },
        {
          description: "定款認証",
          amount: "１５０００",
          date: "2026-11-02",
          paidFromWalletId: "",
          taxCategoryCode: "purchase_exempt",
        },
      ],
      startupCosts: [],
    };
  }

  it("Step 5 previews the entries and names the faulty field", async () => {
    const bank = await walletId("架空銀行 普通");
    const preview = await previewOpeningEntries(prisma, {
      ...(await openingInput()),
      startupCosts: [
        {
          description: "開業前の備品",
          amount: "3,300",
          date: "2026-12-01",
          paidFromWalletId: bank,
          taxCategoryCode: "purchase_10",
        },
      ],
    });
    expect(preview.entries.map((entry) => entry.description)).toEqual([
      "資本金の払込",
      "登録免許税",
      "定款認証",
      "開業前の備品",
    ]);
    expect(
      preview.entries.map((entry) =>
        entry.lines.map((item) => `${item.side} ${item.accountName} ${String(item.amount)}`),
      ),
    ).toEqual([
      ["debit 普通預金 50000", "credit 資本金 50000"],
      ["debit 創立費 150000", "credit 役員借入金 150000"],
      ["debit 創立費 15000", "credit 役員借入金 15000"],
      ["debit 開業費 3300", "credit 普通預金 3300"],
    ]);
    expect(preview.entries[0]?.lines[0]?.subAccountName).toBe("架空銀行 普通");
    expect(preview.entries[2]?.lines[1]?.subAccountName).toBeNull();
    expect(preview.debitTotal).toBe(218_300n);
    expect(preview.creditTotal).toBe(218_300n);
    expect(await prisma.journalEntry.count()).toBe(0);

    const base = await openingInput();
    const outside = await rejectionOf(
      previewOpeningEntries(prisma, {
        ...base,
        formationCosts: [{ ...base.formationCosts[0]!, date: "2026-10-01" }],
      }),
    );
    expect(outside).toMatchObject({ field: "formationCosts.0.date" });
    const unknownWallet = await rejectionOf(
      previewOpeningEntries(prisma, { ...base, capital: { ...base.capital, walletId: "missing" } }),
    );
    expect(unknownWallet).toMatchObject({ field: "capital.walletId" });
    const zero = await rejectionOf(
      previewOpeningEntries(prisma, {
        ...base,
        formationCosts: [{ ...base.formationCosts[0]!, amount: "0" }],
      }),
    );
    expect(issues(zero)).toEqual({ "formationCosts.0.amount": "金額は 1 円以上にしてください" });
  });

  it("Step 5 can be postponed, then registered later", async () => {
    const skipped = await skipSetupStep(prisma, "opening", { actor });
    expect(skipped.current).toBe("complete");
    expect(skipped.skipped.opening).toBe(true);
  });

  it("Step 5 registers the opening entries: 普通預金 50,000 / 資本金 50,000 and 創立費 / 役員借入金", async () => {
    const posted = await postOpeningEntries(prisma, await openingInput(), { actor });
    expect(posted.map((entry) => [entry.no, entry.kind, entry.sourceKind])).toEqual([
      [1, "opening", "system"],
      [2, "opening", "system"],
      [3, "opening", "system"],
    ]);
    const corporate = await prisma.segment.findUniqueOrThrow({ where: { code: "corporate" } });
    for (const entry of posted) {
      for (const item of entry.lines) expect(item.segmentId).toBe(corporate.id);
    }

    const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({ where: { no: 1 } });
    const tb = await loadTrialBalance(prisma, fiscalYear.id);
    expect(() => assertTrialBalanceIdentity(tb)).not.toThrow();
    const balances = Object.fromEntries(tb.rows.map((row) => [row.code, row.balance]));
    expect(balances).toEqual({
      "1100": 50_000n,
      "1700": 165_000n,
      "2400": 165_000n,
      "3000": 50_000n,
    });
    expect(tb.totals).toMatchObject({
      assets: 215_000n,
      liabilities: 165_000n,
      equity: 50_000n,
      netIncome: 0n,
    });
    assertSequence(await prisma.journalEntry.findMany({ select: { no: true } }));
    expect(await auditCount("journal_entry.post")).toBe(3);

    const progress = await getSetupProgress(prisma);
    expect(progress.current).toBe("complete");
    expect(progress.skipped.opening).toBe(false);
  });

  it("refuses a second registration of the opening entries", async () => {
    const error = await rejectionOf(postOpeningEntries(prisma, await openingInput(), { actor }));
    expect(error).toBeInstanceOf(SettingsError);
    expect(await prisma.journalEntry.count()).toBe(3);
    const registered = await loadOpeningEntries(prisma);
    expect(registered.entries.map((entry) => entry.no)).toEqual([1, 2, 3]);
    expect(registered.debitTotal).toBe(215_000n);
  });

  it("derives the cash position for the home", async () => {
    const cash = await loadCashPosition(prisma, "2026-11-30");
    expect(cash.total).toBe(50_000n);
    expect(cash.wallets.map((wallet) => [wallet.name, wallet.balance])).toEqual([
      ["架空銀行 普通", 50_000n],
    ]);
    expect((await loadCashPosition(prisma, "2026-11-01")).total).toBe(0n);
  });

  it("creates the next fiscal year and edits the consumption tax of a year", async () => {
    const year2 = await createNextFiscalYear(prisma, { consumptionTax: "general" }, { actor });
    expect(year2).toMatchObject({
      no: 2,
      startDate: "2027-04-01",
      endDate: "2028-03-31",
      consumptionTax: "general",
      accountingMethod: "tax_exclusive",
    });
    const exempt = await updateFiscalYear(
      prisma,
      { id: year2.id, consumptionTax: "exempt", accountingMethod: "tax_exclusive" },
      { actor },
    );
    expect(exempt.accountingMethod).toBe("tax_inclusive");
    const simplified = await updateFiscalYear(
      prisma,
      { id: year2.id, consumptionTax: "simplified", accountingMethod: "tax_inclusive" },
      { actor },
    );
    expect(simplified).toMatchObject({
      consumptionTax: "simplified",
      accountingMethod: "tax_inclusive",
    });
    const years = await listFiscalYears(prisma);
    expect(years.map((year) => [year.no, year.entryCount])).toEqual([
      [1, 3],
      [2, 0],
    ]);
    expect(await auditCount("fiscal_year.create")).toBe(2);
    expect(await auditCount("fiscal_year.update")).toBe(2);
  });

  it("summarizes the settings for the index", async () => {
    const summary = await getSettingsSummary(prisma, { today: "2026-12-01" });
    expect(summary).toEqual({
      companyName: "架空商会株式会社",
      fiscalYear: {
        no: 1,
        startDate: "2026-11-02",
        endDate: "2027-03-31",
        consumptionTax: "exempt",
      },
      counts: {
        accounts: CHART_TEMPLATE.length,
        taxCategories: TAX_CATEGORIES.length,
        wallets: 2,
        partners: 0,
        segments: STANDARD_SEGMENTS.length,
        memoTags: 0,
      },
    });
    expect((await getSettingsSummary(prisma, { today: "2027-05-01" })).fiscalYear?.no).toBe(2);
    expect((await getSettingsSummary(prisma, { today: "2026-10-01" })).fiscalYear?.no).toBe(1);
  });

  it("left an audit row for every write and none for reads", async () => {
    const actions = await prisma.auditLog.groupBy({
      by: ["action"],
      _count: { _all: true },
      orderBy: { action: "asc" },
    });
    expect(Object.fromEntries(actions.map((row) => [row.action, row._count._all]))).toEqual({
      "company.create": 1,
      "company.update": 3,
      "fiscal_year.create": 2,
      "fiscal_year.update": 2,
      "journal_entry.post": 3,
      "setup.skip": 2,
      "standard_data.bootstrap": 1,
      "sub_account.create": 2,
      "wallet.create": 2,
    });
    expect(await prisma.auditLog.count({ where: { actor: { not: actor } } })).toBe(0);
  });
});
