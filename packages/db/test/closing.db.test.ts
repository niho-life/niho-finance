import { LedgerValidationError } from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  chainedEntryIds,
  closeFiscalYearThrough,
  correctJournalEntry,
  countAuditLog,
  getJournalEntryDetail,
  listAuditLog,
  listJournalEntries,
  loadEntryFormOptions,
  loadEntryHistory,
  postSimpleEntry,
  previewFiscalYearClose,
  SettingsError,
  todayInJapan,
  voidJournalEntryWithOpenDate,
  type SimpleEntryFormInput,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

function ledgerErrors(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
}

/** 締め, the entries of a closed month, and the audit log (11-transactions §1, §7, §8). */
describe.skipIf(!hasTestDatabase)("closing (締め) and the audit log", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 43 期: 2043-04-01 – 2044-03-31. */
  let year: FiscalYear;
  let cardWallet: string;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    year = await createFiscalYear(prisma, {
      no: 43,
      startDate: "2043-04-01",
      endDate: "2044-03-31",
    });
    cardWallet = (await prisma.wallet.findFirstOrThrow({ where: { name: "架空カード" } })).id;
  });

  const expense = (
    entryDate: string,
    overrides: Record<string, unknown> = {},
  ): SimpleEntryFormInput => ({
    type: "expense",
    entryDate,
    description: "通信費",
    counterpart: `wallet:${cardWallet}`,
    accountId: refs.account("5320"),
    amount: "2,200",
    taxCategoryCode: "purchase_10",
    segmentId: refs.segment("platform"),
    partnerId: "",
    memoTagIds: [],
    ...overrides,
  });

  const replacement = (entryDate: string) => ({
    kind: "normal",
    entryDate,
    description: "通信費",
    partnerId: "",
    memoTagIds: [],
    lines: [
      {
        side: "debit",
        accountId: refs.account("5320"),
        amount: "2,000",
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("platform"),
      },
      {
        side: "credit",
        accountId: refs.account("2100"),
        subAccountId: refs.subAccount("架空カード"),
        amount: "2,000",
        taxCategoryCode: "na",
      },
    ],
  });

  async function lockedThrough(): Promise<string | null> {
    const row = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: year.id } });
    return row.lockedThrough ? row.lockedThrough.toISOString().slice(0, 10) : null;
  }

  async function closeAudit() {
    return prisma.auditLog.findMany({
      where: { entity: "fiscal_year", entityId: year.id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, before: true, after: true, reason: true, actor: true },
    });
  }

  let april: string;
  let aprilLate: string;
  let may: string;
  let june: string;

  it("closes through a month end, counting the entries that become read-only", async () => {
    april = (await postSimpleEntry(prisma, expense("2043-04-15"), { actor })).id;
    aprilLate = (await postSimpleEntry(prisma, expense("2043-04-20"), { actor })).id;
    may = (await postSimpleEntry(prisma, expense("2043-05-20"), { actor })).id;
    june = (await postSimpleEntry(prisma, expense("2043-06-05"), { actor })).id;

    const preview = await previewFiscalYearClose(prisma, year.id, "2043-05-31");
    expect(preview).toEqual({
      range: { direction: "close", from: "2043-04-01", to: "2043-05-31" },
      count: 3,
    });
    const closed = await closeFiscalYearThrough(
      prisma,
      year.id,
      { lockedThrough: "2043-05-31", reason: "" },
      { actor },
    );
    expect(closed).toMatchObject({
      no: 43,
      lockedThrough: "2043-05-31",
      range: { direction: "close", from: "2043-04-01", to: "2043-05-31" },
      affectedCount: 3,
    });
    expect(await lockedThrough()).toBe("2043-05-31");
    expect(await closeAudit()).toEqual([
      {
        action: "fiscal_year.close",
        actor,
        before: { lockedThrough: null },
        after: { lockedThrough: "2043-05-31" },
        reason: null,
      },
    ]);
  });

  it("refuses to post on or before the close, with the state and the way back", async () => {
    const refused = await rejectionOf(postSimpleEntry(prisma, expense("2043-05-31"), { actor }));
    expect(ledgerErrors(refused)).toEqual([{ code: "PERIOD_LOCKED", field: "entryDate" }]);
    expect((refused as LedgerValidationError).errors[0]?.message).toBe(
      "2043/05/31 までは締めています。登録するには 設定 › 会計期間 で締めを戻してください",
    );
    // The day after the close is open.
    expect((await postSimpleEntry(prisma, expense("2043-06-01"), { actor })).entryDate).toBe(
      "2043-06-01",
    );
  });

  it("dates the void and the correction of a closed month's entry on the first open day", async () => {
    const detail = await getJournalEntryDetail(prisma, aprilLate);
    expect(detail).toMatchObject({
      isLocked: true,
      firstOpenDate: "2043-06-01",
      reversalDate: "2043-06-01",
      blockedReason: null,
    });
    expect((await getJournalEntryDetail(prisma, june))?.reversalDate).toBe("2043-06-05");

    const voided = await voidJournalEntryWithOpenDate(prisma, may, { reason: "重複" }, { actor });
    expect(voided.reversal.entryDate).toBe("2043-06-01");
    expect(voided.voided).toMatchObject({ status: "voided", entryDate: "2043-05-20" });

    // The replacement's own date must be open: a closed date rolls the whole correction back.
    const lockedReplacement = await rejectionOf(
      correctJournalEntry(
        prisma,
        april,
        { reason: "金額の誤り", replacement: replacement("2043-05-10") },
        { actor },
      ),
    );
    expect(ledgerErrors(lockedReplacement)).toEqual([
      { code: "PERIOD_LOCKED", field: "replacement.entryDate" },
    ]);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: april } })).status).toBe(
      "posted",
    );

    const corrected = await correctJournalEntry(
      prisma,
      april,
      { reason: "金額の誤り", replacement: replacement("2043-06-01") },
      { actor },
    );
    expect(corrected.reversal.entryDate).toBe("2043-06-01");
    expect(corrected.replacement.entryDate).toBe("2043-06-01");
    expect(corrected.voided.replacedById).toBe(corrected.replacement.id);

    const rows = await listJournalEntries(prisma, {
      from: "2043-04-01",
      to: "2043-05-31",
      status: "all",
    });
    expect(rows.rows.every((row) => row.isLocked)).toBe(true);
    expect(rows.rows.find((row) => row.id === april)?.replacedBy?.id).toBe(
      corrected.replacement.id,
    );
  });

  it("checks the close date, needs a reason to move it back, and records both ways", async () => {
    const notMonthEnd = await rejectionOf(
      closeFiscalYearThrough(prisma, year.id, { lockedThrough: "2043-06-15" }, { actor }),
    );
    expect(notMonthEnd).toBeInstanceOf(SettingsError);
    expect(notMonthEnd).toMatchObject({
      field: "lockedThrough",
      message: "締め日は第 43 期（2043/04/01〜2044/03/31）の月末日にしてください",
    });
    await expect(
      closeFiscalYearThrough(prisma, year.id, { lockedThrough: "2044-04-30" }, { actor }),
    ).rejects.toMatchObject({ field: "lockedThrough" });

    // Forward to June: the June entries (one posted, two reversals, one replacement, one new) lock.
    const june30 = await closeFiscalYearThrough(
      prisma,
      year.id,
      { lockedThrough: "2043-06-30" },
      { actor },
    );
    expect(june30.range).toEqual({ direction: "close", from: "2043-06-01", to: "2043-06-30" });
    expect(june30.affectedCount).toBe(5);

    const noReason = await rejectionOf(
      closeFiscalYearThrough(
        prisma,
        year.id,
        { lockedThrough: "2043-04-30", reason: " " },
        { actor },
      ),
    );
    expect(noReason).toMatchObject({
      field: "reason",
      message: "締めを戻す理由を入力してください",
    });
    expect(await lockedThrough()).toBe("2043-06-30");

    const back = await closeFiscalYearThrough(
      prisma,
      year.id,
      { lockedThrough: "2043-04-30", reason: "5 月の請求書が届いた" },
      { actor },
    );
    expect(back.range).toEqual({ direction: "reopen", from: "2043-05-01", to: "2043-06-30" });
    // 05-20 (voided) and the five June entries open again.
    expect(back.affectedCount).toBe(6);
    const open = await closeFiscalYearThrough(
      prisma,
      year.id,
      { lockedThrough: "", reason: "締めをやり直す" },
      { actor },
    );
    expect(open).toMatchObject({
      lockedThrough: null,
      range: { direction: "reopen", from: "2043-04-01", to: "2043-04-30" },
      affectedCount: 2,
    });
    // The same value again changes nothing and records nothing.
    const same = await closeFiscalYearThrough(prisma, year.id, { lockedThrough: "" }, { actor });
    expect(same).toMatchObject({ range: null, affectedCount: 0, lockedThrough: null });

    expect((await closeAudit()).map((row) => [row.action, row.after, row.reason])).toEqual([
      ["fiscal_year.close", { lockedThrough: "2043-05-31" }, null],
      ["fiscal_year.close", { lockedThrough: "2043-06-30" }, null],
      ["fiscal_year.reopen", { lockedThrough: "2043-04-30" }, "5 月の請求書が届いた"],
      ["fiscal_year.reopen", { lockedThrough: null }, "締めをやり直す"],
    ]);
  });

  it("cannot change the close of a closed year (決算済み), nor void its entries", async () => {
    const closedYear = await createFiscalYear(prisma, {
      no: 46,
      startDate: "2046-04-01",
      endDate: "2047-03-31",
    });
    const entry = await postSimpleEntry(prisma, expense("2046-05-10"), { actor });
    await prisma.fiscalYear.update({ where: { id: closedYear.id }, data: { status: "closed" } });
    await expect(
      closeFiscalYearThrough(prisma, closedYear.id, { lockedThrough: "2046-04-30" }, { actor }),
    ).rejects.toThrow("第 46 期は決算済みのため、締めは変えられません");
    expect(
      ledgerErrors(
        await rejectionOf(
          voidJournalEntryWithOpenDate(prisma, entry.id, { reason: "誤り" }, { actor }),
        ),
      ),
    ).toEqual([{ code: "FISCAL_YEAR_CLOSED", field: undefined }]);
    expect((await getJournalEntryDetail(prisma, entry.id))?.blockedReason).toBe(
      "第 46 期は決算済みのため、訂正・取消はできません",
    );
  });

  it("refuses to void or correct the entries of a year in its year-end adjustments (決算整理中)", async () => {
    const closingYear = await createFiscalYear(prisma, {
      no: 47,
      startDate: "2047-04-01",
      endDate: "2048-03-31",
    });
    const entry = await postSimpleEntry(prisma, expense("2047-05-10"), { actor });
    await prisma.fiscalYear.update({ where: { id: closingYear.id }, data: { status: "closing" } });
    const nextNo = async () =>
      (await prisma.fiscalYear.findUniqueOrThrow({ where: { id: closingYear.id } })).nextEntryNo;
    const before = await nextNo();
    expect(
      ledgerErrors(
        await rejectionOf(
          voidJournalEntryWithOpenDate(prisma, entry.id, { reason: "誤り" }, { actor }),
        ),
      ),
    ).toEqual([{ code: "FISCAL_YEAR_CLOSING", field: undefined }]);
    expect(
      ledgerErrors(
        await rejectionOf(
          correctJournalEntry(
            prisma,
            entry.id,
            { reason: "誤り", replacement: replacement("2047-05-10") },
            { actor },
          ),
        ),
      ),
    ).toEqual([{ code: "FISCAL_YEAR_CLOSING", field: undefined }]);
    expect((await getJournalEntryDetail(prisma, entry.id))?.blockedReason).toBe(
      "第 47 期は決算整理中のため、訂正・取消はできません",
    );
    // Nothing was written: still posted, no reversal, no number used.
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe(
      "posted",
    );
    expect(await nextNo()).toBe(before);
  });

  it("lists the audit log newest first, by target and by period, naming the targets", async () => {
    const today = todayInJapan();
    const years = await listAuditLog(prisma, { entity: "fiscal_year", from: today, to: today });
    expect(years.rows.length).toBeGreaterThan(0);
    expect(years.rows.every((row) => row.entity === "fiscal_year")).toBe(true);
    const ours = years.rows.filter((row) => row.entityId === year.id);
    expect(ours.map((row) => row.action)).toEqual([
      "fiscal_year.reopen",
      "fiscal_year.reopen",
      "fiscal_year.close",
      "fiscal_year.close",
    ]);
    expect(ours[0]).toMatchObject({ target: "会計期間 第 43 期", reason: "締めをやり直す" });

    const entries = await listAuditLog(prisma, { entity: "journal_entry" }, 1, { pageSize: 5 });
    expect(entries.rows).toHaveLength(5);
    expect(entries.pageCount).toBeGreaterThan(1);
    for (const row of entries.rows) {
      expect(row.target).toMatch(/^仕訳 No\. \d+$/);
      expect(row.journalEntryId).toBe(row.entityId);
    }
    const times = entries.rows.map((row) => row.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const accounts = await listAuditLog(prisma, { entity: "standard_data" });
    expect(accounts.rows.every((row) => row.target === "標準データ")).toBe(true);
    const tomorrow = await listAuditLog(prisma, { from: "2999-01-01" });
    expect(tomorrow).toMatchObject({ total: 0, rows: [], page: 1, pageCount: 1 });
    const setup = await listAuditLog(prisma, { entity: "setup" });
    expect(setup.rows.every((row) => row.action.startsWith("setup."))).toBe(true);
  });

  it("reading never adds to the audit log", async () => {
    const before = await countAuditLog(prisma);
    const detail = await getJournalEntryDetail(prisma, april);
    await loadEntryHistory(prisma, chainedEntryIds(detail!));
    await listJournalEntries(prisma, { status: "all" });
    await loadEntryFormOptions(prisma);
    await previewFiscalYearClose(prisma, year.id, "2043-05-31");
    await listAuditLog(prisma, {});
    expect(await countAuditLog(prisma)).toBe(before);
  });
});
