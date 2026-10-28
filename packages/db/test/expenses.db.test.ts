import { randomBytes } from "node:crypto";
import { LedgerValidationError, type CalendarDate } from "@niho-finance/ledger";
import type { FiscalYear, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  cancelExpensePayment,
  createUser,
  describeAuditTargets,
  EXPENSE_SUB_ACCOUNT_NAME,
  loadExpenseFormOptions,
  loadExpenseOverview,
  loadExpensePaymentCandidates,
  payExpenseClaims,
  registerDocument,
  reopenWalletTransaction,
  setUserActive,
  SettingsError,
  submitExpenseClaim,
  voidDocument,
  voidExpenseClaim,
  voidJournalEntryWithOpenDate,
  type ExpenseClaimSubmitInput,
  type UserRecord,
} from "../src";
import { toDbDate } from "../src/dates";
import { newId } from "../src/ids";
import { hasTestDatabase } from "./support/database";
import { rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "expenses-tester@example.com";
const options = { actor };

function ledgerErrors(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
}

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}

/**
 * 立替精算 (23-users-and-expenses §5): 提出 → 支払 → 取消 on fiscal years of their own, 第 240 期
 * (本則課税・税込経理, 2100) and 第 241 期 (本則課税・税抜経理, 2101, closed through 2101/04/30), after
 * every other test file's years: the expenses here are losses, and a loss is carried forward to the
 * next ten years (繰越欠損金), which would change the corporate tax of year-end.db.test.ts (2090–).
 * The claimants are users made here.
 */
describe.skipIf(!hasTestDatabase)("expense claims (立替精算)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  let inclusiveYear: FiscalYear;
  let exclusiveYear: FiscalYear;
  let claimant: UserRecord;
  let other: UserRecord;
  let bankWalletId: string;
  let cashWalletId: string;
  let cardWalletId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    inclusiveYear = await createFiscalYear(prisma, {
      no: 240,
      startDate: "2100-04-01",
      endDate: "2101-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_inclusive" },
    });
    exclusiveYear = await createFiscalYear(prisma, {
      no: 241,
      startDate: "2101-04-01",
      endDate: "2102-03-31",
      lockedThrough: "2101-04-30",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    claimant = await createUser(
      prisma,
      {
        email: `claimant-${newId().toLowerCase()}@example.com`,
        name: "架空 一郎",
        role: "accountant",
      },
      options,
    );
    other = await createUser(
      prisma,
      { email: `contractor-${newId().toLowerCase()}@example.com`, role: "viewer" },
      options,
    );
    const wallets = await prisma.wallet.findMany();
    const walletId = (name: string) => {
      const wallet = wallets.find((row) => row.name === name);
      if (!wallet) throw new Error(`not seeded: wallet ${name}`);
      return wallet.id;
    };
    bankWalletId = walletId("架空銀行 普通");
    cashWalletId = walletId("現金");
    cardWalletId = walletId("架空カード");
  });

  const claimInput = (
    overrides: Partial<ExpenseClaimSubmitInput> = {},
  ): ExpenseClaimSubmitInput => ({
    claimantId: claimant.id,
    spentOn: "2100-05-10",
    amount: "1,100",
    accountId: refs.account("5360"),
    taxCategoryCode: "purchase_10",
    segmentId: refs.segment("platform"),
    partnerId: "",
    description: "タクシー代",
    documentId: "",
    ...overrides,
  });

  async function expenseSubAccountId(): Promise<string> {
    const sub = await prisma.subAccount.findFirstOrThrow({
      where: { name: EXPENSE_SUB_ACCOUNT_NAME, account: { code: "2100" } },
    });
    return sub.id;
  }

  /** 未払金〔立替精算〕 in the year: credit − debit. */
  async function payableBalance(year: FiscalYear): Promise<bigint> {
    const lines = await prisma.journalLine.findMany({
      where: { subAccountId: await expenseSubAccountId(), journalEntry: { fiscalYearId: year.id } },
    });
    return lines.reduce(
      (balance, line) => (line.side === "credit" ? balance + line.amount : balance - line.amount),
      0n,
    );
  }

  async function linesOf(entryId: string) {
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      orderBy: { lineNo: "asc" },
      include: { account: { select: { code: true } }, subAccount: { select: { name: true } } },
    });
    return lines.map((line) => [
      line.side,
      line.account.code,
      line.subAccount?.name ?? null,
      line.amount,
      line.taxCategoryCode,
      line.taxAmount,
    ]);
  }

  async function actionsOf(entityId: string): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { entityId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => row.action);
  }

  async function withdrawal(amount: bigint, txnDate: CalendarDate, walletId = bankWalletId) {
    return prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw: "フリコミ カクウ イチロウ",
        externalId: `expense-test-${newId()}`,
      },
    });
  }

  it("submits (費用 / 未払金〔立替精算〕) and pays (未払金〔立替精算〕 / 口座) in a tax-inclusive year", async () => {
    const submitted = await submitExpenseClaim(prisma, claimInput(), options);
    expect(submitted.claim).toMatchObject({
      claimantId: claimant.id,
      spentOn: "2100-05-10",
      amount: 1_100n,
      status: "submitted",
      paymentId: null,
      journalEntryId: submitted.entry.id,
      createdBy: actor,
    });
    const accrual = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: submitted.entry.id },
    });
    expect(accrual).toMatchObject({
      no: submitted.entry.no,
      fiscalYearId: inclusiveYear.id,
      entryDate: toDbDate("2100-05-10"),
      description: "立替精算 架空 一郎 タクシー代",
      kind: "normal",
      sourceKind: "expense",
      sourceId: submitted.claim.id,
      status: "posted",
    });
    expect(await linesOf(accrual.id)).toEqual([
      ["debit", "5360", null, 1_100n, "purchase_10", 100n],
      ["credit", "2100", EXPENSE_SUB_ACCOUNT_NAME, 1_100n, "na", 0n],
    ]);
    const payable = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: accrual.id, side: "credit" },
    });
    expect(payable.partnerId).toBeNull();
    expect(await payableBalance(inclusiveYear)).toBe(1_100n);
    // The sub-account was made by the first submission, with its audit row.
    expect(await actionsOf(await expenseSubAccountId())).toContain("sub_account.create");

    const paid = await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: [submitted.claim.id],
        paidOn: "2100-05-31",
        walletId: bankWalletId,
      },
      options,
    );
    expect(paid.payment).toMatchObject({
      claimantId: claimant.id,
      paidOn: "2100-05-31",
      walletId: bankWalletId,
      walletTransactionId: null,
      amount: 1_100n,
      journalEntryId: paid.entry.id,
      cancelledAt: null,
    });
    const payment = await prisma.journalEntry.findUniqueOrThrow({ where: { id: paid.entry.id } });
    expect(payment).toMatchObject({
      entryDate: toDbDate("2100-05-31"),
      description: "立替精算の支払 架空 一郎（1 件）",
      sourceKind: "expense",
      sourceId: paid.payment.id,
    });
    expect(await linesOf(payment.id)).toEqual([
      ["debit", "2100", EXPENSE_SUB_ACCOUNT_NAME, 1_100n, "na", 0n],
      ["credit", "1100", "架空銀行 普通", 1_100n, "na", 0n],
    ]);
    expect(await payableBalance(inclusiveYear)).toBe(0n);

    const claim = await prisma.expenseClaim.findUniqueOrThrow({
      where: { id: submitted.claim.id },
    });
    expect(claim).toMatchObject({ status: "paid", paymentId: paid.payment.id });
    expect(await actionsOf(claim.id)).toEqual(["expense_claim.submit", "expense_claim.pay"]);
    const audit = await prisma.auditLog.findMany({
      where: { entityId: claim.id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(audit[0]).toMatchObject({
      actor,
      entity: "expense_claim",
      after: {
        id: claim.id,
        amount: "1100",
        status: "submitted",
        spentOn: "2100-05-10T00:00:00.000Z",
      },
    });
    expect(audit[1]).toMatchObject({
      before: { status: "submitted", paymentId: null },
      after: { status: "paid", paymentId: paid.payment.id },
    });
    const names = await describeAuditTargets(prisma, [
      { entity: "expense_claim", entityId: claim.id },
    ]);
    expect(names.get(`expense_claim:${claim.id}`)).toBe("立替精算 2100/05/10 タクシー代");
  });

  it("splits the tax in a tax-exclusive year (仮払消費税) and pays back to a balance of 0", async () => {
    const submitted = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2101-05-12", amount: "1100", description: "文具" }),
      options,
    );
    expect(await linesOf(submitted.entry.id)).toEqual([
      ["debit", "5360", null, 1_000n, "purchase_10", 100n],
      ["debit", "1400", null, 100n, "na", 0n],
      ["credit", "2100", EXPENSE_SUB_ACCOUNT_NAME, 1_100n, "na", 0n],
    ]);
    expect(await payableBalance(exclusiveYear)).toBe(1_100n);

    const paid = await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: submitted.claim.id,
        paidOn: "2101-05-20",
        walletId: cashWalletId,
      },
      options,
    );
    expect(await linesOf(paid.entry.id)).toEqual([
      ["debit", "2100", EXPENSE_SUB_ACCOUNT_NAME, 1_100n, "na", 0n],
      ["credit", "1000", "本社", 1_100n, "na", 0n],
    ]);
    expect(await payableBalance(exclusiveYear)).toBe(0n);
  });

  it("pays several claims of one claimant in one entry, one debit line per claim", async () => {
    const first = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-06-01", amount: "550", description: "駐車場代" }),
      options,
    );
    const second = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-06-03", amount: "2,200", description: "会議の茶菓" }),
      options,
    );
    const balance = await payableBalance(inclusiveYear);

    const paid = await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: [second.claim.id, first.claim.id, first.claim.id],
        paidOn: "2100-06-10",
        walletId: bankWalletId,
      },
      options,
    );
    expect(paid.payment.amount).toBe(2_750n);
    expect(await linesOf(paid.entry.id)).toEqual([
      ["debit", "2100", EXPENSE_SUB_ACCOUNT_NAME, 550n, "na", 0n],
      ["debit", "2100", EXPENSE_SUB_ACCOUNT_NAME, 2_200n, "na", 0n],
      ["credit", "1100", "架空銀行 普通", 2_750n, "na", 0n],
    ]);
    const debit = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: paid.entry.id, lineNo: 1 },
    });
    expect(debit.description).toBe("2100/06/01 駐車場代");
    expect(await payableBalance(inclusiveYear)).toBe(balance - 2_750n);
    const claims = await prisma.expenseClaim.findMany({
      where: { id: { in: [first.claim.id, second.claim.id] } },
    });
    for (const claim of claims) {
      expect(claim).toMatchObject({ status: "paid", paymentId: paid.payment.id });
      expect(await actionsOf(claim.id)).toEqual(["expense_claim.submit", "expense_claim.pay"]);
    }

    const overview = await loadExpenseOverview(prisma);
    const row = overview.payments.rows.find((item) => item.id === paid.payment.id);
    expect(row).toMatchObject({
      paidOn: "2100-06-10",
      claimant: { id: claimant.id, displayName: "架空 一郎" },
      count: 2,
      total: 2_750n,
      walletName: "架空銀行 普通",
      entry: { id: paid.entry.id, no: paid.entry.no, status: "posted" },
      cancelled: false,
    });
  });

  it("matches a withdrawal of the total (registered), and the payment's cancellation puts everything back", async () => {
    const first = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-07-01", amount: "1,300", description: "書籍" }),
      options,
    );
    const second = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-07-02", amount: "2,000", description: "郵送料" }),
      options,
    );
    const line = await withdrawal(-3_300n, "2100-07-20");
    await withdrawal(-3_300n, "2100-06-20"); // before the 利用日: not offered
    await withdrawal(-3_300n, "2100-07-21", cashWalletId); // another wallet
    const balance = await payableBalance(inclusiveYear);

    const candidates = await loadExpensePaymentCandidates(prisma, {
      walletId: bankWalletId,
      amount: 3_300n,
      notBefore: "2100-07-02",
    });
    expect(candidates.map((candidate) => candidate.id)).toContain(line.id);
    for (const candidate of candidates) {
      expect(candidate.amount).toBe(-3_300n);
      expect(candidate.txnDate >= "2100-07-02").toBe(true);
    }

    // A line of another amount is refused.
    const short = await withdrawal(-3_000n, "2100-07-20");
    expect(
      settingsError(
        await rejectionOf(
          payExpenseClaims(
            prisma,
            {
              claimantId: claimant.id,
              claimIds: [first.claim.id, second.claim.id],
              paidOn: "2100-07-20",
              walletId: bankWalletId,
              walletTransactionId: short.id,
            },
            options,
          ),
        ),
      ).field,
    ).toBe("walletTransactionId");

    const paid = await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: [first.claim.id, second.claim.id],
        paidOn: "2100-07-31", // the line's date wins
        walletId: bankWalletId,
        walletTransactionId: line.id,
      },
      options,
    );
    expect(paid.payment).toMatchObject({ paidOn: "2100-07-20", walletTransactionId: line.id });
    const registered = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: line.id } });
    expect(registered).toMatchObject({ status: "registered", journalEntryId: paid.entry.id });
    expect(registered.settledAt).not.toBeNull();
    expect(await actionsOf(line.id)).toEqual(["wallet_transaction.register"]);
    expect(await payableBalance(inclusiveYear)).toBe(balance - 3_300n);

    // 明細 and 取引 do not undo the payment: it is cancelled here (decision 2026-10-29, 23 §5.2).
    expect(
      settingsError(
        await rejectionOf(
          reopenWalletTransaction(prisma, line.id, { reason: "やり直し" }, options),
        ),
      ).message,
    ).toBe(
      "この明細は立替精算の支払に充てています。未処理に戻すには、立替精算の画面で支払を取り消してください",
    );
    expect(
      settingsError(
        await rejectionOf(
          voidJournalEntryWithOpenDate(prisma, paid.entry.id, { reason: "取引の画面" }, options),
        ),
      ).message,
    ).toContain("立替精算 の画面");

    const cancelled = await cancelExpensePayment(
      prisma,
      paid.payment.id,
      { reason: "口座を間違えた" },
      options,
    );
    expect(cancelled.payment).toMatchObject({
      cancelReason: "口座を間違えた",
      reversalEntryId: cancelled.reversal?.id,
    });
    expect(cancelled.payment.cancelledAt).not.toBeNull();
    const reversal = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: cancelled.reversal?.id ?? "" },
    });
    expect(reversal).toMatchObject({
      kind: "reversal",
      reversalOfId: paid.entry.id,
      entryDate: toDbDate("2100-07-20"),
    });
    expect(
      await prisma.journalEntry.findUniqueOrThrow({ where: { id: paid.entry.id } }),
    ).toMatchObject({ status: "voided", voidReason: "口座を間違えた" });
    expect(await payableBalance(inclusiveYear)).toBe(balance);

    const reopened = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: line.id } });
    expect(reopened).toMatchObject({ status: "pending", journalEntryId: null, settledAt: null });
    expect(await actionsOf(line.id)).toEqual([
      "wallet_transaction.register",
      "wallet_transaction.unregister",
    ]);
    for (const id of [first.claim.id, second.claim.id]) {
      expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "submitted",
        paymentId: null,
      });
      expect(await actionsOf(id)).toEqual([
        "expense_claim.submit",
        "expense_claim.pay",
        "expense_claim.unpay",
      ]);
      const unpay = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: id, action: "expense_claim.unpay" },
      });
      expect(unpay).toMatchObject({
        reason: "口座を間違えた",
        before: { status: "paid", paymentId: paid.payment.id },
        after: { status: "submitted", paymentId: null },
      });
    }
    // The cancelled payment stays on the list; the claims are unpaid again.
    const overview = await loadExpenseOverview(prisma);
    expect(overview.payments.rows.find((row) => row.id === paid.payment.id)).toMatchObject({
      cancelled: true,
      cancelReason: "口座を間違えた",
      count: 2,
      reversalEntry: { id: cancelled.reversal?.id },
    });
    const group = overview.unpaid.groups.find((item) => item.claimant.id === claimant.id);
    expect(group?.claims.map((claim) => claim.id)).toEqual(
      expect.arrayContaining([first.claim.id, second.claim.id]),
    );

    // A cancelled payment is not cancelled twice; the claims can be paid again.
    expect(
      settingsError(
        await rejectionOf(
          cancelExpensePayment(prisma, paid.payment.id, { reason: "再度" }, options),
        ),
      ).message,
    ).toBe("この支払は取消済みです。画面を読み込み直してください");
    const again = await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: [first.claim.id, second.claim.id],
        paidOn: "2100-07-25",
        walletId: bankWalletId,
        walletTransactionId: line.id,
      },
      options,
    );
    expect(again.payment.paidOn).toBe("2100-07-20");
    expect(await payableBalance(inclusiveYear)).toBe(balance - 3_300n);
  });

  it("voids an unpaid claim with a reversal of its accrual", async () => {
    const submitted = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-08-05", amount: "4,400", description: "誤って出した立替" }),
      options,
    );
    const balance = await payableBalance(inclusiveYear);

    const voided = await voidExpenseClaim(
      prisma,
      submitted.claim.id,
      { reason: "二重に出した" },
      options,
    );
    expect(voided.claim).toMatchObject({
      status: "void",
      voidReason: "二重に出した",
      reversalEntryId: voided.reversal?.id,
    });
    expect(voided.claim.voidedAt).not.toBeNull();
    expect(voided.reversal).toMatchObject({ status: "posted" });
    expect(
      await prisma.journalEntry.findUniqueOrThrow({ where: { id: voided.reversal?.id ?? "" } }),
    ).toMatchObject({ kind: "reversal", reversalOfId: submitted.entry.id });
    expect(
      await prisma.journalEntry.findUniqueOrThrow({ where: { id: submitted.entry.id } }),
    ).toMatchObject({ status: "voided" });
    expect(await payableBalance(inclusiveYear)).toBe(balance - 4_400n);
    expect(await actionsOf(submitted.claim.id)).toEqual([
      "expense_claim.submit",
      "expense_claim.void",
    ]);
    expect(
      await prisma.auditLog.findFirstOrThrow({
        where: { entityId: submitted.claim.id, action: "expense_claim.void" },
      }),
    ).toMatchObject({ reason: "二重に出した", after: { status: "void" } });

    expect(
      settingsError(
        await rejectionOf(
          voidExpenseClaim(prisma, submitted.claim.id, { reason: "再度" }, options),
        ),
      ).message,
    ).toBe("この立替精算は取消済みです。画面を読み込み直してください");
    const overview = await loadExpenseOverview(prisma);
    expect(overview.voided.find((row) => row.id === submitted.claim.id)).toMatchObject({
      status: "void",
      voidReason: "二重に出した",
      entry: { id: submitted.entry.id, status: "voided" },
    });
  });

  it("refuses to void a paid claim, to mix claimants, and to pay before the 利用日", async () => {
    const paidClaim = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-09-01", description: "支払済みの立替" }),
      options,
    );
    await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: [paidClaim.claim.id],
        paidOn: "2100-09-02",
        walletId: bankWalletId,
      },
      options,
    );
    expect(
      settingsError(
        await rejectionOf(
          voidExpenseClaim(prisma, paidClaim.claim.id, { reason: "取消" }, options),
        ),
      ).message,
    ).toBe("支払済みの立替精算は取り消せません。先に支払を取り消してください");

    const mine = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-09-10", description: "自分の立替" }),
      options,
    );
    const theirs = await submitExpenseClaim(
      prisma,
      claimInput({ claimantId: other.id, spentOn: "2100-09-11", description: "ほかの人の立替" }),
      options,
    );
    const description = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: theirs.entry.id },
    });
    // Without a name the email names the claimant.
    expect(description.description).toBe(`立替精算 ${other.email} ほかの人の立替`);
    const entriesBefore = await prisma.journalEntry.count();
    expect(
      settingsError(
        await rejectionOf(
          payExpenseClaims(
            prisma,
            {
              claimantId: claimant.id,
              claimIds: [mine.claim.id, theirs.claim.id],
              paidOn: "2100-09-30",
              walletId: bankWalletId,
            },
            options,
          ),
        ),
      ),
    ).toEqual({
      message: "ほかの人の立替精算が含まれています。立替えた人ごとに支払ってください",
      field: "claimIds",
    });
    expect(
      settingsError(
        await rejectionOf(
          payExpenseClaims(
            prisma,
            {
              claimantId: claimant.id,
              claimIds: [mine.claim.id],
              paidOn: "2100-09-09",
              walletId: bankWalletId,
            },
            options,
          ),
        ),
      ),
    ).toEqual({ message: "支払日は利用日（2100/09/10）以後にしてください", field: "paidOn" });
    // A card cannot pay a claim.
    expect(
      settingsError(
        await rejectionOf(
          payExpenseClaims(
            prisma,
            {
              claimantId: claimant.id,
              claimIds: [mine.claim.id],
              paidOn: "2100-09-30",
              walletId: cardWalletId,
            },
            options,
          ),
        ),
      ).field,
    ).toBe("walletId");
    // Paid already.
    expect(
      settingsError(
        await rejectionOf(
          payExpenseClaims(
            prisma,
            {
              claimantId: claimant.id,
              claimIds: [paidClaim.claim.id],
              paidOn: "2100-09-30",
              walletId: bankWalletId,
            },
            options,
          ),
        ),
      ).field,
    ).toBe("claimIds");
    expect(await prisma.journalEntry.count()).toBe(entriesBefore);
    expect(
      await prisma.expenseClaim.findUniqueOrThrow({ where: { id: mine.claim.id } }),
    ).toMatchObject({ status: "submitted", paymentId: null });
  });

  it("refuses the transaction screen's void; a claim whose accrual is voided anyway is not paid, and its void skips the reversal", async () => {
    const submitted = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-10-01", description: "取引の画面で取り消した立替" }),
      options,
    );
    // 取引 (no owner): refused, the entry stays posted.
    expect(
      settingsError(
        await rejectionOf(
          voidJournalEntryWithOpenDate(prisma, submitted.entry.id, { reason: "取消" }, options),
        ),
      ).message,
    ).toBe(
      "立替精算 から作った仕訳です。取消は 立替精算 の画面で、立替精算を取り消すか支払を取り消して行います",
    );
    // An accrual voided by another way all the same (e.g. before this rule): the claim stops there.
    const { reversal } = await voidJournalEntryWithOpenDate(
      prisma,
      submitted.entry.id,
      { reason: "取引の画面で取消" },
      { ...options, owner: "expense" },
    );
    expect(
      settingsError(
        await rejectionOf(
          payExpenseClaims(
            prisma,
            {
              claimantId: claimant.id,
              claimIds: [submitted.claim.id],
              paidOn: "2100-10-02",
              walletId: bankWalletId,
            },
            options,
          ),
        ),
      ),
    ).toEqual({
      message: `計上の仕訳 No. ${submitted.entry.no} は取消済みです。この立替精算を取り消して出し直してください`,
      field: "claimIds",
    });

    const entriesBefore = await prisma.journalEntry.count();
    const voided = await voidExpenseClaim(
      prisma,
      submitted.claim.id,
      { reason: "出し直す" },
      options,
    );
    expect(voided.claim).toMatchObject({ status: "void", reversalEntryId: reversal.id });
    expect(await prisma.journalEntry.count()).toBe(entriesBefore);
  });

  it("refuses a submission in a closed month, by an inactive claimant, or on an account 支出 does not offer", async () => {
    const claimsBefore = await prisma.expenseClaim.count();
    const entriesBefore = await prisma.journalEntry.count();

    const closed = await rejectionOf(
      submitExpenseClaim(prisma, claimInput({ spentOn: "2101-04-15" }), options),
    );
    expect(ledgerErrors(closed)).toEqual([{ code: "PERIOD_LOCKED", field: "spentOn" }]);
    expect((closed as LedgerValidationError).errors[0]?.message).toBe(
      "2101/04/30 までは締めています。利用日を開いている日にするか、管理者に締めを戻してもらってください",
    );
    expect(
      ledgerErrors(
        await rejectionOf(
          submitExpenseClaim(prisma, claimInput({ spentOn: "2099-06-01" }), options),
        ),
      ),
    ).toEqual([{ code: "OUT_OF_FISCAL_YEAR", field: "spentOn" }]);

    const leaver = await createUser(
      prisma,
      { email: `leaver-${newId().toLowerCase()}@example.com`, role: "viewer" },
      options,
    );
    await setUserActive(prisma, { id: leaver.id, isActive: false }, options);
    expect(
      settingsError(
        await rejectionOf(
          submitExpenseClaim(prisma, claimInput({ claimantId: leaver.id }), options),
        ),
      ),
    ).toEqual({ message: "立替えた人は有効な利用者から選んでください", field: "claimantId" });

    // 普通預金 is chosen as its wallet, 未払金 is the card's account: neither is an expense here.
    for (const code of ["1100", "2100"]) {
      expect(
        ledgerErrors(
          await rejectionOf(
            submitExpenseClaim(prisma, claimInput({ accountId: refs.account(code) }), options),
          ),
        ),
        code,
      ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
    }
    expect(
      ledgerErrors(
        await rejectionOf(submitExpenseClaim(prisma, claimInput({ segmentId: "" }), options)),
      ),
    ).toEqual([{ code: "SEGMENT_REQUIRED", field: "segmentId" }]);

    for (const overrides of [
      { amount: "0" },
      { amount: "1,000,000,000" },
      { description: "" },
      { description: "あ".repeat(61) },
      { taxCategoryCode: "sales_10" },
      { spentOn: "2100-02-30" },
    ]) {
      expect(
        await rejectionOf(submitExpenseClaim(prisma, claimInput(overrides), options)),
        JSON.stringify(overrides),
      ).toBeInstanceOf(ZodError);
    }
    expect(await prisma.expenseClaim.count()).toBe(claimsBefore);
    expect(await prisma.journalEntry.count()).toBe(entriesBefore);
  });

  it("links the chosen document to the accrual entry", async () => {
    const { document } = await registerDocument(
      prisma,
      {
        storageKey: `documents/2100/11/${newId()}.pdf`,
        sha256: randomBytes(32).toString("hex"),
        mime: "application/pdf",
        byteSize: 2_048,
        originalName: "taxi.pdf",
        source: "upload",
      },
      options,
    );
    expect(document.status).toBe("inbox");
    const before = await loadExpenseFormOptions(prisma);
    expect(before.inboxDocuments.map((row) => row.id)).toContain(document.id);

    const submitted = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-11-05", amount: "3,520", documentId: document.id }),
      options,
    );
    expect(submitted.claim.documentId).toBe(document.id);
    const links = await prisma.documentLink.findMany({ where: { documentId: document.id } });
    expect(links).toEqual([
      expect.objectContaining({ journalEntryId: submitted.entry.id, createdBy: actor }),
    ]);
    const linked = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(linked).toMatchObject({ status: "linked", amount: 3_520n });
    expect(await actionsOf(document.id)).toEqual(
      expect.arrayContaining(["document.create", "document.link"]),
    );

    const overview = await loadExpenseOverview(prisma);
    const row = overview.unpaid.groups
      .flatMap((group) => group.claims)
      .find((claim) => claim.id === submitted.claim.id);
    expect(row).toMatchObject({
      spentOn: "2100-11-05",
      description: "タクシー代",
      accountCode: "5360",
      amount: 3_520n,
      hasDocument: true,
      entry: { id: submitted.entry.id, no: submitted.entry.no, status: "posted" },
    });

    // A voided document cannot be chosen.
    const voidedDocument = await registerDocument(
      prisma,
      {
        storageKey: `documents/2100/11/${newId()}.pdf`,
        sha256: randomBytes(32).toString("hex"),
        mime: "application/pdf",
        byteSize: 1_024,
        source: "upload",
      },
      options,
    );
    await voidDocument(prisma, { id: voidedDocument.document.id, reason: "読めない画像" }, options);
    expect(
      settingsError(
        await rejectionOf(
          submitExpenseClaim(
            prisma,
            claimInput({ spentOn: "2100-11-06", documentId: voidedDocument.document.id }),
            options,
          ),
        ),
      ).field,
    ).toBe("documentId");
  });

  it("offers the active claimants, the accounts 支出 offers and the bank / cash wallets", async () => {
    const choices = await loadExpenseFormOptions(prisma);
    const claimantIds = choices.claimants.map((row) => row.id);
    expect(claimantIds).toEqual(expect.arrayContaining([claimant.id, other.id]));
    expect(choices.claimants.every((row) => row.isActive)).toBe(true);
    const codes = choices.expenseAccounts.map((account) => account.code);
    expect(codes).toContain("5360");
    expect(codes).not.toContain("1100");
    expect(codes).not.toContain("2100");
    expect(codes).not.toContain("1400");
    expect(choices.payFromWallets.map((wallet) => wallet.id)).toEqual(
      expect.arrayContaining([bankWalletId, cashWalletId]),
    );
    expect(choices.payFromWallets.every((w) => w.kind === "bank" || w.kind === "cash")).toBe(true);
  });

  it("keeps the body of a claim and never deletes claims or payments (DB guards)", async () => {
    const submitted = await submitExpenseClaim(
      prisma,
      claimInput({ spentOn: "2100-12-01", description: "書き換えられない立替" }),
      options,
    );
    await expect(
      prisma.expenseClaim.update({ where: { id: submitted.claim.id }, data: { amount: 1n } }),
    ).rejects.toThrow(/ledger guard/);
    await expect(prisma.expenseClaim.delete({ where: { id: submitted.claim.id } })).rejects.toThrow(
      /ledger guard/,
    );
    const paid = await payExpenseClaims(
      prisma,
      {
        claimantId: claimant.id,
        claimIds: [submitted.claim.id],
        paidOn: "2100-12-02",
        walletId: bankWalletId,
      },
      options,
    );
    await expect(
      prisma.expensePayment.update({ where: { id: paid.payment.id }, data: { amount: 1n } }),
    ).rejects.toThrow(/ledger guard/);
    await expect(prisma.expensePayment.delete({ where: { id: paid.payment.id } })).rejects.toThrow(
      /ledger guard/,
    );
    // 支払済み → 取消済み skips 未払.
    await expect(
      prisma.expenseClaim.update({
        where: { id: submitted.claim.id },
        data: { status: "void", paymentId: null, voidedAt: new Date(), voidReason: "直接" },
      }),
    ).rejects.toThrow(/ledger guard/);
  });
});
