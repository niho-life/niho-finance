import { assertSequence, LedgerValidationError, type CalendarDate } from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import {
  countPendingWalletTransactions,
  createRule,
  createWallet,
  describeAuditTargets,
  findTransferCandidates,
  getWalletTransaction,
  ignoreWalletTransaction,
  listWalletTransactions,
  registerWalletTransaction,
  reopenWalletTransaction,
  setWalletActive,
  settleImportedWalletTransactions,
  StatementError,
  toDbDate,
  transferWalletTransaction,
  updateWalletTransactionNote,
  voidJournalEntryWithOpenDate,
  type RegisterStatementInput,
  type RuleCreateInput,
  type WalletSettings,
} from "../src";
import { SettingsError } from "../src/errors";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";

function ledgerErrors(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
}

function statementCode(error: unknown) {
  expect(error).toBeInstanceOf(StatementError);
  const { code, field } = error as StatementError;
  return { code, field };
}

/**
 * 明細 (15-statements §1, §3, §8, §11) on the seeded book. Every test works with wallets and fiscal
 * years of its own (第 61〜64 期), far from the seeded lines that the seed test checks.
 */
describe.skipIf(!hasTestDatabase)("statements (明細)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 61 期: exempt, tax-inclusive, closed through 2061-04-30. */
  let exemptYear: FiscalYear;
  /** 第 62 期: 本則課税, tax-exclusive. */
  let exclusiveYear: FiscalYear;
  let bank: WalletSettings;
  let card: WalletSettings;
  let cash: WalletSettings;
  let externalNo = 0;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    exemptYear = await createFiscalYear(prisma, {
      no: 61,
      startDate: "2061-04-01",
      endDate: "2062-03-31",
      lockedThrough: "2061-04-30",
    });
    exclusiveYear = await createFiscalYear(prisma, {
      no: 62,
      startDate: "2062-04-01",
      endDate: "2063-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    await createFiscalYear(prisma, { no: 63, startDate: "2063-04-01", endDate: "2064-03-31" });
    await createFiscalYear(prisma, { no: 64, startDate: "2064-04-01", endDate: "2065-03-31" });
    bank = await createWallet(prisma, { name: "明細テスト銀行", kind: "bank" }, { actor });
    card = await createWallet(prisma, { name: "明細テストカード", kind: "card" }, { actor });
    cash = await createWallet(
      prisma,
      { name: "明細テスト現金", kind: "cash", defaultSegmentId: refs.segment("corporate") },
      { actor },
    );
  });

  async function addLine(
    wallet: { id: string },
    txnDate: CalendarDate,
    amount: bigint,
    descriptionRaw: string,
    counterpartyRaw: string | null = null,
  ): Promise<string> {
    externalNo += 1;
    const row = await prisma.walletTransaction.create({
      data: {
        id: `01TEST${String(externalNo).padStart(20, "0")}`,
        walletId: wallet.id,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw,
        counterpartyRaw,
        externalId: `test-statements-${externalNo}`,
      },
    });
    return row.id;
  }

  const oneLine = (overrides: Record<string, unknown> = {}): RegisterStatementInput => ({
    description: "",
    partnerId: "",
    lines: [
      {
        accountId: refs.account("5330"),
        amount: "",
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("corporate"),
        partnerId: "",
        description: "",
        ...overrides,
      },
    ],
  });

  async function linesOf(entryId: string) {
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      orderBy: { lineNo: "asc" },
      include: { account: { select: { code: true } } },
    });
    return lines.map((line) => [
      line.side,
      line.account.code,
      line.amount,
      line.taxCategoryCode,
      line.taxAmount,
    ]);
  }

  async function auditOf(entityId: string) {
    return prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      select: { action: true, actor: true, before: true, after: true, reason: true },
    });
  }

  async function lineState(id: string) {
    return prisma.walletTransaction.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        journalEntryId: true,
        ignoredReason: true,
        ruleId: true,
        autoPosted: true,
        settledAt: true,
        note: true,
      },
    });
  }

  async function nextNo(year: FiscalYear): Promise<number> {
    return (await prisma.fiscalYear.findUniqueOrThrow({ where: { id: year.id } })).nextEntryNo;
  }

  describe("登録", () => {
    it("posts one entry on the line's date from the statement line, and logs it", async () => {
      const id = await addLine(bank, "2061-05-10", -3_300n, "テスト文具店 文具");
      const result = await registerWalletTransaction(prisma, id, oneLine(), { actor });
      expect(result.transactionIds).toEqual([id]);
      const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entry.id } });
      expect(entry).toMatchObject({
        fiscalYearId: exemptYear.id,
        no: result.entry.no,
        kind: "normal",
        sourceKind: "wallet_txn",
        sourceId: id,
        description: "テスト文具店 文具",
        entryDate: toDbDate("2061-05-10"),
        createdBy: actor,
      });
      expect(await linesOf(entry.id)).toEqual([
        ["debit", "5330", 3_300n, "purchase_10", 300n],
        ["credit", "1100", 3_300n, "na", 0n],
      ]);
      const walletLine = await prisma.journalLine.findFirstOrThrow({
        where: { journalEntryId: entry.id, side: "credit" },
      });
      expect(walletLine.subAccountId).toBe(bank.subAccountId);

      const state = await lineState(id);
      expect(state).toMatchObject({
        status: "registered",
        journalEntryId: entry.id,
        autoPosted: false,
        ruleId: null,
      });
      expect(state.settledAt).toBeInstanceOf(Date);
      const audit = await auditOf(id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: "wallet_transaction.register",
        actor,
        before: { status: "pending", journalEntryId: null, autoPosted: false },
        after: { status: "registered", journalEntryId: entry.id, autoPosted: false },
      });

      const again = await rejectionOf(registerWalletTransaction(prisma, id, oneLine(), { actor }));
      expect(statementCode(again)).toEqual({ code: "STATEMENT_NOT_PENDING", field: undefined });
      expect((again as Error).message).toBe("この明細は処理済みです。画面を読み込み直してください");
    });

    it("splits a line into balanced lines, and refuses lines that do not add up", async () => {
      const id = await addLine(card, "2061-05-12", -3_980n, "テスト書店 文具と本");
      const stationery = {
        accountId: refs.account("5330"),
        amount: "2,200",
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("corporate"),
      };
      const books = {
        accountId: refs.account("5420"),
        amount: "1780",
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("contract"),
        description: "書籍",
      };
      const split: RegisterStatementInput = {
        description: "文具と本",
        partnerId: "",
        lines: [stationery, books],
      };
      const result = await registerWalletTransaction(prisma, id, split, { actor });
      expect(await linesOf(result.entry.id)).toEqual([
        ["debit", "5330", 2_200n, "purchase_10", 200n],
        ["debit", "5420", 1_780n, "purchase_10", 161n],
        ["credit", "2100", 3_980n, "na", 0n],
      ]);
      expect((await getWalletTransaction(prisma, id))?.entry).toMatchObject({
        no: result.entry.no,
        status: "posted",
        summary: "消耗品費 ほか 1 行",
      });

      const other = await addLine(card, "2061-05-13", -3_980n, "テスト書店 文具と本");
      const before = await nextNo(exemptYear);
      const unbalanced = await rejectionOf(
        registerWalletTransaction(
          prisma,
          other,
          {
            ...split,
            lines: [
              { ...stationery, amount: "2,000" },
              { ...books, amount: "1,500" },
            ],
          },
          { actor },
        ),
      );
      expect(ledgerErrors(unbalanced)).toEqual([{ code: "UNBALANCED", field: "lines" }]);
      expect((unbalanced as Error).message).toContain(
        "行の合計 3,500 円が明細の金額 3,980 円と合いません",
      );
      const blank = await rejectionOf(
        registerWalletTransaction(
          prisma,
          other,
          { ...split, lines: [stationery, { ...books, amount: "" }] },
          { actor },
        ),
      );
      expect(ledgerErrors(blank)).toEqual([{ code: "INVALID_AMOUNT", field: "lines.1.amount" }]);
      expect(await nextNo(exemptYear)).toBe(before);
      expect(await lineState(other)).toMatchObject({ status: "pending", journalEntryId: null });
      expect(await auditOf(other)).toEqual([]);
    });

    it("adds one 仮払 / 仮受消費税 line in a tax-exclusive year", async () => {
      const paid = await addLine(bank, "2062-05-10", -3_300n, "テスト事務 備品");
      const split = await registerWalletTransaction(
        prisma,
        paid,
        {
          lines: [
            {
              accountId: refs.account("5330"),
              amount: "2,200",
              taxCategoryCode: "purchase_10",
              segmentId: refs.segment("corporate"),
            },
            {
              accountId: refs.account("5420"),
              amount: "1,100",
              taxCategoryCode: "purchase_10",
              segmentId: refs.segment("contract"),
            },
          ],
        },
        { actor },
      );
      expect(await linesOf(split.entry.id)).toEqual([
        ["debit", "5330", 2_000n, "purchase_10", 200n],
        ["debit", "5420", 1_000n, "purchase_10", 100n],
        ["debit", "1400", 300n, "na", 0n],
        ["credit", "1100", 3_300n, "na", 0n],
      ]);
      expect((await getWalletTransaction(prisma, paid))?.entry?.summary).toBe("消耗品費 ほか 1 行");

      const received = await addLine(bank, "2062-05-20", 11_000n, "テスト会費 入金");
      const income = await registerWalletTransaction(
        prisma,
        received,
        oneLine({
          accountId: refs.account("4010"),
          taxCategoryCode: "sales_10",
          segmentId: refs.segment("kamakura"),
        }),
        { actor },
      );
      expect(await linesOf(income.entry.id)).toEqual([
        ["debit", "1100", 11_000n, "na", 0n],
        ["credit", "4010", 10_000n, "sales_10", 1_000n],
        ["credit", "2310", 1_000n, "na", 0n],
      ]);
      expect(
        (await prisma.journalEntry.findUniqueOrThrow({ where: { id: income.entry.id } }))
          .fiscalYearId,
      ).toBe(exclusiveYear.id);
      expect((await getWalletTransaction(prisma, received))?.entry?.summary).toBe("売上高 会費");
    });

    it("names the line of a missing segment, money in and out alike", async () => {
      const paid = await addLine(bank, "2061-05-15", -1_100n, "テスト 交通費");
      const outError = await rejectionOf(
        registerWalletTransaction(prisma, paid, oneLine({ segmentId: "" }), { actor }),
      );
      expect(ledgerErrors(outError)).toEqual([
        { code: "SEGMENT_REQUIRED", field: "lines.0.segmentId" },
      ]);
      expect((outError as LedgerValidationError).errors[0]?.message).toBe(
        "セグメントを選んでください",
      );
      const received = await addLine(bank, "2061-05-15", 2_200n, "テスト 入金");
      const inError = await rejectionOf(
        registerWalletTransaction(
          prisma,
          received,
          oneLine({ accountId: refs.account("4010"), taxCategoryCode: "sales_10", segmentId: "" }),
          { actor },
        ),
      );
      expect(ledgerErrors(inError)).toEqual([
        { code: "SEGMENT_REQUIRED", field: "lines.0.segmentId" },
      ]);
      const reserved = await rejectionOf(
        registerWalletTransaction(
          prisma,
          paid,
          oneLine({ accountId: refs.account("1100"), taxCategoryCode: "na" }),
          { actor },
        ),
      );
      expect(ledgerErrors(reserved)).toEqual([
        { code: "ACCOUNT_NOT_ALLOWED", field: "lines.0.accountId" },
      ]);
    });

    it("refuses a closed month and a date outside the fiscal years; the line stays pending", async () => {
      const locked = await addLine(bank, "2061-04-15", -550n, "テスト 締め済み");
      const error = await rejectionOf(
        registerWalletTransaction(prisma, locked, oneLine(), { actor }),
      );
      expect(ledgerErrors(error)).toEqual([{ code: "PERIOD_LOCKED", field: "entryDate" }]);
      expect((error as Error).message).toContain(
        "2061/04/30 までは締めています。登録するには 設定 › 会計期間 で締めを戻してください",
      );
      expect(await lineState(locked)).toMatchObject({ status: "pending", journalEntryId: null });

      const outside = await addLine(bank, "2098-06-01", -550n, "テスト 期の外");
      expect(
        ledgerErrors(
          await rejectionOf(registerWalletTransaction(prisma, outside, oneLine(), { actor })),
        ),
      ).toEqual([{ code: "OUT_OF_FISCAL_YEAR", field: "entryDate" }]);
    });

    it("refuses lines of inactive wallets and lines of 0 yen, which can only be ignored", async () => {
      const closed = await createWallet(
        prisma,
        { name: "明細テスト旧口座", kind: "bank" },
        { actor },
      );
      const old = await addLine(closed, "2061-05-20", -500n, "テスト 旧口座");
      await setWalletActive(prisma, { id: closed.id, isActive: false }, { actor });
      const error = await rejectionOf(registerWalletTransaction(prisma, old, oneLine(), { actor }));
      expect(statementCode(error)).toEqual({ code: "WALLET_INACTIVE", field: undefined });
      expect((error as Error).message).toBe(
        "口座「明細テスト旧口座」は無効です。設定 › 口座 で有効にしてください",
      );

      const zero = await addLine(bank, "2061-05-20", 0n, "テスト 残高調整");
      expect(
        statementCode(
          await rejectionOf(registerWalletTransaction(prisma, zero, oneLine(), { actor })),
        ),
      ).toEqual({ code: "ZERO_AMOUNT", field: undefined });
      await ignoreWalletTransaction(prisma, zero, { reason: "残高調整" }, { actor });
      expect(await lineState(zero)).toMatchObject({ status: "ignored", ignoredReason: "残高調整" });
    });

    it("registers a line once under concurrent requests, without gaps in the numbering", async () => {
      const id = await addLine(bank, "2061-06-30", -880n, "テスト 同時");
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          registerWalletTransaction(prisma, id, oneLine(), { actor }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(statementCode(result.reason)).toMatchObject({ code: "STATEMENT_NOT_PENDING" });
        }
      }
      expect(await prisma.journalEntry.count({ where: { sourceId: id } })).toBe(1);
      assertSequence(
        await prisma.journalEntry.findMany({
          where: { fiscalYearId: exemptYear.id },
          select: { no: true },
        }),
      );
    });
  });

  describe("振替", () => {
    it("ties the other wallet's line: one entry on the paying date, both lines pointing at it", async () => {
      const out = await addLine(bank, "2061-06-01", -10_000n, "テスト ATM 引出");
      const into = await addLine(cash, "2061-06-03", 10_000n, "テスト 現金 入金");
      const candidates = await findTransferCandidates(prisma, [out]);
      expect(candidates.get(out)?.map((candidate) => [candidate.kind, candidate.id])).toEqual([
        ["txn", into],
      ]);
      const result = await transferWalletTransaction(
        prisma,
        out,
        { counterpart: `txn:${into}` },
        { actor },
      );
      expect(result.transactionIds).toEqual([out, into]);
      const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: result.entry.id } });
      expect(entry).toMatchObject({
        kind: "transfer",
        sourceKind: "wallet_txn",
        sourceId: out,
        entryDate: toDbDate("2061-06-01"),
        description: "振替 明細テスト銀行 → 明細テスト現金",
      });
      expect(await linesOf(entry.id)).toEqual([
        ["debit", "1000", 10_000n, "na", 0n],
        ["credit", "1100", 10_000n, "na", 0n],
      ]);
      for (const id of [out, into]) {
        expect(await lineState(id)).toMatchObject({ status: "transfer", journalEntryId: entry.id });
        expect((await auditOf(id)).map((row) => row.action)).toEqual([
          "wallet_transaction.transfer",
        ]);
      }
      expect((await getWalletTransaction(prisma, into))?.entry?.summary).toBe(
        "振替 → 明細テスト銀行",
      );
      expect((await getWalletTransaction(prisma, out))?.entry?.summary).toBe(
        "振替 → 明細テスト現金",
      );

      // From the receiving line: the entry is still dated on the paying line's date.
      const later = await addLine(cash, "2061-06-08", 5_000n, "テスト 預入の受取");
      const paying = await addLine(bank, "2061-06-10", -5_000n, "テスト 預入");
      const second = await transferWalletTransaction(
        prisma,
        later,
        { counterpart: `txn:${paying}` },
        { actor },
      );
      expect(second.transactionIds).toEqual([later, paying]);
      expect(
        (await prisma.journalEntry.findUniqueOrThrow({ where: { id: second.entry.id } })).entryDate,
      ).toEqual(toDbDate("2061-06-10"));
    });

    it("transfers to a wallet alone, with the fee taken from the paying side", async () => {
      const out = await addLine(bank, "2061-07-01", -10_000n, "テスト 送金");
      const sent = await transferWalletTransaction(
        prisma,
        out,
        { counterpart: `wallet:${cash.id}`, fee: "440" },
        { actor },
      );
      expect(sent.transactionIds).toEqual([out]);
      expect(await linesOf(sent.entry.id)).toEqual([
        ["debit", "1000", 9_560n, "na", 0n],
        ["debit", "5400", 440n, "purchase_10", 40n],
        ["credit", "1100", 10_000n, "na", 0n],
      ]);
      const into = await addLine(cash, "2061-07-02", 5_000n, "テスト 受取");
      const received = await transferWalletTransaction(
        prisma,
        into,
        { counterpart: `wallet:${bank.id}`, fee: "220" },
        { actor },
      );
      expect(await linesOf(received.entry.id)).toEqual([
        ["debit", "1000", 5_000n, "na", 0n],
        ["debit", "5400", 220n, "purchase_10", 20n],
        ["credit", "1100", 5_220n, "na", 0n],
      ]);
      expect(
        (await prisma.journalEntry.findUniqueOrThrow({ where: { id: received.entry.id } }))
          .description,
      ).toBe("振替 明細テスト銀行 → 明細テスト現金");
    });

    it("links a later line to a transfer registered from one side, without a new entry", async () => {
      const out = await addLine(bank, "2061-07-20", -1_650n, "テスト カード引落");
      const first = await transferWalletTransaction(
        prisma,
        out,
        { counterpart: `wallet:${card.id}` },
        { actor },
      );
      const repaid = await addLine(card, "2061-07-22", 1_650n, "テスト 口座振替");
      const candidates = (await findTransferCandidates(prisma, [repaid])).get(repaid) ?? [];
      expect(candidates).toEqual([
        expect.objectContaining({
          kind: "entry",
          id: first.entry.id,
          walletId: bank.id,
          entryNo: first.entry.no,
          amount: -1_650n,
        }),
      ]);
      const before = await nextNo(exemptYear);
      const linked = await transferWalletTransaction(
        prisma,
        repaid,
        { counterpart: `entry:${first.entry.id}` },
        { actor },
      );
      expect(linked).toEqual({ entry: first.entry, transactionIds: [repaid] });
      expect(await nextNo(exemptYear)).toBe(before);
      expect(await lineState(repaid)).toMatchObject({
        status: "transfer",
        journalEntryId: first.entry.id,
      });

      // The entry has its card line now: it is no longer offered to another card line.
      const twin = await addLine(card, "2061-07-23", 1_650n, "テスト 口座振替");
      expect((await findTransferCandidates(prisma, [twin])).get(twin)).toBeUndefined();
      expect(
        statementCode(
          await rejectionOf(
            transferWalletTransaction(
              prisma,
              twin,
              { counterpart: `entry:${first.entry.id}` },
              { actor },
            ),
          ),
        ),
      ).toEqual({ code: "CANDIDATE_MISMATCH", field: "counterpart" });

      // 未処理に戻す on the matched line only unlinks it: the entry it was matched to stays posted.
      const unlinked = await reopenWalletTransaction(prisma, repaid, {}, { actor });
      expect(unlinked).toEqual({ reopenedIds: [repaid], reversal: null });
      expect(await lineState(repaid)).toMatchObject({ status: "pending", journalEntryId: null });
      expect(await lineState(out)).toMatchObject({
        status: "transfer",
        journalEntryId: first.entry.id,
      });
      expect(
        (await prisma.journalEntry.findUniqueOrThrow({ where: { id: first.entry.id } })).status,
      ).toBe("posted");
    });

    it("refuses counterparts that do not match: amount, ±5 days, the same wallet, a fee", async () => {
      const out = await addLine(bank, "2061-08-01", -2_000n, "テスト 照合");
      const wrongAmount = await addLine(cash, "2061-08-01", 2_001n, "テスト 照合");
      const tooLate = await addLine(cash, "2061-08-07", 2_000n, "テスト 照合");
      const sameWallet = await addLine(bank, "2061-08-02", 2_000n, "テスト 照合");
      const inTime = await addLine(cash, "2061-08-06", 2_000n, "テスト 照合");
      for (const other of [wrongAmount, tooLate, sameWallet]) {
        expect(
          statementCode(
            await rejectionOf(
              transferWalletTransaction(prisma, out, { counterpart: `txn:${other}` }, { actor }),
            ),
          ),
        ).toEqual({ code: "CANDIDATE_MISMATCH", field: "counterpart" });
      }
      expect(
        ledgerErrors(
          await rejectionOf(
            transferWalletTransaction(
              prisma,
              out,
              { counterpart: `txn:${inTime}`, fee: "100" },
              { actor },
            ),
          ),
        ),
      ).toEqual([{ code: "INVALID_AMOUNT", field: "fee" }]);
      expect(
        ledgerErrors(
          await rejectionOf(
            transferWalletTransaction(prisma, out, { counterpart: `wallet:${bank.id}` }, { actor }),
          ),
        ),
      ).toEqual([{ code: "SAME_WALLET", field: "counterpart" }]);
      expect(await lineState(out)).toMatchObject({ status: "pending" });
      // Exactly 5 days apart is still a candidate.
      await transferWalletTransaction(prisma, out, { counterpart: `txn:${inTime}` }, { actor });
      expect(await lineState(inTime)).toMatchObject({ status: "transfer" });
    });

    it("offers candidates within ±5 days in other active wallets only", async () => {
      const closed = await createWallet(
        prisma,
        { name: "明細テスト休止", kind: "cash" },
        { actor },
      );
      const target = await addLine(bank, "2063-05-10", -7_777n, "テスト 候補");
      const nearest = await addLine(cash, "2063-05-15", 7_777n, "テスト 候補 5 日後");
      const earlier = await addLine(cash, "2063-05-06", 7_777n, "テスト 候補 4 日前");
      await addLine(card, "2063-05-16", 7_777n, "テスト 候補 6 日後");
      await addLine(card, "2063-05-04", 7_777n, "テスト 候補 6 日前");
      await addLine(bank, "2063-05-11", 7_777n, "テスト 同じ口座");
      await addLine(cash, "2063-05-10", 7_778n, "テスト 金額違い");
      await addLine(closed, "2063-05-10", 7_777n, "テスト 無効な口座");
      await setWalletActive(prisma, { id: closed.id, isActive: false }, { actor });
      const found = (await findTransferCandidates(prisma, [target])).get(target) ?? [];
      expect(found.map((candidate) => candidate.id)).toEqual([earlier, nearest]);
      expect(found[0]).toMatchObject({
        kind: "txn",
        walletId: cash.id,
        date: "2063-05-06",
        amount: 7_777n,
        description: "テスト 候補 4 日前",
        entryNo: null,
      });
      const row = await getWalletTransaction(prisma, target);
      expect(row?.candidates.map((candidate) => candidate.id)).toEqual([earlier, nearest]);
      expect(row?.suggestion).toMatchObject({
        mode: "transfer",
        source: "candidate",
        transferToWalletId: cash.id,
        candidate: { kind: "txn", id: earlier },
      });
    });
  });

  describe("無視・未処理に戻す・メモ", () => {
    it("ignores with a reason and reopens without one", async () => {
      const id = await addLine(card, "2061-09-01", -1_200n, "テスト コンビニ 私用");
      await ignoreWalletTransaction(prisma, id, { reason: "私用" }, { actor });
      const ignored = await lineState(id);
      expect(ignored).toMatchObject({
        status: "ignored",
        ignoredReason: "私用",
        journalEntryId: null,
      });
      expect(ignored.settledAt).toBeInstanceOf(Date);
      expect(
        statementCode(await rejectionOf(ignoreWalletTransaction(prisma, id, {}, { actor }))),
      ).toMatchObject({ code: "STATEMENT_NOT_PENDING" });

      expect(await reopenWalletTransaction(prisma, id, {}, { actor })).toEqual({
        reopenedIds: [id],
        reversal: null,
      });
      expect(await lineState(id)).toMatchObject({
        status: "pending",
        ignoredReason: null,
        settledAt: null,
        ruleId: null,
        autoPosted: false,
      });
      expect(
        statementCode(await rejectionOf(reopenWalletTransaction(prisma, id, {}, { actor }))),
      ).toMatchObject({ code: "STATEMENT_NOT_SETTLED" });
      const audit = await auditOf(id);
      expect(audit.map((row) => [row.action, row.reason])).toEqual([
        ["wallet_transaction.ignore", "私用"],
        ["wallet_transaction.reopen", null],
      ]);
      expect(audit[1]).toMatchObject({
        before: { status: "ignored", ignoredReason: "私用" },
        after: { status: "pending", ignoredReason: null },
      });

      await updateWalletTransactionNote(prisma, id, { note: "レシートは紙で保管" }, { actor });
      expect(await lineState(id)).toMatchObject({ note: "レシートは紙で保管", status: "pending" });
      expect((await auditOf(id)).at(-1)).toMatchObject({
        action: "wallet_transaction.update",
        before: { note: null },
        after: { note: "レシートは紙で保管" },
      });
      const targets = await describeAuditTargets(prisma, [
        { entity: "wallet_transaction", entityId: id },
      ]);
      expect(targets.get(`wallet_transaction:${id}`)).toBe("明細 2061/09/01 −1,200");
    });

    it("reopens a registered line with a reversal (the 5-second undo), the reason required", async () => {
      const id = await addLine(bank, "2061-09-05", -2_200n, "テスト 取消");
      const posted = await registerWalletTransaction(prisma, id, oneLine(), { actor });
      const missing = await rejectionOf(
        reopenWalletTransaction(prisma, id, { reason: " " }, { actor }),
      );
      expect(missing).toBeInstanceOf(SettingsError);
      expect(missing).toMatchObject({ field: "reason", message: "理由を入力してください" });

      const result = await reopenWalletTransaction(
        prisma,
        id,
        { reason: "登録直後の取消" },
        { actor },
      );
      expect(result.reopenedIds).toEqual([id]);
      expect(result.reversal).toMatchObject({ entryDate: "2061-09-05" });
      const original = await prisma.journalEntry.findUniqueOrThrow({
        where: { id: posted.entry.id },
      });
      expect(original).toMatchObject({ status: "voided", voidReason: "登録直後の取消" });
      const reversal = await prisma.journalEntry.findUniqueOrThrow({
        where: { id: result.reversal?.id ?? "" },
      });
      expect(reversal).toMatchObject({ kind: "reversal", reversalOfId: posted.entry.id });
      expect(reversal.no).toBe(posted.entry.no + 1);
      expect(await lineState(id)).toMatchObject({
        status: "pending",
        journalEntryId: null,
        settledAt: null,
      });
      expect((await auditOf(id)).map((row) => [row.action, row.reason])).toEqual([
        ["wallet_transaction.register", null],
        ["wallet_transaction.reopen", "登録直後の取消"],
      ]);
      // Registered again from the same line, it gets a new entry.
      const again = await registerWalletTransaction(prisma, id, oneLine(), { actor });
      expect(again.entry.no).toBe(posted.entry.no + 2);
    });

    it("dates the reversal on the first open day when the month has been closed since", async () => {
      const year = await prisma.fiscalYear.findFirstOrThrow({ where: { no: 64 } });
      const id = await addLine(bank, "2064-05-10", -1_100n, "テスト 締め後の取消");
      await registerWalletTransaction(prisma, id, oneLine(), { actor });
      await prisma.fiscalYear.update({
        where: { id: year.id },
        data: { lockedThrough: toDbDate("2064-05-31") },
      });
      const result = await reopenWalletTransaction(prisma, id, { reason: "科目の誤り" }, { actor });
      expect(result.reversal?.entryDate).toBe("2064-06-01");
      expect(await lineState(id)).toMatchObject({ status: "pending" });
    });

    it("reopens both lines of a transfer pair, and skips the void of an entry voided elsewhere", async () => {
      const out = await addLine(bank, "2061-10-01", -3_000n, "テスト 両替");
      const into = await addLine(cash, "2061-10-01", 3_000n, "テスト 両替");
      const pair = await transferWalletTransaction(
        prisma,
        into,
        { counterpart: `txn:${out}` },
        { actor },
      );
      // The entry was posted for the line the owner settled (`into`): from that line, 未処理に戻す
      // voids it and both lines go back; the list tells the two apart (`ownsEntry`).
      const listed = await listWalletTransactions(prisma, { status: "transfer", q: "テスト 両替" });
      expect(
        Object.fromEntries(listed.rows.map((row) => [row.id, row.entry?.ownsEntry ?? null])),
      ).toEqual({ [out]: false, [into]: true });
      const reopened = await reopenWalletTransaction(
        prisma,
        into,
        { reason: "相手の誤り" },
        { actor },
      );
      expect(reopened.reopenedIds).toEqual([out, into].sort());
      expect(reopened.reversal).not.toBeNull();
      for (const id of [out, into]) {
        expect(await lineState(id)).toMatchObject({ status: "pending", journalEntryId: null });
      }
      expect(
        (await prisma.journalEntry.findUniqueOrThrow({ where: { id: pair.entry.id } })).status,
      ).toBe("voided");

      const id = await addLine(bank, "2061-10-05", -1_000n, "テスト 取引の画面で取消");
      const posted = await registerWalletTransaction(prisma, id, oneLine(), { actor });
      await voidJournalEntryWithOpenDate(prisma, posted.entry.id, { reason: "重複" }, { actor });
      const result = await reopenWalletTransaction(prisma, id, { reason: "取消済み" }, { actor });
      expect(result).toEqual({ reopenedIds: [id], reversal: null });
      expect(await prisma.journalEntry.count({ where: { reversalOfId: posted.entry.id } })).toBe(1);
      expect(await lineState(id)).toMatchObject({ status: "pending", journalEntryId: null });
    });
  });

  describe("一覧", () => {
    it("narrows by state, wallet, text and amount, orders and pages", async () => {
      const wallet = await createWallet(
        prisma,
        { name: "明細テスト一覧", kind: "bank" },
        { actor },
      );
      const lineA = await addLine(wallet, "2063-06-03", -1_234n, "テスト 一覧 A");
      const lineB = await addLine(wallet, "2063-06-01", -500n, "振込 ｶｸｳｼｮｳｼﾞ", "ｶｸｳｼｮｳｼﾞ");
      const lineC = await addLine(wallet, "2063-06-03", 1_234n, "テスト 一覧 C");
      const lineD = await addLine(wallet, "2063-06-05", -800n, "テスト 一覧 D");
      const lineE = await addLine(wallet, "2063-06-02", -900n, "テスト 一覧 E");
      const settledEarly = await addLine(wallet, "2063-06-01", -300n, "テスト 一覧 登録 1");
      const settledLate = await addLine(wallet, "2063-06-09", -400n, "テスト 一覧 登録 2");
      for (const id of [settledEarly, settledLate]) {
        await registerWalletTransaction(prisma, id, oneLine(), { actor });
      }

      const pending = await listWalletTransactions(prisma, { wallet: wallet.id });
      expect(pending.rows.map((row) => row.id)).toEqual([lineB, lineE, lineA, lineC, lineD]);
      expect(pending).toMatchObject({ total: 5, page: 1, pageCount: 1, pageSize: 50 });
      expect(pending.rows[0]).toMatchObject({
        walletName: "明細テスト一覧",
        walletKind: "bank",
        walletActive: true,
        counterpartyRaw: "ｶｸｳｼｮｳｼﾞ",
        status: "pending",
        hasDocument: false,
        entry: null,
      });
      expect(pending.rows[0]?.suggestion).not.toBeNull();
      expect(pending.wallets.find((chip) => chip.id === wallet.id)).toMatchObject({ pending: 5 });

      const paged = await listWalletTransactions(
        prisma,
        { wallet: wallet.id, page: 2 },
        { pageSize: 2 },
      );
      expect(paged).toMatchObject({ total: 5, page: 2, pageCount: 3 });
      expect(paged.rows.map((row) => row.id)).toEqual([lineA, lineC]);
      const past = await listWalletTransactions(
        prisma,
        { wallet: wallet.id, page: 99 },
        { pageSize: 2 },
      );
      expect(past.page).toBe(3);
      expect(past.rows.map((row) => row.id)).toEqual([lineD]);

      const registered = await listWalletTransactions(prisma, {
        wallet: wallet.id,
        status: "registered",
      });
      expect(registered.rows.map((row) => row.id)).toEqual([settledLate, settledEarly]);
      expect(registered.rows[0]).toMatchObject({ suggestion: null, candidates: [] });
      expect(registered.rows[0]?.entry?.summary).toBe("消耗品費");

      const search = async (q: string) =>
        (await listWalletTransactions(prisma, { wallet: wallet.id, q })).rows.map((row) => row.id);
      expect(await search("カクウショウジ")).toEqual([lineB]);
      expect(await search("ｶｸｳ")).toEqual([lineB]);
      expect(await search("一覧 a")).toEqual([lineA]);
      expect(await search("1,234")).toEqual([lineA, lineC]);
      expect(await search("−1234")).toEqual([lineA, lineC]);
      expect(await search("100%")).toEqual([]);
      expect(await search("テスト_")).toEqual([]);
    });

    it("counts pending lines per wallet; inactive wallets show only with pending lines", async () => {
      const before = await countPendingWalletTransactions(prisma);
      const quiet = await createWallet(prisma, { name: "明細テスト空", kind: "bank" }, { actor });
      const busy = await createWallet(prisma, { name: "明細テスト残", kind: "bank" }, { actor });
      await addLine(busy, "2063-07-01", -100n, "テスト 残 1");
      await addLine(busy, "2063-07-02", -100n, "テスト 残 2");
      await setWalletActive(prisma, { id: quiet.id, isActive: false }, { actor });
      await setWalletActive(prisma, { id: busy.id, isActive: false }, { actor });
      expect(await countPendingWalletTransactions(prisma)).toBe(before + 2);
      const page = await listWalletTransactions(prisma, { wallet: busy.id });
      expect(page.pendingTotal).toBe(before + 2);
      expect(page.wallets.find((chip) => chip.id === busy.id)).toMatchObject({
        isActive: false,
        pending: 2,
      });
      expect(page.wallets.some((chip) => chip.id === quiet.id)).toBe(false);
      expect(page.rows.every((row) => !row.walletActive)).toBe(true);
    });
  });

  describe("取込時の自動登録", () => {
    it("settles the lines autoPost rules win and keeps the rest pending with the reason", async () => {
      const wallet = await createWallet(
        prisma,
        { name: "明細テスト自動", kind: "bank" },
        { actor },
      );
      const pocket = await createWallet(
        prisma,
        { name: "明細テスト自動現金", kind: "cash", defaultSegmentId: refs.segment("corporate") },
        { actor },
      );
      const rule = (description: string, action: RuleCreateInput["action"], autoPost = true) =>
        createRule(
          prisma,
          {
            name: description,
            walletId: wallet.id,
            match: { descriptionContains: description, sign: "out" },
            action,
            autoPost,
          },
          { actor },
        );
      const feeRule = await rule("テスト自動手数料", {
        mode: "register",
        accountId: refs.account("5400"),
        taxCategoryCode: "purchase_10",
        segmentId: refs.segment("corporate"),
      });
      await rule("テスト自動私用", { mode: "ignore", ignoredReason: "私用" });
      await rule("テスト自動引出", { mode: "transfer", transferToWalletId: pocket.id });
      await rule("テスト自動不足", {
        mode: "register",
        accountId: refs.account("5330"),
        taxCategoryCode: "purchase_10",
      });
      const hint = await rule(
        "テスト自動候補",
        { mode: "register", accountId: refs.account("5330"), taxCategoryCode: "purchase_10" },
        false,
      );

      const fee = await addLine(wallet, "2063-08-01", -440n, "テスト自動手数料");
      const own = await addLine(wallet, "2063-08-02", -1_000n, "テスト自動私用 08/02");
      const withdrawal = await addLine(wallet, "2063-08-03", -3_000n, "テスト自動引出");
      const deposit = await addLine(pocket, "2063-08-03", 3_000n, "テスト 現金の受取");
      const missing = await addLine(wallet, "2063-08-04", -500n, "テスト自動不足");
      const later = await addLine(wallet, "2063-08-05", -700n, "テスト自動候補");

      const result = await settleImportedWalletTransactions(
        prisma,
        [fee, own, withdrawal, deposit, missing, later],
        { actor: "importer@example.com" },
      );
      expect(result).toMatchObject({ registered: 1, transferred: 1, ignored: 1 });
      expect(result.failed).toEqual([
        { id: missing, message: expect.stringContaining("セグメントを選んでください") as string },
      ]);

      expect(await lineState(fee)).toMatchObject({
        status: "registered",
        autoPosted: true,
        ruleId: feeRule.id,
      });
      expect((await auditOf(fee)).at(-1)).toMatchObject({
        action: "wallet_transaction.register",
        actor: "importer@example.com",
        after: { autoPosted: true, ruleId: feeRule.id },
      });
      expect(await lineState(own)).toMatchObject({ status: "ignored", ignoredReason: "私用" });
      const pair = await lineState(withdrawal);
      expect(pair).toMatchObject({ status: "transfer", autoPosted: true });
      expect(await lineState(deposit)).toMatchObject({
        status: "transfer",
        journalEntryId: pair.journalEntryId,
      });
      expect(await lineState(missing)).toMatchObject({ status: "pending" });
      expect((await getWalletTransaction(prisma, missing))?.error).toContain(
        "セグメントを選んでください",
      );
      const stored = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: later } });
      expect(stored.status).toBe("pending");
      expect(stored.suggestion).toMatchObject({ source: "rule", ruleId: hint.id, autoPost: false });
      expect((await getWalletTransaction(prisma, later))?.suggestion).toMatchObject({
        source: "rule",
        ruleId: hint.id,
      });
      expect(await prisma.rule.findUniqueOrThrow({ where: { id: feeRule.id } })).toMatchObject({
        hitCount: 1,
        lastHitAt: expect.any(Date) as Date,
      });

      const byRule = await listWalletTransactions(prisma, {
        wallet: wallet.id,
        status: "registered",
        by: "rule",
      });
      expect(byRule.rows.map((row) => row.id)).toEqual([fee]);
      expect(byRule.rows[0]).toMatchObject({
        autoPosted: true,
        rule: { id: feeRule.id, name: "テスト自動手数料" },
      });
      // `by=rule` does not narrow the pending tab.
      const pendingTab = await listWalletTransactions(prisma, { wallet: wallet.id, by: "rule" });
      expect(pendingTab.rows.map((row) => row.id)).toEqual([missing, later]);
    });
  });
});
