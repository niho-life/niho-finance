/**
 * 明細の登録・振替 → journal entries (docs/design/15-statements.md §1, §8, §9).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildStatementEntry,
  buildStatementTransfer,
  LedgerValidationError,
  STANDARD_TAX_RATE_RULES,
  statementEntryInputLine,
  validateEntry,
  type AccountingMethod,
  type AccountRef,
  type EntryAccount,
  type EntryWallet,
  type JournalEntryInput,
  type SimpleEntryContext,
  type StatementEntryInput,
  type StatementEntryLineInput,
  type StatementTransferInput,
} from "../src";
import { FISCAL_YEAR } from "./fixtures";

const entryAccount = (
  id: string,
  code: string,
  name: string,
  kind: EntryAccount["kind"],
  defaultTaxCategoryCode: string,
  isCashLike = false,
): EntryAccount => ({ id, code, name, kind, defaultTaxCategoryCode, isCashLike });

const ACCOUNT_ROWS: readonly EntryAccount[] = [
  entryAccount("acc_cash", "1000", "現金", "asset", "na", true),
  entryAccount("acc_bank", "1100", "普通預金", "asset", "na", true),
  entryAccount("acc_prepaid", "1300", "前払費用", "asset", "na"),
  entryAccount("acc_input_tax", "1400", "仮払消費税", "asset", "na"),
  entryAccount("acc_card", "2100", "未払金", "liability", "na"),
  entryAccount("acc_output_tax", "2310", "仮受消費税", "liability", "na"),
  entryAccount("acc_owner", "2400", "役員借入金", "liability", "na"),
  entryAccount("acc_capital", "3000", "資本金", "equity", "na"),
  entryAccount("acc_sales", "4010", "売上高 会費", "revenue", "sales_10"),
  entryAccount("acc_contract", "4040", "売上高 受託開発", "revenue", "sales_10"),
  entryAccount("acc_supplies", "5330", "消耗品費", "expense", "purchase_10"),
  entryAccount("acc_rent", "5300", "地代家賃", "expense", "purchase_10"),
  entryAccount("acc_fee", "5400", "支払手数料", "expense", "purchase_10"),
  entryAccount("acc_insurance", "5450", "保険料", "expense", "purchase_exempt"),
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

function context(
  accountingMethod: AccountingMethod,
  overrides: Partial<SimpleEntryContext> = {},
): SimpleEntryContext {
  return {
    accountingMethod,
    taxRules: STANDARD_TAX_RATE_RULES,
    accounts: new Map(ACCOUNT_ROWS.map((account) => [account.id, account])),
    wallets: new Map(WALLET_ROWS.map((wallet) => [wallet.id, wallet])),
    corporateSegmentId: "seg_corporate",
    ...overrides,
  };
}

const LEDGER_ACCOUNTS = new Map<string, AccountRef>(
  ACCOUNT_ROWS.map((account) => [account.id, account]),
);

function accepted(entry: JournalEntryInput, method: AccountingMethod) {
  return validateEntry(entry, {
    fiscalYear: {
      ...FISCAL_YEAR,
      consumptionTax: method === "tax_exclusive" ? "general" : "exempt",
      accountingMethod: method,
    },
    accounts: LEDGER_ACCOUNTS,
  });
}

function totals(entry: JournalEntryInput) {
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

const accountLine = (
  overrides: Partial<StatementEntryLineInput> = {},
): StatementEntryLineInput => ({
  accountId: "acc_supplies",
  amount: 3_980n,
  taxCategoryCode: "purchase_10",
  segmentId: "seg_kamakura",
  partnerId: null,
  description: null,
  ...overrides,
});

const payment = (overrides: Partial<StatementEntryInput> = {}): StatementEntryInput => ({
  walletId: "w_card",
  sourceId: "txn_1",
  txnDate: "2026-12-05",
  amount: -3_980n,
  description: "架空ストア 事務用品",
  partnerId: "p_store",
  lines: [accountLine()],
  ...overrides,
});

function errorsOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerValidationError);
    return (error as LedgerValidationError).errors.map(({ code, field }) => ({ code, field }));
  }
  throw new Error("expected the builder to fail");
}

describe("buildStatementEntry", () => {
  it("is balanced and accepted by the ledger for any split of the line", () => {
    const methods = fc.constantFrom<AccountingMethod>("tax_inclusive", "tax_exclusive");
    const outTaxes = fc.constantFrom(
      "purchase_10",
      "purchase_8r",
      "purchase_10_ni",
      "purchase_exempt",
      "na",
    );
    const inTaxes = fc.constantFrom("sales_10", "sales_8r", "sales_exempt", "na");
    const parts = fc.array(fc.bigInt({ min: 1n, max: 2_000_000n }), {
      minLength: 1,
      maxLength: 5,
    });
    fc.assert(
      fc.property(
        methods,
        fc.boolean(),
        parts,
        fc.array(fc.tuple(outTaxes, inTaxes), { minLength: 5, maxLength: 5 }),
        (method, isOut, amounts, taxes) => {
          const total = amounts.reduce((sum, value) => sum + value, 0n);
          const lines = amounts.map((amount, index) =>
            accountLine({
              accountId: isOut ? "acc_supplies" : "acc_sales",
              amount,
              taxCategoryCode: (taxes[index] ?? ["na", "na"])[isOut ? 0 : 1],
            }),
          );
          const entry = buildStatementEntry(
            payment({ amount: isOut ? -total : total, lines, walletId: "w_bank" }),
            context(method),
          );
          const { debit, credit } = totals(entry);
          expect(debit).toBe(credit);
          expect(debit).toBe(total);
          expect(accepted(entry, method)).toEqual({ ok: true });
        },
      ),
    );
  });

  it("writes a payment as debit account lines and a credit to the wallet", () => {
    const entry = buildStatementEntry(payment(), context("tax_inclusive"));
    expect(entry).toMatchObject({
      entryDate: "2026-12-05",
      description: "架空ストア 事務用品",
      kind: "normal",
      sourceKind: "wallet_txn",
      sourceId: "txn_1",
    });
    expect(rows(entry)).toEqual([
      ["debit", "acc_supplies", 3_980n, "purchase_10", 361n],
      ["credit", "acc_card", 3_980n, "na", 0n],
    ]);
    expect(entry.lines[0]).toMatchObject({ segmentId: "seg_kamakura", partnerId: "p_store" });
    expect(entry.lines[1]).toMatchObject({
      subAccountId: "sub_card",
      segmentId: null,
      partnerId: null,
    });
  });

  it("writes a deposit as a debit to the wallet and credit account lines", () => {
    const entry = buildStatementEntry(
      payment({
        walletId: "w_cash",
        amount: 2_200n,
        lines: [
          accountLine({ accountId: "acc_sales", amount: 2_200n, taxCategoryCode: "sales_10" }),
        ],
      }),
      context("tax_inclusive"),
    );
    expect(rows(entry)).toEqual([
      ["debit", "acc_cash", 2_200n, "na", 0n],
      ["credit", "acc_sales", 2_200n, "sales_10", 200n],
    ]);
    // The wallet's line carries its sub-account and default segment.
    expect(entry.lines[0]).toMatchObject({ subAccountId: "sub_cash", segmentId: "seg_corporate" });
  });

  it("adds one 仮払消費税 line for all the split lines in tax-exclusive years", () => {
    const split = payment({
      amount: -3_980n,
      lines: [
        accountLine({ amount: 2_200n, partnerId: "p_other", description: "文具" }),
        accountLine({ accountId: "acc_rent", amount: 1_100n }),
        accountLine({
          accountId: "acc_insurance",
          amount: 680n,
          taxCategoryCode: "purchase_exempt",
        }),
      ],
    });
    expect(rows(buildStatementEntry(split, context("tax_exclusive")))).toEqual([
      ["debit", "acc_supplies", 2_000n, "purchase_10", 200n],
      ["debit", "acc_rent", 1_000n, "purchase_10", 100n],
      ["debit", "acc_insurance", 680n, "purchase_exempt", 0n],
      ["debit", "acc_input_tax", 300n, "na", 0n],
      ["credit", "acc_card", 3_980n, "na", 0n],
    ]);
    const entry = buildStatementEntry(split, context("tax_exclusive"));
    expect(entry.lines.map((line) => line.partnerId)).toEqual([
      "p_other",
      "p_store",
      "p_store",
      null,
      null,
    ]);
    expect(entry.lines[0]?.description).toBe("文具");
    // Tax-inclusive years keep the amounts and only record the tax.
    expect(rows(buildStatementEntry(split, context("tax_inclusive")))).toEqual([
      ["debit", "acc_supplies", 2_200n, "purchase_10", 200n],
      ["debit", "acc_rent", 1_100n, "purchase_10", 100n],
      ["debit", "acc_insurance", 680n, "purchase_exempt", 0n],
      ["credit", "acc_card", 3_980n, "na", 0n],
    ]);
  });

  it("adds 仮受消費税 after the income lines in tax-exclusive years", () => {
    const entry = buildStatementEntry(
      payment({
        walletId: "w_bank",
        amount: 330_000n,
        lines: [
          accountLine({ accountId: "acc_contract", amount: 330_000n, taxCategoryCode: "sales_10" }),
        ],
      }),
      context("tax_exclusive"),
    );
    expect(rows(entry)).toEqual([
      ["debit", "acc_bank", 330_000n, "na", 0n],
      ["credit", "acc_contract", 300_000n, "sales_10", 30_000n],
      ["credit", "acc_output_tax", 30_000n, "na", 0n],
    ]);
  });

  it("books only the creditable share of the tax without a qualified invoice (経過措置)", () => {
    const entry = buildStatementEntry(
      payment({ lines: [accountLine({ amount: 3_980n, taxCategoryCode: "purchase_10_ni" })] }),
      context("tax_exclusive"),
    );
    // 3,980 contains 361 of tax; from 2026-10 only 70% (252) is creditable.
    expect(rows(entry)).toEqual([
      ["debit", "acc_supplies", 3_728n, "purchase_10_ni", 361n],
      ["debit", "acc_input_tax", 252n, "na", 0n],
      ["credit", "acc_card", 3_980n, "na", 0n],
    ]);
  });

  it("rejects lines that do not add up to the amount, saying both totals", () => {
    const run = () =>
      buildStatementEntry(
        payment({
          lines: [accountLine({ amount: 2_000n }), accountLine({ amount: 1_500n })],
        }),
        context("tax_inclusive"),
      );
    expect(errorsOf(run)).toEqual([{ code: "UNBALANCED", field: "lines" }]);
    expect(() => run()).toThrow("行の合計 3,500 円が明細の金額 3,980 円と合いません");
  });

  it("refuses the reserved accounts and accounts of the other direction, naming the line", () => {
    const reserved = ["acc_bank", "acc_cash", "acc_card", "acc_input_tax", "acc_output_tax"];
    for (const accountId of reserved) {
      expect(
        errorsOf(() =>
          buildStatementEntry(
            payment({ lines: [accountLine({ accountId })] }),
            context("tax_inclusive"),
          ),
        ),
      ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "lines.0.accountId" }]);
    }
    expect(
      errorsOf(() =>
        buildStatementEntry(
          payment({
            amount: 3_980n,
            lines: [
              accountLine({ accountId: "acc_sales", amount: 1_000n, taxCategoryCode: "sales_10" }),
              accountLine({ accountId: "acc_supplies", amount: 2_980n }),
            ],
          }),
          context("tax_inclusive"),
        ),
      ),
    ).toEqual([{ code: "ACCOUNT_NOT_ALLOWED", field: "lines.1.accountId" }]);
    expect(() =>
      buildStatementEntry(
        payment({ amount: 1_000n, lines: [accountLine({ amount: 1_000n })] }),
        context("tax_inclusive"),
      ),
    ).toThrow("入金には選べません。収益・資産・負債・純資産の科目を選んでください");
    // Assets, liabilities and equity are fine where they belong (capital paid in, a prepayment).
    expect(() =>
      buildStatementEntry(
        payment({
          walletId: "w_bank",
          amount: 50_000n,
          lines: [
            accountLine({ accountId: "acc_capital", amount: 50_000n, taxCategoryCode: "na" }),
          ],
        }),
        context("tax_inclusive"),
      ),
    ).not.toThrow();
  });

  it("reports every problem at once: the wallet, unknown accounts and missing tax rules", () => {
    expect(
      errorsOf(() =>
        buildStatementEntry(
          payment({
            walletId: "w_old",
            txnDate: "2018-05-01",
            lines: [
              accountLine({ accountId: "acc_missing", amount: 1_000n }),
              accountLine({ amount: 2_980n }),
            ],
          }),
          context("tax_inclusive"),
        ),
      ),
    ).toEqual([
      { code: "UNKNOWN_WALLET", field: "walletId" },
      { code: "UNKNOWN_ACCOUNT", field: "lines.0.accountId" },
      { code: "TAX_RULE_MISSING", field: "lines.0.taxCategoryCode" },
      { code: "TAX_RULE_MISSING", field: "lines.1.taxCategoryCode" },
    ]);
    expect(
      errorsOf(() =>
        buildStatementEntry(
          payment({ lines: [accountLine()] }),
          context("tax_exclusive", {
            accounts: new Map(
              ACCOUNT_ROWS.filter((row) => row.code !== "1400").map((row) => [row.id, row]),
            ),
          }),
        ),
      ),
    ).toEqual([{ code: "STANDARD_ACCOUNT_MISSING", field: undefined }]);
  });

  it("maps the entry's account lines back to the input lines", () => {
    expect(statementEntryInputLine(0, -1n, 2)).toBe(0);
    expect(statementEntryInputLine(2, -1n, 2)).toBeNull();
    expect(statementEntryInputLine(0, 1n, 2)).toBeNull();
    expect(statementEntryInputLine(2, 1n, 2)).toBe(1);
  });
});

describe("buildStatementTransfer", () => {
  const transfer = (overrides: Partial<StatementTransferInput> = {}): StatementTransferInput => ({
    walletId: "w_bank",
    sourceId: "txn_9",
    txnDate: "2027-01-20",
    amount: -30_000n,
    otherWalletId: "w_cash",
    fee: null,
    description: "ATM 引出",
    ...overrides,
  });

  it("moves money out of this wallet into the other, marked as from a statement line", () => {
    const entry = buildStatementTransfer(transfer(), context("tax_inclusive"));
    expect(entry).toMatchObject({
      entryDate: "2027-01-20",
      kind: "transfer",
      sourceKind: "wallet_txn",
      sourceId: "txn_9",
    });
    expect(rows(entry)).toEqual([
      ["debit", "acc_cash", 30_000n, "na", 0n],
      ["credit", "acc_bank", 30_000n, "na", 0n],
    ]);
  });

  it("takes the fee of a payment from the amount the other wallet receives", () => {
    const entry = buildStatementTransfer(
      transfer({ amount: -10_000n, fee: 440n }),
      context("tax_inclusive"),
    );
    expect(rows(entry)).toEqual([
      ["debit", "acc_cash", 9_560n, "na", 0n],
      ["debit", "acc_fee", 440n, "purchase_10", 40n],
      ["credit", "acc_bank", 10_000n, "na", 0n],
    ]);
    expect(accepted(entry, "tax_inclusive")).toEqual({ ok: true });
  });

  it("charges the fee of a deposit to the paying wallet on top of the amount", () => {
    const entry = buildStatementTransfer(
      transfer({ amount: 10_000n, fee: 440n, otherWalletId: "w_card" }),
      context("tax_exclusive"),
    );
    expect(rows(entry)).toEqual([
      ["debit", "acc_bank", 10_000n, "na", 0n],
      ["debit", "acc_fee", 400n, "purchase_10", 40n],
      ["debit", "acc_input_tax", 40n, "na", 0n],
      ["credit", "acc_card", 10_440n, "na", 0n],
    ]);
    expect(accepted(entry, "tax_exclusive")).toEqual({ ok: true });
  });

  it("names the other wallet `counterpart` and this one `walletId`", () => {
    expect(
      errorsOf(() =>
        buildStatementTransfer(transfer({ otherWalletId: "w_bank" }), context("tax_inclusive")),
      ),
    ).toEqual([{ code: "SAME_WALLET", field: "counterpart" }]);
    expect(
      errorsOf(() =>
        buildStatementTransfer(transfer({ otherWalletId: "w_old" }), context("tax_inclusive")),
      ),
    ).toEqual([{ code: "UNKNOWN_WALLET", field: "counterpart" }]);
    expect(
      errorsOf(() =>
        buildStatementTransfer(
          transfer({ amount: 5_000n, otherWalletId: "w_missing" }),
          context("tax_inclusive"),
        ),
      ),
    ).toEqual([{ code: "UNKNOWN_WALLET", field: "counterpart" }]);
    expect(
      errorsOf(() =>
        buildStatementTransfer(transfer({ walletId: "w_old" }), context("tax_inclusive")),
      ),
    ).toEqual([{ code: "UNKNOWN_WALLET", field: "walletId" }]);
  });

  it("refuses a fee that leaves nothing to move", () => {
    expect(
      errorsOf(() => buildStatementTransfer(transfer({ fee: 30_000n }), context("tax_inclusive"))),
    ).toEqual([{ code: "INVALID_AMOUNT", field: "fee" }]);
  });
});
