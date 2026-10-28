/**
 * 支払 (docs/design/25-payables.md §3, §4, §8.2): the due date of the payment terms, the entries of
 * 計上 and of a payment, and the rest derived from the ledger.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  auditActionLabel,
  AUDIT_ENTITY_LABELS,
  buildPayableEntry,
  buildPayablePaymentEntry,
  defaultPayableDueDate,
  describePaymentTerms,
  isPayableDueSoon,
  isPayableOverdue,
  LedgerValidationError,
  PAYABLE_AUDIT_ACTIONS,
  payableAmounts,
  payableDefaults,
  payableDueDateProblem,
  payableHistoryLabel,
  payablePaymentDescription,
  payableState,
  payableTaxCategoryCode,
  paymentTermsProblem,
  splitPayablePayment,
  STANDARD_TAX_RATE_RULES,
  statementNamesPartner,
  validateEntry,
  type AccountingMethod,
  type AccountRef,
  type CalendarDate,
  type EntryAccount,
  type EntryWallet,
  type JournalEntryInput,
  type PayableEntryInput,
  type PayableLedgerLine,
  type PayablePaymentEntryInput,
  type SimpleEntryContext,
  type ValidationContext,
} from "../src";
import { FISCAL_YEAR } from "./fixtures";

describe("the due date of the payment terms (25 §3)", () => {
  const endOfNextMonth = { closingDay: 31, dueMonths: 1, dueDay: 31 };
  const twentiethTenth = { closingDay: 20, dueMonths: 1, dueDay: 10 };

  it("末締め翌月末払い: 10/15 → 11/30, and the closing day itself stays in its month", () => {
    expect(defaultPayableDueDate("2026-10-15", endOfNextMonth)).toBe("2026-11-30");
    expect(defaultPayableDueDate("2026-10-31", endOfNextMonth)).toBe("2026-11-30");
    expect(defaultPayableDueDate("2026-11-01", endOfNextMonth)).toBe("2026-12-31");
    expect(defaultPayableDueDate("2026-12-10", endOfNextMonth)).toBe("2027-01-31");
  });

  it("20 日締め翌月 10 日払い: 10/25 → 12/10, 10/20 → 11/10", () => {
    expect(defaultPayableDueDate("2026-10-25", twentiethTenth)).toBe("2026-12-10");
    expect(defaultPayableDueDate("2026-10-20", twentiethTenth)).toBe("2026-11-10");
    expect(defaultPayableDueDate("2026-12-21", twentiethTenth)).toBe("2027-02-10");
  });

  it("takes the month's last day in February and in 30-day months", () => {
    // 末締め翌月末払い from January: the end of February (leap year included).
    expect(defaultPayableDueDate("2027-01-31", endOfNextMonth)).toBe("2027-02-28");
    expect(defaultPayableDueDate("2028-01-15", endOfNextMonth)).toBe("2028-02-29");
    // 30 日締め: February closes on its last day.
    const thirtieth = { closingDay: 30, dueMonths: 1, dueDay: 30 };
    expect(defaultPayableDueDate("2027-02-28", thirtieth)).toBe("2027-03-30");
    expect(defaultPayableDueDate("2027-01-31", thirtieth)).toBe("2027-03-30");
    // 31 日払い in a 30-day month, 2 months on.
    expect(defaultPayableDueDate("2026-04-30", { closingDay: 31, dueMonths: 2, dueDay: 31 })).toBe(
      "2026-06-30",
    );
    expect(defaultPayableDueDate("2026-04-30", { closingDay: 15, dueMonths: 0, dueDay: 31 })).toBe(
      "2026-05-31",
    );
  });

  it("defaults to the end of the next month without terms", () => {
    expect(defaultPayableDueDate("2026-10-15", null)).toBe("2026-11-30");
    expect(defaultPayableDueDate("2026-12-31", null)).toBe("2027-01-31");
    expect(defaultPayableDueDate("2027-01-31", null)).toBe("2027-02-28");
  });

  it("is never before the invoice date for valid terms", () => {
    const terms = fc
      .record({
        closingDay: fc.integer({ min: 1, max: 31 }),
        dueMonths: fc.integer({ min: 0, max: 3 }),
        dueDay: fc.integer({ min: 1, max: 31 }),
      })
      .filter((value) => paymentTermsProblem(value) === null);
    const day = fc.integer({ min: 0, max: 3_000 }).map((offset) => {
      const date = new Date(Date.UTC(2026, 0, 1 + offset));
      return date.toISOString().slice(0, 10) as CalendarDate;
    });
    fc.assert(
      fc.property(day, terms, (invoiceDate, value) => {
        expect(defaultPayableDueDate(invoiceDate, value) >= invoiceDate).toBe(true);
      }),
    );
  });

  it("names the terms", () => {
    expect(describePaymentTerms(endOfNextMonth)).toBe("末締め翌月末払い");
    expect(describePaymentTerms(twentiethTenth)).toBe("20 日締め翌月 10 日払い");
    expect(describePaymentTerms({ closingDay: 15, dueMonths: 0, dueDay: 31 })).toBe(
      "15 日締め当月末払い",
    );
    expect(describePaymentTerms({ closingDay: 31, dueMonths: 2, dueDay: 5 })).toBe(
      "末締め翌々月 5 日払い",
    );
    expect(describePaymentTerms({ closingDay: 31, dueMonths: 3, dueDay: 31 })).toBe(
      "末締め 3 か月後末払い",
    );
  });

  it("rejects terms out of range and a same-month payment before the closing", () => {
    expect(paymentTermsProblem(endOfNextMonth)).toBeNull();
    expect(paymentTermsProblem({ closingDay: 0, dueMonths: 1, dueDay: 10 })).toMatch("締め日");
    expect(paymentTermsProblem({ closingDay: 20, dueMonths: 4, dueDay: 10 })).toMatch("何か月後");
    expect(paymentTermsProblem({ closingDay: 20, dueMonths: 1, dueDay: 32 })).toMatch("支払日");
    expect(paymentTermsProblem({ closingDay: 20, dueMonths: 0, dueDay: 10 })).toMatch("当月払い");
    expect(payableDueDateProblem("2026-10-15", "2026-10-14")).toMatch("請求書の日付以後");
    expect(payableDueDateProblem("2026-10-15", "2026-10-15")).toBeNull();
    expect(payableDueDateProblem("2026-10-15", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

const ACCOUNTS: readonly EntryAccount[] = [
  {
    id: "acc_bank",
    code: "1100",
    name: "普通預金",
    kind: "asset",
    defaultTaxCategoryCode: "na",
    isCashLike: true,
  },
  {
    id: "acc_input_tax",
    code: "1400",
    name: "仮払消費税",
    kind: "asset",
    defaultTaxCategoryCode: "na",
  },
  {
    id: "acc_software",
    code: "1520",
    name: "ソフトウェア",
    kind: "asset",
    defaultTaxCategoryCode: "purchase_10",
  },
  {
    id: "acc_payable",
    code: "2100",
    name: "未払金",
    kind: "liability",
    defaultTaxCategoryCode: "na",
  },
  {
    id: "acc_owner",
    code: "2400",
    name: "役員借入金",
    kind: "liability",
    defaultTaxCategoryCode: "na",
  },
  {
    id: "acc_outsource",
    code: "5100",
    name: "外注費",
    kind: "expense",
    defaultTaxCategoryCode: "purchase_10",
  },
  {
    id: "acc_supplies",
    code: "5330",
    name: "消耗品費",
    kind: "expense",
    defaultTaxCategoryCode: "purchase_10",
  },
  {
    id: "acc_fee",
    code: "5400",
    name: "支払手数料",
    kind: "expense",
    defaultTaxCategoryCode: "purchase_10",
  },
  {
    id: "acc_sales",
    code: "4010",
    name: "売上高",
    kind: "revenue",
    defaultTaxCategoryCode: "sales_10",
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
    accountId: "acc_payable",
    subAccountId: "sub_card",
    defaultSegmentId: null,
    isActive: true,
  },
  {
    id: "wal_old",
    name: "旧口座",
    accountId: "acc_bank",
    subAccountId: "sub_old",
    defaultSegmentId: null,
    isActive: false,
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
  const refs: AccountRef[] = ACCOUNTS.map(({ id, code, kind }) => ({ id, code, kind }));
  return {
    fiscalYear: {
      ...FISCAL_YEAR,
      consumptionTax: accountingMethod === "tax_exclusive" ? "general" : "exempt",
      accountingMethod,
    },
    accounts: new Map(refs.map((account) => [account.id, account])),
    subAccounts: new Map([
      ["sub_bank", { accountId: "acc_bank" }],
      ["sub_card", { accountId: "acc_payable" }],
    ]),
  };
}

function linesOf(entry: JournalEntryInput, accountId: string) {
  return entry.lines
    .filter((line) => line.accountId === accountId)
    .map((line) => ({
      side: line.side,
      amount: line.amount,
      tax: line.taxAmount,
      code: line.taxCategoryCode,
      sub: line.subAccountId ?? null,
      partner: line.partnerId ?? null,
    }));
}

function fieldsOf(fn: () => unknown): (string | undefined)[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerValidationError);
    return (error as LedgerValidationError).errors.map((item) => item.field);
  }
  throw new Error("expected a LedgerValidationError");
}

const registration = (overrides: Partial<PayableEntryInput> = {}): PayableEntryInput => ({
  invoiceDate: "2026-12-01",
  partnerId: "par_outsource",
  qualifiedInvoice: true,
  description: "請求書 テスト外注株式会社",
  lines: [
    {
      accountId: "acc_outsource",
      amount: 110_000n,
      taxCategoryCode: "purchase_10",
      segmentId: "seg_contract",
    },
  ],
  ...overrides,
});

describe("計上: 費用 / 未払金 (25 §4.1)", () => {
  it("books the tax-inclusive amount against 2100 without a sub-account (tax-inclusive)", () => {
    const entry = buildPayableEntry(registration(), postingContext("tax_inclusive"));
    expect(validateEntry(entry, validationContext("tax_inclusive"))).toEqual({ ok: true });
    expect(entry).toMatchObject({
      entryDate: "2026-12-01",
      kind: "normal",
      sourceKind: "manual",
      description: "請求書 テスト外注株式会社",
    });
    expect(linesOf(entry, "acc_outsource")).toEqual([
      {
        side: "debit",
        amount: 110_000n,
        tax: 10_000n,
        code: "purchase_10",
        sub: null,
        partner: "par_outsource",
      },
    ]);
    expect(linesOf(entry, "acc_payable")).toEqual([
      {
        side: "credit",
        amount: 110_000n,
        tax: 0n,
        code: "na",
        sub: null,
        partner: "par_outsource",
      },
    ]);
    expect(entry.lines).toHaveLength(2);
  });

  it("splits 仮払消費税 off in tax-exclusive years", () => {
    const entry = buildPayableEntry(registration(), postingContext("tax_exclusive"));
    expect(validateEntry(entry, validationContext("tax_exclusive"))).toEqual({ ok: true });
    expect(linesOf(entry, "acc_outsource")[0]).toMatchObject({ amount: 100_000n, tax: 10_000n });
    expect(linesOf(entry, "acc_input_tax")).toEqual([
      { side: "debit", amount: 10_000n, tax: 0n, code: "na", sub: null, partner: null },
    ]);
    expect(linesOf(entry, "acc_payable")[0]).toMatchObject({ side: "credit", amount: 110_000n });
  });

  it("books 「インボイスなし」 without a registration number, crediting only its share", () => {
    const entry = buildPayableEntry(
      registration({ qualifiedInvoice: false }),
      postingContext("tax_exclusive"),
    );
    expect(validateEntry(entry, validationContext("tax_exclusive"))).toEqual({ ok: true });
    // 2026-12-01: 70% of the tax is creditable (経過措置).
    expect(linesOf(entry, "acc_outsource")).toEqual([
      {
        side: "debit",
        amount: 103_000n,
        tax: 10_000n,
        code: "purchase_10_ni",
        sub: null,
        partner: "par_outsource",
      },
    ]);
    expect(linesOf(entry, "acc_input_tax")[0]).toMatchObject({ amount: 7_000n });
    expect(linesOf(entry, "acc_payable")[0]).toMatchObject({ amount: 110_000n });
    expect(payableTaxCategoryCode("purchase_8r", false)).toBe("purchase_8r_ni");
    expect(payableTaxCategoryCode("purchase_exempt", false)).toBe("purchase_exempt");
    expect(payableTaxCategoryCode("purchase_10", true)).toBe("purchase_10");
  });

  it("keeps one line per tax category and balances for any amounts", () => {
    const entry = buildPayableEntry(
      registration({
        lines: [
          {
            accountId: "acc_supplies",
            amount: 11_000n,
            taxCategoryCode: "purchase_10",
            segmentId: "seg_corporate",
          },
          {
            accountId: "acc_supplies",
            amount: 1_080n,
            taxCategoryCode: "purchase_8r",
            segmentId: "seg_corporate",
          },
        ],
      }),
      postingContext("tax_exclusive"),
    );
    expect(linesOf(entry, "acc_supplies").map((line) => line.code)).toEqual([
      "purchase_10",
      "purchase_8r",
    ]);
    expect(linesOf(entry, "acc_input_tax")[0]?.amount).toBe(1_080n);
    expect(linesOf(entry, "acc_payable")[0]?.amount).toBe(12_080n);

    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 999_999_999n }),
        fc.constantFrom<AccountingMethod>("tax_inclusive", "tax_exclusive"),
        fc.boolean(),
        (amount, method, qualified) => {
          const built = buildPayableEntry(
            registration({
              qualifiedInvoice: qualified,
              lines: [
                {
                  accountId: "acc_outsource",
                  amount,
                  taxCategoryCode: "purchase_10",
                  segmentId: "seg_contract",
                },
              ],
            }),
            postingContext(method),
          );
          expect(validateEntry(built, validationContext(method))).toEqual({ ok: true });
          const payable = linesOf(built, "acc_payable");
          expect(payable).toHaveLength(1);
          expect(payable[0]).toMatchObject({ side: "credit", amount, sub: null });
        },
      ),
    );
  });

  it("accepts a non-cash asset and refuses cash, wallets' accounts, revenue and bad amounts", () => {
    const asset = buildPayableEntry(
      registration({
        lines: [
          {
            accountId: "acc_software",
            amount: 330_000n,
            taxCategoryCode: "purchase_10",
            segmentId: null,
          },
        ],
      }),
      postingContext("tax_inclusive"),
    );
    expect(validateEntry(asset, validationContext("tax_inclusive"))).toEqual({ ok: true });
    for (const accountId of ["acc_bank", "acc_payable", "acc_input_tax", "acc_sales", "nope"]) {
      expect(
        fieldsOf(() =>
          buildPayableEntry(
            registration({
              lines: [
                { accountId, amount: 1_000n, taxCategoryCode: "purchase_10", segmentId: null },
              ],
            }),
            postingContext("tax_inclusive"),
          ),
        ),
      ).toEqual(["accountId"]);
    }
    expect(
      fieldsOf(() =>
        buildPayableEntry(
          registration({
            lines: [
              {
                accountId: "acc_outsource",
                amount: 0n,
                taxCategoryCode: "purchase_10",
                segmentId: null,
              },
              {
                accountId: "acc_bank",
                amount: 1n,
                taxCategoryCode: "purchase_10",
                segmentId: null,
              },
            ],
          }),
          postingContext("tax_inclusive"),
        ),
      ),
    ).toEqual(["lines.0.amount", "lines.1.accountId"]);
  });
});

const payment = (overrides: Partial<PayablePaymentEntryInput> = {}): PayablePaymentEntryInput => ({
  paidOn: "2026-12-25",
  walletId: "wal_bank",
  amount: 110_000n,
  fee: 0n,
  partnerId: "par_outsource",
  description: payablePaymentDescription("テスト外注株式会社", "11 月分.pdf"),
  segmentId: "seg_contract",
  walletTransactionId: null,
  ...overrides,
});

describe("支払: 未払金 / 口座 (25 §4.2)", () => {
  it("splits the amount: partial, exact, a fee up to 1,100 yen, refused above", () => {
    expect(splitPayablePayment(50_000n, 110_000n)).toEqual({
      applied: 50_000n,
      fee: 0n,
      remainingAfter: 60_000n,
      problem: null,
    });
    expect(splitPayablePayment(110_000n, 110_000n)).toMatchObject({ fee: 0n, remainingAfter: 0n });
    expect(splitPayablePayment(110_660n, 110_000n)).toEqual({
      applied: 110_000n,
      fee: 660n,
      remainingAfter: 0n,
      problem: null,
    });
    expect(splitPayablePayment(111_100n, 110_000n).problem).toBeNull();
    expect(splitPayablePayment(111_101n, 110_000n).problem).toBe(
      "出金額が残り 110,000 円を 1,101 円超えています。手数料にできるのは 1,100 円までです",
    );
    expect(splitPayablePayment(1n, 0n).problem).toBe("支払済みのため残りはありません");
  });

  it("debits 未払金 with the partner and credits the bank (a partial payment)", () => {
    const entry = buildPayablePaymentEntry(
      payment({ amount: 50_000n }),
      postingContext("tax_inclusive"),
    );
    expect(validateEntry(entry, validationContext("tax_inclusive"))).toEqual({ ok: true });
    expect(entry).toMatchObject({
      entryDate: "2026-12-25",
      kind: "normal",
      sourceKind: "manual",
      description: "支払 テスト外注株式会社 11 月分.pdf",
    });
    expect(entry.sourceId).toBeUndefined();
    expect(linesOf(entry, "acc_payable")).toEqual([
      { side: "debit", amount: 50_000n, tax: 0n, code: "na", sub: null, partner: "par_outsource" },
    ]);
    expect(linesOf(entry, "acc_bank")).toEqual([
      { side: "credit", amount: 50_000n, tax: 0n, code: "na", sub: "sub_bank", partner: null },
    ]);
  });

  it("books the fee as 支払手数料 (仮払消費税 in tax-exclusive years) and keeps the line's source", () => {
    const entry = buildPayablePaymentEntry(
      payment({ amount: 110_660n, fee: 660n, walletTransactionId: "wtx_1" }),
      postingContext("tax_exclusive"),
    );
    expect(validateEntry(entry, validationContext("tax_exclusive"))).toEqual({ ok: true });
    expect(entry).toMatchObject({ sourceKind: "wallet_txn", sourceId: "wtx_1" });
    expect(linesOf(entry, "acc_payable")[0]).toMatchObject({ side: "debit", amount: 110_000n });
    expect(linesOf(entry, "acc_fee")).toEqual([
      { side: "debit", amount: 600n, tax: 60n, code: "purchase_10", sub: null, partner: null },
    ]);
    expect(linesOf(entry, "acc_input_tax")[0]).toMatchObject({ amount: 60n });
    expect(linesOf(entry, "acc_bank")[0]).toMatchObject({ side: "credit", amount: 110_660n });
    expect(entry.lines.find((line) => line.accountId === "acc_fee")?.segmentId).toBe(
      "seg_contract",
    );
    const corporate = buildPayablePaymentEntry(
      payment({ amount: 110_660n, fee: 660n, segmentId: null }),
      postingContext("tax_inclusive"),
    );
    expect(corporate.lines.find((line) => line.accountId === "acc_fee")?.segmentId).toBe(
      "seg_corporate",
    );
  });

  it("pays with a card: 未払金 without a sub-account against the card's 未払金", () => {
    const entry = buildPayablePaymentEntry(
      payment({ walletId: "wal_card" }),
      postingContext("tax_inclusive"),
    );
    expect(validateEntry(entry, validationContext("tax_inclusive"))).toEqual({ ok: true });
    expect(linesOf(entry, "acc_payable")).toEqual([
      { side: "debit", amount: 110_000n, tax: 0n, code: "na", sub: null, partner: "par_outsource" },
      { side: "credit", amount: 110_000n, tax: 0n, code: "na", sub: "sub_card", partner: null },
    ]);
  });

  it("refuses an inactive wallet and a fee as large as the amount", () => {
    expect(
      fieldsOf(() =>
        buildPayablePaymentEntry(payment({ walletId: "wal_old" }), postingContext("tax_inclusive")),
      ),
    ).toEqual(["walletId"]);
    expect(
      fieldsOf(() =>
        buildPayablePaymentEntry(
          payment({ amount: 500n, fee: 500n }),
          postingContext("tax_inclusive"),
        ),
      ),
    ).toEqual(["amount"]);
  });
});

describe("the rest and the state, derived (25 §1, §2)", () => {
  const line = (
    entryId: string,
    side: PayableLedgerLine["side"],
    amount: bigint,
    overrides: Partial<PayableLedgerLine> = {},
  ): PayableLedgerLine => ({
    entryId,
    entryStatus: "posted",
    entryKind: "normal",
    side,
    amount,
    ...overrides,
  });

  it("counts the payments in force only (not voided ones, reversals or the registration)", () => {
    const amounts = payableAmounts("reg", [
      line("reg", "credit", 110_000n),
      line("pay1", "debit", 50_000n),
      line("pay2", "debit", 30_000n, { entryStatus: "voided" }),
      line("rev2", "credit", 30_000n, { entryKind: "reversal" }),
      line("rev3", "debit", 30_000n, { entryKind: "reversal" }),
    ]);
    expect(amounts).toEqual({ registered: 110_000n, paid: 50_000n, remaining: 60_000n });
    expect(payableState({ registrationStatus: "posted", ...amounts })).toBe("partial");
  });

  it("is 未払 / 支払済み / 取消 by the rest and the registration", () => {
    const unpaid = payableAmounts("reg", [line("reg", "credit", 110_000n)]);
    expect(payableState({ registrationStatus: "posted", ...unpaid })).toBe("unpaid");
    const paid = payableAmounts("reg", [
      line("reg", "credit", 110_000n),
      line("pay", "debit", 110_000n),
    ]);
    expect(paid.remaining).toBe(0n);
    expect(payableState({ registrationStatus: "posted", ...paid })).toBe("paid");
    expect(payableState({ registrationStatus: "voided", ...unpaid })).toBe("cancelled");
  });

  it("is overdue or due soon only while open", () => {
    expect(isPayableOverdue("unpaid", "2026-12-09", "2026-12-10")).toBe(true);
    expect(isPayableOverdue("partial", "2026-12-10", "2026-12-10")).toBe(false);
    expect(isPayableOverdue("paid", "2026-12-01", "2026-12-10")).toBe(false);
    expect(isPayableOverdue("unpaid", null, "2026-12-10")).toBe(false);
    expect(isPayableDueSoon("unpaid", "2026-12-17", "2026-12-10")).toBe(true);
    expect(isPayableDueSoon("unpaid", "2026-12-18", "2026-12-10")).toBe(false);
    expect(isPayableDueSoon("unpaid", "2026-12-09", "2026-12-10")).toBe(false);
    expect(isPayableDueSoon("cancelled", "2026-12-12", "2026-12-10")).toBe(false);
  });
});

describe("the form's defaults and the vocabulary", () => {
  const partner = {
    name: "テスト外注株式会社",
    invoiceRegistrationNumber: null,
    defaultAccountId: null,
    defaultTaxCategoryCode: null,
    defaultSegmentId: null,
    paymentTerms: { closingDay: 20, dueMonths: 1, dueDay: 10 },
  };
  const outsource = {
    id: "acc_outsource",
    defaultTaxCategoryCode: "purchase_10",
    defaultSegmentId: null,
  };

  it("takes the partner's terms and moves the tax to 「インボイスなし」 without a number", () => {
    expect(
      payableDefaults({
        partner,
        account: outsource,
        fallbackSegmentId: "seg_corporate",
        documentRegistrationNumber: null,
        invoiceDate: "2026-10-25",
      }),
    ).toEqual({
      accountId: "acc_outsource",
      taxCategoryCode: "purchase_10_ni",
      segmentId: "seg_corporate",
      dueDate: "2026-12-10",
      description: "請求書 テスト外注株式会社",
    });
    // A number on the document makes it a qualified invoice; the partner's segment wins.
    expect(
      payableDefaults({
        partner: { ...partner, defaultSegmentId: "seg_contract", paymentTerms: null },
        account: outsource,
        fallbackSegmentId: "seg_corporate",
        documentRegistrationNumber: "T9999999999999",
        invoiceDate: null,
      }),
    ).toMatchObject({ taxCategoryCode: "purchase_10", segmentId: "seg_contract", dueDate: null });
    // A customer's sales category is no default for a purchase: the account's is taken.
    expect(
      payableDefaults({
        partner: { ...partner, defaultTaxCategoryCode: "sales_10" },
        account: outsource,
        fallbackSegmentId: null,
        documentRegistrationNumber: "T9999999999999",
        invoiceDate: null,
      }).taxCategoryCode,
    ).toBe("purchase_10");
  });

  it("finds the partner in a statement line by name or kana", () => {
    const named = { name: "テスト外注株式会社", nameKana: "テストガイチュウ" };
    expect(
      statementNamesPartner({ descriptionRaw: "振込 ﾃｽﾄｶﾞｲﾁｭｳ(ｶ", counterpartyRaw: null }, named),
    ).toBe(true);
    expect(
      statementNamesPartner({ descriptionRaw: "振込", counterpartyRaw: "テストガイチュウ" }, named),
    ).toBe(true);
    expect(
      statementNamesPartner({ descriptionRaw: "振込 テスト外注", counterpartyRaw: null }, named),
    ).toBe(true);
    expect(
      statementNamesPartner({ descriptionRaw: "振込 架空商店", counterpartyRaw: null }, named),
    ).toBe(false);
  });

  it("labels the audit entity and actions", () => {
    expect(AUDIT_ENTITY_LABELS.payable).toBe("支払");
    for (const action of PAYABLE_AUDIT_ACTIONS) expect(auditActionLabel(action)).toBeTruthy();
    expect(auditActionLabel("payable.pay")).toBe("支払の登録");
    expect(payableHistoryLabel({ action: "payable.cancel_payment", via: null })).toBe("支払の取消");
    expect(payableHistoryLabel({ action: "payable.cancel_payment", via: "statement" })).toBe(
      "支払の取消（明細を未処理に戻す）",
    );
    expect(payableHistoryLabel({ action: "payable.cancel", via: "entries" })).toBe(
      "登録の取消（取引の画面）",
    );
  });
});
