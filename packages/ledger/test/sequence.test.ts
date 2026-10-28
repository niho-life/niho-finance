import { describe, expect, it } from "vitest";
import { assertSequence, FIRST_ENTRY_NO, nextEntryNo } from "../src";

describe("entry numbering", () => {
  it("starts at 1 and adds 1", () => {
    expect(FIRST_ENTRY_NO).toBe(1);
    expect(nextEntryNo(0)).toBe(1);
    expect(nextEntryNo(41)).toBe(42);
    expect(() => nextEntryNo(-1)).toThrow(/INVALID_SEQUENCE_NUMBER/);
    expect(() => nextEntryNo(1.5)).toThrow(/INVALID_SEQUENCE_NUMBER/);
  });

  it("assertSequence explains what is wrong", () => {
    expect(() => assertSequence([])).not.toThrow();
    expect(() => assertSequence([{ no: 2 }, { no: 1 }, { no: 3 }])).not.toThrow();
    expect(() => assertSequence([{ no: 2 }, { no: 3 }])).toThrow(/SEQUENCE_START/);
    expect(() => assertSequence([{ no: 1 }, { no: 3 }])).toThrow(
      /SEQUENCE_GAP: entry number 2 is missing/,
    );
    expect(() => assertSequence([{ no: 1 }, { no: 2 }, { no: 2 }])).toThrow(/SEQUENCE_DUPLICATE/);
    expect(() => assertSequence([{ no: 0 }])).toThrow(/INVALID_SEQUENCE_NUMBER/);
  });
});
