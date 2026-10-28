import { LedgerValidationError, type CalendarDate } from "@niho-finance/ledger";
import type { Company, FiscalYear, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  cancelInvoicePayment,
  createInvoiceDraft,
  describeAuditTargets,
  discardInvoiceDraft,
  fromDbDate,
  getInvoiceDetail,
  getInvoiceSettings,
  issueInvoice,
  listInvoices,
  loadDepositCandidates,
  loadInvoiceDraftInput,
  loadInvoiceFormOptions,
  loadInvoiceHistory,
  markInvoiceSent,
  newId,
  recordInvoicePayment,
  SettingsError,
  toDbDate,
  updateInvoiceDraft,
  updateInvoiceSettings,
  voidInvoice,
  type InvoiceDraftInput,
  type InvoiceLineFormInput,
  type InvoicePaymentInput,
  type InvoiceRecord,
} from "../src";
import { hasTestDatabase } from "./support/database";
import { fictionalCorporateNumber, rejectionOf } from "./support/fictional";
import { testPrisma } from "./support/prisma";
import { createFiscalYear, seededRefs, type SeededRefs } from "./support/refs";

const actor = "tester@example.com";
const options = { actor };

/** The fixture of 18 §3.2: 10% and 8% mixed, with a discount (prices without tax). */
const FIXTURE_LINES: InvoiceLineFormInput[] = [
  {
    date: "",
    name: "設計・開発 一式",
    quantity: "1",
    unit: "式",
    unitPrice: "100,000",
    taxCategoryCode: "sales_10",
  },
  {
    date: "",
    name: "保守（2 か月）",
    quantity: "2",
    unit: "月",
    unitPrice: "15005",
    taxCategoryCode: "sales_10",
  },
  {
    date: "",
    name: "打合せの飲料",
    quantity: "3",
    unit: "本",
    unitPrice: "345",
    taxCategoryCode: "sales_8r",
  },
  {
    date: "",
    name: "値引き",
    quantity: "1",
    unit: "",
    unitPrice: "-5,005",
    taxCategoryCode: "sales_10",
  },
];

function fixtureLine(
  index: number,
  overrides: Partial<InvoiceLineFormInput> = {},
): InvoiceLineFormInput {
  const line = FIXTURE_LINES[index];
  if (!line) throw new Error(`no fixture line ${index}`);
  return { ...line, ...overrides };
}

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
 * 請求 (18-invoicing): drafts, the issue with its number, copies and 売掛金 / 売上, payments and
 * their cancellation, voids, conversions and the list, on fiscal years of their own (第 51〜53 期)
 * far from the seeded year 1 and the other test files.
 */
describe.skipIf(!hasTestDatabase)("invoicing (請求)", () => {
  let prisma: PrismaClient;
  let refs: SeededRefs;
  /** 第 51 期: exempt, tax-inclusive. */
  let exemptYear: FiscalYear;
  /** 第 52 期: 本則課税, tax-exclusive. */
  let exclusiveYear: FiscalYear;
  let company: Company;
  let partnerId: string;
  let bankWalletId: string;
  let cardWalletId: string;

  beforeAll(async () => {
    prisma = testPrisma();
    refs = await seededRefs(prisma);
    exemptYear = await createFiscalYear(prisma, {
      no: 51,
      startDate: "2051-04-01",
      endDate: "2052-03-31",
    });
    exclusiveYear = await createFiscalYear(prisma, {
      no: 52,
      startDate: "2052-04-01",
      endDate: "2053-03-31",
      tax: { consumptionTax: "general", accountingMethod: "tax_exclusive" },
    });
    await createFiscalYear(prisma, {
      no: 53,
      startDate: "2053-04-01",
      endDate: "2054-03-31",
      lockedThrough: "2053-06-30",
    });
    company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    // Start from a company without a registration (区分記載請求書); restored afterwards.
    await prisma.company.update({
      where: { id: company.id },
      data: { invoiceRegistrationNumber: null, invoiceRegisteredOn: null },
    });
    partnerId = (await prisma.partner.findFirstOrThrow({ where: { name: "架空デザイン合同会社" } }))
      .id;
    const wallets = new Map(
      (await prisma.wallet.findMany()).map((row) => [row.name, row.id] as const),
    );
    bankWalletId = wallets.get("架空銀行 普通") ?? "";
    cardWalletId = wallets.get("架空カード") ?? "";
  });

  afterAll(async () => {
    if (!company) return;
    await prisma.company.update({
      where: { id: company.id },
      data: {
        invoiceRegistrationNumber: company.invoiceRegistrationNumber,
        invoiceRegisteredOn: company.invoiceRegisteredOn,
        bankAccountForInvoice: company.bankAccountForInvoice ?? undefined,
      },
    });
  });

  const draftInput = (overrides: Partial<InvoiceDraftInput> = {}): InvoiceDraftInput => ({
    docType: "invoice",
    partnerId,
    title: "架空サイトの開発",
    issueDate: "2051-06-01",
    dueDate: "",
    pricesIncludeTax: false,
    note: "",
    revenueAccountId: "",
    segmentId: "",
    sourceInvoiceId: "",
    lines: FIXTURE_LINES,
    ...overrides,
  });

  async function issued(overrides: Partial<InvoiceDraftInput> = {}): Promise<InvoiceRecord> {
    const draft = await createInvoiceDraft(prisma, draftInput(overrides), options);
    return issueInvoice(prisma, draft.id, options);
  }

  const payment = (overrides: Partial<InvoicePaymentInput> = {}): InvoicePaymentInput => ({
    paidOn: "2052-06-20",
    walletId: bankWalletId,
    amount: "100,000",
    fee: "",
    walletTransactionId: "",
    ...overrides,
  });

  async function entryLines(entryId: string) {
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

  async function storedPayments(invoiceId: string) {
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    return row.payments as { id: string; journalEntryId: string; cancelledAt: string | null }[];
  }

  async function statementLine(amount: bigint, txnDate: CalendarDate, walletId = bankWalletId) {
    return prisma.walletTransaction.create({
      data: {
        id: newId(),
        walletId,
        txnDate: toDbDate(txnDate),
        amount,
        descriptionRaw: "フリコミ カクウデザイン",
        externalId: `invoice-test-${newId()}`,
      },
    });
  }

  it("saves a draft with the totals of 18 §3.2 and issues it: number, copies, 売掛金 / 売上", async () => {
    const draft = await createInvoiceDraft(prisma, draftInput(), options);
    expect(draft).toMatchObject({
      docType: "invoice",
      status: "draft",
      total: 138_622n,
      balance: 138_622n,
      journalEntryId: null,
    });
    expect(draft.number).toBe(`INV-draft-${draft.id}`);

    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    // 10% 125,005 → 12,500 once (per line it would be 12,501); 8% 1,035 → 82.
    expect(stored.subtotalByRate).toEqual({
      sales_10: {
        ratePercent: 10,
        reduced: false,
        taxable: true,
        lineCount: 3,
        subtotal: "125005",
        amountExclusive: "125005",
        amountInclusive: "137505",
      },
      sales_8r: {
        ratePercent: 8,
        reduced: true,
        taxable: true,
        lineCount: 1,
        subtotal: "1035",
        amountExclusive: "1035",
        amountInclusive: "1117",
      },
    });
    expect(stored.taxByRate).toEqual({ sales_10: "12500", sales_8r: "82" });
    expect(stored.total).toBe(138_622n);
    expect(stored.lines).toEqual([
      {
        date: null,
        name: "設計・開発 一式",
        quantity: "1",
        unit: "式",
        unitPrice: "100000",
        taxCategoryCode: "sales_10",
        amount: "100000",
      },
      {
        date: null,
        name: "保守（2 か月）",
        quantity: "2",
        unit: "月",
        unitPrice: "15005",
        taxCategoryCode: "sales_10",
        amount: "30010",
      },
      {
        date: null,
        name: "打合せの飲料",
        quantity: "3",
        unit: "本",
        unitPrice: "345",
        taxCategoryCode: "sales_8r",
        amount: "1035",
      },
      {
        date: null,
        name: "値引き",
        quantity: "1",
        unit: null,
        unitPrice: "-5005",
        taxCategoryCode: "sales_10",
        amount: "-5005",
      },
    ]);
    expect(stored).toMatchObject({
      revenueAccountId: refs.account("4040"),
      segmentId: refs.segment("contract"),
      issuerSnapshot: null,
      recipientSnapshot: null,
    });

    const before = await getInvoiceDetail(prisma, draft.id, { today: "2051-06-01" });
    expect(before).toMatchObject({
      qualified: false,
      plannedNumber: "INV-2051-0001",
      checklist: { qualified: false, ready: true },
      issuer: { name: company.name, invoiceRegistrationNumber: null, bankAccount: null },
      recipient: { name: "架空デザイン合同会社" },
      actions: {
        canEdit: true,
        canIssue: true,
        canDiscard: true,
        canSend: false,
        canPay: false,
        canVoid: false,
      },
    });

    const result = await issueInvoice(prisma, draft.id, options);
    expect(result).toMatchObject({
      number: "INV-2051-0001",
      status: "issued",
      total: 138_622n,
      balance: 138_622n,
    });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.issuedAt).not.toBeNull();
    expect(row.issuerSnapshot).toEqual({
      name: company.name,
      address: company.address,
      representative: company.representative,
      invoiceRegistrationNumber: null,
      invoiceRegisteredOn: null,
      qualified: false,
      bankAccount: null,
    });
    expect(row.recipientSnapshot).toEqual({ name: "架空デザイン合同会社", address: null });

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId ?? "" },
    });
    expect(entry).toMatchObject({
      fiscalYearId: exemptYear.id,
      kind: "normal",
      sourceKind: "invoice",
      sourceId: draft.id,
      description: "請求書 INV-2051-0001 架空デザイン合同会社",
    });
    expect(fromDbDate(entry.entryDate)).toBe("2051-06-01");
    // 税込経理: the revenue lines carry the tax-inclusive amounts with the document's taxes.
    expect(await entryLines(entry.id)).toEqual([
      ["debit", "1200", 138_622n, "na", 0n],
      ["credit", "4040", 137_505n, "sales_10", 12_500n],
      ["credit", "4040", 1_117n, "sales_8r", 82n],
    ]);

    const detail = await getInvoiceDetail(prisma, draft.id, { today: "2051-06-02" });
    expect(detail).toMatchObject({
      number: "INV-2051-0001",
      status: "issued",
      total: 138_622n,
      taxTotal: 12_582n,
      balance: 138_622n,
      hasReducedRate: true,
      overdue: false,
      checklist: null,
      plannedNumber: null,
      journalEntry: { id: entry.id, no: entry.no, voided: false, reversal: null },
      revenueAccount: { code: "4040" },
      segment: { code: "contract" },
      actions: {
        canEdit: false,
        canIssue: false,
        canSend: true,
        canPay: true,
        canVoid: true,
        blocked: { edit: "発行済みのため編集できません。直すには無効にして複製します" },
        convertTo: [],
      },
    });
    expect(detail?.rates.map((rate) => [rate.label, rate.amountInclusive, rate.taxAmount])).toEqual(
      [
        ["10%", 137_505n, 12_500n],
        ["8%（軽減）", 1_117n, 82n],
      ],
    );
    expect(detail?.lines.map((line) => [line.quantity, line.amount, line.reduced])).toEqual([
      ["1", 100_000n, false],
      ["2", 30_010n, false],
      ["3", 1_035n, true],
      ["1", -5_005n, false],
    ]);
  });

  it("books tax-exclusive amounts and 仮受消費税 in a tax-exclusive year", async () => {
    const result = await issued({ issueDate: "2052-06-01", dueDate: "2052-07-31" });
    expect(result.number).toBe("INV-2052-0001");
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId ?? "" },
    });
    expect(entry.fiscalYearId).toBe(exclusiveYear.id);
    expect(await entryLines(entry.id)).toEqual([
      ["debit", "1200", 138_622n, "na", 0n],
      ["credit", "4040", 125_005n, "sales_10", 12_500n],
      ["credit", "4040", 1_035n, "sales_8r", 82n],
      ["credit", "2310", 12_582n, "na", 0n],
    ]);

    // Tax-inclusive unit prices: the tax is taken out of the rate's total once.
    const inclusive = await createInvoiceDraft(
      prisma,
      draftInput({
        issueDate: "2052-06-02",
        dueDate: "",
        pricesIncludeTax: "true",
        lines: [fixtureLine(0, { quantity: "1", unitPrice: "11,000" })],
      }),
      options,
    );
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inclusive.id } });
    expect(row.pricesIncludeTax).toBe(true);
    expect(row.subtotalByRate).toMatchObject({
      sales_10: { subtotal: "11000", amountExclusive: "10000", amountInclusive: "11000" },
    });
    expect(row.taxByRate).toEqual({ sales_10: "1000" });
    expect(row.total).toBe(11_000n);
  });

  it("numbers per type and fiscal year without gaps: void numbers count", async () => {
    const second = await issued({ issueDate: "2051-06-10" });
    expect(second.number).toBe("INV-2051-0002");
    await voidInvoice(prisma, second.id, { reason: "宛先の誤り" }, options);
    const third = await issued({ issueDate: "2051-06-11" });
    expect(third.number).toBe("INV-2051-0003");

    const quote = await issued({ docType: "quote", issueDate: "2051-06-12" });
    expect(quote).toMatchObject({ number: "QT-2051-0001", journalEntryId: null });
    const delivery = await issued({
      docType: "delivery",
      issueDate: "2051-06-12",
      dueDate: "2051-07-12",
    });
    expect(delivery).toMatchObject({ number: "DN-2051-0001", dueDate: null });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row).toMatchObject({ revenueAccountId: null, segmentId: null });
    expect(row.issuerSnapshot).toMatchObject({ bankAccount: null });

    // A draft's planned number is not reserved: an issue in between moves it.
    const waiting = await createInvoiceDraft(
      prisma,
      draftInput({ issueDate: "2051-06-20" }),
      options,
    );
    const planned = (await getInvoiceDetail(prisma, waiting.id, { today: "2051-06-20" }))
      ?.plannedNumber;
    expect(planned).toBe("INV-2051-0004");
    expect((await issued({ issueDate: "2051-06-13" })).number).toBe("INV-2051-0004");
    expect((await issueInvoice(prisma, waiting.id, options)).number).toBe("INV-2051-0005");
  });

  it("never rewrites an issued document: the app and the DB trigger refuse", async () => {
    const result = await issued({ issueDate: "2051-06-15" });
    const edit = await rejectionOf(
      updateInvoiceDraft(prisma, result.id, draftInput({ title: "書き換え" }), options),
    );
    expect(settingsError(edit).message).toBe(
      "発行済みのため編集できません。直すには無効にして複製します",
    );
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "title" = '書き換え' WHERE "id" = ${result.id}`,
    ).rejects.toThrow(/ledger guard: invoice .* its body is immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "total" = 1 WHERE "id" = ${result.id}`,
    ).rejects.toThrow(/its body is immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "status" = 'draft' WHERE "id" = ${result.id}`,
    ).rejects.toThrow(/cannot go back to draft/);
    await expect(
      prisma.$executeRaw`DELETE FROM "invoice" WHERE "id" = ${result.id}`,
    ).rejects.toThrow(/ledger guard: invoice .* cannot be deleted/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "invoice" CASCADE`)).rejects.toThrow(
      /TRUNCATE on invoice is not allowed/,
    );
    // The state columns may change after the issue (送付).
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "sent_to" = 'a@example.com' WHERE "id" = ${result.id}`,
    ).resolves.toBe(1);

    // A draft's body is free; it is still never deleted.
    const draft = await createInvoiceDraft(prisma, draftInput(), options);
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "title" = '下書きの件名' WHERE "id" = ${draft.id}`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`DELETE FROM "invoice" WHERE "id" = ${draft.id}`,
    ).rejects.toThrow(/cannot be deleted/);

    // A void document never changes again.
    await voidInvoice(prisma, result.id, { reason: "テスト" }, options);
    await expect(
      prisma.$executeRaw`UPDATE "invoice" SET "sent_to" = 'b@example.com' WHERE "id" = ${result.id}`,
    ).rejects.toThrow(/is void and cannot change/);
  });

  it("edits a draft (totals recomputed) and discards it logically", async () => {
    const draft = await createInvoiceDraft(prisma, draftInput(), options);
    const edited = await updateInvoiceDraft(
      prisma,
      draft.id,
      draftInput({
        docType: "quote",
        title: "保守のみ",
        lines: [fixtureLine(1)],
      }),
      options,
    );
    // The type never changes on an edit.
    expect(edited).toMatchObject({ docType: "invoice", total: 33_011n });
    // Saving the same body again writes nothing.
    await updateInvoiceDraft(
      prisma,
      draft.id,
      draftInput({ title: "保守のみ", lines: [fixtureLine(1)] }),
      options,
    );
    const history = await loadInvoiceHistory(prisma, draft.id);
    expect(history.map((row) => row.action)).toEqual(["invoice.create", "invoice.update"]);

    const discarded = await discardInvoiceDraft(prisma, draft.id, options);
    expect(discarded).toMatchObject({ status: "void", number: `INV-draft-${draft.id}` });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ status: "void", voidReason: "下書きを破棄" });
    expect(row.voidedAt).not.toBeNull();
    expect(
      settingsError(await rejectionOf(discardInvoiceDraft(prisma, draft.id, options))).message,
    ).toMatch(/すでに破棄/);
    expect(
      settingsError(await rejectionOf(issueInvoice(prisma, draft.id, options))).message,
    ).toMatch(/無効の書類は発行できません/);
  });

  it("validates the form: quantities, sales categories, dates, partners and accounts", async () => {
    const zod = async (input: InvoiceDraftInput) => {
      const error = await rejectionOf(createInvoiceDraft(prisma, input, options));
      expect(error).toBeInstanceOf(ZodError);
      return (error as ZodError).issues.map(({ path, message }) => ({ path, message }));
    };
    expect(await zod(draftInput({ lines: [fixtureLine(0, { quantity: "0" })] }))).toContainEqual({
      path: ["lines", 0, "quantity"],
      message: "数量は 0 より大きい数（小数 2 桁まで）にしてください",
    });
    expect(
      await zod(draftInput({ lines: [fixtureLine(0, { quantity: "1.234" })] })),
    ).toContainEqual(expect.objectContaining({ path: ["lines", 0, "quantity"] }));
    expect(
      await zod(draftInput({ lines: [fixtureLine(0, { taxCategoryCode: "purchase_10" })] })),
    ).toContainEqual({
      path: ["lines", 0, "taxCategoryCode"],
      message: "税区分は売上の税区分から選んでください",
    });
    expect(await zod(draftInput({ lines: [] }))).toContainEqual({
      path: ["lines"],
      message: "行は 1 行以上にしてください",
    });
    expect(await zod(draftInput({ dueDate: "2051-05-31" }))).toContainEqual({
      path: ["dueDate"],
      message: "期限は発行日以後にしてください",
    });

    const inactive = await prisma.partner.create({
      data: { id: newId(), name: "架空休止株式会社", kind: "customer", isActive: false },
    });
    expect(
      settingsError(
        await rejectionOf(
          createInvoiceDraft(prisma, draftInput({ partnerId: inactive.id }), options),
        ),
      ),
    ).toEqual({
      message:
        "取引先「架空休止株式会社」は無効です。有効な取引先を選ぶか、設定 › 取引先 で有効にしてください",
      field: "partnerId",
    });
    expect(
      settingsError(
        await rejectionOf(
          createInvoiceDraft(
            prisma,
            draftInput({ revenueAccountId: refs.account("1100") }),
            options,
          ),
        ),
      ),
    ).toEqual({ message: "売上の科目は収益の科目から選んでください", field: "revenueAccountId" });

    // The choices of the form: customers (not vendors), revenue accounts, the defaults.
    const choices = await loadInvoiceFormOptions(prisma);
    expect(choices.partners.map((partner) => partner.name)).toContain("架空デザイン合同会社");
    expect(choices.partners.map((partner) => partner.name)).not.toContain("架空クラウド株式会社");
    expect(choices.revenueAccounts.every((account) => account.code.startsWith("4"))).toBe(true);
    expect(choices.taxCategories.map((category) => category.code)).toEqual([
      "sales_10",
      "sales_8r",
      "sales_exempt",
      "sales_out",
      "sales_export",
    ]);
    expect(choices.defaults).toEqual({
      revenueAccountId: refs.account("4040"),
      segmentId: refs.segment("contract"),
      taxCategoryCode: "sales_10",
    });
  });

  it("registers payments: partial, with a fee (支払手数料・仮払消費税), from a statement line, and cancels them", async () => {
    const invoice = await issued({ issueDate: "2052-06-01", dueDate: "2052-07-31" });

    // A partial payment lowers the balance only.
    const partial = await recordInvoicePayment(prisma, invoice.id, payment(), options);
    expect(partial).toMatchObject({ status: "issued", balance: 38_622n });
    const [first] = await storedPayments(invoice.id);
    expect(await entryLines(first?.journalEntryId ?? "")).toEqual([
      ["debit", "1100", 100_000n, "na", 0n],
      ["credit", "1200", 100_000n, "na", 0n],
    ]);
    const firstEntry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: first?.journalEntryId ?? "" },
    });
    expect(firstEntry).toMatchObject({
      sourceKind: "invoice",
      sourceId: invoice.id,
      description: `入金 ${invoice.number} 架空デザイン合同会社`,
    });

    expect(
      settingsError(
        await rejectionOf(
          recordInvoicePayment(prisma, invoice.id, payment({ paidOn: "2052-05-31" }), options),
        ),
      ),
    ).toEqual({ message: "入金日は発行日以後にしてください", field: "paidOn" });
    expect(
      settingsError(
        await rejectionOf(
          recordInvoicePayment(
            prisma,
            invoice.id,
            payment({ amount: "38,622", fee: "1" }),
            options,
          ),
        ),
      ),
    ).toEqual({
      message: "入金額と手数料の合計が残高 38,622 円を超えています",
      field: "amount",
    });

    // The rest with the transfer fee the customer deducted: the balance reaches 0.
    const paid = await recordInvoicePayment(
      prisma,
      invoice.id,
      payment({ paidOn: "2052-06-25", amount: "38,182", fee: "440" }),
      options,
    );
    expect(paid).toMatchObject({ status: "paid", balance: 0n });
    const [, second] = await storedPayments(invoice.id);
    expect(await entryLines(second?.journalEntryId ?? "")).toEqual([
      ["debit", "1100", 38_182n, "na", 0n],
      ["debit", "5400", 400n, "purchase_10", 40n],
      ["debit", "1400", 40n, "na", 0n],
      ["credit", "1200", 38_622n, "na", 0n],
    ]);
    const feeLine = await prisma.journalLine.findFirstOrThrow({
      where: { journalEntryId: second?.journalEntryId ?? "", lineNo: 2 },
    });
    expect(feeLine.segmentId).toBe(refs.segment("contract"));
    expect(
      settingsError(await rejectionOf(recordInvoicePayment(prisma, invoice.id, payment(), options)))
        .message,
    ).toMatch(/入金済み/);

    // A paid invoice records its first sending and stays paid.
    const sent = await markInvoiceSent(
      prisma,
      invoice.id,
      { sentTo: "billing@example.com" },
      options,
    );
    expect(sent.status).toBe("paid");
    expect(sent.sentAt).not.toBeNull();
    await expect(markInvoiceSent(prisma, invoice.id, { sentTo: "" }, options)).rejects.toThrow(
      /送付の記録があります/,
    );

    // Cancelling the payment reverses its entry; a sent invoice returns to 送付済み.
    const cancelled = await cancelInvoicePayment(
      prisma,
      invoice.id,
      { paymentId: second?.id ?? "", reason: "金額の誤り" },
      options,
    );
    expect(cancelled).toMatchObject({ status: "sent", balance: 38_622n });
    const voidedEntry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: second?.journalEntryId ?? "" },
      include: { reversal: true },
    });
    expect(voidedEntry).toMatchObject({ status: "voided", voidReason: "金額の誤り" });
    expect(voidedEntry.reversal?.kind).toBe("reversal");
    const afterCancel = await storedPayments(invoice.id);
    expect(afterCancel[1]).toMatchObject({
      cancelReason: "金額の誤り",
      reversalEntryId: voidedEntry.reversal?.id,
    });
    expect(afterCancel[1]?.cancelledAt).not.toBeNull();
    await expect(
      cancelInvoicePayment(
        prisma,
        invoice.id,
        { paymentId: second?.id ?? "", reason: "二度目" },
        options,
      ),
    ).rejects.toThrow(/取消済み/);

    // From a statement line: the closest deposits are offered, the line becomes registered.
    const exact = await statementLine(38_622n, "2052-07-01");
    const smaller = await statementLine(30_000n, "2052-07-02");
    const larger = await statementLine(50_000n, "2052-07-03");
    const candidates = await loadDepositCandidates(prisma, invoice.id);
    expect(candidates[0]).toMatchObject({
      id: exact.id,
      walletName: "架空銀行 普通",
      txnDate: "2052-07-01",
      amount: 38_622n,
      difference: 0n,
    });
    expect(candidates.findIndex((row) => row.id === smaller.id)).toBeGreaterThan(0);
    expect(candidates.some((row) => row.id === larger.id)).toBe(false);

    expect(
      settingsError(
        await rejectionOf(
          recordInvoicePayment(
            prisma,
            invoice.id,
            payment({ walletTransactionId: exact.id, walletId: cardWalletId }),
            options,
          ),
        ),
      ).field,
    ).toBe("walletId");
    // The line's date, wallet and amount are used, whatever the form said.
    const fromLine = await recordInvoicePayment(
      prisma,
      invoice.id,
      payment({ walletTransactionId: exact.id, paidOn: "2052-06-30", amount: "1" }),
      options,
    );
    expect(fromLine).toMatchObject({ status: "paid", balance: 0n });
    const third = (await storedPayments(invoice.id))[2] as unknown as {
      id: string;
      paidOn: string;
      amount: string;
      walletTransactionId: string;
      journalEntryId: string;
    };
    expect(third).toMatchObject({
      paidOn: "2052-07-01",
      amount: "38622",
      walletTransactionId: exact.id,
    });
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({ where: { id: exact.id } }),
    ).toMatchObject({ status: "registered", journalEntryId: third.journalEntryId });
    const lineAudit = await prisma.auditLog.findMany({
      where: { entity: "wallet_transaction", entityId: exact.id },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });
    expect(lineAudit.map((row) => row.action)).toEqual(["wallet_transaction.register"]);

    // Cancelling it puts the line back to pending.
    await cancelInvoicePayment(
      prisma,
      invoice.id,
      { paymentId: third.id, reason: "別の請求の入金" },
      options,
    );
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({ where: { id: exact.id } }),
    ).toMatchObject({ status: "pending", journalEntryId: null });

    const detail = await getInvoiceDetail(prisma, invoice.id, { today: "2052-08-01" });
    expect(detail).toMatchObject({
      status: "sent",
      balance: 38_622n,
      overdue: true,
      overdueDays: 1,
      sentTo: "billing@example.com",
      actions: {
        canPay: true,
        canVoid: false,
        blocked: { void: "入金が残っています。先に入金を取り消してください" },
      },
    });
    expect(
      detail?.payments.map((row) => [row.walletName, row.applied, row.cancelled, row.cancelReason]),
    ).toEqual([
      ["架空銀行 普通", 100_000n, false, null],
      ["架空銀行 普通", 38_622n, true, "金額の誤り"],
      ["架空銀行 普通", 38_622n, true, "別の請求の入金"],
    ]);
    expect(detail?.payments[1]?.reversalEntry?.no).toBe(voidedEntry.reversal?.no);

    // A payment in force keeps the invoice from being voided.
    expect(
      settingsError(
        await rejectionOf(voidInvoice(prisma, invoice.id, { reason: "取りやめ" }, options)),
      ).message,
    ).toBe("入金が残っています。先に入金を取り消してください");
  });

  it("voids an invoice with the reversal of its 売掛金 entry; the number stays", async () => {
    const invoice = await issued({ issueDate: "2051-07-01" });
    const voided = await voidInvoice(prisma, invoice.id, { reason: "取引の取りやめ" }, options);
    expect(voided).toMatchObject({ status: "void", number: invoice.number });
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: invoice.journalEntryId ?? "" },
      include: { reversal: true },
    });
    expect(entry).toMatchObject({ status: "voided", voidReason: "取引の取りやめ" });
    expect(entry.reversal).toMatchObject({ kind: "reversal", reversalOfId: entry.id });
    expect(fromDbDate(entry.reversal?.entryDate ?? new Date(0))).toBe("2051-07-01");

    const detail = await getInvoiceDetail(prisma, invoice.id, { today: "2051-07-02" });
    expect(detail).toMatchObject({
      status: "void",
      voidReason: "取引の取りやめ",
      journalEntry: { voided: true, reversal: { id: entry.reversal?.id } },
      actions: { canVoid: false, canPay: false, canSend: false, canEdit: false },
    });
    await expect(voidInvoice(prisma, invoice.id, { reason: "二度目" }, options)).rejects.toThrow(
      /すでに無効/,
    );
    await expect(voidInvoice(prisma, invoice.id, { reason: " " }, options)).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it("converts an issued quote into an invoice and a delivery note; refuses other sources", async () => {
    const draftQuote = await createInvoiceDraft(prisma, draftInput({ docType: "quote" }), options);
    expect(
      settingsError(
        await rejectionOf(
          createInvoiceDraft(prisma, draftInput({ sourceInvoiceId: draftQuote.id }), options),
        ),
      ),
    ).toEqual({
      message: "変換元の見積書は下書きです。発行してから請求書を作ってください",
      field: "sourceInvoiceId",
    });

    const quote = await issued({ docType: "quote", issueDate: "2051-08-01" });
    const invoice = await createInvoiceDraft(
      prisma,
      draftInput({ issueDate: "2051-08-10", sourceInvoiceId: quote.id }),
      options,
    );
    const delivery = await createInvoiceDraft(
      prisma,
      draftInput({ docType: "delivery", issueDate: "2051-08-05", sourceInvoiceId: quote.id }),
      options,
    );
    const issuedInvoice = await issueInvoice(prisma, invoice.id, options);
    expect(
      settingsError(
        await rejectionOf(
          createInvoiceDraft(prisma, draftInput({ sourceInvoiceId: issuedInvoice.id }), options),
        ),
      ),
    ).toEqual({
      message:
        "請求書から請求書は作れません。見積書から納品書・請求書を、納品書から請求書を作れます",
      field: "sourceInvoiceId",
    });

    const quoteDetail = await getInvoiceDetail(prisma, quote.id, { today: "2051-08-10" });
    expect(quoteDetail?.actions.convertTo).toEqual(["delivery", "invoice"]);
    expect(quoteDetail?.convertedTo.map((ref) => ref.id)).toEqual([invoice.id, delivery.id]);
    await discardInvoiceDraft(prisma, delivery.id, options);
    const afterDiscard = await getInvoiceDetail(prisma, quote.id, { today: "2051-08-10" });
    expect(afterDiscard?.convertedTo).toEqual([
      { id: invoice.id, docType: "invoice", number: issuedInvoice.number, status: "issued" },
    ]);
    const invoiceDetail = await getInvoiceDetail(prisma, invoice.id, { today: "2051-08-10" });
    expect(invoiceDetail?.source).toEqual({
      id: quote.id,
      docType: "quote",
      number: quote.number,
      status: "issued",
    });

    // The form values of a document (edit / conversion / copy), lines as text.
    const source = await loadInvoiceDraftInput(prisma, quote.id);
    expect(source).toMatchObject({ docType: "quote", number: quote.number, status: "issued" });
    expect(source?.values.lines.map((line) => [line.quantity, line.unitPrice])).toEqual([
      ["1", "100000"],
      ["2", "15005"],
      ["3", "345"],
      ["1", "-5005"],
    ]);
    const copy = await createInvoiceDraft(
      prisma,
      {
        ...(source ? source.values : draftInput()),
        sourceInvoiceId: "",
        issueDate: "2051-08-20",
        dueDate: "",
      },
      options,
    );
    expect(copy).toMatchObject({ docType: "quote", status: "draft", total: 138_622n });
  });

  it("issues a 区分記載請求書 before the registration date and a 適格請求書 from it, with the 振込先", async () => {
    const registration = `T${fictionalCorporateNumber()}`;
    try {
      await prisma.company.update({
        where: { id: company.id },
        data: {
          invoiceRegistrationNumber: registration,
          invoiceRegisteredOn: toDbDate("2051-09-01"),
        },
      });
      const settings = await updateInvoiceSettings(
        prisma,
        {
          bankName: "架空銀行",
          branchName: "見本支店",
          accountType: "ordinary",
          accountNumber: "１２３４５６７",
          accountHolder: "カクウシヨウカイ",
          note: "振込手数料は貴社にてご負担ください",
        },
        options,
      );
      expect(settings.bankAccount).toEqual({
        bankName: "架空銀行",
        branchName: "見本支店",
        accountType: "ordinary",
        accountNumber: "1234567",
        accountHolder: "カクウシヨウカイ",
        note: "振込手数料は貴社にてご負担ください",
      });
      await expect(
        updateInvoiceSettings(prisma, { accountNumber: "12-34" }, options),
      ).rejects.toThrow(/口座番号は数字にしてください/);

      const before = await createInvoiceDraft(
        prisma,
        draftInput({ issueDate: "2051-08-31", dueDate: "" }),
        options,
      );
      const from = await createInvoiceDraft(
        prisma,
        draftInput({ issueDate: "2051-09-01", dueDate: "" }),
        options,
      );
      const beforeDetail = await getInvoiceDetail(prisma, before.id, { today: "2051-09-01" });
      expect(beforeDetail).toMatchObject({
        qualified: false,
        issuer: { invoiceRegistrationNumber: null },
      });
      expect(
        beforeDetail?.checklist?.items.find((item) => item.key === "registration"),
      ).toMatchObject({ state: "info" });
      const fromDetail = await getInvoiceDetail(prisma, from.id, { today: "2051-09-01" });
      expect(fromDetail).toMatchObject({
        qualified: true,
        issuer: { invoiceRegistrationNumber: registration, bankAccount: settings.bankAccount },
      });

      await issueInvoice(prisma, before.id, options);
      await issueInvoice(prisma, from.id, options);
      const quote = await issued({ docType: "quote", issueDate: "2051-09-02" });
      const snapshot = async (id: string) =>
        (await prisma.invoice.findUniqueOrThrow({ where: { id } })).issuerSnapshot;
      expect(await snapshot(before.id)).toMatchObject({
        qualified: false,
        invoiceRegistrationNumber: null,
        invoiceRegisteredOn: null,
        bankAccount: settings.bankAccount,
      });
      expect(await snapshot(from.id)).toMatchObject({
        qualified: true,
        invoiceRegistrationNumber: registration,
        invoiceRegisteredOn: "2051-09-01",
        bankAccount: settings.bankAccount,
      });
      expect(await snapshot(quote.id)).toMatchObject({ qualified: true, bankAccount: null });

      // Later settings never reach an issued document.
      const cleared = await updateInvoiceSettings(
        prisma,
        { bankName: "", branchName: "", accountType: "", accountNumber: "", accountHolder: "" },
        options,
      );
      expect(cleared.bankAccount).toBeNull();
      expect((await getInvoiceSettings(prisma)).bankAccount).toBeNull();
      const audit = await prisma.auditLog.findMany({
        where: { entity: "company", entityId: company.id, action: "company.update" },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        take: 2,
      });
      expect(audit.map((row) => [row.before, row.after])).toEqual([
        [{ bankAccountForInvoice: settings.bankAccount }, { bankAccountForInvoice: null }],
        [{ bankAccountForInvoice: null }, { bankAccountForInvoice: settings.bankAccount }],
      ]);
      const fromAfter = await getInvoiceDetail(prisma, from.id, { today: "2051-09-02" });
      expect(fromAfter?.issuer).toMatchObject({
        qualified: true,
        bankAccount: settings.bankAccount,
      });
    } finally {
      await prisma.company.update({
        where: { id: company.id },
        data: { invoiceRegistrationNumber: null, invoiceRegisteredOn: null },
      });
    }
  });

  it("refuses to issue on a closed date or outside the fiscal years, naming the issue date", async () => {
    const closed = await createInvoiceDraft(
      prisma,
      draftInput({ issueDate: "2053-06-15", dueDate: "" }),
      options,
    );
    const detail = await getInvoiceDetail(prisma, closed.id, { today: "2053-07-01" });
    expect(detail?.actions.canIssue).toBe(false);
    expect(detail?.actions.blocked.issue).toMatch(/2053\/06\/30 までは締めています/);
    expect(ledgerErrors(await rejectionOf(issueInvoice(prisma, closed.id, options)))).toEqual([
      { code: "PERIOD_LOCKED", field: "issueDate" },
    ]);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: closed.id } })).toMatchObject({
      status: "draft",
      journalEntryId: null,
    });

    const outside = await createInvoiceDraft(
      prisma,
      draftInput({ issueDate: "2099-01-01", dueDate: "" }),
      options,
    );
    expect(
      (await getInvoiceDetail(prisma, outside.id, { today: "2099-01-01" }))?.plannedNumber,
    ).toBeNull();
    expect(ledgerErrors(await rejectionOf(issueInvoice(prisma, outside.id, options)))).toEqual([
      { code: "OUT_OF_FISCAL_YEAR", field: "issueDate" },
    ]);

    // The refused issue took no number: the next one in the year is still 0001.
    expect((await issued({ issueDate: "2053-07-01", dueDate: "" })).number).toBe("INV-2053-0001");
  });

  it("lists the overdue invoices first, then by issue date, with the filters", async () => {
    const partner = await prisma.partner.create({
      data: { id: newId(), name: "架空リスト合同会社", kind: "customer" },
    });
    const of = (overrides: Partial<InvoiceDraftInput>) =>
      issued({ partnerId: partner.id, ...overrides });
    const a = await of({ issueDate: "2051-10-01", dueDate: "2051-10-31", title: "保守 10 月" });
    const d = await of({ issueDate: "2051-09-01", dueDate: "2051-11-30", title: "保守 9 月" });
    await markInvoiceSent(prisma, d.id, { sentTo: "" }, options);
    const b = await of({ issueDate: "2051-11-01", dueDate: "2051-12-31", title: "開発 11 月" });
    const c = await createInvoiceDraft(
      prisma,
      draftInput({
        partnerId: partner.id,
        issueDate: "2051-12-01",
        dueDate: "2052-01-31",
        title: "開発 12 月",
      }),
      options,
    );
    const e = await of({ issueDate: "2051-08-01", dueDate: "2051-08-31", title: "完了分" });
    await recordInvoicePayment(
      prisma,
      e.id,
      payment({ paidOn: "2051-08-20", amount: "138,622" }),
      options,
    );
    const q = await of({ docType: "quote", issueDate: "2051-11-15", dueDate: "", title: "次期" });

    const today: CalendarDate = "2051-12-15";
    const ids = async (filters: Parameters<typeof listInvoices>[1], page = 1, pageSize = 50) =>
      (
        await listInvoices(prisma, { partner: partner.id, ...filters }, page, { today, pageSize })
      ).rows.map((row) => row.id);

    const page = await listInvoices(prisma, { partner: partner.id }, 1, { today });
    expect(page.rows.map((row) => row.id)).toEqual([a.id, d.id, c.id, b.id]);
    expect(page).toMatchObject({ total: 4, page: 1, pageCount: 1, truncated: false });
    expect(page.rows[0]).toMatchObject({
      overdue: true,
      overdueDays: 45,
      partnerName: "架空リスト合同会社",
      balance: 138_622n,
    });
    expect(page.rows[1]).toMatchObject({ status: "sent", overdue: true, overdueDays: 15 });
    expect(page.rows[2]).toMatchObject({ status: "draft", overdue: false });

    expect(await ids({ status: "draft" })).toEqual([c.id]);
    expect(await ids({ status: "issued" })).toEqual([a.id, d.id, b.id]);
    expect(await ids({ status: "paid" })).toEqual([e.id]);
    expect(await ids({ type: "quote" })).toEqual([q.id]);
    expect(await ids({ type: "all", status: "all" })).toEqual([a.id, d.id, c.id, q.id, b.id, e.id]);
    expect(await ids({ q: a.number.toLowerCase() })).toEqual([a.id]);
    expect(await ids({ q: "保守" })).toEqual([a.id, d.id]);
    // A draft's placeholder number is never searched.
    expect(await ids({ q: "draft", status: "all" })).toEqual([]);
    expect(await ids({}, 2, 2)).toEqual([c.id, b.id]);
    expect(await ids({}, 99, 3)).toEqual([b.id]);
  });

  it("records the history of a document in the audit log", async () => {
    const draft = await createInvoiceDraft(
      prisma,
      draftInput({ issueDate: "2051-10-05", dueDate: "" }),
      options,
    );
    await updateInvoiceDraft(
      prisma,
      draft.id,
      draftInput({ issueDate: "2051-10-06", dueDate: "" }),
      options,
    );
    const result = await issueInvoice(prisma, draft.id, options);
    await markInvoiceSent(prisma, draft.id, { sentTo: "billing@example.com" }, options);
    await recordInvoicePayment(
      prisma,
      draft.id,
      payment({ paidOn: "2051-10-20", amount: "50,000" }),
      options,
    );
    const [paid] = await storedPayments(draft.id);
    await cancelInvoicePayment(
      prisma,
      draft.id,
      { paymentId: paid?.id ?? "", reason: "二重登録" },
      options,
    );
    await voidInvoice(prisma, draft.id, { reason: "金額の誤り" }, options);

    const history = await loadInvoiceHistory(prisma, draft.id);
    expect(history.map((row) => row.action)).toEqual([
      "invoice.create",
      "invoice.update",
      "invoice.issue",
      "invoice.send",
      "invoice.pay",
      "invoice.cancel_payment",
      "invoice.void",
    ]);
    expect(history.map((row) => row.reason)).toEqual([
      null,
      null,
      null,
      null,
      null,
      "二重登録",
      "金額の誤り",
    ]);
    expect(history[2]).toMatchObject({
      actor,
      before: { status: "draft", issueDate: "2051-10-06" },
      after: { number: result.number, status: "issued", journalEntryId: result.journalEntryId },
    });
    expect(history[4]?.after).toMatchObject({ amount: "50000", fee: "0", paidOn: "2051-10-20" });

    const quote = await createInvoiceDraft(prisma, draftInput({ docType: "quote" }), options);
    const names = await describeAuditTargets(prisma, [
      { entity: "invoice", entityId: draft.id },
      { entity: "invoice", entityId: quote.id },
    ]);
    expect(names.get(`invoice:${draft.id}`)).toBe(`請求 ${result.number}`);
    expect(names.get(`invoice:${quote.id}`)).toBe("請求 見積書（下書き）");
  });
});
