import { describe, expect, it } from "vitest";
import {
  assertValidEntry,
  LedgerValidationError,
  validateEntry,
  type JournalEntryInput,
} from "../src";
import { ACCOUNTS, context, entry, line } from "./fixtures";

function codes(input: JournalEntryInput, ctx = context()) {
  const result = validateEntry(input, ctx);
  return result.ok ? [] : result.errors.map((error) => error.code);
}

const capitalPayment = entry(
  [line("debit", ACCOUNTS.bank, 50_000n), line("credit", ACCOUNTS.capital, 50_000n)],
  { kind: "opening", entryDate: "2026-11-02", description: "資本金の払込" },
);

describe("validateEntry", () => {
  it("accepts a balanced entry inside the open fiscal year", () => {
    expect(validateEntry(capitalPayment, context())).toEqual({ ok: true });
  });

  it("requires 2 or more lines", () => {
    expect(codes(entry([]))).toEqual(["TOO_FEW_LINES"]);
    expect(codes(entry([line("debit", ACCOUNTS.bank, 100n)]))).toEqual([
      "TOO_FEW_LINES",
      "UNBALANCED",
    ]);
  });

  it("requires positive whole-yen amounts", () => {
    const zero = entry([line("debit", ACCOUNTS.bank, 0n), line("credit", ACCOUNTS.capital, 0n)]);
    expect(codes(zero)).toEqual(["NON_POSITIVE_AMOUNT", "NON_POSITIVE_AMOUNT"]);
    const negative = entry([
      line("debit", ACCOUNTS.bank, -5n),
      line("credit", ACCOUNTS.capital, -5n),
    ]);
    expect(codes(negative)).toContain("NON_POSITIVE_AMOUNT");
    const float = entry([
      line("debit", ACCOUNTS.bank, 1.5 as unknown as bigint),
      line("credit", ACCOUNTS.capital, 1n),
    ]);
    expect(codes(float)).toContain("INVALID_AMOUNT");
  });

  it("checks the tax amount and the tax category", () => {
    const tooMuchTax = entry([
      line("debit", ACCOUNTS.fees, 110n, { taxCategoryCode: "purchase_10", taxAmount: 111n }),
      line("credit", ACCOUNTS.bank, 110n),
    ]);
    expect(codes(tooMuchTax)).toEqual(["INVALID_TAX_AMOUNT"]);
    const missing = entry([
      line("debit", ACCOUNTS.fees, 110n, { taxCategoryCode: " " }),
      line("credit", ACCOUNTS.bank, 110n),
    ]);
    expect(codes(missing)).toEqual(["TAX_CATEGORY_REQUIRED"]);
    const taxOnOutOfScope = entry([
      line("debit", ACCOUNTS.fees, 110n, { taxCategoryCode: "na", taxAmount: 10n }),
      line("credit", ACCOUNTS.bank, 110n),
    ]);
    expect(codes(taxOnOutOfScope)).toEqual(["TAX_AMOUNT_NOT_ALLOWED"]);
    const unknown = entry([
      line("debit", ACCOUNTS.fees, 110n, { taxCategoryCode: "made_up" }),
      line("credit", ACCOUNTS.bank, 110n),
    ]);
    expect(
      codes(unknown, { ...context(), taxCategoryCodes: new Set(["na", "purchase_10"]) }),
    ).toEqual(["UNKNOWN_TAX_CATEGORY"]);
  });

  it("requires a segment on revenue, expense and internal lines only", () => {
    const noSegment = entry([
      line("debit", ACCOUNTS.bank, 1_100n, { segmentId: null }),
      line("credit", ACCOUNTS.sales, 1_100n, {
        segmentId: null,
        taxCategoryCode: "sales_10",
        taxAmount: 100n,
      }),
    ]);
    expect(codes(noSegment)).toEqual(["SEGMENT_REQUIRED"]);
    const internal = entry([
      line("debit", ACCOUNTS.internal, 100n, { segmentId: null }),
      line("credit", ACCOUNTS.internal, 100n),
    ]);
    expect(codes(internal)).toEqual(["SEGMENT_REQUIRED"]);
  });

  it("rejects unknown and inactive accounts (reversals may still use inactive ones)", () => {
    const unknown = entry([
      line("debit", { id: "nope", code: "0000", kind: "asset" }, 1n),
      line("credit", ACCOUNTS.bank, 1n),
    ]);
    expect(codes(unknown)).toEqual(["UNKNOWN_ACCOUNT"]);
    const accounts = new Map(context().accounts);
    accounts.set(ACCOUNTS.bank.id, { ...ACCOUNTS.bank, isActive: false });
    const ctx = { ...context(), accounts };
    expect(codes(capitalPayment, ctx)).toEqual(["ACCOUNT_INACTIVE"]);
    expect(codes({ ...capitalPayment, kind: "reversal", reversalOfId: "je_1" }, ctx)).toEqual([]);
  });

  it("checks that a sub-account belongs to the line's account", () => {
    const subAccounts = new Map([
      ["sub_bank", { accountId: ACCOUNTS.bank.id }],
      ["sub_card", { accountId: ACCOUNTS.payable.id }],
    ]);
    const ctx = { ...context(), subAccounts };
    const withSub = (subAccountId: string) =>
      entry([
        line("debit", ACCOUNTS.bank, 1n, { subAccountId }),
        line("credit", ACCOUNTS.capital, 1n),
      ]);
    expect(codes(withSub("sub_bank"), ctx)).toEqual([]);
    expect(codes(withSub("sub_card"), ctx)).toEqual(["SUB_ACCOUNT_MISMATCH"]);
    expect(codes(withSub("sub_missing"), ctx)).toEqual(["UNKNOWN_SUB_ACCOUNT"]);
  });

  it("checks the fiscal year bounds, the close and the year status", () => {
    expect(codes({ ...capitalPayment, entryDate: "2026-11-01" })).toEqual(["OUT_OF_FISCAL_YEAR"]);
    expect(codes({ ...capitalPayment, entryDate: "2027-04-01" })).toEqual(["OUT_OF_FISCAL_YEAR"]);
    expect(
      codes(
        { ...capitalPayment, entryDate: "2026-11-30" },
        context({ lockedThrough: "2026-11-30" }),
      ),
    ).toEqual(["PERIOD_LOCKED"]);
    expect(
      codes(
        { ...capitalPayment, entryDate: "2026-12-01" },
        context({ lockedThrough: "2026-11-30" }),
      ),
    ).toEqual([]);
    expect(codes(capitalPayment, context({ status: "closed" }))).toEqual(["FISCAL_YEAR_CLOSED"]);
    expect(codes(capitalPayment, context({ status: "closing" }))).toEqual(["FISCAL_YEAR_CLOSING"]);
    expect(codes({ ...capitalPayment, entryDate: "2026-11-31" })).toEqual(["INVALID_DATE"]);
  });

  it("checks the header fields", () => {
    expect(codes({ ...capitalPayment, description: "  " })).toEqual(["DESCRIPTION_REQUIRED"]);
    expect(codes({ ...capitalPayment, kind: "reversal" })).toEqual(["INVALID_REVERSAL_LINK"]);
    expect(codes({ ...capitalPayment, reversalOfId: "je_1" })).toEqual(["INVALID_REVERSAL_LINK"]);
    expect(codes({ ...capitalPayment, kind: "bogus" as never })).toEqual(["INVALID_KIND"]);
    expect(codes({ ...capitalPayment, sourceKind: "bogus" as never })).toEqual([
      "INVALID_SOURCE_KIND",
    ]);
    const badSide = entry([
      line("debit", ACCOUNTS.bank, 1n),
      { ...line("credit", ACCOUNTS.capital, 1n), side: "left" as never },
    ]);
    expect(codes(badSide)).toEqual(["INVALID_SIDE"]);
  });

  it("returns owner-facing messages with line numbers", () => {
    const result = validateEntry(
      entry([line("debit", ACCOUNTS.bank, 1_000n), line("credit", ACCOUNTS.capital, 900n)]),
      context(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]?.message).toBe(
      "借方合計と貸方合計が一致しません（借方 1,000 円 / 貸方 900 円）",
    );
  });

  it("assertValidEntry throws a LedgerValidationError with every code", () => {
    try {
      assertValidEntry({ ...capitalPayment, description: "" }, context({ status: "closed" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerValidationError);
      expect((error as LedgerValidationError).codes).toEqual([
        "FISCAL_YEAR_CLOSED",
        "DESCRIPTION_REQUIRED",
      ]);
      expect((error as LedgerValidationError).has("FISCAL_YEAR_CLOSED")).toBe(true);
    }
  });
});
