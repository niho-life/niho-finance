/**
 * The 7 invariants of docs/design/02-accounting-rules.md §6.
 * Property tests generate arbitrary entry sequences with fast-check.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertSequence,
  assertTrialBalanceIdentity,
  assertValidEntry,
  buildReversal,
  computeBalances,
  inclusiveTaxAmount,
  LedgerInvariantError,
  LedgerValidationError,
  nextEntryNo,
  sumByRateWithSingleRounding,
  trialBalance,
  validateEntry,
  type CalendarDate,
  type JournalLineInput,
} from "../src";
import {
  ACCOUNT_LIST,
  ACCOUNTS,
  amountArb,
  context,
  dateArb,
  entry,
  FISCAL_YEAR,
  line,
  NON_INTERNAL_ACCOUNTS,
  segmentArb,
  validEntryArb,
} from "./fixtures";

const RUNS = { numRuns: 300 };

describe("invariant 1: debits equal credits", () => {
  it("validateEntry reports UNBALANCED exactly when the debit and credit totals differ", () => {
    const lineArb = fc.record({
      side: fc.constantFrom("debit" as const, "credit" as const),
      account: fc.constantFrom(...NON_INTERNAL_ACCOUNTS),
      amount: amountArb,
    });
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 2, maxLength: 8 }), (raw) => {
        const lines = raw.map((l) => line(l.side, l.account, l.amount));
        const debit = raw.filter((l) => l.side === "debit").reduce((t, l) => t + l.amount, 0n);
        const credit = raw.filter((l) => l.side === "credit").reduce((t, l) => t + l.amount, 0n);
        const result = validateEntry(entry(lines), context());
        const unbalanced = !result.ok && result.errors.some((e) => e.code === "UNBALANCED");
        expect(unbalanced).toBe(debit !== credit);
      }),
      RUNS,
    );
  });

  it("over any sequence of valid entries, total debits equal total credits", () => {
    fc.assert(
      fc.property(fc.array(validEntryArb(), { maxLength: 30 }), (entries) => {
        for (const e of entries) expect(validateEntry(e, context())).toEqual({ ok: true });
        const rows = computeBalances(entries, { groupBy: "account" });
        const debit = rows.reduce((t, r) => t + r.debit, 0n);
        const credit = rows.reduce((t, r) => t + r.credit, 0n);
        expect(debit).toBe(credit);
        expect(rows.reduce((t, r) => t + r.net, 0n)).toBe(0n);
      }),
      RUNS,
    );
  });

  it("rejects an entry when one amount is changed", () => {
    fc.assert(
      fc.property(validEntryArb(), fc.nat(), amountArb, (valid, index, delta) => {
        const target = index % valid.lines.length;
        const lines = valid.lines.map((l, i) =>
          i === target ? { ...l, amount: l.amount + delta } : l,
        );
        const result = validateEntry({ ...valid, lines }, context());
        expect(result.ok).toBe(false);
        expect(!result.ok && result.errors.map((e) => e.code)).toContain("UNBALANCED");
      }),
      RUNS,
    );
  });
});

describe("invariant 2: internal accounts always net to 0", () => {
  it("the internal balance of any sequence of valid entries is 0", () => {
    fc.assert(
      fc.property(fc.array(validEntryArb(), { maxLength: 30 }), (entries) => {
        const rows = computeBalances(entries, { groupBy: "account" });
        const internal = rows.find((r) => r.accountId === ACCOUNTS.internal.id);
        expect(internal?.net ?? 0n).toBe(0n);
        const tb = trialBalance(entries, ACCOUNT_LIST, FISCAL_YEAR);
        expect(tb.totals.internal).toBe(0n);
      }),
      RUNS,
    );
  });

  it("rejects an entry whose internal debit and credit differ, even if the entry balances", () => {
    fc.assert(
      fc.property(amountArb, segmentArb, (amount, segmentId) => {
        const lines = [
          line("debit", ACCOUNTS.internal, amount, { segmentId }),
          line("credit", ACCOUNTS.bank, amount),
        ];
        const result = validateEntry(entry(lines), context());
        expect(!result.ok && result.errors.map((e) => e.code)).toEqual(["INTERNAL_UNBALANCED"]);
      }),
      RUNS,
    );
  });

  it("assertTrialBalanceIdentity throws when internal accounts do not net to 0", () => {
    const tb = trialBalance(
      [entry([line("debit", ACCOUNTS.internal, 100n), line("credit", ACCOUNTS.bank, 100n)])],
      ACCOUNT_LIST,
      FISCAL_YEAR,
    );
    expect(() => assertTrialBalanceIdentity(tb)).toThrow(LedgerInvariantError);
    expect(() => assertTrialBalanceIdentity(tb)).toThrow(/INTERNAL_NONZERO/);
  });
});

describe("invariant 3: nothing can be posted or voided on or before the close", () => {
  const lockedArb = dateArb(FISCAL_YEAR.startDate, FISCAL_YEAR.endDate);

  it("posting throws exactly when the entry date is on or before lockedThrough", () => {
    fc.assert(
      fc.property(validEntryArb(), lockedArb, (valid, lockedThrough) => {
        const ctx = context({ lockedThrough });
        const post = () => assertValidEntry(valid, ctx);
        if (valid.entryDate <= lockedThrough) {
          expect(post).toThrow(LedgerValidationError);
          expect(post).toThrow(/PERIOD_LOCKED/);
        } else {
          expect(post).not.toThrow();
        }
      }),
      RUNS,
    );
  });

  it("voiding throws when the reversal is dated on or before lockedThrough", () => {
    fc.assert(
      fc.property(validEntryArb(), lockedArb, (valid, lockedThrough) => {
        const original = { ...valid, id: "je_1", no: 1, status: "posted" as const };
        const reversal = buildReversal(original, { date: original.entryDate, reason: "誤入力" });
        const ctx = context({ lockedThrough });
        if (reversal.entryDate <= lockedThrough) {
          expect(() => assertValidEntry(reversal, ctx)).toThrow(/PERIOD_LOCKED/);
        } else {
          expect(() => assertValidEntry(reversal, ctx)).not.toThrow();
        }
      }),
      RUNS,
    );
  });

  it("a closed fiscal year rejects everything; a closing one only accepts adjusting and closing entries", () => {
    const valid = entry([
      line("debit", ACCOUNTS.bank, 100n),
      line("credit", ACCOUNTS.capital, 100n),
    ]);
    expect(() => assertValidEntry(valid, context({ status: "closed" }))).toThrow(
      /FISCAL_YEAR_CLOSED/,
    );
    expect(() =>
      assertValidEntry({ ...valid, kind: "adjusting" }, context({ status: "closed" })),
    ).toThrow(/FISCAL_YEAR_CLOSED/);
    expect(() => assertValidEntry(valid, context({ status: "closing" }))).toThrow(
      /FISCAL_YEAR_CLOSING/,
    );
    expect(() =>
      assertValidEntry({ ...valid, kind: "adjusting" }, context({ status: "closing" })),
    ).not.toThrow();
    expect(() =>
      assertValidEntry({ ...valid, kind: "closing" }, context({ status: "closing" })),
    ).not.toThrow();
  });
});

describe("invariant 4: an entry and its reversal sum to 0", () => {
  it("every account, sub-account and segment nets to 0 after a void", () => {
    fc.assert(
      fc.property(validEntryArb(), (valid) => {
        const original = { ...valid, id: "je_1", no: 7, status: "posted" as const };
        const reversal = buildReversal(original, { date: valid.entryDate, reason: "金額の誤り" });
        expect(validateEntry(reversal, context())).toEqual({ ok: true });
        for (const groupBy of ["account", "subAccount", "segment"] as const) {
          for (const row of computeBalances([original, reversal], { groupBy })) {
            expect(row.net).toBe(0n);
            expect(row.debit).toBe(row.credit);
          }
        }
      }),
      RUNS,
    );
  });
});

describe("invariant 5: entry numbers increase from 1 without gaps", () => {
  it("numbers assigned by nextEntryNo form 1..n in any order", () => {
    const assignedArb = fc.integer({ min: 1, max: 300 }).chain((count) => {
      const numbers: number[] = [];
      let last = 0;
      for (let i = 0; i < count; i += 1) {
        last = nextEntryNo(last);
        numbers.push(last);
      }
      return fc.shuffledSubarray(numbers, { minLength: count, maxLength: count });
    });
    fc.assert(
      fc.property(assignedArb, (numbers) => {
        expect(Math.min(...numbers)).toBe(1);
        expect(() => assertSequence(numbers.map((no) => ({ no })))).not.toThrow();
      }),
      RUNS,
    );
  });

  it("a missing number or a duplicate is detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 300 }), fc.nat(), (count, pick) => {
        const numbers = Array.from({ length: count }, (_, i) => i + 1);
        const gapIndex = pick % (count - 1); // never the last one: 1..n-1 is still a valid sequence
        const withGap = numbers.filter((_, i) => i !== gapIndex);
        expect(() => assertSequence(withGap.map((no) => ({ no })))).toThrow(/SEQUENCE_(GAP|START)/);
        const duplicated = [...numbers, numbers[pick % count] ?? 1];
        expect(() => assertSequence(duplicated.map((no) => ({ no })))).toThrow(
          /SEQUENCE_DUPLICATE/,
        );
      }),
      RUNS,
    );
  });

  it("a void consumes the next number (the reversal is a new entry)", () => {
    const original = { no: nextEntryNo(0) };
    const reversal = { no: nextEntryNo(original.no) };
    const next = { no: nextEntryNo(reversal.no) };
    expect([original.no, reversal.no, next.no]).toEqual([1, 2, 3]);
    expect(() => assertSequence([original, reversal, next])).not.toThrow();
  });
});

describe("invariant 6: tax-inclusive invoices are off by less than 1 yen per rate", () => {
  const taxableLineArb = fc.record({ amount: amountArb, ratePercent: fc.constantFrom(10, 8) });

  it("the single-rounded tax per rate is the exact tax truncated (error < 1 yen)", () => {
    fc.assert(
      fc.property(fc.array(taxableLineArb, { minLength: 1, maxLength: 30 }), (lines) => {
        const summaries = sumByRateWithSingleRounding(lines);
        for (const summary of summaries) {
          const rate = BigInt(summary.ratePercent);
          const total = lines
            .filter((l) => l.ratePercent === summary.ratePercent)
            .reduce((t, l) => t + l.amount, 0n);
          expect(summary.amount).toBe(total);
          // exact tax = total × rate / (100 + rate); tax ≤ exact < tax + 1
          expect(summary.taxAmount * (100n + rate) <= total * rate).toBe(true);
          expect(total * rate < (summary.taxAmount + 1n) * (100n + rate)).toBe(true);
          expect(summary.amountExclusive + summary.taxAmount).toBe(summary.amountInclusive);
          // rounding per line would drift by up to (lines − 1) yen; the single rounding never does
          const perLine = lines
            .filter((l) => l.ratePercent === summary.ratePercent)
            .reduce((t, l) => t + inclusiveTaxAmount(l.amount, l.ratePercent), 0n);
          expect(summary.taxAmount >= perLine).toBe(true);
          expect(summary.taxAmount - perLine < BigInt(summary.lineCount)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("the same holds for tax-exclusive amounts", () => {
    fc.assert(
      fc.property(fc.array(taxableLineArb, { minLength: 1, maxLength: 30 }), (lines) => {
        for (const summary of sumByRateWithSingleRounding(lines, {
          amountsInclude: "tax_exclusive",
        })) {
          const rate = BigInt(summary.ratePercent);
          expect(summary.taxAmount * 100n <= summary.amount * rate).toBe(true);
          expect(summary.amount * rate < (summary.taxAmount + 1n) * 100n).toBe(true);
          expect(summary.amountInclusive).toBe(summary.amount + summary.taxAmount);
        }
      }),
      RUNS,
    );
  });
});

describe("invariant 7: assets = liabilities + net assets + net income", () => {
  it("holds for any sequence of valid entries, any as-of date and earlier unclosed years", () => {
    // Entries span the previous year too, so opening balances come from earlier entries.
    const previousYearStart: CalendarDate = "2025-11-02";
    const ctx = context({ startDate: previousYearStart });
    fc.assert(
      fc.property(
        fc.array(validEntryArb(dateArb(previousYearStart, FISCAL_YEAR.endDate)), { maxLength: 40 }),
        dateArb(FISCAL_YEAR.startDate, FISCAL_YEAR.endDate),
        (entries, asOf) => {
          for (const e of entries) expect(validateEntry(e, ctx)).toEqual({ ok: true });
          const tb = trialBalance(entries, ACCOUNT_LIST, FISCAL_YEAR, { asOf });
          expect(() => assertTrialBalanceIdentity(tb)).not.toThrow();
          const { totals } = tb;
          expect(totals.assets).toBe(totals.liabilities + totals.equity + totals.netIncome);
          expect(totals.debit).toBe(totals.credit);
        },
      ),
      RUNS,
    );
  });

  it("detects a broken ledger (an unbalanced entry slipped in)", () => {
    const broken: JournalLineInput[] = [
      line("debit", ACCOUNTS.bank, 1_000n),
      line("credit", ACCOUNTS.sales, 900n),
    ];
    const tb = trialBalance([entry(broken)], ACCOUNT_LIST, FISCAL_YEAR);
    expect(() => assertTrialBalanceIdentity(tb)).toThrow(/TRIAL_BALANCE_UNBALANCED/);
  });
});
