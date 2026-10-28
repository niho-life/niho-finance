/**
 * 収入 / 支出 / 振替 / 伝票 → journal entries (docs/design/11-transactions.md §1, §4, §9).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildSimpleEntry,
  buildVoucherEntry,
  containedTaxAmount,
  isReservedAccount,
  LedgerValidationError,
  splitTaxInclusive,
  STANDARD_TAX_RATE_RULES,
  validateEntry,
  voucherLineTaxAmount,
  type AccountingMethod,
  type AccountRef,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type EntryAccount,
  type EntryWallet,
  type JournalEntryInput,
  type SimpleEntryContext,
  type SimpleEntryInput,
  type ValidationContext,
  type VoucherEntryInput,
  resolveTaxRule,
} from "../src";
import { amountArb, dateArb, FISCAL_YEAR } from "./fixtures";

const ACCOUNT_ROWS: readonly EntryAccount[] = [
  { id: "acc_cash", code: "1000", name: "現金", kind: "asset", defaultTaxCategoryCode: "na" },
  { id: "acc_bank", code: "1100", name: "普通預金", kind: "asset", defaultTaxCategoryCode: "na" },
  { id: "acc_ar", code: "1200", name: "売掛金", kind: "asset", defaultTaxCategoryCode: "na" },
  {
    id: "acc_prepaid",
    code: "1300",
    name: "前払費用",
    kind: "asset",
    defaultTaxCategoryCode: "na",
  },
  {
    id: "acc_input_tax",
    code: "1400",
    name: "仮払消費税",
    kind: "asset",
    defaultTaxCategoryCode: "na",
  },
  { id: "acc_card", code: "2100", name: "未払金", kind: "liability", defaultTaxCategoryCode: "na" },
  {
    id: "acc_accrued",
    code: "2110",
    name: "未払費用",
    kind: "liability",
    defaultTaxCategoryCode: "na",
  },
  {
    id: "acc_output_tax",
    code: "2310",
    name: "仮受消費税",
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
    id: "acc_sales",
    code: "4010",
    name: "売上高 会費",
    kind: "revenue",
    defaultTaxCategoryCode: "sales_10",
  },
  {
    id: "acc_comm",
    code: "5320",
    name: "通信費",
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
    id: "acc_insurance",
    code: "5450",
    name: "保険料",
    kind: "expense",
    defaultTaxCategoryCode: "purchase_exempt",
  },
];

const WALLET_ROWS: readonly EntryWallet[] = [
  {
    id: "w_bank",
    name: "架空銀行 普通",
    accountId: "acc_bank",
    subAccountId: "sub_bank",
    defaultSegmentId: null,
    isActive: true,
  },
  {
    id: "w_card",
    name: "架空カード",
    accountId: "acc_card",
    subAccountId: "sub_card",
    defaultSegmentId: null,
    isActive: true,
  },
  {
    id: "w_cash",
    name: "現金",
    accountId: "acc_cash",
    subAccountId: "sub_cash",
    defaultSegmentId: "seg_corporate",
    isActive: true,
  },
  {
    id: "w_old",
    name: "旧口座",
    accountId: "acc_bank",
    subAccountId: "sub_old",
    defaultSegmentId: null,
    isActive: false,
  },
];

const ACCOUNTS = new Map(ACCOUNT_ROWS.map((account) => [account.id, account]));
const WALLETS = new Map(WALLET_ROWS.map((wallet) => [wallet.id, wallet]));

function context(
  accountingMethod: AccountingMethod,
  overrides: Partial<SimpleEntryContext> = {},
): SimpleEntryContext {
  return {
    accountingMethod,
    taxRules: STANDARD_TAX_RATE_RULES,
    accounts: ACCOUNTS,
    wallets: WALLETS,
    corporateSegmentId: "seg_corporate",
    ...overrides,
  };
}

/** The three ways a fiscal year handles the tax (11 §10): exempt, taxable tax-inclusive, tax-exclusive. */
const METHODS: readonly { consumptionTax: ConsumptionTaxMethod; method: AccountingMethod }[] = [
  { consumptionTax: "exempt", method: "tax_inclusive" },
  { consumptionTax: "simplified", method: "tax_inclusive" },
  { consumptionTax: "general", method: "tax_exclusive" },
];

function validation(
  consumptionTax: ConsumptionTaxMethod,
  method: AccountingMethod,
): ValidationContext {
  return {
    fiscalYear: { ...FISCAL_YEAR, consumptionTax, accountingMethod: method },
    accounts: new Map<string, AccountRef>(ACCOUNT_ROWS.map((account) => [account.id, account])),
  };
}

function totals(entry: JournalEntryInput): { debit: bigint; credit: bigint } {
  let debit = 0n;
  let credit = 0n;
  for (const line of entry.lines) {
    if (line.side === "debit") debit += line.amount;
    else credit += line.amount;
  }
  return { debit, credit };
}

function rows(entry: JournalEntryInput) {
  return entry.lines.map((line) => [
    line.side,
    line.accountId,
    line.amount,
    line.taxCategoryCode,
    line.taxAmount,
  ]);
}

const expense = (overrides: Partial<SimpleEntryInput> = {}): SimpleEntryInput =>
  ({
    type: "expense",
    entryDate: "2026-11-05",
    description: "クラウド利用料",
    counterpart: { kind: "wallet", walletId: "w_card" },
    accountId: "acc_comm",
    amount: 1_100n,
    taxCategoryCode: "purchase_10",
    segmentId: "seg_platform",
    partnerId: "p_cloud",
    memoTagIds: ["tag_1"],
    ...overrides,
  }) as SimpleEntryInput;

const income = (overrides: Partial<SimpleEntryInput> = {}): SimpleEntryInput =>
  ({
    type: "income",
    entryDate: "2026-11-20",
    description: "月会費",
    counterpart: { kind: "wallet", walletId: "w_bank" },
    accountId: "acc_sales",
    amount: 11_000n,
    taxCategoryCode: "sales_10",
    segmentId: "seg_kamakura",
    partnerId: null,
    ...overrides,
  }) as SimpleEntryInput;

const transfer = (overrides: Partial<SimpleEntryInput> = {}): SimpleEntryInput =>
  ({
    type: "transfer",
    entryDate: "2026-11-30",
    description: "振替",
    fromWalletId: "w_bank",
    toWalletId: "w_cash",
    amount: 10_000n,
    fee: null,
    ...overrides,
  }) as SimpleEntryInput;

function buildErrors(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerValidationError);
    return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
  }
  throw new Error("expected the builder to fail");
}

describe("buildSimpleEntry: debits equal credits for any input", () => {
  const SALES = ["sales_10", "sales_8r", "sales_exempt", "sales_out", "sales_export", "na"];
  const PURCHASES = [
    "purchase_10",
    "purchase_8r",
    "purchase_10_ni",
    "purchase_8r_ni",
    "purchase_exempt",
    "purchase_out",
    "na",
  ];
  const methodArb = fc.constantFrom(...METHODS);
  const datesArb = dateArb(FISCAL_YEAR.startDate, FISCAL_YEAR.endDate);
  const counterpartArb = (accountIds: string[]) =>
    fc.oneof(
      fc.constantFrom("w_bank", "w_card", "w_cash").map((walletId) => ({
        kind: "wallet" as const,
        walletId,
      })),
      fc.constantFrom(...accountIds).map((accountId) => ({ kind: "account" as const, accountId })),
    );

  const inputArb: fc.Arbitrary<SimpleEntryInput> = fc.oneof(
    fc.record({
      type: fc.constant("income" as const),
      entryDate: datesArb,
      description: fc.constant("入金"),
      counterpart: counterpartArb(["acc_ar", "acc_owner"]),
      accountId: fc.constant("acc_sales"),
      amount: amountArb,
      taxCategoryCode: fc.constantFrom(...SALES),
      segmentId: fc.constant("seg_kamakura"),
      partnerId: fc.constantFrom(null, "p_1"),
    }),
    fc.record({
      type: fc.constant("expense" as const),
      entryDate: datesArb,
      description: fc.constant("支払"),
      counterpart: counterpartArb(["acc_accrued", "acc_owner"]),
      accountId: fc.constantFrom("acc_comm", "acc_fee", "acc_insurance", "acc_prepaid"),
      amount: amountArb,
      taxCategoryCode: fc.constantFrom(...PURCHASES),
      segmentId: fc.constant("seg_platform"),
      partnerId: fc.constantFrom(null, "p_2"),
    }),
    fc.record({
      type: fc.constant("transfer" as const),
      entryDate: datesArb,
      description: fc.constant("振替"),
      fromWalletId: fc.constantFrom("w_bank", "w_cash"),
      toWalletId: fc.constant("w_card"),
      amount: amountArb,
      fee: fc.option(fc.bigInt({ min: 1n, max: 5_000n }), { nil: null }),
    }),
  );

  it("is accepted by the ledger and moves exactly the amount (plus the fee)", () => {
    fc.assert(
      fc.property(inputArb, methodArb, (input, { consumptionTax, method }) => {
        const entry = buildSimpleEntry(input, context(method));
        expect(validateEntry(entry, validation(consumptionTax, method))).toEqual({ ok: true });
        const { debit, credit } = totals(entry);
        expect(debit).toBe(credit);
        const moved = input.type === "transfer" ? input.amount + (input.fee ?? 0n) : input.amount;
        expect(debit).toBe(moved);
        for (const line of entry.lines) expect(line.taxAmount <= line.amount).toBe(true);
        const taxLines = entry.lines.filter((line) =>
          ["acc_input_tax", "acc_output_tax"].includes(line.accountId),
        );
        if (method === "tax_inclusive") expect(taxLines).toEqual([]);
        else {
          // The tax lines carry the creditable share of the contained tax (経過措置 for `_ni`).
          const creditable = entry.lines.reduce((total, line) => {
            const rule = resolveTaxRule(
              line.taxCategoryCode,
              entry.entryDate,
              STANDARD_TAX_RATE_RULES,
            );
            const percent = rule?.deductiblePercent ?? 100;
            return total + (line.taxAmount * BigInt(percent)) / 100n;
          }, 0n);
          expect(taxLines.reduce((total, line) => total + line.amount, 0n)).toBe(creditable);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("buildSimpleEntry: 収入・支出", () => {
  it("tax-inclusive years (exempt ones too) keep the amount and only record the tax", () => {
    for (const { consumptionTax, method } of METHODS.filter((m) => m.method === "tax_inclusive")) {
      const entry = buildSimpleEntry(expense(), context(method));
      expect(validateEntry(entry, validation(consumptionTax, method))).toEqual({ ok: true });
      expect(entry).toMatchObject({
        kind: "normal",
        sourceKind: "manual",
        description: "クラウド利用料",
      });
      expect(rows(entry)).toEqual([
        ["debit", "acc_comm", 1_100n, "purchase_10", 100n],
        ["credit", "acc_card", 1_100n, "na", 0n],
      ]);
      expect(entry.lines[0]).toMatchObject({
        segmentId: "seg_platform",
        partnerId: "p_cloud",
        description: "クラウド利用料",
        memoTagIds: ["tag_1"],
      });
      // The wallet line carries the wallet's sub-account; tags go on every line.
      expect(entry.lines[1]).toMatchObject({
        subAccountId: "sub_card",
        partnerId: null,
        memoTagIds: ["tag_1"],
      });
      expect(rows(buildSimpleEntry(income(), context(method)))).toEqual([
        ["debit", "acc_bank", 11_000n, "na", 0n],
        ["credit", "acc_sales", 11_000n, "sales_10", 1_000n],
      ]);
    }
  });

  it("tax-exclusive years book the amount without the tax and add 仮受・仮払消費税", () => {
    expect(rows(buildSimpleEntry(income(), context("tax_exclusive")))).toEqual([
      ["debit", "acc_bank", 11_000n, "na", 0n],
      ["credit", "acc_sales", 10_000n, "sales_10", 1_000n],
      ["credit", "acc_output_tax", 1_000n, "na", 0n],
    ]);
    // 1,000 × 10 ÷ 110 = 90.9… → 90
    expect(rows(buildSimpleEntry(expense({ amount: 1_000n }), context("tax_exclusive")))).toEqual([
      ["debit", "acc_comm", 910n, "purchase_10", 90n],
      ["debit", "acc_input_tax", 90n, "na", 0n],
      ["credit", "acc_card", 1_000n, "na", 0n],
    ]);
  });

  it("adds no tax line for categories outside the tax, or when the tax rounds to 0", () => {
    const insurance = expense({
      accountId: "acc_insurance",
      taxCategoryCode: "purchase_exempt",
      amount: 5_000n,
    });
    expect(rows(buildSimpleEntry(insurance, context("tax_exclusive")))).toEqual([
      ["debit", "acc_insurance", 5_000n, "purchase_exempt", 0n],
      ["credit", "acc_card", 5_000n, "na", 0n],
    ]);
    const tiny = expense({ amount: 10n });
    expect(rows(buildSimpleEntry(tiny, context("tax_exclusive")))).toEqual([
      ["debit", "acc_comm", 10n, "purchase_10", 0n],
      ["credit", "acc_card", 10n, "na", 0n],
    ]);
  });

  it("posts to an account instead of a wallet, with the partner on that line", () => {
    const entry = buildSimpleEntry(
      income({
        counterpart: { kind: "account", accountId: "acc_ar" },
        partnerId: "p_design",
      } as never),
      context("tax_inclusive"),
    );
    expect(entry.lines[0]).toMatchObject({
      side: "debit",
      accountId: "acc_ar",
      subAccountId: null,
      partnerId: "p_design",
      segmentId: null,
    });
    expect(entry.lines[1]).toMatchObject({ partnerId: "p_design" });
  });

  it("rejects a taxable category without a rule on the date, naming the field", () => {
    const withoutSales10 = STANDARD_TAX_RATE_RULES.filter(
      (rule) => rule.taxCategoryCode !== "sales_10",
    );
    try {
      buildSimpleEntry(income(), context("tax_inclusive", { taxRules: withoutSales10 }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerValidationError);
      expect((error as LedgerValidationError).errors).toEqual([
        {
          code: "TAX_RULE_MISSING",
          field: "taxCategoryCode",
          message:
            "税区分「課税売上 10%」の税率が 2026/11/20 に設定されていません。設定 › 税区分 で足してください",
        },
      ]);
    }
    // Before the 10% rate existed there is no rule either; categories outside the tax need none.
    expect(
      buildErrors(() =>
        buildSimpleEntry(expense({ entryDate: "2019-09-30" } as never), context("tax_inclusive")),
      ),
    ).toEqual([{ code: "TAX_RULE_MISSING", field: "taxCategoryCode" }]);
    const noRules = context("tax_exclusive", { taxRules: [] });
    expect(rows(buildSimpleEntry(expense({ taxCategoryCode: "purchase_out" }), noRules))).toEqual([
      ["debit", "acc_comm", 1_100n, "purchase_out", 0n],
      ["credit", "acc_card", 1_100n, "na", 0n],
    ]);
  });

  it("names every faulty field at once", () => {
    expect(
      buildErrors(() =>
        buildSimpleEntry(
          expense({
            accountId: "acc_sales",
            counterpart: { kind: "wallet", walletId: "w_old" },
          } as never),
          context("tax_inclusive"),
        ),
      ),
    ).toEqual([
      { code: "ACCOUNT_NOT_ALLOWED", field: "accountId" },
      { code: "UNKNOWN_WALLET", field: "counterpart" },
    ]);
    expect(
      buildErrors(() =>
        buildSimpleEntry(
          income({ counterpart: { kind: "account", accountId: "acc_missing" } } as never),
          context("tax_inclusive"),
        ),
      ),
    ).toEqual([{ code: "UNKNOWN_ACCOUNT", field: "counterpart" }]);
    const withoutOutputTax = new Map([...ACCOUNTS].filter(([id]) => id !== "acc_output_tax"));
    expect(
      buildErrors(() =>
        buildSimpleEntry(income(), context("tax_exclusive", { accounts: withoutOutputTax })),
      ),
    ).toEqual([{ code: "STANDARD_ACCOUNT_MISSING", field: undefined }]);
  });

  it("refuses the accounts the forms leave out: wallets' accounts, 仮払・仮受消費税, cash", () => {
    // 2100 is the card wallet's account, 1100 the bank's; 1400 / 2310 are written by the ledger.
    for (const accountId of ["acc_card", "acc_bank", "acc_input_tax", "acc_output_tax"]) {
      expect(
        buildErrors(() => buildSimpleEntry(expense({ accountId }), context("tax_inclusive"))),
        accountId,
      ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
      expect(
        buildErrors(() => buildSimpleEntry(income({ accountId }), context("tax_inclusive"))),
        accountId,
      ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
    }
    // As 入金先 / 支払元 too: such money is chosen as the wallet.
    expect(
      buildErrors(() =>
        buildSimpleEntry(
          expense({ counterpart: { kind: "account", accountId: "acc_card" } } as never),
          context("tax_inclusive"),
        ),
      ),
    ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "counterpart" }]);
    // A cash-like asset without a wallet is refused as well.
    const cashLike = new Map(
      [...ACCOUNTS].map(([id, account]) => [
        id,
        id === "acc_prepaid" ? { ...account, isCashLike: true } : account,
      ]),
    );
    expect(
      buildErrors(() =>
        buildSimpleEntry(
          expense({ accountId: "acc_prepaid" }),
          context("tax_inclusive", { accounts: cashLike }),
        ),
      ),
    ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "accountId" }]);
    // An inactive wallet no longer reserves its account (the 旧口座 posts to 1100 like the bank).
    const withoutBank = new Map([...WALLETS].filter(([id]) => id !== "w_bank"));
    expect(
      buildSimpleEntry(
        income({ counterpart: { kind: "account", accountId: "acc_bank" } } as never),
        context("tax_inclusive", { wallets: withoutBank }),
      ).lines[0]?.accountId,
    ).toBe("acc_bank");
    expect(
      isReservedAccount({ id: "acc_comm", code: "5320", kind: "expense" }, new Set(["acc_card"])),
    ).toBe(false);
  });
});

describe("buildSimpleEntry: 振替", () => {
  it("moves the amount between wallets with kind transfer and no tax", () => {
    const entry = buildSimpleEntry(transfer(), context("tax_exclusive"));
    expect(entry.kind).toBe("transfer");
    expect(rows(entry)).toEqual([
      ["debit", "acc_cash", 10_000n, "na", 0n],
      ["credit", "acc_bank", 10_000n, "na", 0n],
    ]);
    // The wallet lines carry the wallets' default segments (現金 → 共通).
    expect(entry.lines.map((line) => line.segmentId)).toEqual(["seg_corporate", null]);
  });

  it("charges the fee to 支払手数料 and takes it from the paying wallet", () => {
    const inclusive = buildSimpleEntry(transfer({ fee: 440n }), context("tax_inclusive"));
    expect(rows(inclusive)).toEqual([
      ["debit", "acc_cash", 10_000n, "na", 0n],
      ["debit", "acc_fee", 440n, "purchase_10", 40n],
      ["credit", "acc_bank", 10_440n, "na", 0n],
    ]);
    // The paying bank has no default segment: the fee goes to 共通.
    expect(inclusive.lines[1]).toMatchObject({ segmentId: "seg_corporate", description: "手数料" });

    const exclusive = buildSimpleEntry(transfer({ fee: 440n }), context("tax_exclusive"));
    expect(rows(exclusive)).toEqual([
      ["debit", "acc_cash", 10_000n, "na", 0n],
      ["debit", "acc_fee", 400n, "purchase_10", 40n],
      ["debit", "acc_input_tax", 40n, "na", 0n],
      ["credit", "acc_bank", 10_440n, "na", 0n],
    ]);

    const fromCash = buildSimpleEntry(
      transfer({ fromWalletId: "w_cash", toWalletId: "w_bank", fee: 110n }),
      context("tax_inclusive"),
    );
    expect(fromCash.lines[1]).toMatchObject({ accountId: "acc_fee", segmentId: "seg_corporate" });
  });

  it("rejects the same wallet on both sides", () => {
    expect(
      buildErrors(() =>
        buildSimpleEntry(transfer({ toWalletId: "w_bank" }), context("tax_inclusive")),
      ),
    ).toEqual([{ code: "SAME_WALLET", field: "toWalletId" }]);
  });
});

describe("buildVoucherEntry", () => {
  const voucher = (overrides: Partial<VoucherEntryInput> = {}): VoucherEntryInput => ({
    entryDate: "2026-12-31",
    description: "決算整理",
    kind: "adjusting",
    partnerId: "p_default",
    memoTagIds: ["tag_1"],
    lines: [
      {
        side: "debit",
        accountId: "acc_comm",
        subAccountId: null,
        amount: 910n,
        taxCategoryCode: "purchase_10",
        segmentId: "seg_platform",
        partnerId: null,
        description: "未払分",
      },
      {
        side: "debit",
        accountId: "acc_input_tax",
        subAccountId: null,
        amount: 90n,
        taxCategoryCode: "na",
        segmentId: null,
        partnerId: "p_other",
        description: null,
      },
      {
        side: "credit",
        accountId: "acc_card",
        subAccountId: "sub_card",
        amount: 1_000n,
        taxCategoryCode: "na",
        segmentId: null,
        partnerId: null,
        description: null,
      },
    ],
    ...overrides,
  });

  it("computes each row's tax: exclusive rows × rate ÷ 100, inclusive rows × rate ÷ (100 + rate)", () => {
    const exclusive = buildVoucherEntry(voucher(), {
      accountingMethod: "tax_exclusive",
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    expect(exclusive).toMatchObject({ kind: "adjusting", sourceKind: "manual" });
    // 910 × 10 ÷ 100 = 91; no line is added (the 仮払 row is written by hand).
    expect(rows(exclusive)).toEqual([
      ["debit", "acc_comm", 910n, "purchase_10", 91n],
      ["debit", "acc_input_tax", 90n, "na", 0n],
      ["credit", "acc_card", 1_000n, "na", 0n],
    ]);
    const inclusive = buildVoucherEntry(voucher(), {
      accountingMethod: "tax_inclusive",
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    // 910 × 10 ÷ 110 = 82.7… → 82
    expect(inclusive.lines[0]?.taxAmount).toBe(82n);
  });

  it("gives blank rows the entry's partner and every row the tags", () => {
    const entry = buildVoucherEntry(voucher(), {
      accountingMethod: "tax_inclusive",
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    expect(entry.lines.map((line) => line.partnerId)).toEqual([
      "p_default",
      "p_other",
      "p_default",
    ]);
    for (const line of entry.lines) expect(line.memoTagIds).toEqual(["tag_1"]);
    expect(entry.lines[2]?.subAccountId).toBe("sub_card");
  });

  it("names the row of a taxable category without a rule", () => {
    try {
      buildVoucherEntry(voucher(), { accountingMethod: "tax_inclusive", taxRules: [] });
      expect.unreachable();
    } catch (error) {
      expect((error as LedgerValidationError).errors).toMatchObject([
        { code: "TAX_RULE_MISSING", field: "lines.0.taxCategoryCode", lineIndex: 0 },
      ]);
    }
  });

  it("keeps the tax a row brings (an unchanged row of a correction) instead of computing it", () => {
    const [first, ...rest] = voucher().lines;
    if (!first) throw new Error("the voucher has rows");
    // Computed it would be 910 × 10 ÷ 100 = 91; the original 支出 split 1,000 into 910 / 90.
    const kept = buildVoucherEntry(voucher({ lines: [{ ...first, taxAmount: 90n }, ...rest] }), {
      accountingMethod: "tax_exclusive",
      taxRules: [],
    });
    expect(kept.lines.map((line) => line.taxAmount)).toEqual([90n, 0n, 0n]);
  });

  it("leaves the balance check to the ledger", () => {
    const unbalanced = buildVoucherEntry(voucher({ lines: voucher().lines.slice(0, 2) }), {
      accountingMethod: "tax_inclusive",
      taxRules: STANDARD_TAX_RATE_RULES,
    });
    const result = validateEntry(unbalanced, validation("exempt", "tax_inclusive"));
    expect(!result.ok && result.errors.map((error) => error.code)).toEqual(["UNBALANCED"]);
  });
});

describe("tax helpers of the forms", () => {
  const date: CalendarDate = "2026-11-02";

  it("show the tax contained in an amount, or null without a rule", () => {
    expect(containedTaxAmount(1_100n, "purchase_10", date, STANDARD_TAX_RATE_RULES)).toBe(100n);
    expect(containedTaxAmount(1_080n, "sales_8r", date, STANDARD_TAX_RATE_RULES)).toBe(80n);
    expect(containedTaxAmount(1_100n, "purchase_exempt", date, [])).toBe(0n);
    expect(containedTaxAmount(1_100n, "purchase_10", date, [])).toBeNull();
    expect(
      voucherLineTaxAmount(1_000n, "sales_10", date, "tax_exclusive", STANDARD_TAX_RATE_RULES),
    ).toBe(100n);
    expect(
      voucherLineTaxAmount(1_100n, "sales_10", date, "tax_inclusive", STANDARD_TAX_RATE_RULES),
    ).toBe(100n);
  });

  it("split a tax-inclusive amount by the accounting method", () => {
    const options = { taxRules: STANDARD_TAX_RATE_RULES };
    expect(
      splitTaxInclusive(3_300n, "purchase_10", date, {
        ...options,
        accountingMethod: "tax_inclusive",
      }),
    ).toEqual({ amount: 3_300n, taxAmount: 300n, taxLineAmount: 0n });
    expect(
      splitTaxInclusive(3_300n, "purchase_10", date, {
        ...options,
        accountingMethod: "tax_exclusive",
      }),
    ).toEqual({ amount: 3_000n, taxAmount: 300n, taxLineAmount: 300n });
  });

  it("books only the creditable share of the tax without a qualified invoice (経過措置)", () => {
    const options = { taxRules: STANDARD_TAX_RATE_RULES };
    // 2026-10-01 〜 2028-09-30: 70% of the contained tax (300 × 70% = 210); the rest stays in the cost.
    expect(
      splitTaxInclusive(3_300n, "purchase_10_ni", date, {
        ...options,
        accountingMethod: "tax_exclusive",
      }),
    ).toEqual({ amount: 3_090n, taxAmount: 300n, taxLineAmount: 210n });
    // Tax-inclusive years keep the amount; the ratio is applied by the consumption tax report.
    expect(
      splitTaxInclusive(3_300n, "purchase_10_ni", date, {
        ...options,
        accountingMethod: "tax_inclusive",
      }),
    ).toEqual({ amount: 3_300n, taxAmount: 300n, taxLineAmount: 0n });
    // 2026-09-30 and before: 80%.
    expect(
      splitTaxInclusive(3_300n, "purchase_10_ni", "2026-09-30", {
        ...options,
        accountingMethod: "tax_exclusive",
      }),
    ).toEqual({ amount: 3_060n, taxAmount: 300n, taxLineAmount: 240n });
  });
});
