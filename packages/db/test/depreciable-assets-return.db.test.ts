import type { CalendarDate } from "@niho-finance/ledger";
import { CSV_CONTENT_TYPES, csvText, depreciableAssetsReturnCsv } from "@niho-finance/reports";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  disposeFixedAsset,
  fromDbDate,
  getFixedAssetDetail,
  loadDepreciableAssetsReturn,
  newId,
  postDepreciation,
  registerFixedAsset,
  SettingsError,
  setPropertyTaxMunicipality,
  startYearEnd,
  toDbDate,
  updateFixedAsset,
  voidFixedAsset,
  type DepreciableAssetsReturnData,
  type FixedAssetRegisterInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

type Key =
  | "interior"
  | "copier"
  | "shelf"
  | "printer"
  | "software"
  | "vehicle"
  | "safe"
  | "sofa"
  | "server"
  | "desk"
  | "tablet"
  | "voided";

/**
 * 償却資産申告の元データ (16 §14): the register's assets split into 全資産 / 増加 / 減少 / 対象外 on 1 January,
 * the overrides of the asset (資産の種類・申告の対象外・即時の耐用年数) and the 申告先, with their audit rows.
 */
describe.skipIf(!hasTestDatabase)("depreciable assets return (償却資産申告の元データ)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 180 期: 2080-04-01 – 2081-03-31 (免税・税込). */
  let year: FiscalYear;
  let bank: string;
  let calendarItemId: string | null = null;
  const ids = {} as Record<Key, string>;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    year = await createFiscalYear(prisma, {
      no: 180,
      startDate: "2080-04-01",
      endDate: "2081-03-31",
    });
    // 第 181 期: 2081-04-01 – 2082-03-31 (the disposals of the return of 2082).
    await createFiscalYear(prisma, { no: 181, startDate: "2081-04-01", endDate: "2082-03-31" });
    bank = (await prisma.wallet.findFirstOrThrow({ where: { name: "架空銀行 普通" } })).id;
  });

  // The calendar belongs to the seed (calendar.db.test.ts compares it): leave it as it was.
  afterAll(async () => {
    if (calendarItemId) await prisma.calendarItem.delete({ where: { id: calendarItemId } });
  });

  const purchase = (name: string, overrides: Record<string, unknown>): FixedAssetRegisterInput => ({
    source: "purchase",
    counterpart: `wallet:${bank}`,
    entryDate: "2080-04-01",
    amount: "600,000",
    taxCategoryCode: "purchase_10",
    accountId: refs.account("1510"),
    name,
    method: "declining_balance",
    usefulLifeYears: "5",
    segmentId: "",
    note: "",
    ...overrides,
  });

  async function register(key: Key, name: string, overrides: Record<string, unknown> = {}) {
    ids[key] = (await registerFixedAsset(prisma, purchase(name, overrides), { actor })).id;
  }

  const mine = (rows: readonly { assetId: string }[]) => {
    const names = new Map(Object.entries(ids).map(([key, id]) => [id, key]));
    return rows.flatMap((row) => (names.has(row.assetId) ? [names.get(row.assetId)] : []));
  };

  /** The register's own rule, from its columns: 償却資産税の対象, not excluded by hand, held on `date`. */
  async function registerTaxableCost(date: CalendarDate): Promise<bigint> {
    const rows = await prisma.fixedAsset.findMany({
      where: {
        voidedAt: null,
        isDepreciableAssetTaxed: true,
        propertyTaxExcludedReason: null,
        acquisitionDate: { lte: toDbDate(date) },
      },
      select: { cost: true, disposedAt: true, disposalEntry: { select: { status: true } } },
    });
    return rows
      .filter(
        (row) =>
          !(
            row.disposedAt &&
            fromDbDate(row.disposedAt) <= date &&
            (!row.disposalEntry || row.disposalEntry.status === "posted")
          ),
      )
      .reduce((sum, row) => sum + row.cost, 0n);
  }

  function csvAllCost(data: DepreciableAssetsReturnData): bigint {
    return depreciableAssetsReturnCsv(data)
      .filter((row) => row[0] === "全資産")
      .reduce((sum, row) => sum + (row[6] as bigint), 0n);
  }

  it("keeps a useful life for an 即時償却 asset at registration, without changing its depreciation", async () => {
    await register("interior", "申告 内装工事", {
      accountId: refs.account("1500"),
      amount: "1,000,000",
      method: "straight_line",
      usefulLifeYears: "15",
    });
    await register("copier", "申告 複合機", { entryDate: "2080-06-10" });
    await register("shelf", "申告 棚", {
      entryDate: "2080-05-01",
      amount: "150,000",
      method: "lump_sum_3y",
      usefulLifeYears: "",
    });
    await register("printer", "申告 プリンタ", {
      entryDate: "2080-07-01",
      amount: "98,000",
      method: "immediate",
      usefulLifeYears: "4",
    });
    await register("software", "申告 会計ソフト", {
      accountId: refs.account("1520"),
      amount: "500,000",
      method: "straight_line",
    });
    await register("vehicle", "申告 社用車", {
      entryDate: "2080-08-01",
      amount: "2,000,000",
      usefulLifeYears: "6",
    });
    await register("safe", "申告 金庫", { entryDate: "2081-01-01", amount: "400,000" });
    await register("sofa", "申告 応接セット", { entryDate: "2081-01-02", amount: "300,000" });
    await register("server", "申告 サーバー", { entryDate: "2080-04-15", amount: "500,000" });
    await register("desk", "申告 事務机", { entryDate: "2080-04-20", amount: "250,000" });
    await register("tablet", "申告 タブレット", { entryDate: "2080-09-01", amount: "300,000" });
    await register("voided", "申告 取消した資産", { entryDate: "2080-10-01" });

    const printer = await getFixedAssetDetail(prisma, ids.printer, { today: "2080-11-01" });
    expect(printer).toMatchObject({
      usefulLifeYears: 4,
      residualValue: 0n,
      propertyTax: { taxable: false, reason: "少額減価償却資産（10 万円未満）", assetType: 6 },
    });
    expect(printer?.schedule[0]).toMatchObject({ fiscalYearNo: 180, amount: 98_000n });

    await voidFixedAsset(prisma, ids.voided, { reason: "二重に登録した" }, { actor });
    await disposeFixedAsset(prisma, ids.tablet, { date: "2080-12-31" }, { actor });
  });

  it("changes the kind and the exclusion of an asset, with the audit log", async () => {
    await updateFixedAsset(
      prisma,
      ids.vehicle,
      { propertyTaxAssetType: "5", propertyTaxExcludedReason: "自動車税の課税対象（車両）" },
      { actor },
    );
    await updateFixedAsset(prisma, ids.copier, { propertyTaxAssetType: "2" }, { actor });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "fixed_asset", entityId: ids.vehicle, action: "fixed_asset.update" },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(audit.before).toMatchObject({
      propertyTaxAssetType: null,
      propertyTaxExcludedReason: null,
    });
    expect(audit.after).toMatchObject({
      propertyTaxAssetType: 5,
      propertyTaxExcludedReason: "自動車税の課税対象（車両）",
    });
    const vehicle = await getFixedAssetDetail(prisma, ids.vehicle);
    expect(vehicle).toMatchObject({
      propertyTaxAssetType: 5,
      propertyTaxExcludedReason: "自動車税の課税対象（車両）",
      isDepreciableAssetTaxed: true,
      propertyTax: { taxable: false, reason: "自動車税の課税対象（車両）", assetType: 5 },
    });
    await expect(
      updateFixedAsset(prisma, ids.copier, { propertyTaxAssetType: "7" }, { actor }),
    ).rejects.toThrow("資産の種類は 1〜6 にしてください");
  });

  it("saves the 申告先 on the company, audited only when it changes", async () => {
    const before = (await prisma.company.findFirstOrThrow()).propertyTaxMunicipality;
    expect(
      await setPropertyTaxMunicipality(prisma, { municipality: " 架空市 " }, { actor }),
    ).toEqual({ municipality: "架空市" });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "company", action: "company.update" },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect([audit.before, audit.after]).toEqual([
      { propertyTaxMunicipality: before },
      { propertyTaxMunicipality: "架空市" },
    ]);
    const count = await prisma.auditLog.count({ where: { action: "company.update" } });
    await setPropertyTaxMunicipality(prisma, { municipality: "架空市" }, { actor });
    expect(await prisma.auditLog.count({ where: { action: "company.update" } })).toBe(count);
  });

  it("splits the return of 2081 on 1 January, and its total is the register's", async () => {
    const before = await loadDepreciableAssetsReturn(prisma, { year: 2081, today: "2080-11-01" });
    expect(before.deadline).toBeNull();
    calendarItemId = newId();
    await prisma.calendarItem.create({
      data: {
        id: calendarItemId,
        fiscalYearId: year.id,
        kind: "filing",
        title: "法定調書合計表・給与支払報告書・償却資産申告書（税務署・市区町村）",
        dueDate: toDbDate("2081-01-31"),
        ruleKey: "annual.legal-records",
      },
    });

    const data = await loadDepreciableAssetsReturn(prisma, { year: 2081, today: "2080-11-01" });
    expect(data.assessmentDate).toBe("2081-01-01");
    expect(data.window).toEqual({ from: "2080-01-02", to: "2081-01-01" });
    expect(mine(data.all)).toEqual(["interior", "copier", "server", "desk", "safe"]);
    expect(data.all.find((row) => row.assetId === ids.copier)?.assetType).toBe(2);
    expect(mine(data.increased)).toEqual(["interior", "copier", "server", "desk", "safe"]);
    expect(mine(data.decreased)).toEqual([]);
    expect(data.excluded.filter((row) => mine([row]).length > 0).map((row) => row.reason)).toEqual([
      "無形固定資産（ソフトウェア）",
      "一括償却資産（3 年）",
      "少額減価償却資産（10 万円未満）",
      "自動車税の課税対象（車両）",
    ]);
    expect(data.totals.all.cost).toBe(await registerTaxableCost("2081-01-01"));
    expect(csvAllCost(data)).toBe(data.totals.all.cost);
    expect(data.municipality).toBe("架空市");
    expect(data.deadline).toMatchObject({ dueDate: "2081-01-31", completedAt: null });
    expect(data.deadline?.title).toContain("償却資産申告書");
    expect(data.years).toContain(2081);
    expect(data.years).toEqual([...data.years].sort((a, b) => b - a));

    const text = csvText(depreciableAssetsReturnCsv(data));
    expect(text).toContain(
      "全資産,6 工具、器具及び備品,申告 金庫,1,令和 63 年 1 月,2081-01,400000,5,,,,新品取得,,,",
    );
    expect(CSV_CONTENT_TYPES.utf8).toBe("text/csv; charset=utf-8");
  });

  it("keeps the 即時 life free after posting, the 定額 life locked, and splits 2082", async () => {
    await startYearEnd(prisma, year.id, {}, { actor, today: "2081-05-01" });
    await postDepreciation(prisma, year.id, { assetIds: [ids.printer, ids.interior] }, { actor });
    await updateFixedAsset(prisma, ids.printer, { usefulLifeYears: "5" }, { actor });
    expect((await getFixedAssetDetail(prisma, ids.printer))?.usefulLifeYears).toBe(5);
    expect(
      settingsError(
        await rejectionOf(
          updateFixedAsset(prisma, ids.printer, { usefulLifeYears: "1" }, { actor }),
        ),
      ),
    ).toEqual({ message: "耐用年数は 2〜50 年で入力してください", field: "usefulLifeYears" });
    await expect(
      updateFixedAsset(prisma, ids.interior, { usefulLifeYears: "10" }, { actor }),
    ).rejects.toThrow("償却の仕訳があるため");
    await updateFixedAsset(prisma, ids.interior, { propertyTaxAssetType: "6" }, { actor });
    expect((await getFixedAssetDetail(prisma, ids.interior))?.propertyTax.assetType).toBe(6);
    await updateFixedAsset(prisma, ids.interior, { propertyTaxAssetType: "" }, { actor });
    const interior = await getFixedAssetDetail(prisma, ids.interior);
    expect(interior).toMatchObject({
      propertyTaxAssetType: null,
      propertyTax: { taxable: true, reason: null, assetType: 1 },
      usefulLifeYears: 15,
      canEditParameters: false,
    });

    await disposeFixedAsset(
      prisma,
      ids.server,
      { date: "2081-06-01", proceeds: "300,000", walletId: bank },
      { actor },
    );
    await disposeFixedAsset(prisma, ids.desk, { date: "2081-07-01" }, { actor });

    const data = await loadDepreciableAssetsReturn(prisma, { year: 2082, today: "2081-11-01" });
    expect(data.window).toEqual({ from: "2081-01-02", to: "2082-01-01" });
    expect(mine(data.all)).toEqual(["interior", "copier", "safe", "sofa"]);
    expect(mine(data.increased)).toEqual(["sofa"]);
    expect(mine(data.decreased)).toEqual(["server", "desk"]);
    expect(
      data.decreased.filter((row) => mine([row]).length > 0).map((row) => row.decrease),
    ).toEqual([
      { reason: "売却", scope: "全部", date: "2081-06-01" },
      { reason: "滅失", scope: "全部", date: "2081-07-01" },
    ]);
    expect(data.totals.all.cost).toBe(await registerTaxableCost("2082-01-01"));
    expect(csvAllCost(data)).toBe(data.totals.all.cost);
    for (const rows of [data.all, data.decreased, data.excluded]) {
      expect(mine(rows)).not.toContain("tablet");
      expect(mine(rows)).not.toContain("voided");
    }
  });
});

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}
