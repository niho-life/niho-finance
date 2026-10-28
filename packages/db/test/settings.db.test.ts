import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  bootstrapStandardData,
  createAccount,
  createMemoTag,
  createPartner,
  createSegment,
  createSubAccount,
  createTaxRateRule,
  createWallet,
  listAccounts,
  listPartners,
  listSegments,
  listSubAccounts,
  listTaxCategories,
  loadCashPosition,
  loadTrialBalance,
  setAccountActive,
  setMemoTagActive,
  setPartnerActive,
  setSegmentActive,
  setSubAccountActive,
  setTaxRateRuleEnabled,
  setWalletActive,
  SettingsError,
  updateAccount,
  updateMemoTag,
  updatePartner,
  updateSegment,
  updateSubAccount,
  updateWallet,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber, rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

/** Settings writes on the seeded book. Each test adds its own rows (other files share the database). */
describe.skipIf(!hasTestDatabase)("settings repository", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
  });

  async function actionsOf(entityId: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, actor: true },
    });
    for (const row of rows) expect(row.actor).toBe(actor);
    return rows.map((row) => row.action);
  }

  it("bootstrap adds nothing to a seeded book", async () => {
    const before = await prisma.auditLog.count();
    expect(await bootstrapStandardData(prisma, { actor })).toEqual({
      taxCategories: 0,
      taxRateRules: 0,
      segments: 0,
      accounts: 0,
    });
    expect(await prisma.auditLog.count()).toBe(before);
  });

  describe("accounts", () => {
    it("adds an account with the default tax category of its kind", async () => {
      const account = await createAccount(
        prisma,
        { code: "５４９１", name: "雑費 その他", kind: "expense", group: "sga" },
        { actor },
      );
      expect(account).toMatchObject({
        code: "5491",
        defaultTaxCategoryCode: "purchase_10",
        isActive: true,
        subAccountCount: 0,
      });
      const duplicate = await rejectionOf(
        createAccount(
          prisma,
          { code: "5491", name: "別", kind: "expense", group: "sga" },
          { actor },
        ),
      );
      expect(duplicate).toMatchObject({ field: "code" });
      expect((duplicate as SettingsError).message).toContain("雑費 その他");

      const mismatch = await rejectionOf(
        createAccount(prisma, { code: "1999", name: "x", kind: "asset", group: "sga" }, { actor }),
      );
      expect(mismatch).toBeInstanceOf(ZodError);
      const badCode = await rejectionOf(
        createAccount(
          prisma,
          { code: "12", name: "x", kind: "asset", group: "current_assets" },
          { actor },
        ),
      );
      expect((badCode as ZodError).issues[0]?.message).toBe("コードは 4 桁の数字です");
    });

    it("edits name, group, default tax category and cash flag in place", async () => {
      const account = (await listAccounts(prisma)).find((item) => item.code === "5491");
      if (!account) throw new Error("5491 missing");
      const updated = await updateAccount(
        prisma,
        { id: account.id, name: "雑費（少額）", defaultTaxCategoryCode: "purchase_8r" },
        { actor },
      );
      expect(updated).toMatchObject({
        name: "雑費（少額）",
        defaultTaxCategoryCode: "purchase_8r",
      });
      await expect(
        updateAccount(prisma, { id: account.id, group: "current_assets" }, { actor }),
      ).rejects.toMatchObject({ field: "group" });
      await expect(
        updateAccount(prisma, { id: account.id, isCashLike: true }, { actor }),
      ).rejects.toMatchObject({ field: "isCashLike" });
      const cleared = await updateAccount(
        prisma,
        { id: account.id, defaultTaxCategoryCode: "" },
        { actor },
      );
      expect(cleared.defaultTaxCategoryCode).toBeNull();
      expect(await actionsOf(account.id)).toEqual([
        "account.create",
        "account.update",
        "account.update",
      ]);
    });

    it("deactivates an account unless an active wallet posts to it", async () => {
      await expect(
        setAccountActive(prisma, { id: refs.account("1100"), isActive: false }, { actor }),
      ).rejects.toThrow(/架空銀行 普通/);
      const account = (await listAccounts(prisma)).find((item) => item.code === "5491");
      if (!account) throw new Error("5491 missing");
      expect(
        (await setAccountActive(prisma, { id: account.id, isActive: false }, { actor })).isActive,
      ).toBe(false);
      expect(
        (await setAccountActive(prisma, { id: account.id, isActive: "true" }, { actor })).isActive,
      ).toBe(true);
      expect((await actionsOf(account.id)).slice(-2)).toEqual([
        "account.deactivate",
        "account.activate",
      ]);
    });

    it("keeps sub-accounts of wallets tied to the wallet", async () => {
      const receivable = refs.account("1200");
      const sub = await createSubAccount(
        prisma,
        { accountId: receivable, name: "架空デザイン合同会社" },
        { actor },
      );
      await expect(
        createSubAccount(
          prisma,
          { accountId: receivable, name: "架空デザイン合同会社" },
          { actor },
        ),
      ).rejects.toMatchObject({ field: "name" });
      const renamed = await updateSubAccount(
        prisma,
        { id: sub.id, name: "架空デザイン" },
        { actor },
      );
      expect(renamed.name).toBe("架空デザイン");
      expect(
        (await setSubAccountActive(prisma, { id: sub.id, isActive: false }, { actor })).isActive,
      ).toBe(false);

      const walletSub = refs.subAccount("架空銀行 普通");
      await expect(
        updateSubAccount(prisma, { id: walletSub, name: "改名" }, { actor }),
      ).rejects.toThrow(/口座/);
      await expect(
        setSubAccountActive(prisma, { id: walletSub, isActive: false }, { actor }),
      ).rejects.toThrow(SettingsError);
      const list = await listSubAccounts(prisma, refs.account("1100"));
      expect(list.find((item) => item.id === walletSub)?.walletName).toBe("架空銀行 普通");
      expect(await actionsOf(sub.id)).toEqual([
        "sub_account.create",
        "sub_account.update",
        "sub_account.deactivate",
      ]);
    });
  });

  describe("tax rate rules", () => {
    it("shows the rule in force today", async () => {
      const categories = await listTaxCategories(prisma, { on: "2026-11-15" });
      const byCode = new Map(categories.map((category) => [category.code, category]));
      expect(byCode.get("purchase_10_ni")?.current).toMatchObject({
        ratePercent: 10,
        deductiblePercent: 70,
      });
      expect(byCode.get("sales_8r")?.current?.ratePercent).toBe(8);
      expect(byCode.get("sales_8r")?.rules.some((rule) => !rule.enabled)).toBe(true);
    });

    it("adds rules, checks the deductible ratio and refuses ambiguous periods", async () => {
      await expect(
        createTaxRateRule(
          prisma,
          { taxCategoryCode: "purchase_8r", effectiveFrom: "2031-01-01", ratePercent: "8" },
          { actor },
        ),
      ).rejects.toMatchObject({ field: "deductiblePercent" });
      await expect(
        createTaxRateRule(
          prisma,
          {
            taxCategoryCode: "sales_10",
            effectiveFrom: "2031-01-01",
            ratePercent: "10",
            deductiblePercent: "100",
          },
          { actor },
        ),
      ).rejects.toMatchObject({ field: "deductiblePercent" });
      await expect(
        createTaxRateRule(
          prisma,
          { taxCategoryCode: "sales_exempt", effectiveFrom: "2031-01-01", ratePercent: "5" },
          { actor },
        ),
      ).rejects.toMatchObject({ field: "ratePercent" });

      const first = await createTaxRateRule(
        prisma,
        {
          taxCategoryCode: "purchase_8r",
          effectiveFrom: "2031-01-01",
          ratePercent: "8",
          deductiblePercent: "100",
          note: "テスト",
        },
        { actor },
      );
      expect(first).toMatchObject({ enabled: true, effectiveTo: null, note: "テスト" });
      const ambiguous = {
        taxCategoryCode: "purchase_8r",
        effectiveFrom: "2031-01-01",
        ratePercent: "10",
        deductiblePercent: "100",
      };
      await expect(createTaxRateRule(prisma, ambiguous, { actor })).rejects.toThrow(/同じ適用期間/);
      await expect(
        createTaxRateRule(
          prisma,
          { ...ambiguous, ratePercent: "8", effectiveTo: "2031-12-31" },
          { actor },
        ),
      ).rejects.toMatchObject({ field: "effectiveFrom" });

      await setTaxRateRuleEnabled(prisma, { id: first.id, enabled: false }, { actor });
      const second = await createTaxRateRule(prisma, ambiguous, { actor });
      await expect(
        setTaxRateRuleEnabled(prisma, { id: first.id, enabled: true }, { actor }),
      ).rejects.toThrow(SettingsError);
      await setTaxRateRuleEnabled(prisma, { id: second.id, enabled: false }, { actor });
      expect(await actionsOf(first.id)).toEqual(["tax_rate_rule.create", "tax_rate_rule.disable"]);
      expect(await actionsOf(second.id)).toEqual(["tax_rate_rule.create", "tax_rate_rule.disable"]);
    });
  });

  describe("wallets", () => {
    it("adds a wallet with an opening balance dated on the founding date", async () => {
      const wallet = await createWallet(
        prisma,
        { name: "架空信用金庫 普通", kind: "bank", openingBalance: "12,000", note: "予備" },
        { actor },
      );
      expect(wallet).toMatchObject({
        accountCode: "1100",
        subAccountName: "架空信用金庫 普通",
        openingBalance: 12_000n,
        openingBalanceDate: "2026-11-02",
        note: "予備",
      });

      await expect(
        createWallet(prisma, { name: "預け金", kind: "other" }, { actor }),
      ).rejects.toMatchObject({ field: "accountId" });
      await expect(
        createWallet(
          prisma,
          { name: "経費", kind: "other", accountId: refs.account("5400") },
          { actor },
        ),
      ).rejects.toThrow(/資産か負債/);
      await expect(
        createWallet(prisma, { name: "架空銀行 普通", kind: "bank" }, { actor }),
      ).rejects.toMatchObject({ field: "name" });
    });

    it("renames and moves a wallet's sub-account, unless journal lines use it", async () => {
      const wallets = await prisma.wallet.findMany();
      const seeded = wallets.find((item) => item.name === "架空銀行 普通");
      const added = wallets.find((item) => item.name === "架空信用金庫 普通");
      if (!seeded || !added) throw new Error("wallets missing");

      await expect(
        updateWallet(prisma, { id: seeded.id, accountId: refs.account("1000") }, { actor }),
      ).rejects.toMatchObject({ field: "accountId" });

      const moved = await updateWallet(
        prisma,
        { id: added.id, name: "架空信用金庫 当座", kind: "cash", accountId: refs.account("1000") },
        { actor },
      );
      expect(moved).toMatchObject({
        name: "架空信用金庫 当座",
        kind: "cash",
        accountCode: "1000",
        subAccountName: "架空信用金庫 当座",
        subAccountId: added.subAccountId,
      });
      const cleared = await updateWallet(prisma, { id: added.id, openingBalance: "" }, { actor });
      expect(cleared).toMatchObject({ openingBalance: null, openingBalanceDate: null });
      await updateWallet(prisma, { id: added.id, openingBalance: "-500" }, { actor });

      const inactive = await setWalletActive(prisma, { id: added.id, isActive: false }, { actor });
      expect(inactive.isActive).toBe(false);
      const sub = await prisma.subAccount.findUniqueOrThrow({
        where: { id: added.subAccountId ?? "" },
      });
      expect(sub).toMatchObject({ isActive: false, accountId: refs.account("1000") });
      expect(await actionsOf(added.id)).toEqual([
        "wallet.create",
        "wallet.update",
        "wallet.update",
        "wallet.update",
        "wallet.deactivate",
      ]);
    });

    it("keeps a wallet's statement opening balance out of the cash position", async () => {
      const wallet = await createWallet(
        prisma,
        {
          name: "架空ネット銀行",
          kind: "bank",
          openingBalance: "7,000",
          openingBalanceDate: "2026-12-01",
        },
        { actor },
      );
      const tb = await loadTrialBalance(prisma, refs.fiscalYear1.id, { asOf: "2026-12-31" });
      const cashAccounts = new Set([
        refs.account("1000"),
        refs.account("1100"),
        refs.account("1150"),
      ]);
      const journalCash = tb.rows
        .filter((row) => cashAccounts.has(row.accountId))
        .reduce((sum, row) => sum + row.balance, 0n);
      // The home agrees with the trial balance: the opening balance is for reconciliation (S4).
      expect((await loadCashPosition(prisma, "2026-12-31")).total).toBe(journalCash);
      expect(
        (await loadCashPosition(prisma, "2026-12-31")).wallets.find((w) => w.id === wallet.id),
      ).toMatchObject({ balance: 0n });
      await setWalletActive(prisma, { id: wallet.id, isActive: false }, { actor });
    });
  });

  describe("partners", () => {
    it("adds partners with a verified registration number and finds them", async () => {
      const number = fictionalCorporateNumber();
      const partner = await createPartner(
        prisma,
        {
          name: "架空印刷株式会社",
          nameKana: "カクウインサツ",
          kind: "vendor",
          invoiceRegistrationNumber: `t${number.slice(0, 1)}-${number.slice(1)}`,
          defaultAccountId: refs.account("5330"),
          defaultSegmentId: refs.segment("kamakura"),
          defaultTaxCategoryCode: "purchase_10",
        },
        { actor },
      );
      expect(partner.invoiceRegistrationNumber).toBe(`T${number}`);
      const invalid = await rejectionOf(
        createPartner(
          prisma,
          { name: "架空工房", kind: "vendor", invoiceRegistrationNumber: "T1999999999999" },
          { actor },
        ),
      );
      expect((invalid as ZodError).issues[0]?.message).toContain("検査用数字");
      expect((await listPartners(prisma, { query: "いんさつ" })).length).toBe(0);
      expect((await listPartners(prisma, { query: "印刷" })).map((item) => item.id)).toEqual([
        partner.id,
      ]);
      expect((await listPartners(prisma, { query: number })).map((item) => item.id)).toEqual([
        partner.id,
      ]);

      const updated = await updatePartner(
        prisma,
        { id: partner.id, kind: "both", invoiceRegistrationNumber: "" },
        { actor },
      );
      expect(updated).toMatchObject({ kind: "both", invoiceRegistrationNumber: null });
      await setPartnerActive(prisma, { id: partner.id, isActive: false }, { actor });
      expect(await actionsOf(partner.id)).toEqual([
        "partner.create",
        "partner.update",
        "partner.deactivate",
      ]);
    });
  });

  describe("segments and tags", () => {
    it("keeps the 4 standard segments", async () => {
      const segment = await createSegment(prisma, { code: "hayama", name: "葉山" }, { actor });
      expect(segment).toMatchObject({ isStandard: false });
      const order = (await listSegments(prisma)).map((item) => item.code);
      expect(order.indexOf("hayama")).toBeLessThan(order.indexOf("corporate"));
      await expect(
        createSegment(prisma, { code: "hayama", name: "別" }, { actor }),
      ).rejects.toMatchObject({ field: "code" });
      await expect(
        createSegment(prisma, { code: "葉山", name: "葉山" }, { actor }),
      ).rejects.toThrow(ZodError);

      const corporate = refs.segment("corporate");
      await expect(
        updateSegment(prisma, { id: corporate, code: "common" }, { actor }),
      ).rejects.toMatchObject({ field: "code" });
      await expect(
        setSegmentActive(prisma, { id: corporate, isActive: false }, { actor }),
      ).rejects.toThrow("標準のセグメントは無効にできません");
      expect(
        (await updateSegment(prisma, { id: segment.id, name: "葉山拠点" }, { actor })).name,
      ).toBe("葉山拠点");
      expect(
        (await setSegmentActive(prisma, { id: segment.id, isActive: false }, { actor })).isActive,
      ).toBe(false);
      expect(await actionsOf(segment.id)).toEqual([
        "segment.create",
        "segment.update",
        "segment.deactivate",
      ]);
    });

    it("adds, renames and deactivates tags", async () => {
      const tag = await createMemoTag(prisma, { name: "出張" }, { actor });
      await expect(createMemoTag(prisma, { name: "設立" }, { actor })).rejects.toMatchObject({
        field: "name",
      });
      expect(
        (await updateMemoTag(prisma, { id: tag.id, name: "出張（国内）" }, { actor })).name,
      ).toBe("出張（国内）");
      await setMemoTagActive(prisma, { id: tag.id, isActive: false }, { actor });
      expect(await actionsOf(tag.id)).toEqual([
        "memo_tag.create",
        "memo_tag.update",
        "memo_tag.deactivate",
      ]);
    });
  });
});
