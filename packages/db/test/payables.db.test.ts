import { randomBytes } from "node:crypto";
import {
  LedgerValidationError,
  payableHistoryLabel,
  type CalendarDate,
} from "@niho-finance/ledger";
import type { FiscalYear, Partner, PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  cancelPayable,
  cancelPayablePayment,
  countPayablesDue,
  createPartner,
  createWallet,
  describeAuditTargets,
  getPayableDetail,
  ignoreWalletTransaction,
  listPayables,
  listPayablesForCashflow,
  loadCashflowInputs,
  loadDocumentPayableStatus,
  loadHomeTodos,
  loadPayableCandidates,
  loadPayableFormOptions,
  loadPayableHistory,
  loadPaymentCandidates,
  newId,
  payPayable,
  registerDocument,
  registerPayable,
  reopenWalletTransaction,
  replaceDocument,
  SettingsError,
  toDbDate,
  updatePartnerPaymentTerms,
  updatePayable,
  voidJournalEntryWithOpenDate,
  type DocumentRegisterInput,
  type PayableRegisterInput,
  type WalletSettings,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber, rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";
const options = { actor };

function settingsError(error: unknown) {
  expect(error).toBeInstanceOf(SettingsError);
  const { message, field } = error as SettingsError;
  return { message, field };
}

function ledgerErrors(error: unknown) {
  expect(error).toBeInstanceOf(LedgerValidationError);
  return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
}

/**
 * 支払 (25-payables): received invoices registered as 費用 / 未払金, paid from statement lines or by
 * hand, the rest derived from the ledger, the forecast, the home and the audit log. Fiscal years of
 * their own (第 56〜58 期), wallets and partners of their own; nothing is left undated or open near
 * the dates the other test files use.
 */
describe.skipIf(!hasTestDatabase)("payables (支払)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 56 期: exempt, tax-inclusive. */
  let exemptYear: FiscalYear;
  /** 第 57 期: 本則課税, tax-exclusive. */
  let exclusiveYear: FiscalYear;
  let bank: WalletSettings;
  let card: WalletSettings;
  /** テスト外注株式会社: a registration number (適格請求書). */
  let outsource: Partner;
  /** テスト工房: no registration number (インボイスなし). */
  let workshop: Partner;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    exemptYear = await createFiscalYear(prisma, {
      no: 56,
      startDate: "2056-04-01",
      endDate: "2057-03-31",
    });
    exclusiveYear = await createFiscalYear(prisma, {
      no: 57,
      startDate: "2057-04-01",
      endDate: "2058-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    await createFiscalYear(prisma, {
      no: 58,
      startDate: "2058-04-01",
      endDate: "2059-03-31",
      lockedThrough: "2058-06-30",
    });
    bank = await createWallet(prisma, { name: "支払テスト銀行", kind: "bank" }, options);
    card = await createWallet(prisma, { name: "支払テストカード", kind: "card" }, options);
    const created = await createPartner(
      prisma,
      {
        name: "テスト外注株式会社",
        nameKana: "テストガイチュウ",
        kind: "vendor",
        invoiceRegistrationNumber: `T${fictionalCorporateNumber("999999999996")}`,
      },
      options,
    );
    outsource = await prisma.partner.findUniqueOrThrow({ where: { id: created.id } });
    const plain = await createPartner(
      prisma,
      { name: "テスト工房", nameKana: "テストコウボウ", kind: "vendor" },
      options,
    );
    workshop = await prisma.partner.findUniqueOrThrow({ where: { id: plain.id } });
  });

  function fileInput(overrides: Partial<DocumentRegisterInput> = {}): DocumentRegisterInput {
    return {
      storageKey: `documents/2056/10/${newId()}.pdf`,
      sha256: randomBytes(32).toString("hex"),
      mime: "application/pdf",
      byteSize: 23_456,
      originalName: "請求書.pdf",
      source: "upload",
      ...overrides,
    };
  }

  async function received(overrides: Partial<DocumentRegisterInput> = {}) {
    const result = await registerDocument(prisma, fileInput(overrides), options);
    expect(result.duplicate).toBe(false);
    return result.document;
  }

  const registration = (
    documentId: string,
    overrides: Partial<PayableRegisterInput> = {},
  ): PayableRegisterInput => ({
    documentId,
    partnerId: outsource.id,
    invoiceDate: "2056-10-15",
    dueDate: "",
    amount: "110,000",
    accountId: refs.account("5100"),
    taxCategoryCode: "purchase_10",
    segmentId: "",
    description: "",
    walletId: "",
    ...overrides,
  });

  async function outflow(
    wallet: { id: string },
    txnDate: CalendarDate,
    amount: bigint,
    counterpartyRaw: string | null = null,
  ): Promise<string> {
    const row = await prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId: wallet.id,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw: "振込",
        counterpartyRaw,
        externalId: `test-payables-${newId()}`,
      },
    });
    return row.id;
  }

  async function linesOf(entryId: string) {
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: entryId },
      orderBy: { lineNo: "asc" },
      include: { account: { select: { code: true } } },
    });
    return lines.map((line) => ({
      side: line.side,
      code: line.account.code,
      amount: line.amount,
      tax: line.taxCategoryCode,
      taxAmount: line.taxAmount,
      sub: line.subAccountId,
      partner: line.partnerId,
    }));
  }

  /** The history as the detail names its rows (`payableHistoryLabel`). */
  async function historyOf(documentId: string): Promise<string[]> {
    return (await loadPayableHistory(prisma, documentId)).map(payableHistoryLabel);
  }

  async function detailOf(documentId: string, today: CalendarDate = "2056-11-01") {
    const detail = await getPayableDetail(prisma, documentId, { today });
    if (!detail) throw new Error(`no payable for ${documentId}`);
    return detail;
  }

  it("saves a partner's payment terms (all three or none) and defaults the due date by them", async () => {
    expect(
      await updatePartnerPaymentTerms(
        prisma,
        { partnerId: outsource.id, closingDay: "31", dueMonths: "1", dueDay: "31" },
        options,
      ),
    ).toEqual({ closingDay: 31, dueMonths: 1, dueDay: 31 });
    expect(await prisma.partner.findUniqueOrThrow({ where: { id: outsource.id } })).toMatchObject({
      paymentClosingDay: 31,
      paymentDueMonths: 1,
      paymentDueDay: 31,
    });
    const audit = await prisma.auditLog.findMany({
      where: { entity: "partner", entityId: outsource.id, action: "partner.update" },
    });
    expect(audit).toHaveLength(1);
    // Saving the same terms again writes nothing.
    await updatePartnerPaymentTerms(
      prisma,
      { partnerId: outsource.id, closingDay: "31", dueMonths: "1", dueDay: "31" },
      options,
    );
    expect(
      await prisma.auditLog.count({
        where: { entity: "partner", entityId: outsource.id, action: "partner.update" },
      }),
    ).toBe(1);

    const partial = await rejectionOf(
      updatePartnerPaymentTerms(
        prisma,
        { partnerId: workshop.id, closingDay: "20", dueMonths: "", dueDay: "10" },
        options,
      ),
    );
    expect(partial).toBeInstanceOf(ZodError);
    expect((partial as ZodError).issues.map((issue) => issue.path)).toEqual([["dueMonths"]]);
    const sameMonth = await rejectionOf(
      updatePartnerPaymentTerms(
        prisma,
        { partnerId: workshop.id, closingDay: "20", dueMonths: "0", dueDay: "10" },
        options,
      ),
    );
    expect((sameMonth as ZodError).issues.map((issue) => issue.path)).toEqual([["dueDay"]]);
    // The database refuses terms out of range or incomplete, whatever the application does.
    await expect(
      prisma.partner.update({ where: { id: workshop.id }, data: { paymentClosingDay: 20 } }),
    ).rejects.toThrow();
    await expect(
      prisma.partner.update({
        where: { id: workshop.id },
        data: { paymentClosingDay: 20, paymentDueMonths: 4, paymentDueDay: 10 },
      }),
    ).rejects.toThrow();

    // 20 日締め翌月 10 日払い for the workshop, then cleared again.
    await updatePartnerPaymentTerms(
      prisma,
      { partnerId: workshop.id, closingDay: "20", dueMonths: "1", dueDay: "10" },
      options,
    );
    const document = await received({
      txnDate: "2056-10-25",
      amount: "33000",
      partnerId: workshop.id,
    });
    const form = await loadPayableFormOptions(prisma, { documentId: document.id });
    expect(form.document).toMatchObject({ id: document.id, problem: null, registered: false });
    expect(form.values).toMatchObject({
      documentId: document.id,
      partnerId: workshop.id,
      invoiceDate: "2056-10-25",
      amount: 33_000n,
      dueDate: "2056-12-10",
      accountId: refs.account("5100"),
      // No registration number: 課税仕入 is offered as 「インボイスなし」.
      taxCategoryCode: "purchase_10_ni",
      segmentId: refs.segment("corporate"),
      description: "請求書 テスト工房",
    });
    expect(form.partners.find((row) => row.id === workshop.id)?.paymentTerms).toEqual({
      closingDay: 20,
      dueMonths: 1,
      dueDay: 10,
    });
    expect(form.candidates.some((row) => row.id === document.id)).toBe(true);
    expect(form.accounts.some((row) => row.code === "5100")).toBe(true);
    expect(form.accounts.some((row) => ["1100", "2100", "1400"].includes(row.code))).toBe(false);
    expect(form.wallets.map((row) => row.id)).toEqual(expect.arrayContaining([bank.id, card.id]));
    expect(
      await updatePartnerPaymentTerms(
        prisma,
        { partnerId: workshop.id, closingDay: "", dueMonths: "", dueDay: "" },
        options,
      ),
    ).toBeNull();
  });

  it("registers a received invoice: 費用 / 未払金 without a sub-account, the document filled and linked", async () => {
    const document = await received({ kind: "receipt", originalName: "10 月分.pdf" });
    const record = await registerPayable(prisma, registration(document.id), options);
    expect(record).toMatchObject({ documentId: document.id, partnerName: "テスト外注株式会社" });

    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: record.entry.id } });
    expect(entry).toMatchObject({
      fiscalYearId: exemptYear.id,
      no: record.entry.no,
      entryDate: toDbDate("2056-10-15"),
      description: "請求書 テスト外注株式会社",
      kind: "normal",
      sourceKind: "manual",
      sourceId: null,
    });
    expect(await linesOf(record.entry.id)).toEqual([
      {
        side: "debit",
        code: "5100",
        amount: 110_000n,
        tax: "purchase_10",
        taxAmount: 10_000n,
        sub: null,
        partner: outsource.id,
      },
      {
        side: "credit",
        code: "2100",
        amount: 110_000n,
        tax: "na",
        taxAmount: 0n,
        sub: null,
        partner: outsource.id,
      },
    ]);
    const segment = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: record.entry.id, side: "debit" },
    });
    expect(segment.segmentId).toBe(refs.segment("corporate"));

    // The document: 受領した請求書, its empty items filled, linked to the entry, the payable's columns.
    const stored = await prisma.document.findUniqueOrThrow({
      where: { id: document.id },
      include: { links: true },
    });
    expect(stored).toMatchObject({
      kind: "invoice_in",
      status: "linked",
      txnDate: toDbDate("2056-10-15"),
      amount: 110_000n,
      partnerId: outsource.id,
      payableEntryId: record.entry.id,
      payableDueDate: toDbDate("2056-11-30"),
      payableWalletId: null,
    });
    expect(stored.links.map((link) => link.journalEntryId)).toEqual([record.entry.id]);
    expect(await loadDocumentPayableStatus(prisma, document.id)).toEqual({
      canRegister: false,
      state: "unpaid",
    });

    // One registration per document.
    expect(
      settingsError(await rejectionOf(registerPayable(prisma, registration(document.id), options)))
        .field,
    ).toBe("documentId");
    const form = await loadPayableFormOptions(prisma, { documentId: document.id });
    expect(form.document).toMatchObject({ registered: true });
    expect(form.values).toBeNull();
    expect(form.candidates.some((row) => row.id === document.id)).toBe(false);

    const page = await listPayables(prisma, { partner: outsource.id }, 1, { today: "2056-11-01" });
    expect(page.rows.find((row) => row.documentId === document.id)).toMatchObject({
      partnerId: outsource.id,
      partnerName: "テスト外注株式会社",
      title: "10 月分.pdf",
      invoiceDate: "2056-10-15",
      dueDate: "2056-11-30",
      amount: 110_000n,
      paid: 0n,
      remaining: 110_000n,
      state: "unpaid",
      overdue: false,
      registration: { id: record.entry.id, no: record.entry.no, fiscalYearNo: 56 },
    });
    const overdue = await listPayables(prisma, { partner: outsource.id }, 1, {
      today: "2056-12-03",
    });
    expect(overdue.rows.find((row) => row.documentId === document.id)).toMatchObject({
      overdue: true,
      overdueDays: 3,
    });

    // 期日・支払元を変える: not before the invoice date; audit payable.update.
    expect(
      settingsError(
        await rejectionOf(updatePayable(prisma, document.id, { dueDate: "2056-10-14" }, options)),
      ).field,
    ).toBe("dueDate");
    expect(
      await updatePayable(
        prisma,
        document.id,
        { dueDate: "2056-12-10", walletId: bank.id },
        options,
      ),
    ).toEqual({ documentId: document.id, dueDate: "2056-12-10", walletId: bank.id });
    expect((await detailOf(document.id)).plannedWallet).toMatchObject({ id: bank.id });
    expect(await historyOf(document.id)).toEqual(["未払の登録", "期日・支払元の変更"]);
  });

  it("books 「インボイスなし」 in a tax-exclusive year and names the field of a ledger refusal", async () => {
    const document = await received({ originalName: "工房 5 月分.pdf" });
    const record = await registerPayable(
      prisma,
      registration(document.id, {
        partnerId: workshop.id,
        invoiceDate: "2057-05-10",
        amount: "33000",
        dueDate: "2057-06-30",
      }),
      options,
    );
    // 2057: nothing of the tax without an invoice is creditable (経過措置 ended), so no 仮払消費税.
    expect(await linesOf(record.entry.id)).toEqual([
      {
        side: "debit",
        code: "5100",
        amount: 33_000n,
        tax: "purchase_10_ni",
        taxAmount: 3_000n,
        sub: null,
        partner: workshop.id,
      },
      {
        side: "credit",
        code: "2100",
        amount: 33_000n,
        tax: "na",
        taxAmount: 0n,
        sub: null,
        partner: workshop.id,
      },
    ]);
    expect(
      (await prisma.journalEntry.findUniqueOrThrow({ where: { id: record.entry.id } }))
        .fiscalYearId,
    ).toBe(exclusiveYear.id);

    // A qualified invoice in the same year: 仮払消費税 of the tax.
    const qualified = await received();
    const booked = await registerPayable(
      prisma,
      registration(qualified.id, { invoiceDate: "2057-05-12", dueDate: "2057-06-30" }),
      options,
    );
    expect((await linesOf(booked.entry.id)).map((line) => [line.code, line.amount])).toEqual([
      ["5100", 100_000n],
      ["1400", 10_000n],
      ["2100", 110_000n],
    ]);
    await cancelPayable(prisma, qualified.id, { reason: "テストの後始末" }, options);

    // The closed month and an account the payable cannot book are named on their fields.
    const closed = await received();
    expect(
      ledgerErrors(
        await rejectionOf(
          registerPayable(
            prisma,
            registration(closed.id, { invoiceDate: "2058-05-01", dueDate: "2058-06-30" }),
            options,
          ),
        ),
      ),
    ).toEqual([{ code: "PERIOD_LOCKED", field: "invoiceDate" }]);
    expect(
      ledgerErrors(
        await rejectionOf(
          registerPayable(
            prisma,
            registration(closed.id, { accountId: refs.account("1100") }),
            options,
          ),
        ),
      ),
    ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
    // Nothing was written for the refused registrations.
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: closed.id } })).payableEntryId,
    ).toBeNull();
  });

  it("pays from statement lines: partially, then in full with the fee; 「未処理に戻す」 brings the rest back", async () => {
    const document = await received({ originalName: "11 月分.pdf" });
    await registerPayable(
      prisma,
      registration(document.id, { invoiceDate: "2056-11-05", amount: "220,000" }),
      options,
    );
    const first = await outflow(bank, "2056-11-20", -100_000n, "ﾃｽﾄｶﾞｲﾁｭｳ(ｶ");
    const other = await outflow(bank, "2056-11-21", -400_000n);

    // The lines that can pay it: outflows up to the rest + 1,100, the closest first.
    const lines = await loadPaymentCandidates(prisma, document.id);
    expect(lines.find((row) => row.id === first)).toMatchObject({
      walletId: bank.id,
      walletName: "支払テスト銀行",
      txnDate: "2056-11-20",
      amount: 100_000n,
      applied: 100_000n,
      fee: 0n,
      remainingAfter: 120_000n,
    });
    expect(lines.some((row) => row.id === other)).toBe(false);
    // From the statement screen: the payables the line can pay, the partner it names first.
    const forLine = await loadPayableCandidates(prisma, first, { today: "2056-11-20" });
    expect(forLine?.problem).toBeNull();
    expect(forLine?.payables.find((row) => row.documentId === document.id)).toMatchObject({
      samePartner: true,
      remaining: 220_000n,
      applied: 100_000n,
      remainingAfter: 120_000n,
    });
    // The partner's payables first, the closest rest first among them.
    const order = forLine?.payables.map((row) => [row.samePartner, row.remaining]) ?? [];
    expect(order[0]?.[0]).toBe(true);
    expect(await loadPayableCandidates(prisma, newId(), { today: "2056-11-20" })).toBeNull();
    expect((await loadPayableCandidates(prisma, other, { today: "2056-11-21" }))?.payables).toEqual(
      [],
    );

    // A line of another wallet than the form's is refused on the wallet.
    expect(
      settingsError(
        await rejectionOf(
          payPayable(
            prisma,
            document.id,
            { paidOn: "2056-11-20", walletId: card.id, amount: "1", walletTransactionId: first },
            options,
          ),
        ),
      ).field,
    ).toBe("walletId");
    // The line's date, wallet and amount count, whatever the form said.
    const partial = await payPayable(
      prisma,
      document.id,
      { paidOn: "2056-11-01", walletId: bank.id, amount: "1", walletTransactionId: first },
      options,
    );
    expect(partial).toMatchObject({
      applied: 100_000n,
      fee: 0n,
      remaining: 120_000n,
      state: "partial",
    });
    expect(
      await prisma.journalEntry.findUniqueOrThrow({ where: { id: partial.entry.id } }),
    ).toMatchObject({
      entryDate: toDbDate("2056-11-20"),
      sourceKind: "wallet_txn",
      sourceId: first,
      description: "支払 テスト外注株式会社 11 月分.pdf",
    });
    expect(await linesOf(partial.entry.id)).toEqual([
      {
        side: "debit",
        code: "2100",
        amount: 100_000n,
        tax: "na",
        taxAmount: 0n,
        sub: null,
        partner: outsource.id,
      },
      {
        side: "credit",
        code: "1100",
        amount: 100_000n,
        tax: "na",
        taxAmount: 0n,
        sub: bank.subAccountId,
        partner: null,
      },
    ]);
    // The line is registered with its settledAt (S5's settleWalletTransactionWithEntry), and the
    // document is linked to it (no more 「証憑なし」).
    const settled = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: first } });
    expect(settled).toMatchObject({ status: "registered", journalEntryId: partial.entry.id });
    expect(settled.settledAt).not.toBeNull();
    expect(
      await prisma.documentLink.count({
        where: { documentId: document.id, walletTransactionId: first },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.auditLog.findMany({
          where: { entity: "wallet_transaction", entityId: first },
          select: { action: true },
        })
      ).map((row) => row.action),
    ).toEqual(["wallet_transaction.register"]);

    const afterPartial = await detailOf(document.id);
    expect(afterPartial).toMatchObject({
      state: "partial",
      amount: 220_000n,
      paid: 100_000n,
      remaining: 120_000n,
      actions: { pay: true, update: true, cancel: false, reregister: false },
    });
    expect(afterPartial.actions.cancelBlocked).toMatch("先に支払を取り消して");
    expect(afterPartial.payments).toEqual([
      {
        entryId: partial.entry.id,
        no: partial.entry.no,
        fiscalYearNo: 56,
        paidOn: "2056-11-20",
        wallet: { id: bank.id, name: "支払テスト銀行" },
        amount: 100_000n,
        applied: 100_000n,
        fee: 0n,
        walletTransactionId: first,
      },
    ]);

    // More than the rest by over 1,100 yen is refused; up to it, the difference is the fee.
    const tooMuch = await outflow(bank, "2056-11-30", -121_101n);
    expect(
      settingsError(
        await rejectionOf(
          payPayable(
            prisma,
            document.id,
            { paidOn: "2056-11-30", walletId: bank.id, amount: "1", walletTransactionId: tooMuch },
            options,
          ),
        ),
      ),
    ).toEqual({
      message:
        "出金額が残り 120,000 円を 1,101 円超えています。手数料にできるのは 1,100 円までです",
      field: "amount",
    });
    const second = await outflow(bank, "2056-11-30", -120_660n, "テストガイチュウ");
    const full = await payPayable(
      prisma,
      document.id,
      { paidOn: "2056-11-30", walletId: bank.id, amount: "120660", walletTransactionId: second },
      options,
    );
    expect(full).toMatchObject({ applied: 120_000n, fee: 660n, remaining: 0n, state: "paid" });
    expect(
      (await linesOf(full.entry.id)).map((line) => [line.side, line.code, line.amount, line.tax]),
    ).toEqual([
      ["debit", "2100", 120_000n, "na"],
      ["debit", "5400", 660n, "purchase_10"],
      ["credit", "1100", 120_660n, "na"],
    ]);
    expect(await loadPaymentCandidates(prisma, document.id)).toEqual([]);
    const open = await listPayables(prisma, { partner: outsource.id }, 1, { today: "2056-12-01" });
    expect(open.rows.some((row) => row.documentId === document.id)).toBe(false);
    const paid = await listPayables(prisma, { partner: outsource.id, status: "paid" }, 1, {
      today: "2056-12-01",
    });
    expect(paid.rows.find((row) => row.documentId === document.id)).toMatchObject({
      state: "paid",
      remaining: 0n,
      overdue: false,
    });
    expect(
      settingsError(
        await rejectionOf(
          payPayable(
            prisma,
            document.id,
            { paidOn: "2056-12-01", walletId: bank.id, amount: "1", walletTransactionId: "" },
            options,
          ),
        ),
      ).message,
    ).toMatch("支払済み");

    // 「未処理に戻す」 on the statement screen voids the entry; the rest comes back by itself.
    const reopened = await reopenWalletTransaction(
      prisma,
      second,
      { reason: "別の支払の明細" },
      options,
    );
    expect(reopened.reopenedIds).toEqual([second]);
    expect(
      (await prisma.journalEntry.findUniqueOrThrow({ where: { id: full.entry.id } })).status,
    ).toBe("voided");
    const back = await detailOf(document.id);
    expect(back).toMatchObject({ state: "partial", paid: 100_000n, remaining: 120_000n });
    expect(back.payments.map((row) => row.entryId)).toEqual([partial.entry.id]);
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({ where: { id: second } }),
    ).toMatchObject({ status: "pending", journalEntryId: null, settledAt: null });

    // 支払の取消 of a payment from a statement line puts the line back to 未処理 too.
    const cancelled = await cancelPayablePayment(
      prisma,
      document.id,
      { entryId: partial.entry.id, reason: "金額の誤り" },
      options,
    );
    expect(cancelled.reopenedIds).toEqual([first]);
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({ where: { id: first } }),
    ).toMatchObject({ status: "pending", journalEntryId: null });
    expect(await detailOf(document.id)).toMatchObject({
      state: "unpaid",
      remaining: 220_000n,
      payments: [],
    });

    // Settle it again so that nothing stays open for the other tests: by hand, from the bank.
    await payPayable(
      prisma,
      document.id,
      { paidOn: "2056-12-05", walletId: bank.id, amount: "220000", walletTransactionId: "" },
      options,
    );
    for (const id of [first, other, tooMuch, second]) {
      await ignoreWalletTransaction(prisma, id, { reason: "テストの後始末" }, options);
    }
    expect((await loadPayableCandidates(prisma, first, { today: "2056-12-05" }))?.problem).toMatch(
      "処理済み",
    );
    expect(await historyOf(document.id)).toEqual([
      "未払の登録",
      "支払の登録",
      "支払の登録",
      "支払の取消（明細を未処理に戻す）",
      "支払の取消",
      "支払の登録",
    ]);
  });

  it("cancels a payment and the registration; a void on the transaction screen is 取消 too", async () => {
    const document = await received({ originalName: "工房 6 月分.pdf" });
    await registerPayable(
      prisma,
      registration(document.id, {
        partnerId: workshop.id,
        invoiceDate: "2057-06-01",
        amount: "55000",
        dueDate: "2057-07-31",
      }),
      options,
    );
    // By card, without a statement line: 未払金 against the card's 未払金.
    const paid = await payPayable(
      prisma,
      document.id,
      { paidOn: "2057-06-10", walletId: card.id, amount: "20000", walletTransactionId: "" },
      options,
    );
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: paid.entry.id } });
    expect(entry).toMatchObject({ sourceKind: "manual", sourceId: null });
    expect((await linesOf(paid.entry.id)).map((line) => [line.side, line.code, line.sub])).toEqual([
      ["debit", "2100", null],
      ["credit", "2100", card.subAccountId],
    ]);
    expect((await detailOf(document.id)).payments[0]?.wallet).toEqual({
      id: card.id,
      name: "支払テストカード",
    });

    expect(
      settingsError(
        await rejectionOf(cancelPayable(prisma, document.id, { reason: "誤登録" }, options)),
      ).message,
    ).toBe("支払が残っているため取り消せません。先に支払を取り消してください");
    const reversed = await cancelPayablePayment(
      prisma,
      document.id,
      { entryId: paid.entry.id, reason: "カードではなかった" },
      options,
    );
    expect(reversed.reopenedIds).toEqual([]);
    expect(
      await prisma.journalEntry.findUniqueOrThrow({ where: { id: reversed.reversal.id } }),
    ).toMatchObject({ kind: "reversal", reversalOfId: paid.entry.id });
    expect(await detailOf(document.id)).toMatchObject({ state: "unpaid", remaining: 55_000n });

    const cancelled = await cancelPayable(prisma, document.id, { reason: "誤登録" }, options);
    const detail = await detailOf(document.id);
    expect(detail).toMatchObject({
      state: "cancelled",
      registration: { status: "voided", voidReason: "誤登録" },
      actions: { pay: false, cancel: false, cancelBlocked: null, reregister: true },
    });
    expect(cancelled.reversal.entryDate).toBe("2057-06-01");
    // The columns stay (history); the list shows it under すべて only.
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).payableEntryId,
    ).toBe(detail.registration.id);
    const all = await listPayables(prisma, { partner: workshop.id, status: "all" }, 1, {
      today: "2057-06-15",
    });
    expect(all.rows.find((row) => row.documentId === document.id)?.state).toBe("cancelled");
    const open = await listPayables(prisma, { partner: workshop.id }, 1, { today: "2057-06-15" });
    expect(open.rows.some((row) => row.documentId === document.id)).toBe(false);
    expect(await loadDocumentPayableStatus(prisma, document.id)).toEqual({
      canRegister: true,
      state: "cancelled",
    });

    // Registered again: a new entry replaces the old one on the document.
    const again = await registerPayable(
      prisma,
      registration(document.id, {
        partnerId: workshop.id,
        invoiceDate: "2057-06-01",
        amount: "50000",
        dueDate: "2057-07-31",
      }),
      options,
    );
    expect(await detailOf(document.id)).toMatchObject({
      state: "unpaid",
      amount: 50_000n,
      registration: { id: again.entry.id, status: "posted" },
    });
    // Voiding the entry on the transaction screen (a hand-written entry there) cancels it too.
    await voidJournalEntryWithOpenDate(
      prisma,
      again.entry.id,
      { reason: "取引の画面で取消" },
      options,
    );
    expect((await detailOf(document.id)).state).toBe("cancelled");
    expect(await historyOf(document.id)).toEqual([
      "未払の登録",
      "支払の登録",
      "支払の取消",
      "登録の取消",
      "未払の登録",
      "登録の取消（取引の画面）",
    ]);
  });

  it("feeds the cash-flow forecast and the home's やること with what is still to pay", async () => {
    const document = await received({ originalName: "保守 12 月分.pdf" });
    await registerPayable(
      prisma,
      registration(document.id, {
        invoiceDate: "2056-12-01",
        amount: "66,000",
        dueDate: "2056-12-20",
      }),
      options,
    );
    const label = "テスト外注株式会社 保守 12 月分.pdf";
    const listed = await listPayablesForCashflow(prisma);
    expect(listed.filter((row) => row.label === label)).toEqual([
      { date: "2056-12-20", amount: 66_000n, label },
    ]);
    const inputs = await loadCashflowInputs(prisma, { start: "2056-12-01", days: 90 });
    expect(inputs.payables?.find((row) => row.label === label)).toEqual({
      date: "2056-12-20",
      amount: 66_000n,
      label,
    });

    // The home: due within 7 days (or overdue: warn). Counted against the list's numbers.
    const expectTodo = async (today: CalendarDate) => {
      const summary = (await listPayables(prisma, {}, 1, { today })).summary;
      const due = await countPayablesDue(prisma, { today });
      expect(due.count).toBe(summary.dueSoon.count + summary.overdue.count);
      expect(due.overdueCount).toBe(summary.overdue.count);
      const todo = (await loadHomeTodos(prisma, today)).find((row) => row.key === "payables-due");
      return { due, todo };
    };
    const soon = await expectTodo("2056-12-14");
    expect(soon.due.count).toBeGreaterThanOrEqual(1);
    expect(soon.todo).toMatchObject({
      badge: String(soon.due.count),
      label: "7 日以内に支払う請求",
      href: "/payables",
      tone: soon.due.overdueCount > 0 ? "warn" : "count",
    });
    const late = await expectTodo("2056-12-21");
    expect(late.due.overdueCount).toBeGreaterThanOrEqual(1);
    expect(late.todo?.tone).toBe("warn");

    // Paid: out of the forecast and the home.
    await payPayable(
      prisma,
      document.id,
      { paidOn: "2056-12-18", walletId: bank.id, amount: "66000", walletTransactionId: "" },
      options,
    );
    expect((await listPayablesForCashflow(prisma)).some((row) => row.label === label)).toBe(false);
    expect((await expectTodo("2056-12-21")).due.count).toBe(late.due.count - 1);
  });

  it("moves the payable with a replaced document and keeps its history", async () => {
    const document = await received({ originalName: "差し替え前.pdf" });
    await registerPayable(
      prisma,
      registration(document.id, {
        invoiceDate: "2056-12-02",
        amount: "11000",
        dueDate: "2056-12-31",
      }),
      options,
    );
    const replaced = await replaceDocument(
      prisma,
      {
        id: document.id,
        reason: "鮮明な写し",
        replacement: fileInput({ originalName: "差し替え後.pdf" }),
      },
      options,
    );
    const next = replaced.document.id;
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: next } });
    const old = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stored).toMatchObject({
      payableEntryId: old.payableEntryId,
      payableDueDate: toDbDate("2056-12-31"),
    });
    const rows = (
      await listPayables(prisma, { partner: outsource.id, status: "all" }, 1, {
        today: "2056-12-03",
      })
    ).rows.map((row) => row.documentId);
    expect(rows).toContain(next);
    expect(rows).not.toContain(document.id);
    expect(await detailOf(next)).toMatchObject({ state: "unpaid", remaining: 11_000n });
    expect((await detailOf(document.id)).document).toMatchObject({
      status: "voided",
      replacedById: next,
    });
    // The voided document no longer acts; the replacement does, with the old history.
    expect(
      settingsError(
        await rejectionOf(
          payPayable(
            prisma,
            document.id,
            { paidOn: "2056-12-10", walletId: bank.id, amount: "11000", walletTransactionId: "" },
            options,
          ),
        ),
      ).message,
    ).toMatch("差し替え後の証憑");
    await payPayable(
      prisma,
      next,
      { paidOn: "2056-12-10", walletId: bank.id, amount: "11000", walletTransactionId: "" },
      options,
    );
    expect(await historyOf(next)).toEqual(["未払の登録", "支払の登録"]);
    expect((await detailOf(next)).state).toBe("paid");

    // The audit log names the payable.
    const targets = await describeAuditTargets(prisma, [{ entity: "payable", entityId: next }]);
    expect(targets.get(`payable:${next}`)).toBe("支払 テスト外注株式会社 差し替え後.pdf");
  });

  it("shows the voids made on the statement and the transaction screens in the history", async () => {
    const document = await received({ originalName: "履歴 1 月分.pdf" });
    const registered = await registerPayable(
      prisma,
      registration(document.id, {
        invoiceDate: "2057-01-05",
        amount: "44,000",
        dueDate: "2057-01-31",
      }),
      options,
    );
    // Paid from a statement line, put back on the statement screen.
    const line = await outflow(bank, "2057-01-10", -44_000n);
    await payPayable(
      prisma,
      document.id,
      { paidOn: "2057-01-10", walletId: bank.id, amount: "44000", walletTransactionId: line },
      options,
    );
    await reopenWalletTransaction(prisma, line, { reason: "別の振込だった" }, options);
    // Paid by hand, voided on the transaction screen.
    const byHand = await payPayable(
      prisma,
      document.id,
      { paidOn: "2057-01-20", walletId: bank.id, amount: "44000", walletTransactionId: "" },
      options,
    );
    await voidJournalEntryWithOpenDate(
      prisma,
      byHand.entry.id,
      { reason: "二重に登録した" },
      options,
    );
    // The registration voided on the transaction screen.
    await voidJournalEntryWithOpenDate(
      prisma,
      registered.entry.id,
      { reason: "請求書の取り下げ" },
      options,
    );

    const history = await loadPayableHistory(prisma, document.id);
    expect(history.map(payableHistoryLabel)).toEqual([
      "未払の登録",
      "支払の登録",
      "支払の取消（明細を未処理に戻す）",
      "支払の登録",
      "支払の取消（取引の画面）",
      "登録の取消（取引の画面）",
    ]);
    expect(history.map((row) => row.reason)).toEqual([
      null,
      null,
      "別の振込だった",
      null,
      "二重に登録した",
      "請求書の取り下げ",
    ]);
    expect(history.map((row) => row.via)).toEqual([
      null,
      null,
      "statement",
      null,
      "entries",
      "entries",
    ]);
    expect(history[4]).toMatchObject({
      actor,
      action: "payable.cancel_payment",
      before: { entryId: byHand.entry.id, entryNo: byHand.entry.no },
    });
    expect((await detailOf(document.id)).state).toBe("cancelled");
    await ignoreWalletTransaction(prisma, line, { reason: "テストの後始末" }, options);
  });

  it("leaves nothing open or undated for the other test files", async () => {
    // Cancel what is still open, so that the forecast of other files sees none of it.
    const open = (
      await listPayables(prisma, {}, 1, { today: "2056-04-01", pageSize: 500 })
    ).rows.filter((row) => row.partnerId === outsource.id || row.partnerId === workshop.id);
    for (const row of open) {
      const detail = await detailOf(row.documentId);
      for (const payment of detail.payments) {
        await cancelPayablePayment(
          prisma,
          row.documentId,
          { entryId: payment.entryId, reason: "テストの後始末" },
          options,
        );
      }
      await cancelPayable(prisma, row.documentId, { reason: "テストの後始末" }, options);
    }
    for (const partner of [outsource.id, workshop.id]) {
      expect((await listPayables(prisma, { partner }, 1, { today: "2056-04-01" })).total).toBe(0);
    }
    const names = ["テスト外注株式会社", "テスト工房"];
    expect(
      (await listPayablesForCashflow(prisma)).filter((row) =>
        names.some((name) => row.label.startsWith(name)),
      ),
    ).toEqual([]);
  });
});
