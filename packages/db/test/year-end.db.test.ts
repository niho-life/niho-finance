import {
  assertTrialBalanceIdentity,
  LedgerValidationError,
  trialBalance,
  type CalendarDate,
  type TrialBalance,
} from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countInboxDocuments,
  cancelYearEnd,
  closeFiscalYearThrough,
  closeYear,
  correctJournalEntry,
  getJournalEntryDetail,
  loadAccountRefs,
  loadCorporateTaxEstimate,
  loadLedgerEntries,
  loadTrialBalance,
  loadYearEndBalances,
  loadYearEndChecklist,
  postAccrual,
  postConsumptionTaxSettlement,
  postCorporateTax,
  postDeferredAmortization,
  postDepreciation,
  postSimpleEntry,
  postVoucherEntry,
  previewFiscalYearClose,
  registerFixedAsset,
  reopenYear,
  setYearEndCheck,
  SettingsError,
  startYearEnd,
  voidJournalEntryWithOpenDate,
  voidYearEndEntry,
  type SimpleEntryFormInput,
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

function ledgerCodes(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).codes;
}

/** 決算: the transitions, the year-end postings, their void, the close and its reopening (#14). */
describe.skipIf(!hasTestDatabase)("year-end closing (決算)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 160 期: 2090-04-01 – 2091-03-31 (免税・税込). */
  let year: FiscalYear;
  /** 第 161 期: 2091-04-01 – 2092-03-31. */
  let nextYear: FiscalYear;
  let bank: string;
  let card: string;
  let incomeEntry: string;
  let assetId: string;
  const today = "2091-05-01";

  // The test database is shared by every db test file, in an order vitest may change. These years
  // (2090–2096) keep away from the other files' fiscal years: no other year starts within the 10
  // years before them (the loss carryforward of 法人税等 reads those), and 2098–2099 stay outside
  // every year (the invoice and statement tests use them as dates without a fiscal year).
  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    year = await createFiscalYear(prisma, {
      no: 160,
      startDate: "2090-04-01",
      endDate: "2091-03-31",
    });
    nextYear = await createFiscalYear(prisma, {
      no: 161,
      startDate: "2091-04-01",
      endDate: "2092-03-31",
    });
    const wallet = async (name: string) =>
      (await prisma.wallet.findFirstOrThrow({ where: { name } })).id;
    bank = await wallet("架空銀行 普通");
    card = await wallet("架空カード");
  });

  const simple = (
    type: "income" | "expense",
    entryDate: string,
    amount: string,
    overrides: Record<string, unknown> = {},
  ): SimpleEntryFormInput => ({
    type,
    entryDate,
    description: type === "income" ? "月会費" : "通信費",
    counterpart: type === "income" ? `wallet:${bank}` : `wallet:${card}`,
    accountId: refs.account(type === "income" ? "4010" : "5320"),
    amount,
    taxCategoryCode: type === "income" ? "sales_10" : "purchase_10",
    segmentId: refs.segment(type === "income" ? "kamakura" : "platform"),
    partnerId: "",
    memoTagIds: [],
    ...overrides,
  });

  async function status(id: string) {
    const row = await prisma.fiscalYear.findUniqueOrThrow({ where: { id } });
    return {
      status: row.status,
      lockedThrough: row.lockedThrough ? row.lockedThrough.toISOString().slice(0, 10) : null,
    };
  }

  async function yearAudit(id: string) {
    return prisma.auditLog.findMany({
      where: { entity: "fiscal_year", entityId: id, action: { not: "fiscal_year.close" } },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, before: true, after: true, reason: true },
    });
  }

  /** Trial balance of `period` with the balance-sheet accounts as of `asOf`. */
  async function balanceAt(
    period: { startDate: CalendarDate; endDate: CalendarDate },
    asOf: CalendarDate,
  ): Promise<TrialBalance> {
    return trialBalance(
      await loadLedgerEntries(prisma, { through: asOf }),
      await loadAccountRefs(prisma),
      period,
      { asOf },
    );
  }

  it("records the year's transactions and an asset bought in it", async () => {
    incomeEntry = (
      await postSimpleEntry(prisma, simple("income", "2090-05-20", "1,100,000"), { actor })
    ).id;
    await postSimpleEntry(prisma, simple("expense", "2090-06-05", "330,000"), { actor });
    // 開業費 120,000 (役員立替) for the 繰延資産.
    await postVoucherEntry(
      prisma,
      {
        kind: "normal",
        entryDate: "2090-04-01",
        description: "開業費（役員立替）",
        partnerId: "",
        memoTagIds: [],
        lines: [
          {
            side: "debit",
            accountId: refs.account("1710"),
            amount: "120,000",
            taxCategoryCode: "na",
          },
          {
            side: "credit",
            accountId: refs.account("2400"),
            subAccountId: refs.subAccount("役員立替"),
            amount: "120,000",
            taxCategoryCode: "na",
          },
        ],
      },
      { actor },
    );
    const asset = await registerFixedAsset(
      prisma,
      {
        source: "purchase",
        counterpart: `wallet:${bank}`,
        entryDate: "2090-07-10",
        amount: "600,000",
        taxCategoryCode: "purchase_10",
        accountId: refs.account("1510"),
        name: "ノート PC",
        method: "declining_balance",
        usefulLifeYears: "4",
        segmentId: "",
        note: "",
      },
      { actor },
    );
    assetId = asset.id;
    expect(asset.acquisitionEntry?.entryDate).toBe("2090-07-10");
  });

  it("starts only after the last day, and moves a close on the last day back", async () => {
    expect(
      settingsError(
        await rejectionOf(startYearEnd(prisma, year.id, {}, { actor, today: "2091-03-31" })),
      ).message,
    ).toBe("期末は 2091/03/31 です。決算整理は 2091/04/01 から始められます");
    expect(
      settingsError(
        await rejectionOf(startYearEnd(prisma, nextYear.id, {}, { actor, today: "2092-05-01" })),
      ).message,
    ).toBe("第 160 期を締めてから始めます");

    await closeFiscalYearThrough(prisma, year.id, { lockedThrough: "2091-03-31" }, { actor });
    const checklist = await loadYearEndChecklist(prisma, year.id, { today });
    expect(checklist).toMatchObject({
      canStart: true,
      startBlockedReason: null,
      lockedThroughAfterStart: "2091-02-28",
      canPost: false,
    });
    expect(checklist.normalEntryCount).toBe(4);

    const result = await startYearEnd(prisma, year.id, { reason: "" }, { actor, today });
    expect(result).toMatchObject({ no: 160, status: "closing", lockedThrough: "2091-02-28" });
    expect(await status(year.id)).toEqual({ status: "closing", lockedThrough: "2091-02-28" });
    expect((await yearAudit(year.id)).map((row) => [row.action, row.before, row.after])).toEqual([
      [
        "fiscal_year.start_adjusting",
        { status: "open", lockedThrough: "2091-03-31" },
        { status: "closing", lockedThrough: "2091-02-28" },
      ],
    ]);
  });

  it("takes only adjusting entries while closing, and keeps the monthly close as it is", async () => {
    expect(
      ledgerCodes(
        await rejectionOf(
          postSimpleEntry(prisma, simple("expense", "2091-03-31", "1,100"), { actor }),
        ),
      ),
    ).toContain("FISCAL_YEAR_CLOSING");
    const voucher = await postVoucherEntry(
      prisma,
      {
        kind: "adjusting",
        entryDate: "2091-03-31",
        description: "立替金の振替",
        partnerId: "",
        memoTagIds: [],
        lines: [
          {
            side: "debit",
            accountId: refs.account("1350"),
            amount: "2,000",
            taxCategoryCode: "na",
          },
          {
            side: "credit",
            accountId: refs.account("1100"),
            amount: "2,000",
            taxCategoryCode: "na",
          },
        ],
      },
      { actor },
    );
    expect(voucher.kind).toBe("adjusting");

    const message =
      "第 160 期は決算整理中のため、締め日は変えられません。決算 の画面で決算整理をやめると変えられます";
    await expect(
      closeFiscalYearThrough(
        prisma,
        year.id,
        { lockedThrough: "2091-01-31", reason: "戻したい" },
        { actor },
      ),
    ).rejects.toThrow(message);
    await expect(previewFiscalYearClose(prisma, year.id, "2091-01-31")).rejects.toThrow(message);
  });

  it("posts the depreciation once per asset and year", async () => {
    const posted = await postDepreciation(prisma, year.id, {}, { actor });
    // 600,000 × 0.500 × 9 / 12 (2090/07/10〜2091/03/31 は 9 か月) = 225,000。
    expect(posted.map((row) => [row.assetId, row.amount])).toEqual([[assetId, 225_000n]]);
    const entry = await getJournalEntryDetail(prisma, posted[0]!.entry.id);
    expect(entry).toMatchObject({
      kind: "adjusting",
      sourceKind: "fixed_asset",
      sourceId: assetId,
      entryDate: "2091-03-31",
      description: "減価償却費 ノート PC",
    });
    expect(entry?.lines.map((line) => [line.side, line.accountCode, line.amount])).toEqual([
      ["debit", "5460", 225_000n],
      ["credit", "1590", 225_000n],
    ]);
    expect(entry?.lines[0]?.segmentId).toBe(refs.segment("corporate"));

    expect(await postDepreciation(prisma, year.id, {}, { actor })).toEqual([]);
    expect(
      settingsError(
        await rejectionOf(postDepreciation(prisma, year.id, { assetIds: [assetId] }, { actor })),
      ).message,
    ).toBe("計上済みです。取り消してから計上し直してください");
  });

  it("amortizes 繰延資産 (5 年) once per account and year", async () => {
    const before = await loadYearEndChecklist(prisma, year.id, { today });
    const startup = before.deferred.find((row) => row.accountCode === "1710");
    // 120,000 × 12 / 60 = 24,000。
    expect(startup).toMatchObject({
      cost: 120_000n,
      startDate: "2090-04-01",
      amortizedBefore: 0n,
      fiveYears: 24_000n,
      full: 120_000n,
      posted: null,
    });
    const entry = await postDeferredAmortization(
      prisma,
      year.id,
      { accountId: refs.account("1710"), mode: "five_years" },
      { actor },
    );
    const detail = await getJournalEntryDetail(prisma, entry.id);
    expect(detail).toMatchObject({
      sourceKind: "year_end",
      sourceId: `year_end:deferred:${year.id}:${refs.account("1710")}`,
      description: "開業費の償却",
    });
    expect(detail?.lines.map((line) => [line.side, line.accountCode, line.amount])).toEqual([
      ["debit", "5480", 24_000n],
      ["credit", "1710", 24_000n],
    ]);
    await expect(
      postDeferredAmortization(
        prisma,
        year.id,
        { accountId: refs.account("1710"), mode: "full" },
        { actor },
      ),
    ).rejects.toThrow("計上済みです");
    // 創立費 of the seed (165,000, 2026/11/02): more than 60 months ago, so all of it.
    const formation = before.deferred.find((row) => row.accountCode === "1700");
    expect(formation?.fiveYears).toBe(165_000n);
    await postDeferredAmortization(
      prisma,
      year.id,
      { accountId: refs.account("1700"), mode: "five_years" },
      { actor },
    );
  });

  it("posts accruals with the reversal on the next year's first day, and voids them together", async () => {
    const prepaid = await postAccrual(
      prisma,
      year.id,
      {
        type: "prepaid_expense",
        plAccountId: refs.account("5320"),
        amount: "30,000",
        segmentId: refs.segment("platform"),
        description: "年払いのクラウド 翌期分",
      },
      { actor },
    );
    expect(prepaid.reversal?.entryDate).toBe("2091-04-01");
    const reversalEntry = await getJournalEntryDetail(prisma, prepaid.reversal!.id);
    expect(reversalEntry).toMatchObject({
      kind: "adjusting",
      sourceKind: "year_end",
      sourceId: `year_end:accrual_reversal:${prepaid.entry.id}`,
      description: "振り戻し: 年払いのクラウド 翌期分",
    });
    expect(reversalEntry?.fiscalYear.no).toBe(161);
    expect(reversalEntry?.lines.map((line) => [line.side, line.accountCode])).toEqual([
      ["credit", "1300"],
      ["debit", "5320"],
    ]);

    const accrued = await postAccrual(
      prisma,
      year.id,
      {
        type: "accrued_expense",
        plAccountId: refs.account("5320"),
        amount: "5,000",
        segmentId: refs.segment("platform"),
        description: "3 月分の通信費",
        reverse: false,
      },
      { actor },
    );
    expect(accrued.reversal).toBeNull();
    expect(
      settingsError(
        await rejectionOf(
          postAccrual(
            prisma,
            year.id,
            {
              type: "deferred_revenue",
              plAccountId: refs.account("5320"),
              amount: "1",
              reverse: false,
            },
            { actor },
          ),
        ),
      ).field,
    ).toBe("plAccountId");

    const auditBefore = await prisma.auditLog.count();
    const voided = await voidYearEndEntry(
      prisma,
      prepaid.entry.id,
      { reason: "翌期分はなかった" },
      { actor },
    );
    expect(voided.reversal.entryDate).toBe("2091-03-31");
    expect(voided.accrualReversal?.voided.id).toBe(prepaid.reversal!.id);
    expect(await status(year.id)).toEqual({ status: "closing", lockedThrough: "2091-02-28" });
    const statuses = await prisma.journalEntry.findMany({
      where: { id: { in: [prepaid.entry.id, prepaid.reversal!.id] } },
      select: { status: true },
    });
    expect(statuses.map((row) => row.status)).toEqual(["voided", "voided"]);
    // Two rows per void (the reversal's posting and the void), nothing for the status juggling.
    expect((await prisma.auditLog.count()) - auditBefore).toBe(4);
    const reversal = await getJournalEntryDetail(prisma, voided.reversal.id);
    expect(reversal).toMatchObject({ kind: "reversal", reversalOf: { id: prepaid.entry.id } });

    const checklist = await loadYearEndChecklist(prisma, year.id, { today });
    expect(checklist.accruals.entries.map((row) => [row.type, row.amount, row.reversal])).toEqual([
      ["accrued_expense", 5_000n, null],
    ]);
    expect(checklist.accruals.reversalAvailable).toBe(true);
  });

  it("refuses consumption tax in an exempt year and estimates the corporate taxes", async () => {
    await expect(
      postConsumptionTaxSettlement(prisma, year.id, { payable: "0" }, { actor }),
    ).rejects.toThrow("免税の期のため、消費税の精算は要りません");

    // 所得 = 1,100,000 − 通信費 335,000 − 減価償却費 225,000 − 創立費償却 165,000 − 開業費償却 24,000
    //      = 351,000。法人税 351,000 × 19% = 66,690 → 66,600、地方法人税 66,000 × 10.3% → 6,700、
    // 法人税割 県 600・市 3,900、均等割 20,000 + 50,000、事業税 351,000 × 3.5% → 12,200、
    // 特別法人事業税 12,200 × 37% → 4,500。合計 164,500。
    const estimate = await loadCorporateTaxEstimate(prisma, year.id);
    expect(estimate).toMatchObject({
      pretaxIncome: 351_000n,
      lossCarryforward: 0n,
      booked: 0n,
      suggested: 164_500n,
      posted: null,
      dueDate: "2091-05-31",
    });
    expect(estimate.estimate.total).toBe(164_500n);

    const entry = await postCorporateTax(prisma, year.id, { amount: "164,500" }, { actor });
    const detail = await getJournalEntryDetail(prisma, entry.id);
    expect(detail?.lines.map((line) => [line.side, line.accountCode, line.amount])).toEqual([
      ["debit", "8000", 164_500n],
      ["credit", "2120", 164_500n],
    ]);
    expect(await loadCorporateTaxEstimate(prisma, year.id)).toMatchObject({
      booked: 164_500n,
      suggested: 0n,
      posted: { id: entry.id },
    });
    await expect(postCorporateTax(prisma, year.id, { amount: "1,000" }, { actor })).rejects.toThrow(
      "計上済みです",
    );
  });

  it("records the confirmations and shows the checklist", async () => {
    await setYearEndCheck(prisma, year.id, { key: "balances", checked: true }, { actor });
    await setYearEndCheck(prisma, year.id, { key: "accruals", checked: "on" }, { actor });
    await setYearEndCheck(prisma, year.id, { key: "accruals", checked: false }, { actor });
    const checks = await setYearEndCheck(
      prisma,
      year.id,
      { key: "accruals", checked: true },
      { actor },
    );
    expect(checks.accruals?.actor).toBe(actor);
    const audit = await prisma.auditLog.findMany({
      where: { entity: "fiscal_year", entityId: year.id, action: "fiscal_year.check" },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { after: true },
    });
    expect(audit.map((row) => Object.keys(row.after as object))).toEqual([
      ["balances"],
      ["accruals"],
      ["accruals"],
      ["accruals"],
    ]);
    expect((audit[2]?.after as Record<string, unknown>).accruals).toBeNull();

    const checklist = await loadYearEndChecklist(prisma, year.id, { today });
    // Steps 1 and 2 are S5's pending lines and S6's inbox, shared by the whole test database.
    const inbox = await countInboxDocuments(prisma);
    const pending = await prisma.walletTransaction.count({
      where: { status: "pending", txnDate: { lte: year.endDate } },
    });
    expect(checklist.steps.map((step) => [step.no, step.state])).toEqual([
      [1, pending === 0 ? "done" : "todo"],
      [2, inbox === 0 ? "done" : "todo"],
      [3, "done"],
      [4, "done"],
      [5, "done"],
      [6, "na"],
      [7, "done"],
      [8, "todo"],
      [9, "pending"],
      [10, "pending"],
    ]);
    expect(checklist.closing).toMatchObject({
      netIncome: 186_500n,
      closingEntry: null,
      warnings: [],
    });
    expect(checklist.depreciation.map((row) => [row.name, row.state])).toEqual([
      ["ノート PC", "posted"],
    ]);
    // The statement balance is the wallet's last imported line on or before the year end; the
    // shared test book may hold lines of other files (S4's imports), so compare with what is there.
    const bankRow = checklist.wallets.find((row) => row.walletId === bank);
    const lastLine = await prisma.walletTransaction.findFirst({
      where: { walletId: bank, txnDate: { lte: year.endDate }, balanceAfter: { not: null } },
      orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { balanceAfter: true },
    });
    const statementBalance = lastLine?.balanceAfter ?? null;
    expect(bankRow).toMatchObject({
      statementBalance,
      difference:
        statementBalance === null ? null : statementBalance - (bankRow?.ledgerBalance ?? 0n),
    });
    expect(checklist.adjustingEntries.map((entry) => entry.purposeLabel)).toEqual([
      "伝票",
      "減価償却 ノート PC",
      "繰延資産の償却",
      "繰延資産の償却",
      "前払・未払",
      "法人税等",
    ]);
  });

  it("closes the year: the next year's opening balance-sheet is last year's plus the net income", async () => {
    const before = await loadTrialBalance(prisma, year.id);
    const result = await closeYear(prisma, year.id, {}, { actor });
    // 351,000 − 164,500 = 186,500。
    expect(result).toMatchObject({ status: "closed", netIncome: 186_500n });
    expect(result.closingEntry).not.toBeNull();
    const closing = await getJournalEntryDetail(prisma, result.closingEntry!.id);
    expect(closing).toMatchObject({
      kind: "closing",
      sourceKind: "year_end",
      sourceId: `year_end:closing:${year.id}`,
      description: "決算振替 第 160 期",
      entryDate: "2091-03-31",
    });
    expect(closing?.lines.at(-1)).toMatchObject({
      side: "credit",
      accountCode: "3200",
      amount: 186_500n,
    });
    expect((await yearAudit(year.id)).at(-1)).toMatchObject({
      action: "fiscal_year.close_year",
      after: { status: "closed", closingEntryId: result.closingEntry!.id, netIncome: "186500" },
    });

    // 受け入れ条件: the next year's balance sheet at its start = the closed year's before closing,
    // except 繰越利益剰余金 (+ net income); the P&L before it is only the other (unclosed) years'.
    const opening = await balanceAt(
      { startDate: "2091-04-01", endDate: "2092-03-31" },
      "2091-03-31",
    );
    const accounts = new Map(
      (await loadAccountRefs(prisma)).map((account) => [account.id, account]),
    );
    const balanceSheet = (tb: TrialBalance) =>
      new Map(
        tb.rows
          .filter((row) => ["asset", "liability", "equity"].includes(row.kind))
          .map((row) => [row.accountId, row.balance]),
      );
    const last = balanceSheet(before);
    const next = balanceSheet(opening);
    const retained = refs.account("3200");
    for (const id of new Set([...last.keys(), ...next.keys()])) {
      const expected = (last.get(id) ?? 0n) + (id === retained ? 186_500n : 0n);
      expect([accounts.get(id)?.code, next.get(id) ?? 0n]).toEqual([
        accounts.get(id)?.code,
        expected,
      ]);
    }
    expect(opening.totals.priorPeriodsProfit).toBe(before.totals.priorPeriodsProfit);
    assertTrialBalanceIdentity(opening);
    expect(opening.rows.some((row) => row.kind === "revenue" || row.kind === "expense")).toBe(
      false,
    );

    const balances = await loadYearEndBalances(prisma, year.id);
    expect(balances.balanced).toBe(true);
    // The rows before closing are the closed year's trial balance; after it, the next year's.
    for (const row of balances.rows) {
      expect([row.code, row.beforeClosing, row.opening]).toEqual([
        row.code,
        last.get(row.accountId) ?? 0n,
        next.get(row.accountId) ?? 0n,
      ]);
    }
    expect(balances.rows.length).toBe(
      [...new Set([...last.keys(), ...next.keys()])].filter(
        (id) => (last.get(id) ?? 0n) !== 0n || (next.get(id) ?? 0n) !== 0n,
      ).length,
    );
    expect(balances.netIncome).toBe(186_500n);
    expect(balances.rows.find((row) => row.code === "3200")?.closing).toBe(186_500n);
    expect(balances.closingEntry?.id).toBe(result.closingEntry!.id);
  });

  it("refuses to post, void or correct anything in the closed year", async () => {
    expect(
      ledgerCodes(
        await rejectionOf(
          postVoucherEntry(
            prisma,
            {
              kind: "adjusting",
              entryDate: "2091-03-31",
              description: "遅れた決算整理",
              partnerId: "",
              memoTagIds: [],
              lines: [
                {
                  side: "debit",
                  accountId: refs.account("1350"),
                  amount: "1",
                  taxCategoryCode: "na",
                },
                {
                  side: "credit",
                  accountId: refs.account("1100"),
                  amount: "1",
                  taxCategoryCode: "na",
                },
              ],
            },
            { actor },
          ),
        ),
      ),
    ).toContain("FISCAL_YEAR_CLOSED");
    expect(
      ledgerCodes(
        await rejectionOf(
          voidJournalEntryWithOpenDate(prisma, incomeEntry, { reason: "誤り" }, { actor }),
        ),
      ),
    ).toEqual(["FISCAL_YEAR_CLOSED"]);
    expect(
      ledgerCodes(
        await rejectionOf(
          correctJournalEntry(
            prisma,
            incomeEntry,
            {
              reason: "誤り",
              replacement: {
                kind: "normal",
                entryDate: "2090-05-20",
                description: "月会費",
                partnerId: "",
                memoTagIds: [],
                lines: [
                  {
                    side: "debit",
                    accountId: refs.account("1100"),
                    amount: "1",
                    taxCategoryCode: "na",
                  },
                  {
                    side: "credit",
                    accountId: refs.account("4010"),
                    amount: "1",
                    taxCategoryCode: "sales_10",
                    segmentId: refs.segment("kamakura"),
                  },
                ],
              },
            },
            { actor },
          ),
        ),
      ),
    ).toEqual(["FISCAL_YEAR_CLOSED"]);
    expect((await getJournalEntryDetail(prisma, incomeEntry))?.blockedReason).toBe(
      "第 160 期は決算済みのため、訂正・取消はできません",
    );
    const adjusting = (await loadYearEndChecklist(prisma, year.id, { today })).adjustingEntries[0]!;
    await expect(
      voidYearEndEntry(prisma, adjusting.id, { reason: "誤り" }, { actor }),
    ).rejects.toThrow("第 160 期は締め済みのため、取り消せません");
    await expect(postCorporateTax(prisma, year.id, { amount: "1" }, { actor })).rejects.toThrow(
      "決算整理を始めてから計上してください",
    );
    await expect(
      setYearEndCheck(prisma, year.id, { key: "balances", checked: false }, { actor }),
    ).rejects.toThrow("締め済み");
  });

  it("reopens with a reason, once the next year is not closed, and can close again", async () => {
    // 第 161 期 can start now; closing it (no P&L there: the reversal was voided) blocks the reopening.
    expect(
      (await loadYearEndChecklist(prisma, nextYear.id, { today: "2092-05-01" })).canStart,
    ).toBe(true);
    await startYearEnd(prisma, nextYear.id, {}, { actor, today: "2092-05-01" });
    expect(await closeYear(prisma, nextYear.id, {}, { actor })).toMatchObject({
      status: "closed",
      closingEntry: null,
      netIncome: 0n,
    });
    await expect(reopenYear(prisma, year.id, { reason: "やり直し" }, { actor })).rejects.toThrow(
      "第 161 期が締め済みのため、第 160 期の締めは戻せません",
    );
    await reopenYear(prisma, nextYear.id, { reason: "第 160 期を直す" }, { actor });
    expect(
      settingsError(
        await rejectionOf(cancelYearEnd(prisma, nextYear.id, { reason: "" }, { actor })),
      ),
    ).toEqual({ message: "決算整理をやめる理由を入力してください", field: "reason" });
    expect(
      await cancelYearEnd(prisma, nextYear.id, { reason: "第 160 期を直す" }, { actor }),
    ).toMatchObject({ status: "open", lockedThrough: null });

    expect(settingsError(await rejectionOf(reopenYear(prisma, year.id, {}, { actor })))).toEqual({
      message: "締めを戻す理由を入力してください",
      field: "reason",
    });
    const closingEntry = (await loadYearEndBalances(prisma, year.id)).closingEntry!;
    const reopened = await reopenYear(prisma, year.id, { reason: "法人税等を直す" }, { actor });
    expect(reopened).toMatchObject({ status: "closing", closingEntry: { id: closingEntry.id } });
    expect(await status(year.id)).toEqual({ status: "closing", lockedThrough: "2091-02-28" });
    const voided = await getJournalEntryDetail(prisma, closingEntry.id);
    expect(voided).toMatchObject({ status: "voided", voidReason: "法人税等を直す" });
    expect(voided?.reversal).not.toBeNull();
    expect((await yearAudit(year.id)).at(-1)).toMatchObject({
      action: "fiscal_year.reopen_year",
      before: { status: "closed" },
      after: { status: "closing", voidedClosingEntryId: closingEntry.id },
      reason: "法人税等を直す",
    });

    const again = await closeYear(prisma, year.id, {}, { actor });
    expect(again.netIncome).toBe(186_500n);
    expect(again.closingEntry?.id).not.toBe(closingEntry.id);
    expect((await loadYearEndBalances(prisma, year.id)).balanced).toBe(true);
  });

  it("settles the consumption tax of a taxable, tax-exclusive year", async () => {
    const taxable = await createFiscalYear(prisma, {
      no: 164,
      startDate: "2094-04-01",
      endDate: "2095-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    const day = "2095-05-01";
    // The test book may hold small unsettled tax lines of other years: compare with what was there
    // (the amounts here are large enough to keep every balance positive).
    const before = (await loadYearEndChecklist(prisma, taxable.id, { today: day })).consumptionTax;
    await postSimpleEntry(prisma, simple("income", "2094-06-01", "11,000,000"), { actor });
    await postSimpleEntry(prisma, simple("expense", "2094-06-02", "3,300,000"), { actor });
    await startYearEnd(prisma, taxable.id, {}, { actor, today: day });
    const checklist = await loadYearEndChecklist(prisma, taxable.id, { today: day });
    const tax = checklist.consumptionTax;
    expect(tax).toMatchObject({
      applicable: true,
      outputTaxBalance: before.outputTaxBalance + 1_000_000n,
      inputTaxBalance: before.inputTaxBalance + 300_000n,
      posted: null,
    });
    expect(checklist.steps[5]?.state).toBe("todo");

    const payable = tax.suggestedPayable - 100n;
    const entry = await postConsumptionTaxSettlement(
      prisma,
      taxable.id,
      { payable: payable.toString() },
      { actor },
    );
    const detail = await getJournalEntryDetail(prisma, entry.id);
    expect(detail).toMatchObject({
      sourceKind: "year_end",
      sourceId: `year_end:consumption_tax:${taxable.id}`,
    });
    const difference = tax.outputTaxBalance - tax.inputTaxBalance - payable;
    expect(detail?.lines.map((line) => [line.side, line.accountCode, line.amount])).toEqual([
      ["debit", "2310", tax.outputTaxBalance],
      ["credit", "1400", tax.inputTaxBalance],
      ["credit", "2130", payable],
      ["credit", "4510", difference],
    ]);
    await expect(
      postConsumptionTaxSettlement(prisma, taxable.id, { payable: "100" }, { actor }),
    ).rejects.toThrow("計上済みです");
    const after = await loadYearEndChecklist(prisma, taxable.id, { today: day });
    expect(after.steps[5]).toMatchObject({ state: "done" });
    expect(after.consumptionTax.posted?.id).toBe(entry.id);
  });
});
