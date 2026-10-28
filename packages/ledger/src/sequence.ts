import { LedgerInvariantError } from "./errors";

/**
 * Entry numbers (`JournalEntry.no`) per fiscal year: start at 1, increase by 1, never skip.
 * A void consumes a number too (the reversal is a new entry); nothing is ever renumbered.
 */
export const FIRST_ENTRY_NO = 1;

/** The number to assign next, given the last assigned number in the fiscal year (0 when none). */
export function nextEntryNo(lastAssigned: number): number {
  if (!Number.isSafeInteger(lastAssigned) || lastAssigned < 0) {
    throw new LedgerInvariantError(
      "INVALID_SEQUENCE_NUMBER",
      `${lastAssigned} is not a valid entry number`,
    );
  }
  return lastAssigned + 1;
}

/** Asserts that the numbers of one fiscal year's entries are exactly 1..n (any order). */
export function assertSequence(entries: Iterable<{ no: number }>): void {
  const numbers = [...entries].map((entry) => entry.no).sort((a, b) => a - b);
  numbers.forEach((no, index) => {
    if (!Number.isSafeInteger(no) || no < FIRST_ENTRY_NO) {
      throw new LedgerInvariantError(
        "INVALID_SEQUENCE_NUMBER",
        `${no} is not a valid entry number`,
      );
    }
    const expected = FIRST_ENTRY_NO + index;
    if (no === expected) return;
    if (index > 0 && no === numbers[index - 1]) {
      throw new LedgerInvariantError(
        "SEQUENCE_DUPLICATE",
        `entry number ${no} is used more than once`,
      );
    }
    if (index === 0) {
      throw new LedgerInvariantError(
        "SEQUENCE_START",
        `entry numbers start at ${no}, expected ${FIRST_ENTRY_NO}`,
      );
    }
    throw new LedgerInvariantError("SEQUENCE_GAP", `entry number ${expected} is missing`);
  });
}
