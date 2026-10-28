import fc from "fast-check";
import {
  addDays,
  daysBetween,
  type AccountRef,
  type CalendarDate,
  type FiscalYearContext,
  type JournalEntryInput,
  type JournalLineInput,
  type ValidationContext,
} from "../src";

/** A small chart covering every account kind. */
export const ACCOUNTS = {
  cash: { id: "acc_cash", code: "1000", kind: "asset" },
  bank: { id: "acc_bank", code: "1100", kind: "asset" },
  payable: { id: "acc_payable", code: "2100", kind: "liability" },
  ownerLoan: { id: "acc_owner_loan", code: "2400", kind: "liability" },
  capital: { id: "acc_capital", code: "3000", kind: "equity" },
  sales: { id: "acc_sales", code: "4010", kind: "revenue" },
  fees: { id: "acc_fees", code: "5400", kind: "expense" },
  internal: { id: "acc_internal", code: "9000", kind: "internal" },
} as const satisfies Record<string, AccountRef>;

export const ACCOUNT_LIST: readonly AccountRef[] = Object.values(ACCOUNTS);
export const ACCOUNT_MAP: ReadonlyMap<string, AccountRef> = new Map(
  ACCOUNT_LIST.map((account) => [account.id, account]),
);
export const NON_INTERNAL_ACCOUNTS: readonly AccountRef[] = ACCOUNT_LIST.filter(
  (account) => account.kind !== "internal",
);

export const SEGMENTS = ["seg_platform", "seg_kamakura", "seg_contract", "seg_corporate"] as const;

/** The first fiscal year of the fictional company in the seed. */
export const FISCAL_YEAR: FiscalYearContext = {
  startDate: "2026-11-02",
  endDate: "2027-03-31",
  lockedThrough: null,
  status: "open",
  consumptionTax: "exempt",
  accountingMethod: "tax_inclusive",
};

export function context(overrides: Partial<FiscalYearContext> = {}): ValidationContext {
  return { fiscalYear: { ...FISCAL_YEAR, ...overrides }, accounts: ACCOUNT_MAP };
}

export function line(
  side: JournalLineInput["side"],
  account: AccountRef,
  amount: bigint,
  overrides: Partial<JournalLineInput> = {},
): JournalLineInput {
  return {
    side,
    accountId: account.id,
    amount,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: "seg_corporate",
    ...overrides,
  };
}

export function entry(
  lines: JournalLineInput[],
  overrides: Partial<JournalEntryInput> = {},
): JournalEntryInput {
  return {
    entryDate: "2026-11-10",
    description: "テスト仕訳",
    kind: "normal",
    sourceKind: "manual",
    lines,
    ...overrides,
  };
}

export const amountArb = fc.bigInt({ min: 1n, max: 50_000_000n });
export const segmentArb = fc.constantFrom(...SEGMENTS);

export function dateArb(from: CalendarDate, to: CalendarDate): fc.Arbitrary<CalendarDate> {
  return fc.integer({ min: 0, max: daysBetween(from, to) }).map((offset) => addDays(from, offset));
}

/**
 * Random entries that follow the rules: every entry is a set of (debit, credit) pairs of equal
 * amount, plus optional internal pairs between two segments, so debits = credits and internal = 0.
 */
export function validEntryArb(
  dates: fc.Arbitrary<CalendarDate> = dateArb(FISCAL_YEAR.startDate, FISCAL_YEAR.endDate),
): fc.Arbitrary<JournalEntryInput> {
  const transferArb = fc.record({
    debit: fc.constantFrom(...NON_INTERNAL_ACCOUNTS),
    credit: fc.constantFrom(...NON_INTERNAL_ACCOUNTS),
    amount: amountArb,
    debitSegment: segmentArb,
    creditSegment: segmentArb,
  });
  const internalArb = fc.record({ amount: amountArb, from: segmentArb, to: segmentArb });
  return fc
    .record({
      entryDate: dates,
      transfers: fc.array(transferArb, { minLength: 1, maxLength: 4 }),
      internals: fc.array(internalArb, { maxLength: 2 }),
    })
    .map(({ entryDate, transfers, internals }) => {
      const lines: JournalLineInput[] = [];
      for (const transfer of transfers) {
        lines.push(
          line("debit", transfer.debit, transfer.amount, { segmentId: transfer.debitSegment }),
        );
        lines.push(
          line("credit", transfer.credit, transfer.amount, { segmentId: transfer.creditSegment }),
        );
      }
      for (const pair of internals) {
        lines.push(line("debit", ACCOUNTS.internal, pair.amount, { segmentId: pair.from }));
        lines.push(line("credit", ACCOUNTS.internal, pair.amount, { segmentId: pair.to }));
      }
      return entry(lines, { entryDate });
    });
}
