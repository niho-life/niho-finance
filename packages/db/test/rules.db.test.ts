import type { CalendarDate } from "@niho-finance/ledger";
import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  applyRuleToPending,
  countActiveRules,
  countRuleMatches,
  createRule,
  createWallet,
  describeAuditTargets,
  getRule,
  listRules,
  setRuleActive,
  toDbDate,
  updateRule,
  type RuleCreateInput,
  type WalletSettings,
} from "../src";
import { SettingsError } from "../src/errors";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

function zodIssues(error: unknown) {
  expect(error).toBeInstanceOf(ZodError);
  return (error as ZodError).issues.map((issue) => [issue.path.join("."), issue.message]);
}

/**
 * 設定 › ルール (15-statements §10). The rules here are tied to wallets of this file, so that they
 * never match the seeded lines or the lines of the other files.
 */
describe.skipIf(!hasTestDatabase)("rules (ルール)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let bank: WalletSettings;
  let cash: WalletSettings;
  let realtyId: string;
  let lineNo = 0;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    await createFiscalYear(prisma, {
      no: 65,
      startDate: "2065-04-01",
      endDate: "2066-03-31",
      lockedThrough: "2065-04-30",
    });
    bank = await createWallet(prisma, { name: "ルールテスト銀行", kind: "bank" }, { actor });
    cash = await createWallet(prisma, { name: "ルールテスト現金", kind: "cash" }, { actor });
    realtyId = (await prisma.partner.findFirstOrThrow({ where: { name: "架空不動産株式会社" } }))
      .id;
  });

  async function addLine(
    wallet: { id: string },
    txnDate: CalendarDate,
    amount: bigint,
    descriptionRaw: string,
  ): Promise<string> {
    lineNo += 1;
    const row = await prisma.walletTransaction.create({
      data: {
        id: `01RULE${String(lineNo).padStart(20, "0")}`,
        walletId: wallet.id,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw,
        externalId: `test-rules-${lineNo}`,
      },
    });
    return row.id;
  }

  const rent = (overrides: Partial<RuleCreateInput> = {}): RuleCreateInput => ({
    name: "",
    walletId: bank.id,
    match: {
      descriptionContains: "ルールテスト家賃",
      sign: "out",
      amountMin: "50,000",
      amountMax: "100,000",
    },
    action: {
      mode: "register",
      accountId: refs.account("5300"),
      taxCategoryCode: "purchase_10",
      partnerId: realtyId,
      segmentId: refs.segment("kamakura"),
    },
    autoPost: "on",
    priority: "5",
    ...overrides,
  });

  async function actionsOf(id: string) {
    const rows = await prisma.auditLog.findMany({
      where: { entity: "rule", entityId: id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true },
    });
    return rows.map((row) => row.action);
  }

  it("creates, updates, deactivates and activates a rule, with the audit log", async () => {
    const activeBefore = await countActiveRules(prisma);
    const created = await createRule(prisma, rent(), { actor });
    expect(created).toMatchObject({
      name: null,
      displayName: "摘要に「ルールテスト家賃」 · 出金 · 50,000〜100,000",
      walletId: bank.id,
      walletName: "ルールテスト銀行",
      matchSummary: "摘要に「ルールテスト家賃」 · 出金 · 50,000〜100,000",
      actionSummary: "登録: 地代家賃 / 課税仕入 10% / 架空不動産株式会社 / 鎌倉",
      match: { amountMin: 50_000n, amountMax: 100_000n, sign: "out", descriptionRegex: null },
      autoPost: true,
      priority: 5,
      hitCount: 0,
      lastHitAt: null,
      isActive: true,
      valid: true,
    });
    const stored = await prisma.rule.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.match).toMatchObject({ amountMin: "50000", amountMax: "100000" });
    expect(await countActiveRules(prisma)).toBe(activeBefore + 1);

    const renamed = await updateRule(
      prisma,
      created.id,
      { name: "家賃テスト", priority: "-3" },
      { actor },
    );
    expect(renamed).toMatchObject({ name: "家賃テスト", displayName: "家賃テスト", priority: -3 });
    expect(renamed.match).toEqual(created.match);
    // A 候補 rule never posts by itself.
    const hint = await updateRule(
      prisma,
      created.id,
      { action: { mode: "suggest", accountId: refs.account("5300") } },
      { actor },
    );
    expect(hint).toMatchObject({ autoPost: false, actionSummary: "候補: 地代家賃" });
    // Nothing changed: no audit row.
    await updateRule(prisma, created.id, { name: "家賃テスト" }, { actor });
    expect((await setRuleActive(prisma, created.id, false, { actor })).isActive).toBe(false);
    expect((await setRuleActive(prisma, created.id, true, { actor })).isActive).toBe(true);
    expect(await actionsOf(created.id)).toEqual([
      "rule.create",
      "rule.update",
      "rule.update",
      "rule.deactivate",
      "rule.activate",
    ]);
    expect(await getRule(prisma, created.id)).toMatchObject({ name: "家賃テスト", priority: -3 });
    const targets = await describeAuditTargets(prisma, [{ entity: "rule", entityId: created.id }]);
    expect(targets.get(`rule:${created.id}`)).toBe("ルール 家賃テスト");
    const listed = await listRules(prisma);
    expect(listed.some((rule) => rule.id === created.id)).toBe(true);
    const priorities = listed.map((rule) => rule.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  });

  it("names the field of every invalid rule", async () => {
    const issues = async (input: RuleCreateInput) =>
      zodIssues(await rejectionOf(createRule(prisma, input, { actor })));
    expect(await issues(rent({ match: {} }))).toEqual([
      ["match.descriptionContains", "条件を 1 つ以上入れてください"],
    ]);
    expect(await issues(rent({ match: { descriptionRegex: "(" } }))).toEqual([
      ["match.descriptionRegex", "正規表現が正しくありません"],
    ]);
    expect(await issues(rent({ match: { amountMin: "2,000", amountMax: "1,000" } }))).toEqual([
      ["match.amountMax", "金額の上限は下限以上にしてください"],
    ]);
    expect(
      await issues(rent({ action: { mode: "register", taxCategoryCode: "purchase_10" } })),
    ).toEqual([["action.accountId", "科目を選んでください"]]);
    expect(await issues(rent({ action: { mode: "transfer" } }))).toEqual([
      ["action.transferToWalletId", "相手口座を選んでください"],
    ]);
    expect(await issues(rent({ action: { mode: "suggest" } }))).toEqual([
      ["action.accountId", "科目・税区分・取引先・セグメントのどれかを入れてください"],
    ]);
    expect(await issues(rent({ priority: "101" }))).toEqual([
      ["priority", "優先度は -100〜100 にしてください"],
    ]);

    const settings = async (input: RuleCreateInput) => {
      const error = await rejectionOf(createRule(prisma, input, { actor }));
      expect(error).toBeInstanceOf(SettingsError);
      return error as SettingsError;
    };
    const reserved = await settings(
      rent({
        action: { mode: "register", accountId: refs.account("1100"), taxCategoryCode: "na" },
      }),
    );
    expect(reserved).toMatchObject({ field: "action.accountId" });
    expect(reserved.message).toContain("口座どうしの移動は動作を振替にしてください");
    const direction = await settings(
      rent({ match: { descriptionContains: "ルールテスト", sign: "in" } }),
    );
    expect(direction).toMatchObject({ field: "action.accountId" });
    expect(direction.message).toContain("入金には使えません");
    expect(
      await settings(rent({ action: { mode: "transfer", transferToWalletId: bank.id } })),
    ).toMatchObject({ field: "action.transferToWalletId" });
    expect(
      await settings(
        rent({ action: { mode: "register", accountId: "01MISSING", taxCategoryCode: "na" } }),
      ),
    ).toMatchObject({ field: "action.accountId" });
    expect(await settings(rent({ walletId: "01MISSING" }))).toMatchObject({ field: "walletId" });
  });

  it("counts the pending lines the conditions match, with the totals in and out", async () => {
    await addLine(bank, "2065-05-01", -60_000n, "ルールテスト照合 A");
    await addLine(bank, "2065-05-02", -120_000n, "ルールテスト照合 B");
    await addLine(bank, "2065-05-03", 70_000n, "ルールテスト照合 C");
    await addLine(cash, "2065-05-04", -80_000n, "ルールテスト照合 D");
    expect(
      await countRuleMatches(prisma, {
        walletId: bank.id,
        match: { descriptionContains: "ルールテスト照合", sign: "out" },
      }),
    ).toEqual({ count: 2, inflow: 0n, outflow: 180_000n });
    expect(
      await countRuleMatches(prisma, {
        walletId: bank.id,
        match: { descriptionContains: "ﾙｰﾙﾃｽﾄ照合", sign: "out", amountMax: "100,000" },
      }),
    ).toEqual({ count: 1, inflow: 0n, outflow: 60_000n });
    expect(
      await countRuleMatches(prisma, {
        walletId: "",
        match: { descriptionContains: "ルールテスト照合" },
      }),
    ).toEqual({ count: 4, inflow: 70_000n, outflow: 260_000n });
    expect(await countRuleMatches(prisma, { walletId: bank.id, match: {} })).toEqual({
      count: 0,
      inflow: 0n,
      outflow: 0n,
    });
  });

  it("applies a rule to the pending lines it wins, leaving refusals pending", async () => {
    const register = await createRule(
      prisma,
      {
        name: "ルールテスト適用",
        walletId: bank.id,
        match: { descriptionContains: "ルールテスト適用", sign: "out" },
        action: {
          mode: "register",
          accountId: refs.account("5400"),
          taxCategoryCode: "purchase_10",
          segmentId: refs.segment("corporate"),
        },
        priority: "10",
      },
      { actor },
    );
    const ignore = await createRule(
      prisma,
      {
        name: "ルールテスト私用",
        walletId: bank.id,
        match: { descriptionContains: "ルールテスト適用 私用" },
        action: { mode: "ignore", ignoredReason: "私用" },
        priority: "20",
      },
      { actor },
    );
    const suggestOnly = await createRule(
      prisma,
      {
        walletId: bank.id,
        match: { descriptionContains: "ルールテスト適用" },
        action: { mode: "suggest", segmentId: refs.segment("corporate") },
        priority: "-10",
      },
      { actor },
    );
    const won = await addLine(bank, "2065-06-01", -1_100n, "ルールテスト適用 1");
    const other = await addLine(bank, "2065-06-02", -2_200n, "ルールテスト適用 私用");
    const closed = await addLine(bank, "2065-04-20", -3_300n, "ルールテスト適用 締め");

    const result = await applyRuleToPending(prisma, register.id, { actor });
    expect(result).toMatchObject({ registered: 1, transferred: 0, ignored: 0 });
    expect(result.failed).toEqual([
      { id: closed, message: expect.stringContaining("2065/04/30 までは締めています") as string },
    ]);
    expect(await prisma.walletTransaction.findUniqueOrThrow({ where: { id: won } })).toMatchObject({
      status: "registered",
      autoPosted: true,
      ruleId: register.id,
    });
    expect(
      (await prisma.walletTransaction.findUniqueOrThrow({ where: { id: other } })).status,
    ).toBe("pending");
    expect(
      (await prisma.walletTransaction.findUniqueOrThrow({ where: { id: closed } })).suggestion,
    ).toMatchObject({
      ruleId: register.id,
      error: expect.stringContaining("締めています") as string,
    });
    expect(await getRule(prisma, register.id)).toMatchObject({ hitCount: 1 });
    const applied = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "rule", entityId: register.id, action: "rule.apply" },
    });
    expect(applied.after).toEqual({ registered: 1, transferred: 0, ignored: 0, failed: 1 });

    expect(await applyRuleToPending(prisma, ignore.id, { actor })).toEqual({
      registered: 0,
      transferred: 0,
      ignored: 1,
      failed: [],
    });
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({ where: { id: other } }),
    ).toMatchObject({ status: "ignored", ignoredReason: "私用", autoPosted: true });

    expect(await applyRuleToPending(prisma, suggestOnly.id, { actor })).toEqual({
      registered: 0,
      transferred: 0,
      ignored: 0,
      failed: [],
    });
    await setRuleActive(prisma, suggestOnly.id, false, { actor });
    expect(await rejectionOf(applyRuleToPending(prisma, suggestOnly.id, { actor }))).toBeInstanceOf(
      SettingsError,
    );
  });
});
