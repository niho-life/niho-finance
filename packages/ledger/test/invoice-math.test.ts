/**
 * 請求の計算と仕訳 (docs/design/18-invoicing.md §2–§5, 03 §2.3, 02 §4.4).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildInvoiceIssueEntry,
  buildInvoicePaymentEntry,
  computeInvoiceTotals,
  defaultDueDate,
  defaultReceiptProviso,
  formatReceiptNumber,
  draftInvoiceNumber,
  formatInvoiceNumber,
  formatQuantity,
  invoiceBalance,
  invoiceChecklist,
  invoiceNumberLabel,
  invoiceNumberPrefix,
  invoiceRateLabel,
  isInvoiceOverdue,
  isQualifiedInvoice,
  LedgerValidationError,
  lineAmount,
  nextInvoiceSequence,
  overdueDays,
  parseInvoiceSequence,
  parseQuantity,
  RECEIPT_PROVISO_MAX,
  RECEIPT_STAMP_NOTE,
  receiptDateProblem,
  receiptNumberPrefix,
  receiptStampNote,
  STANDARD_TAX_RATE_RULES,
  validateEntry,
  type AccountingMethod,
  type AccountRef,
  type CalendarDate,
  type EntryAccount,
  type EntryWallet,
  type InvoiceLineAmountInput,
  type InvoiceTotals,
  type JournalEntryInput,
  type SimpleEntryContext,
  type ValidationContext,
} from "../src";
import { FISCAL_YEAR } from "./fixtures";

const ISSUE_DATE: CalendarDate = "2026-12-01";

/** The fixture of 18 §3.2: 10% and 8% mixed, with a discount (prices without tax). */
const FIXTURE_LINES: InvoiceLineAmountInput[] = [
  { quantity: 100n, unitPrice: 100_000n, taxCategoryCode: "sales_10" },
  { quantity: 200n, unitPrice: 15_005n, taxCategoryCode: "sales_10" },
  { quantity: 300n, unitPrice: 345n, taxCategoryCode: "sales_8r" },
  { quantity: 100n, unitPrice: -5_005n, taxCategoryCode: "sales_10" },
];

function totalsOf(
  lines: readonly InvoiceLineAmountInput[],
  options: { pricesIncludeTax?: boolean; issueDate?: CalendarDate } = {},
): InvoiceTotals {
  return computeInvoiceTotals(lines, {
    pricesIncludeTax: options.pricesIncludeTax ?? false,
    issueDate: options.issueDate ?? ISSUE_DATE,
    taxRules: STANDARD_TAX_RATE_RULES,
  });
}

describe("quantities and line amounts", () => {
  it("parses up to 2 decimals as hundredths", () => {
    expect(parseQuantity("1")).toBe(100n);
    expect(parseQuantity("1.5")).toBe(150n);
    expect(parseQuantity("0.25")).toBe(25n);
    expect(parseQuantity("１，０００．５")).toBe(100_050n);
    expect(parseQuantity(" 2 ")).toBe(200n);
  });

  it("rejects what is not a positive quantity with at most 2 decimals", () => {
    for (const text of ["", "0", "0.00", "-1", "1.234", "abc", "1e3", "1.", ".5"]) {
      expect(parseQuantity(text)).toBeNull();
    }
  });

  it("formats hundredths as the shortest decimal", () => {
    expect(formatQuantity(150n)).toBe("1.5");
    expect(formatQuantity(105n)).toBe("1.05");
    expect(formatQuantity(300n)).toBe("3");
    expect(formatQuantity(25n)).toBe("0.25");
  });

  it("round-trips any quantity", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 99_999_999_999n }), (hundredths) => {
        expect(parseQuantity(formatQuantity(hundredths))).toBe(hundredths);
      }),
    );
  });

  it("truncates the amount toward 0 (discounts included)", () => {
    expect(lineAmount(150n, 333n)).toBe(499n); // 499.5
    expect(lineAmount(150n, -333n)).toBe(-499n);
    expect(lineAmount(100n, -5_005n)).toBe(-5_005n);
  });
});

describe("totals per tax rate (one rounding per rate)", () => {
  it("matches the fixture of the design: 10% 12,500 / 8% 82 / 138,622", () => {
    const totals = totalsOf(FIXTURE_LINES);
    expect(totals.lineAmounts).toEqual([100_000n, 30_010n, 1_035n, -5_005n]);
    expect(totals.rates).toEqual([
      {
        taxCategoryCode: "sales_10",
        ratePercent: 10,
        reduced: false,
        taxable: true,
        lineCount: 3,
        subtotal: 125_005n,
        amountExclusive: 125_005n,
        taxAmount: 12_500n,
        amountInclusive: 137_505n,
      },
      {
        taxCategoryCode: "sales_8r",
        ratePercent: 8,
        reduced: true,
        taxable: true,
        lineCount: 1,
        subtotal: 1_035n,
        amountExclusive: 1_035n,
        taxAmount: 82n,
        amountInclusive: 1_117n,
      },
    ]);
    expect(totals.taxTotal).toBe(12_582n);
    expect(totals.total).toBe(138_622n);
  });

  it("differs from adding up per-line taxes (which the rule forbids)", () => {
    const perLine = [100_000n, 30_010n, -5_005n].reduce((sum, amount) => sum + amount / 10n, 0n);
    expect(perLine).toBe(12_501n);
    expect(totalsOf(FIXTURE_LINES).rates[0]?.taxAmount).toBe(12_500n);
  });

  it("takes the tax out of tax-inclusive prices once per rate", () => {
    const totals = totalsOf(
      [
        { quantity: 100n, unitPrice: 110_000n, taxCategoryCode: "sales_10" },
        { quantity: 100n, unitPrice: 1_001n, taxCategoryCode: "sales_10" },
        { quantity: 100n, unitPrice: 1_080n, taxCategoryCode: "sales_8r" },
      ],
      { pricesIncludeTax: true },
    );
    const [ten, eight] = totals.rates;
    // 111,001 × 10 / 110 = 10,091.0… → 10,091 (per line: 10,000 + 91 = 10,091; 1,001 alone is 91.0…)
    expect(ten).toMatchObject({
      subtotal: 111_001n,
      taxAmount: 10_091n,
      amountExclusive: 100_910n,
    });
    expect(ten?.amountInclusive).toBe(111_001n);
    expect(eight).toMatchObject({ subtotal: 1_080n, taxAmount: 80n, amountExclusive: 1_000n });
    expect(totals.total).toBe(112_081n);
  });

  it("keeps the categories outside the tax apart, at 0%", () => {
    const totals = totalsOf([
      { quantity: 100n, unitPrice: 10_000n, taxCategoryCode: "sales_10" },
      { quantity: 100n, unitPrice: 3_000n, taxCategoryCode: "sales_exempt" },
      { quantity: 100n, unitPrice: 2_000n, taxCategoryCode: "sales_out" },
    ]);
    expect(
      totals.rates.map((rate) => [rate.taxCategoryCode, rate.ratePercent, rate.taxAmount]),
    ).toEqual([
      ["sales_10", 10, 1_000n],
      ["sales_exempt", 0, 0n],
      ["sales_out", 0, 0n],
    ]);
    expect(totals.rates.map(invoiceRateLabel)).toEqual(["10%", "非課税", "不課税"]);
    expect(totals.total).toBe(16_000n);
  });

  it("names the line of a category that is not for sales or has no rule", () => {
    let error: unknown;
    try {
      totalsOf(
        [
          { quantity: 100n, unitPrice: 1_000n, taxCategoryCode: "sales_10" },
          { quantity: 100n, unitPrice: 1_000n, taxCategoryCode: "purchase_10" },
          { quantity: 100n, unitPrice: 1_000n, taxCategoryCode: "sales_10" },
        ],
        { issueDate: "2019-09-30" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LedgerValidationError);
    const errors = (error as LedgerValidationError).errors;
    expect(errors.map(({ code, field }) => ({ code, field }))).toEqual([
      { code: "TAX_RULE_MISSING", field: "lines.0.taxCategoryCode" },
      { code: "UNKNOWN_TAX_CATEGORY", field: "lines.1.taxCategoryCode" },
      { code: "TAX_RULE_MISSING", field: "lines.2.taxCategoryCode" },
    ]);
    expect(errors[0]?.message).toContain("2019/09/30");
  });

  it("totals equal the sum of the rates, whatever the lines", () => {
    const lineArb = fc.record({
      quantity: fc.bigInt({ min: 1n, max: 100_000n }),
      unitPrice: fc.bigInt({ min: -200_000n, max: 2_000_000n }),
      taxCategoryCode: fc.constantFrom("sales_10", "sales_8r", "sales_exempt", "sales_export"),
    });
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 12 }),
        fc.boolean(),
        (lines, inc) => {
          const totals = totalsOf(lines, { pricesIncludeTax: inc });
          const sum = (pick: (rate: (typeof totals.rates)[number]) => bigint) =>
            totals.rates.reduce((total, rate) => total + pick(rate), 0n);
          expect(sum((rate) => rate.amountInclusive)).toBe(totals.total);
          expect(sum((rate) => rate.amountExclusive) + sum((rate) => rate.taxAmount)).toBe(
            totals.total,
          );
          expect(sum((rate) => rate.subtotal)).toBe(
            totals.lineAmounts.reduce((total, amount) => total + amount, 0n),
          );
        },
      ),
    );
  });
});

describe("適格請求書 / 区分記載請求書 and the checklist", () => {
  const registered = {
    name: "架空商事株式会社",
    invoiceRegistrationNumber: "T9999999999999",
    invoiceRegisteredOn: "2026-12-01" as CalendarDate,
  };
  const unregistered = {
    name: "架空商事株式会社",
    invoiceRegistrationNumber: null,
    invoiceRegisteredOn: null,
  };
  const lines = [
    { name: "設計・開発 一式", date: null, taxCategoryCode: "sales_10" },
    { name: "保守", date: null, taxCategoryCode: "sales_10" },
    { name: "打合せの飲料", date: null, taxCategoryCode: "sales_8r" },
    { name: "値引き", date: null, taxCategoryCode: "sales_10" },
  ];

  it("is qualified only from the registration date with a number", () => {
    expect(isQualifiedInvoice(registered, "2026-12-01")).toBe(true);
    expect(isQualifiedInvoice(registered, "2026-11-30")).toBe(false);
    expect(isQualifiedInvoice(unregistered, "2026-12-01")).toBe(false);
    expect(isQualifiedInvoice({ ...registered, invoiceRegisteredOn: null }, "2026-12-01")).toBe(
      false,
    );
  });

  it("checks a qualified invoice item by item", () => {
    const checklist = invoiceChecklist({
      issuer: registered,
      issueDate: ISSUE_DATE,
      recipientName: "架空デザイン合同会社",
      lines,
      totals: totalsOf(FIXTURE_LINES),
    });
    expect(checklist.qualified).toBe(true);
    expect(checklist.ready).toBe(true);
    expect(checklist.items.map((item) => [item.key, item.state])).toEqual([
      ["issuer", "ok"],
      ["registration", "ok"],
      ["recipient", "ok"],
      ["date", "ok"],
      ["content", "ok"],
      ["amounts", "ok"],
      ["tax", "ok"],
    ]);
    const tax = checklist.items.find((item) => item.key === "tax");
    expect(tax?.detail).toBe("10% 12,500 円 · 8%（軽減） 82 円");
    expect(checklist.items.find((item) => item.key === "content")?.detail).toContain("※");
  });

  it("says a 区分記載請求書 is issued without a registration", () => {
    const checklist = invoiceChecklist({
      issuer: unregistered,
      issueDate: ISSUE_DATE,
      recipientName: "架空デザイン合同会社",
      lines,
      totals: totalsOf(FIXTURE_LINES),
    });
    expect(checklist.qualified).toBe(false);
    expect(checklist.ready).toBe(true);
    const registration = checklist.items.find((item) => item.key === "registration");
    expect(registration).toMatchObject({ state: "info" });
    expect(registration?.detail).toContain("区分記載請求書");
    expect(checklist.items.find((item) => item.key === "amounts")?.detail).toBe(
      "10% 137,505 円（税込） · 8%（軽減） 1,117 円（税込）",
    );
  });

  it("blocks the issue on a missing recipient, a nameless line or a discount too large", () => {
    const totals = totalsOf([
      { quantity: 100n, unitPrice: 1_000n, taxCategoryCode: "sales_10" },
      { quantity: 100n, unitPrice: -2_000n, taxCategoryCode: "sales_10" },
      { quantity: 100n, unitPrice: 5_000n, taxCategoryCode: "sales_8r" },
    ]);
    const checklist = invoiceChecklist({
      issuer: { ...unregistered, name: " " },
      issueDate: ISSUE_DATE,
      recipientName: null,
      lines: [
        { name: "作業", date: null, taxCategoryCode: "sales_10" },
        { name: " ", date: null, taxCategoryCode: "sales_10" },
        { name: "飲料", date: "2026-11-20", taxCategoryCode: "sales_8r" },
      ],
      totals,
    });
    expect(checklist.ready).toBe(false);
    const errors = checklist.items.filter((item) => item.state === "error");
    expect(errors.map((item) => item.key)).toEqual(["issuer", "recipient", "content", "amounts"]);
    expect(errors.find((item) => item.key === "content")?.detail).toBe(
      "2 行目の品名を入れてください",
    );
    expect(errors.find((item) => item.key === "amounts")?.detail).toBe(
      "値引きが 10% の対価の額を超えています",
    );
    expect(checklist.items.find((item) => item.key === "date")?.detail).toContain("1 行");
  });

  it("is an error when the totals cannot be computed", () => {
    const checklist = invoiceChecklist({
      issuer: registered,
      issueDate: ISSUE_DATE,
      recipientName: "架空デザイン合同会社",
      lines,
      totals: null,
    });
    expect(checklist.ready).toBe(false);
  });
});

describe("numbers, dates and the balance", () => {
  it("numbers per type and fiscal year with 4 digits", () => {
    expect(invoiceNumberPrefix("invoice", "2026-11-02")).toBe("INV-2026-");
    expect(formatInvoiceNumber("invoice", "2026-11-02", 1)).toBe("INV-2026-0001");
    expect(formatInvoiceNumber("quote", "2027-04-01", 12)).toBe("QT-2027-0012");
    expect(formatInvoiceNumber("delivery", "2027-04-01", 12_345)).toBe("DN-2027-12345");
  });

  it("continues after the highest number with the prefix (void ones count)", () => {
    const numbers = ["INV-2026-0001", "INV-2026-0003", "INV-2027-0009", "QT-2026-0004"];
    expect(nextInvoiceSequence(numbers, "INV-2026-")).toBe(4);
    expect(nextInvoiceSequence([], "INV-2026-")).toBe(1);
    expect(nextInvoiceSequence(["INV-2026-9999"], "INV-2026-")).toBe(10_000);
    expect(parseInvoiceSequence(draftInvoiceNumber("invoice", "01ABC"), "INV-2026-")).toBeNull();
  });

  it("hides a draft's placeholder number", () => {
    expect(invoiceNumberLabel(draftInvoiceNumber("quote", "01ABC"))).toBe("下書き");
    expect(invoiceNumberLabel("QT-2026-0001")).toBe("QT-2026-0001");
  });

  it("defaults the due date by type", () => {
    expect(defaultDueDate("invoice", "2026-12-01")).toBe("2027-01-31");
    expect(defaultDueDate("invoice", "2027-01-15")).toBe("2027-02-28");
    expect(defaultDueDate("quote", "2026-12-01")).toBe("2026-12-31");
    expect(defaultDueDate("delivery", "2026-12-01")).toBeNull();
  });

  it("is overdue only when an open invoice passed its due date", () => {
    const invoice = { docType: "invoice", status: "sent", dueDate: "2027-01-31" } as const;
    expect(isInvoiceOverdue(invoice, "2027-02-01")).toBe(true);
    expect(isInvoiceOverdue(invoice, "2027-01-31")).toBe(false);
    expect(isInvoiceOverdue({ ...invoice, status: "paid" }, "2027-02-01")).toBe(false);
    expect(isInvoiceOverdue({ ...invoice, docType: "quote" }, "2027-02-01")).toBe(false);
    expect(overdueDays("2027-01-31", "2027-02-03")).toBe(3);
  });

  it("subtracts the payments in force, fees included", () => {
    expect(
      invoiceBalance(138_622n, [
        { amount: 100_000n, fee: 0n, cancelled: false },
        { amount: 38_000n, fee: 622n, cancelled: false },
        { amount: 5_000n, fee: 0n, cancelled: true },
      ]),
    ).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

const ACCOUNTS: readonly (EntryAccount & { kind: AccountRef["kind"] })[] = [
  {
    id: "acc_bank",
    code: "1100",
    name: "普通預金",
    kind: "asset",
    defaultTaxCategoryCode: "na",
    isCashLike: true,
  },
  { id: "acc_ar", code: "1200", name: "売掛金", kind: "asset", defaultTaxCategoryCode: "na" },
  {
    id: "acc_input_tax",
    code: "1400",
    name: "仮払消費税",
    kind: "asset",
    defaultTaxCategoryCode: "na",
  },
  { id: "acc_card", code: "2100", name: "未払金", kind: "liability", defaultTaxCategoryCode: "na" },
  {
    id: "acc_output_tax",
    code: "2310",
    name: "仮受消費税",
    kind: "liability",
    defaultTaxCategoryCode: "na",
  },
  {
    id: "acc_contract",
    code: "4040",
    name: "売上高 受託開発",
    kind: "revenue",
    defaultTaxCategoryCode: "sales_10",
  },
  {
    id: "acc_fee",
    code: "5400",
    name: "支払手数料",
    kind: "expense",
    defaultTaxCategoryCode: "purchase_10",
  },
];

const WALLETS: readonly EntryWallet[] = [
  {
    id: "wal_bank",
    name: "架空銀行 普通",
    accountId: "acc_bank",
    subAccountId: "sub_bank",
    defaultSegmentId: null,
    isActive: true,
  },
  {
    id: "wal_card",
    name: "架空カード",
    accountId: "acc_card",
    subAccountId: "sub_card",
    defaultSegmentId: null,
    isActive: true,
  },
];

function postingContext(accountingMethod: AccountingMethod): SimpleEntryContext {
  return {
    accountingMethod,
    taxRules: STANDARD_TAX_RATE_RULES,
    accounts: new Map(ACCOUNTS.map((account) => [account.id, account])),
    wallets: new Map(WALLETS.map((wallet) => [wallet.id, wallet])),
    corporateSegmentId: "seg_corporate",
  };
}

function validationContext(accountingMethod: AccountingMethod): ValidationContext {
  return {
    fiscalYear: {
      ...FISCAL_YEAR,
      consumptionTax: accountingMethod === "tax_exclusive" ? "general" : "exempt",
      accountingMethod,
    },
    accounts: new Map(ACCOUNTS.map((account) => [account.id, account])),
    subAccounts: new Map([
      ["sub_bank", { accountId: "acc_bank" }],
      ["sub_card", { accountId: "acc_card" }],
    ]),
  };
}

function side(entry: JournalEntryInput, accountId: string) {
  return entry.lines
    .filter((line) => line.accountId === accountId)
    .map((line) => ({
      side: line.side,
      amount: line.amount,
      tax: line.taxAmount,
      code: line.taxCategoryCode,
    }));
}

const issueInput = (totals: InvoiceTotals) => ({
  invoiceId: "inv_1",
  number: "INV-2026-0001",
  issueDate: ISSUE_DATE,
  partnerId: "par_design",
  partnerName: "架空デザイン合同会社",
  title: "受託開発 12 月分",
  revenueAccountId: "acc_contract",
  segmentId: "seg_contract",
  totals,
});

describe("issuing an invoice: 売掛金 / 売上", () => {
  it("books tax-inclusive amounts with their tax in tax-inclusive years", () => {
    const entry = buildInvoiceIssueEntry(
      issueInput(totalsOf(FIXTURE_LINES)),
      postingContext("tax_inclusive"),
    );
    expect(validateEntry(entry, validationContext("tax_inclusive"))).toEqual({ ok: true });
    expect(entry).toMatchObject({
      entryDate: ISSUE_DATE,
      kind: "normal",
      sourceKind: "invoice",
      sourceId: "inv_1",
      description: "請求書 INV-2026-0001 架空デザイン合同会社",
    });
    expect(side(entry, "acc_ar")).toEqual([
      { side: "debit", amount: 138_622n, tax: 0n, code: "na" },
    ]);
    expect(side(entry, "acc_contract")).toEqual([
      { side: "credit", amount: 137_505n, tax: 12_500n, code: "sales_10" },
      { side: "credit", amount: 1_117n, tax: 82n, code: "sales_8r" },
    ]);
    expect(side(entry, "acc_output_tax")).toEqual([]);
    expect(entry.lines.find((line) => line.accountId === "acc_ar")?.partnerId).toBe("par_design");
  });

  it("books tax-exclusive amounts and 仮受消費税 in tax-exclusive years", () => {
    const entry = buildInvoiceIssueEntry(
      issueInput(totalsOf(FIXTURE_LINES)),
      postingContext("tax_exclusive"),
    );
    expect(validateEntry(entry, validationContext("tax_exclusive"))).toEqual({ ok: true });
    expect(side(entry, "acc_contract")).toEqual([
      { side: "credit", amount: 125_005n, tax: 12_500n, code: "sales_10" },
      { side: "credit", amount: 1_035n, tax: 82n, code: "sales_8r" },
    ]);
    expect(side(entry, "acc_output_tax")).toEqual([
      { side: "credit", amount: 12_582n, tax: 0n, code: "na" },
    ]);
  });

  it("balances and keeps the document's taxes for any document", () => {
    const lineArb = fc.record({
      quantity: fc.bigInt({ min: 1n, max: 10_000n }),
      unitPrice: fc.bigInt({ min: 1n, max: 3_000_000n }),
      taxCategoryCode: fc.constantFrom("sales_10", "sales_8r", "sales_exempt"),
    });
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        fc.constantFrom<AccountingMethod>("tax_inclusive", "tax_exclusive"),
        (lines, inc, method) => {
          const totals = totalsOf(lines, { pricesIncludeTax: inc });
          // Lines below 1 yen each (0.01 × 1 円) can total 0 yen: such a document is never issued.
          fc.pre(totals.total > 0n);
          const entry = buildInvoiceIssueEntry(issueInput(totals), postingContext(method));
          expect(validateEntry(entry, validationContext(method))).toEqual({ ok: true });
          const revenueTax = entry.lines
            .filter((line) => line.accountId === "acc_contract")
            .reduce((sum, line) => sum + line.taxAmount, 0n);
          expect(revenueTax).toBe(totals.taxTotal);
        },
      ),
    );
  });

  it("refuses a revenue account that is not revenue and a negative rate", () => {
    const totals = totalsOf([
      { quantity: 100n, unitPrice: 1_000n, taxCategoryCode: "sales_10" },
      { quantity: 100n, unitPrice: -2_000n, taxCategoryCode: "sales_8r" },
      { quantity: 100n, unitPrice: 9_000n, taxCategoryCode: "sales_10" },
    ]);
    let error: unknown;
    try {
      buildInvoiceIssueEntry(
        { ...issueInput(totals), revenueAccountId: "acc_fee" },
        postingContext("tax_inclusive"),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).errors.map((item) => item.field)).toEqual([
      "revenueAccountId",
      "lines",
    ]);
  });
});

describe("a payment: 普通預金 / 売掛金, the fee as 支払手数料", () => {
  const payment = {
    invoiceId: "inv_1",
    number: "INV-2026-0001",
    partnerId: "par_design",
    partnerName: "架空デザイン合同会社",
    paidOn: "2027-01-10" as CalendarDate,
    walletId: "wal_bank",
    amount: 137_962n,
    fee: 660n,
    segmentId: "seg_contract",
  };

  it("debits the wallet and the fee, credits the receivable with both (tax-inclusive)", () => {
    const entry = buildInvoicePaymentEntry(payment, postingContext("tax_inclusive"));
    expect(validateEntry(entry, validationContext("tax_inclusive"))).toEqual({ ok: true });
    expect(entry).toMatchObject({
      sourceKind: "invoice",
      sourceId: "inv_1",
      entryDate: "2027-01-10",
    });
    expect(side(entry, "acc_bank")).toEqual([
      { side: "debit", amount: 137_962n, tax: 0n, code: "na" },
    ]);
    expect(side(entry, "acc_fee")).toEqual([
      { side: "debit", amount: 660n, tax: 60n, code: "purchase_10" },
    ]);
    expect(side(entry, "acc_ar")).toEqual([
      { side: "credit", amount: 138_622n, tax: 0n, code: "na" },
    ]);
    expect(entry.lines.find((line) => line.accountId === "acc_bank")?.subAccountId).toBe(
      "sub_bank",
    );
    expect(entry.lines.find((line) => line.accountId === "acc_fee")?.segmentId).toBe(
      "seg_contract",
    );
  });

  it("splits the fee's tax into 仮払消費税 in tax-exclusive years", () => {
    const entry = buildInvoicePaymentEntry(payment, postingContext("tax_exclusive"));
    expect(validateEntry(entry, validationContext("tax_exclusive"))).toEqual({ ok: true });
    expect(side(entry, "acc_fee")).toEqual([
      { side: "debit", amount: 600n, tax: 60n, code: "purchase_10" },
    ]);
    expect(side(entry, "acc_input_tax")).toEqual([
      { side: "debit", amount: 60n, tax: 0n, code: "na" },
    ]);
  });

  it("has no fee line without a fee; the fee segment falls back to 共通", () => {
    const entry = buildInvoicePaymentEntry(
      { ...payment, fee: 0n, segmentId: null },
      postingContext("tax_inclusive"),
    );
    expect(entry.lines).toHaveLength(2);
    const withFee = buildInvoicePaymentEntry(
      { ...payment, segmentId: null },
      postingContext("tax_inclusive"),
    );
    expect(withFee.lines.find((line) => line.accountId === "acc_fee")?.segmentId).toBe(
      "seg_corporate",
    );
  });

  it("refuses a liability wallet and a non-positive amount", () => {
    let error: unknown;
    try {
      buildInvoicePaymentEntry(
        { ...payment, walletId: "wal_card", amount: 0n },
        postingContext("tax_inclusive"),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LedgerValidationError);
    expect((error as LedgerValidationError).errors.map((item) => item.field)).toEqual([
      "amount",
      "walletId",
    ]);
  });
});

describe("receipts (領収書, 18 §15)", () => {
  it("numbers RC-<期>-<連番> like the documents", () => {
    expect(receiptNumberPrefix("2026-11-02")).toBe("RC-2026-");
    expect(formatReceiptNumber("2026-11-02", 1)).toBe("RC-2026-0001");
    expect(formatReceiptNumber("2027-04-01", 12_345)).toBe("RC-2027-12345");
    expect(nextInvoiceSequence(["RC-2026-0001", "RC-2026-0002", "INV-2026-0007"], "RC-2026-")).toBe(
      3,
    );
    expect(() => formatReceiptNumber("2026-11-02", 0)).toThrow(RangeError);
  });

  it("says 「<件名> の代金として」, or 「お品代として」 without a title", () => {
    expect(defaultReceiptProviso("架空サイトの開発")).toBe("架空サイトの開発 の代金として");
    expect(defaultReceiptProviso(null)).toBe("お品代として");
    expect(defaultReceiptProviso("  ")).toBe("お品代として");
    const long = defaultReceiptProviso("あ".repeat(200));
    expect([...long]).toHaveLength(RECEIPT_PROVISO_MAX);
    expect(long.endsWith("… の代金として")).toBe(true);
  });

  it("notes the stamp duty from 50,000 円 without the tax", () => {
    const totals = computeInvoiceTotals(FIXTURE_LINES, {
      pricesIncludeTax: false,
      issueDate: ISSUE_DATE,
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    expect(receiptStampNote(totals.rates)).toBe(RECEIPT_STAMP_NOTE);
    // 54,999 円 with the tax is 49,999 円 without it: no note.
    expect(receiptStampNote([{ amountExclusive: 49_999n }])).toBeNull();
    expect(receiptStampNote([{ amountExclusive: 45_000n }, { amountExclusive: 5_000n }])).toBe(
      RECEIPT_STAMP_NOTE,
    );
    expect(receiptStampNote([])).toBeNull();
  });

  it("issues on or after the last payment and not after today", () => {
    expect(receiptDateProblem("2026-12-15", "2026-12-10", "2026-12-20")).toBeNull();
    expect(receiptDateProblem("2026-12-10", "2026-12-10", "2026-12-10")).toBeNull();
    expect(receiptDateProblem("2026-12-09", "2026-12-10", "2026-12-20")).toBe(
      "発行日は入金日（2026/12/10）以後にしてください",
    );
    expect(receiptDateProblem("2026-12-21", "2026-12-10", "2026-12-20")).toBe(
      "発行日は今日以前にしてください",
    );
  });
});
