import { describe, expect, it } from "vitest";
import { buildReversal, LedgerValidationError, type RecordedJournalEntry } from "../src";
import { ACCOUNTS, entry, line } from "./fixtures";

const original: RecordedJournalEntry = {
  ...entry(
    [
      line("debit", ACCOUNTS.fees, 1_650n, {
        taxCategoryCode: "purchase_10",
        taxAmount: 150n,
        memoTagIds: ["tag_1"],
      }),
      line("credit", ACCOUNTS.payable, 1_650n, { subAccountId: "sub_card" }),
    ],
    { sourceKind: "wallet_txn", sourceId: "wtx_1", description: "クラウド利用料" },
  ),
  id: "je_1",
  no: 5,
  status: "posted",
};

describe("buildReversal", () => {
  it("swaps debit and credit and links to the original", () => {
    const reversal = buildReversal(original, { date: "2026-12-01", reason: "金額の誤り" });
    expect(reversal).toMatchObject({
      entryDate: "2026-12-01",
      kind: "reversal",
      reversalOfId: "je_1",
      sourceKind: "wallet_txn",
      sourceId: "wtx_1",
      description: "取消 No.5: クラウド利用料",
    });
    expect(
      reversal.lines.map((l) => [
        l.side,
        l.accountId,
        l.amount,
        l.taxAmount,
        l.subAccountId ?? null,
      ]),
    ).toEqual([
      ["credit", ACCOUNTS.fees.id, 1_650n, 150n, null],
      ["debit", ACCOUNTS.payable.id, 1_650n, 0n, "sub_card"],
    ]);
    expect(reversal.lines[0]?.memoTagIds).toEqual(["tag_1"]);
  });

  it("refuses voided entries, reversals and an empty reason", () => {
    const attempt =
      (target: RecordedJournalEntry, reason = "誤り") =>
      () =>
        buildReversal(target, { date: "2026-12-01", reason });
    expect(attempt({ ...original, status: "voided" })).toThrow(/ALREADY_VOIDED/);
    expect(attempt({ ...original, kind: "reversal", reversalOfId: "je_0" })).toThrow(
      /CANNOT_REVERSE_REVERSAL/,
    );
    expect(attempt(original, "  ")).toThrow(LedgerValidationError);
  });
});
