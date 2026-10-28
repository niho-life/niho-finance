import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  disposeFixedAsset,
  getFixedAssetDetail,
  getJournalEntryDetail,
  listAcquisitionCandidates,
  listFixedAssets,
  loadFixedAssetLedger,
  postDepreciation,
  postSimpleEntry,
  registerFixedAsset,
  SettingsError,
  startYearEnd,
  updateFixedAsset,
  voidFixedAsset,
  voidYearEndEntry,
  type FixedAssetRegisterInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}

/** 固定資産台帳: registration, edits, the special measure's cap, disposal and sale (#14 §5). */
describe.skipIf(!hasTestDatabase)("fixed assets (固定資産台帳)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 70 期: 2070-04-01 – 2071-03-31 (免税・税込). */
  let year: FiscalYear;
  /** 第 71 期: 2071-04-01 – 2072-03-31. */
  let nextYear: FiscalYear;
  /**
   * 第 81 期: 2026-01-01 – 2026-03-31 (3 か月・課税・税抜). The special measure ends with acquisitions on
   * 2029-03-31, and the test book's years from 2026-11-02 belong to other tests: the free months
   * before the seeded first year host it (limit 300,000 before 2026-04-01).
   */
  let shortYear: FiscalYear;
  let bank: string;
  let acquisition: string;
  const ids: Record<"A" | "B" | "C" | "D" | "E", string> = { A: "", B: "", C: "", D: "", E: "" };

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    year = await createFiscalYear(prisma, {
      no: 70,
      startDate: "2070-04-01",
      endDate: "2071-03-31",
    });
    nextYear = await createFiscalYear(prisma, {
      no: 71,
      startDate: "2071-04-01",
      endDate: "2072-03-31",
    });
    shortYear = await createFiscalYear(prisma, {
      no: 81,
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    bank = (await prisma.wallet.findFirstOrThrow({ where: { name: "架空銀行 普通" } })).id;
  });

  const purchase = (overrides: Record<string, unknown>): FixedAssetRegisterInput => ({
    source: "purchase",
    counterpart: `wallet:${bank}`,
    entryDate: "2070-04-01",
    amount: "1,000,000",
    taxCategoryCode: "purchase_10",
    accountId: refs.account("1500"),
    name: "内装",
    method: "straight_line",
    usefulLifeYears: "5",
    segmentId: "",
    note: "",
    ...overrides,
  });

  const fromEntry = (overrides: Record<string, unknown>): FixedAssetRegisterInput => ({
    source: "entry",
    entryId: acquisition,
    accountId: refs.account("1510"),
    cost: "98,000",
    name: "プリンタ",
    method: "immediate",
    usefulLifeYears: "",
    segmentId: "",
    note: "",
    ...overrides,
  });

  async function candidate() {
    return (await listAcquisitionCandidates(prisma)).find(
      (row) => row.entryId === acquisition && row.accountId === refs.account("1510"),
    );
  }

  async function entryCount(fiscalYearId: string) {
    return prisma.journalEntry.count({ where: { fiscalYearId } });
  }

  async function lines(entryId: string) {
    const detail = await getJournalEntryDetail(prisma, entryId);
    return detail?.lines.map((line) => [line.side, line.accountCode, line.amount]);
  }

  it("registers from an acquisition entry, up to what is not registered yet", async () => {
    acquisition = (
      await postSimpleEntry(
        prisma,
        {
          type: "expense",
          entryDate: "2070-04-10",
          description: "プリンタとノート PC",
          counterpart: `wallet:${bank}`,
          accountId: refs.account("1510"),
          amount: "298,000",
          taxCategoryCode: "purchase_10",
          segmentId: refs.segment("corporate"),
          partnerId: "",
          memoTagIds: [],
        },
        { actor },
      )
    ).id;
    expect(await candidate()).toMatchObject({
      entryDate: "2070-04-10",
      fiscalYearNo: 70,
      accountCode: "1510",
      amount: 298_000n,
      registered: 0n,
      remaining: 298_000n,
    });

    const a = await registerFixedAsset(prisma, fromEntry({}), { actor });
    ids.A = a.id;
    expect(a.acquisitionEntry?.id).toBe(acquisition);
    expect(await candidate()).toMatchObject({ registered: 98_000n, remaining: 200_000n });
    expect(
      settingsError(
        await rejectionOf(registerFixedAsset(prisma, fromEntry({ cost: "250,000" }), { actor })),
      ),
    ).toEqual({ message: "取得価額は仕訳の残りの額 200,000 円までにしてください", field: "cost" });
    expect(
      settingsError(
        await rejectionOf(
          registerFixedAsset(prisma, fromEntry({ accountId: refs.account("1520") }), { actor }),
        ),
      ).field,
    ).toBe("accountId");

    ids.B = (
      await registerFixedAsset(
        prisma,
        fromEntry({
          cost: "200,000",
          name: "ノート PC",
          method: "declining_balance",
          usefulLifeYears: "4",
        }),
        { actor },
      )
    ).id;
    expect(await candidate()).toBeUndefined();

    const detail = await getFixedAssetDetail(prisma, ids.A, { today: "2070-06-01" });
    expect(detail).toMatchObject({
      acquisitionDate: "2070-04-10",
      cost: 98_000n,
      method: "immediate",
      usefulLifeYears: null,
      residualValue: 0n,
      isSpecialSmallAsset: false,
      isDepreciableAssetTaxed: false,
      status: "active",
      canEditParameters: true,
      segmentId: refs.segment("corporate"),
    });
    expect(detail?.history.map((row) => row.action)).toEqual(["fixed_asset.create"]);
  });

  it("registers together with the purchase, and checks the method against the asset", async () => {
    const before = await entryCount(year.id);
    const d = await registerFixedAsset(prisma, purchase({}), { actor });
    ids.D = d.id;
    ids.E = (
      await registerFixedAsset(
        prisma,
        purchase({ accountId: refs.account("1520"), amount: "500,000", name: "会員管理ソフト" }),
        { actor },
      )
    ).id;
    ids.C = (
      await registerFixedAsset(
        prisma,
        purchase({
          accountId: refs.account("1510"),
          entryDate: "2070-05-01",
          amount: "150,000",
          name: "棚",
          method: "lump_sum_3y",
          usefulLifeYears: "",
        }),
        { actor },
      )
    ).id;
    expect(await entryCount(year.id)).toBe(before + 3);
    expect(await lines(d.acquisitionEntry!.id)).toEqual([
      ["debit", "1500", 1_000_000n],
      ["credit", "1100", 1_000_000n],
    ]);

    const rejected = [
      [
        purchase({ accountId: refs.account("1520"), method: "declining_balance" }),
        { message: "建物附属設備とソフトウェアは定額法だけです", field: "method" },
      ],
      [
        purchase({ accountId: refs.account("1600") }),
        {
          message:
            "勘定科目「1600 敷金・保証金」には固定資産を登録できません。工具器具備品などの固定資産の科目を選んでください",
          field: "accountId",
        },
      ],
      [
        purchase({ usefulLifeYears: "" }),
        { message: "耐用年数は 2〜50 年で入力してください", field: "usefulLifeYears" },
      ],
      [
        purchase({ method: "lump_sum_3y", amount: "200,000" }),
        { message: "一括償却（3 年）は 200,000 円未満の資産だけです", field: "method" },
      ],
    ] as const;
    for (const [input, expected] of rejected) {
      expect(
        settingsError(await rejectionOf(registerFixedAsset(prisma, input, { actor }))),
      ).toEqual(expected);
    }
    // Rejected registrations leave no acquisition entry behind.
    expect(await entryCount(year.id)).toBe(before + 3);

    const interior = await getFixedAssetDetail(prisma, ids.D, { today: "2070-06-01" });
    expect(interior).toMatchObject({ residualValue: 1n, isDepreciableAssetTaxed: true });
    // 第 70・71 期 are in the book; 72 is not, so the rest is projected 12-month years.
    expect(
      interior?.schedule.map((row) => [row.startDate, row.amount, row.state, row.fiscalYearNo]),
    ).toEqual([
      ["2070-04-01", 200_000n, "unposted", 70],
      ["2071-04-01", 200_000n, "unposted", 71],
      ["2072-04-01", 200_000n, "projected", null],
      ["2073-04-01", 200_000n, "projected", null],
      ["2074-04-01", 199_999n, "projected", null],
    ]);
    const stored = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: ids.D } });
    expect(stored.schedule).toHaveLength(5);
    expect((stored.schedule as unknown[])[0]).toEqual({
      startDate: "2070-04-01",
      endDate: "2071-03-31",
      opening: "1000000",
      amount: "200000",
      closing: "800000",
    });
    expect((await getFixedAssetDetail(prisma, ids.E))?.isDepreciableAssetTaxed).toBe(false);
  });

  it("caps the special measure at 3,000,000 × months ÷ 12, on tax-exclusive costs", async () => {
    const special = (name: string, amount = "290,000") =>
      purchase({
        accountId: refs.account("1510"),
        entryDate: "2026-02-10",
        amount,
        name,
        method: "immediate",
        usefulLifeYears: "",
      });
    // 290,000 円（税込）→ 取得価額 263,637 円（税抜経理）。3 か月の期の上限は 750,000 円。
    const first = await registerFixedAsset(prisma, special("タブレット 1"), { actor });
    const detail = await getFixedAssetDetail(prisma, first.id);
    expect(detail).toMatchObject({
      cost: 263_637n,
      isSpecialSmallAsset: true,
      isDepreciableAssetTaxed: true,
    });
    await registerFixedAsset(prisma, special("タブレット 2"), { actor });
    expect(
      settingsError(
        await rejectionOf(registerFixedAsset(prisma, special("タブレット 3"), { actor })),
      ),
    ).toEqual({
      message: "第 81 期の特例の上限 750,000 円を超えます（登録済み 527,274 円）",
      field: "method",
    });
    // Acquired before 2026-04-01 the limit is 300,000: 税込 330,000 円 → 取得価額 300,000 円 is not below it.
    expect(
      settingsError(
        await rejectionOf(registerFixedAsset(prisma, special("複合機", "330,000"), { actor })),
      ),
    ).toEqual({ message: "即時償却は 300,000 円未満の資産だけです", field: "method" });
    expect(await entryCount(shortYear.id)).toBe(2);
  });

  it("edits freely until depreciation is posted, and voids a registration with a reason", async () => {
    const renamed = await updateFixedAsset(
      prisma,
      ids.B,
      { name: "ノート PC（営業用）", cost: "150,000" },
      { actor },
    );
    expect(renamed).toMatchObject({ name: "ノート PC（営業用）", cost: 150_000n });
    expect(
      settingsError(
        await rejectionOf(updateFixedAsset(prisma, ids.B, { cost: "250,000" }, { actor })),
      ),
    ).toEqual({ message: "取得価額は仕訳の残りの額 200,000 円までにしてください", field: "cost" });
    await updateFixedAsset(prisma, ids.B, { cost: "200,000" }, { actor });

    await expect(voidFixedAsset(prisma, ids.C, { reason: "" }, { actor })).rejects.toThrow();
    await voidFixedAsset(prisma, ids.C, { reason: "取得の仕訳を誤って登録した" }, { actor });
    const list = await listFixedAssets(prisma, { today: "2070-06-01" });
    expect(list.rows.some((row) => row.id === ids.C)).toBe(false);
    expect(list.voidedCount).toBeGreaterThanOrEqual(1);
    const all = await listFixedAssets(prisma, { includeVoided: true, today: "2070-06-01" });
    expect(all.rows.find((row) => row.id === ids.C)).toMatchObject({
      status: "voided",
      bookValue: null,
      voidReason: "取得の仕訳を誤って登録した",
    });
    expect(list.rows.find((row) => row.id === ids.D)).toMatchObject({
      accountCode: "1500",
      status: "active",
      bookValue: 800_000n,
    });
    expect(list.fiscalYear?.no).toBe(70);

    await startYearEnd(prisma, year.id, {}, { actor, today: "2071-05-01" });
    const posted = await postDepreciation(prisma, year.id, {}, { actor });
    expect(new Map(posted.map((row) => [row.assetId, row.amount]))).toEqual(
      new Map([
        [ids.A, 98_000n],
        [ids.B, 100_000n],
        [ids.D, 200_000n],
        [ids.E, 100_000n],
      ]),
    );
    const locked =
      "償却の仕訳があるため、取得価額・取得日・科目・償却方法・耐用年数は変えられません。償却の仕訳を取り消すと変えられます";
    await expect(updateFixedAsset(prisma, ids.B, { cost: "150,000" }, { actor })).rejects.toThrow(
      locked,
    );
    await updateFixedAsset(prisma, ids.B, { name: "ノート PC" }, { actor });
    await expect(voidFixedAsset(prisma, ids.B, { reason: "誤り" }, { actor })).rejects.toThrow(
      "償却の仕訳があるため、登録は取り消せません",
    );
    const blocked = await getFixedAssetDetail(prisma, ids.B, { today: "2071-05-01" });
    expect(blocked).toMatchObject({
      canEditParameters: false,
      canVoid: false,
      editBlockedReason: locked,
    });
    expect(blocked?.schedule[0]).toMatchObject({ state: "posted", fiscalYearNo: 70 });

    // Voiding the depreciation entry opens the parameters again; posting it once more closes them.
    const entryId = blocked!.schedule[0]!.entries[0]!.id;
    await voidYearEndEntry(prisma, entryId, { reason: "耐用年数を確かめる" }, { actor });
    expect((await getFixedAssetDetail(prisma, ids.B))?.canEditParameters).toBe(true);
    expect(
      (await postDepreciation(prisma, year.id, { assetIds: [ids.B] }, { actor })).map(
        (row) => row.amount,
      ),
    ).toEqual([100_000n]);

    expect(
      settingsError(
        await rejectionOf(disposeFixedAsset(prisma, ids.D, { date: "2071-03-31" }, { actor })),
      ),
    ).toEqual({
      message:
        "第 70 期は決算整理中のため、除却・売却は登録できません。決算整理をやめるか、翌期の日付にしてください",
      field: "date",
    });
    expect((await getFixedAssetDetail(prisma, ids.B))?.history.map((row) => row.action)).toEqual([
      "fixed_asset.create",
      "fixed_asset.update",
      "fixed_asset.update",
      "fixed_asset.update",
    ]);
  });

  it("disposes and sells in the next year: 除却損, 売却益, 売却損, and an expensed asset", async () => {
    expect(
      settingsError(
        await rejectionOf(
          disposeFixedAsset(prisma, ids.D, { date: "2071-05-15", proceeds: "900,000" }, { actor }),
        ),
      ),
    ).toEqual({ message: "入金先の口座を選んでください", field: "walletId" });

    // 除却: 帳簿価額 200,000 − 100,000 = 100,000 は雑損失。
    const scrapped = await disposeFixedAsset(
      prisma,
      ids.B,
      { date: "2071-06-30", proceeds: "", description: "" },
      { actor },
    );
    expect(scrapped.bookValue).toBe(100_000n);
    expect(await lines(scrapped.entry!.id)).toEqual([
      ["debit", "1590", 100_000n],
      ["debit", "5600", 100_000n],
      ["credit", "1510", 200_000n],
    ]);

    // 売却益: 帳簿価額 800,000、売却額 900,000（課税売上、うち消費税 81,818）。
    const sold = await disposeFixedAsset(
      prisma,
      ids.D,
      { date: "2071-05-15", proceeds: "900,000", walletId: bank, description: "内装の売却" },
      { actor },
    );
    expect(sold.bookValue).toBe(800_000n);
    const soldEntry = await getJournalEntryDetail(prisma, sold.entry!.id);
    expect(soldEntry).toMatchObject({
      kind: "normal",
      sourceKind: "fixed_asset",
      sourceId: ids.D,
      description: "内装の売却",
    });
    expect(soldEntry?.lines.map((line) => [line.side, line.accountCode, line.amount])).toEqual([
      ["debit", "1590", 200_000n],
      ["debit", "1100", 900_000n],
      ["debit", "4510", 800_000n],
      ["credit", "1500", 1_000_000n],
      ["credit", "4510", 900_000n],
    ]);
    expect(soldEntry?.lines[4]).toMatchObject({ taxCategoryCode: "sales_10", taxAmount: 81_818n });
    expect(soldEntry?.lines[2]).toMatchObject({ taxCategoryCode: "na", taxAmount: 0n });

    // 売却損: 帳簿価額 400,000、売却額 110,000。
    const loss = await disposeFixedAsset(
      prisma,
      ids.E,
      { date: "2071-05-20", proceeds: "110,000", walletId: bank },
      { actor },
    );
    expect(await lines(loss.entry!.id)).toEqual([
      ["debit", "1590", 100_000n],
      ["debit", "1100", 110_000n],
      ["debit", "5600", 400_000n],
      ["credit", "1520", 500_000n],
      ["credit", "5600", 110_000n],
    ]);

    // 即時償却で費用にした資産: 帳簿価額 0、売却額なし → 仕訳を作らない。
    const expensed = await disposeFixedAsset(prisma, ids.A, { date: "2071-04-30" }, { actor });
    expect(expensed).toEqual({
      assetId: ids.A,
      disposedAt: "2071-04-30",
      entry: null,
      bookValue: 0n,
    });

    const list = await listFixedAssets(prisma, { today: "2071-06-30" });
    const status = (id: string) => list.rows.find((row) => row.id === id);
    expect(status(ids.A)).toMatchObject({ status: "disposed", bookValue: 0n });
    expect(status(ids.B)).toMatchObject({ status: "disposed", disposedAt: "2071-06-30" });
    expect(status(ids.D)).toMatchObject({ status: "sold", bookValue: 0n });
    expect(status(ids.E)).toMatchObject({ status: "sold" });
    const detail = await getFixedAssetDetail(prisma, ids.D);
    expect(detail).toMatchObject({
      disposeBlockedReason: "除却・売却済みです",
      canEditParameters: false,
      disposalEntry: { id: sold.entry!.id, status: "posted" },
    });
    expect(detail?.history.at(-1)).toMatchObject({ action: "fixed_asset.dispose" });
    await expect(updateFixedAsset(prisma, ids.D, { cost: "900,000" }, { actor })).rejects.toThrow(
      "除却・売却済みのため",
    );
    await expect(
      disposeFixedAsset(prisma, ids.D, { date: "2071-06-01" }, { actor }),
    ).rejects.toThrow("除却・売却済みです");
  });

  it("gives the statements the year's movements per asset (#15)", async () => {
    const mine = (rows: Awaited<ReturnType<typeof loadFixedAssetLedger>>["rows"]) =>
      new Map(
        rows
          .filter((row) => Object.values(ids).includes(row.assetId))
          .map((row) => [
            row.assetId,
            [
              row.openingBookValue,
              row.increase,
              row.decrease,
              row.depreciation,
              row.closingBookValue,
              row.accumulated,
            ],
          ]),
      );
    const first = await loadFixedAssetLedger(prisma, year.id);
    expect(mine(first.rows)).toEqual(
      new Map([
        [ids.A, [0n, 98_000n, 0n, 98_000n, 0n, 98_000n]],
        [ids.B, [0n, 200_000n, 0n, 100_000n, 100_000n, 100_000n]],
        [ids.D, [0n, 1_000_000n, 0n, 200_000n, 800_000n, 200_000n]],
        [ids.E, [0n, 500_000n, 0n, 100_000n, 400_000n, 100_000n]],
      ]),
    );
    expect(first.rows.find((row) => row.assetId === ids.E)).toMatchObject({
      isSpecialSmallAsset: false,
      isDepreciableAssetTaxed: false,
    });
    expect(first.totals.closingBookValue).toBe(
      first.rows.reduce((sum, row) => sum + row.closingBookValue, 0n),
    );

    const second = await loadFixedAssetLedger(prisma, nextYear.id);
    expect(mine(second.rows)).toEqual(
      new Map([
        [ids.B, [100_000n, 0n, 100_000n, 0n, 0n, 0n]],
        [ids.D, [800_000n, 0n, 800_000n, 0n, 0n, 0n]],
        [ids.E, [400_000n, 0n, 400_000n, 0n, 0n, 0n]],
      ]),
    );
  });
});
