import { STANDARD_TAX_RATE_RULES, validateEntry, type AccountRef } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  buildOpeningEntries,
  companyInputSchema,
  openingInputSchema,
  SettingsError,
  walletCreateSchema,
  type OpeningContext,
} from "../src";

const ACCOUNTS = {
  capital: { id: "acc_3000", code: "3000", name: "資本金" },
  formationCosts: { id: "acc_1700", code: "1700", name: "創立費" },
  startupCosts: { id: "acc_1710", code: "1710", name: "開業費" },
  ownerLoan: { id: "acc_2400", code: "2400", name: "役員借入金" },
};

const INPUT_TAX = { id: "acc_1400", code: "1400", name: "仮払消費税" };

function context(
  accountingMethod: "tax_inclusive" | "tax_exclusive" = "tax_inclusive",
  inputTaxAccount: OpeningContext["inputTaxAccount"] = INPUT_TAX,
): OpeningContext {
  return {
    fiscalYear: { id: "fy1", startDate: "2026-11-02", endDate: "2027-03-31", accountingMethod },
    accounts: ACCOUNTS,
    inputTaxAccount,
    wallets: new Map([
      [
        "w_bank",
        {
          id: "w_bank",
          name: "架空銀行 普通",
          accountId: "acc_1100",
          subAccountId: "sub_bank",
          isActive: true,
        },
      ],
      [
        "w_old",
        {
          id: "w_old",
          name: "旧口座",
          accountId: "acc_1100",
          subAccountId: "sub_old",
          isActive: false,
        },
      ],
    ]),
    corporateSegmentId: "seg_corporate",
    taxRules: STANDARD_TAX_RATE_RULES,
    accountLabels: new Map(),
    subAccountLabels: new Map(),
  };
}

const LEDGER_ACCOUNTS = new Map<string, AccountRef>(
  [
    { id: "acc_1100", code: "1100", kind: "asset" },
    { id: "acc_1400", code: "1400", kind: "asset" },
    { id: "acc_1700", code: "1700", kind: "asset" },
    { id: "acc_1710", code: "1710", kind: "asset" },
    { id: "acc_2400", code: "2400", kind: "liability" },
    { id: "acc_3000", code: "3000", kind: "equity" },
  ].map((account) => [account.id, account as AccountRef]),
);

function input(overrides: Record<string, unknown> = {}) {
  return openingInputSchema.parse({
    capital: { date: "2026-11-02", amount: "50,000", walletId: "w_bank" },
    formationCosts: [
      {
        description: "登録免許税",
        amount: "150000",
        date: "2026-11-02",
        paidFromWalletId: "",
        taxCategoryCode: "purchase_out",
      },
    ],
    startupCosts: [
      {
        description: "備品",
        amount: "3,300",
        date: "2026-12-01",
        paidFromWalletId: "w_bank",
        taxCategoryCode: "purchase_10",
      },
    ],
    ...overrides,
  });
}

describe("buildOpeningEntries", () => {
  it("builds balanced opening entries on the 共通 segment", () => {
    const entries = buildOpeningEntries(input(), context());
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({ kind: "opening", sourceKind: "system" });
      for (const line of entry.lines) expect(line.segmentId).toBe("seg_corporate");
      const result = validateEntry(entry, {
        fiscalYear: {
          startDate: "2026-11-02",
          endDate: "2027-03-31",
          lockedThrough: null,
          status: "open",
          consumptionTax: "exempt",
          accountingMethod: "tax_inclusive",
        },
        accounts: LEDGER_ACCOUNTS,
      });
      expect(result).toEqual({ ok: true });
    }
    expect(entries[1]?.lines.map((line) => [line.side, line.accountId, line.subAccountId])).toEqual(
      [
        ["debit", "acc_1700", null],
        ["credit", "acc_2400", null],
      ],
    );
    // 3,300 tax-inclusive at 10% contains 300 of consumption tax (kept for reference reports).
    expect(entries[2]?.lines[0]).toMatchObject({
      accountId: "acc_1710",
      amount: 3_300n,
      taxCategoryCode: "purchase_10",
      taxAmount: 300n,
    });
    expect(entries[2]?.lines[1]).toMatchObject({ accountId: "acc_1100", subAccountId: "sub_bank" });
  });

  it("splits taxable costs of a tax-exclusive year into the cost and 仮払消費税 (11 §1)", () => {
    const entries = buildOpeningEntries(input(), context("tax_exclusive"));
    // 3,300 tax-inclusive at 10% → 3,000 for 開業費 and 300 for 仮払消費税, paid 3,300.
    expect(
      entries[2]?.lines.map((line) => [line.side, line.accountId, line.amount, line.taxAmount]),
    ).toEqual([
      ["debit", "acc_1710", 3_000n, 300n],
      ["debit", "acc_1400", 300n, 0n],
      ["credit", "acc_1100", 3_300n, 0n],
    ]);
    expect(entries[2]?.lines[1]).toMatchObject({
      taxCategoryCode: "na",
      segmentId: "seg_corporate",
    });
    // Costs outside the tax are not split.
    expect(entries[1]?.lines).toHaveLength(2);
    for (const entry of entries) {
      const result = validateEntry(entry, {
        fiscalYear: {
          startDate: "2026-11-02",
          endDate: "2027-03-31",
          lockedThrough: null,
          status: "open",
          consumptionTax: "general",
          accountingMethod: "tax_exclusive",
        },
        accounts: LEDGER_ACCOUNTS,
      });
      expect(result).toEqual({ ok: true });
    }
  });

  it("refuses a missing 仮払消費税 account, a taxable cost without a rule and inactive wallets", () => {
    try {
      buildOpeningEntries(input(), context("tax_exclusive", null));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsError);
      expect((error as SettingsError).field).toBe("startupCosts.0.taxCategoryCode");
      expect((error as SettingsError).message).toContain("仮払消費税");
    }
    try {
      buildOpeningEntries(input(), { ...context(), taxRules: [] });
      expect.unreachable();
    } catch (error) {
      expect((error as SettingsError).field).toBe("startupCosts.0.taxCategoryCode");
      expect((error as SettingsError).message).toBe(
        "税区分「課税仕入 10%」の税率が 2026/12/01 に設定されていません。設定 › 税区分 で足してください",
      );
    }
    expect(() =>
      buildOpeningEntries(
        input({ capital: { date: "2026-11-02", amount: "50000", walletId: "w_old" } }),
        context(),
      ),
    ).toThrow(/無効/);
  });
});

describe("input schemas", () => {
  it("normalizes the company form", () => {
    const parsed = companyInputSchema.parse({
      name: "  架空商会株式会社 ",
      nameKana: "",
      representative: undefined,
      address: null,
      foundedOn: "2026-11-02",
      fiscalYearEndMonth: "３",
      corporateNumber: "",
      invoiceRegistrationNumber: "",
      invoiceRegisteredOn: "",
    });
    expect(parsed).toEqual({
      name: "架空商会株式会社",
      nameKana: null,
      representative: null,
      address: null,
      foundedOn: "2026-11-02",
      fiscalYearEndMonth: 3,
      corporateNumber: null,
      invoiceRegistrationNumber: null,
      invoiceRegisteredOn: null,
    });
  });

  it("parses amounts typed with separators and turns missing optional fields into null", () => {
    expect(
      walletCreateSchema.parse({ name: "現金", kind: "cash", openingBalance: "１２,０００" }),
    ).toEqual({
      name: "現金",
      kind: "cash",
      accountId: null,
      defaultSegmentId: null,
      openingBalanceDate: null,
      openingBalance: 12_000n,
      note: null,
    });
    expect(
      walletCreateSchema.safeParse({ name: "現金", kind: "cash", openingBalance: "1.5" }).success,
    ).toBe(false);
  });
});
