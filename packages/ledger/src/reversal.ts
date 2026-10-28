import type { CalendarDate } from "./date";
import { LedgerValidationError } from "./errors";
import { oppositeSide, type JournalEntryInput, type RecordedJournalEntry } from "./types";

export type ReversibleEntry = Pick<
  RecordedJournalEntry,
  "id" | "no" | "status" | "kind" | "description" | "sourceKind" | "sourceId" | "lines"
>;

export interface BuildReversalOptions {
  /** Same date as the original, or the first open date when the original's month is closed. */
  date: CalendarDate;
  /** Why the entry is cancelled. Stored on the original entry (`voidReason`). */
  reason: string;
}

export type ReversalInput = JournalEntryInput & { kind: "reversal"; reversalOfId: string };

/**
 * Builds the reversing entry that cancels `entry`: every line with debit and credit swapped.
 * The caller validates it against the fiscal year (`validateEntry`), which rejects closed periods.
 */
export function buildReversal(
  entry: ReversibleEntry,
  options: BuildReversalOptions,
): ReversalInput {
  if (entry.status === "voided") {
    throw new LedgerValidationError([
      { code: "ALREADY_VOIDED", message: `仕訳 No.${entry.no} はすでに取消されています` },
    ]);
  }
  if (entry.kind === "reversal") {
    throw new LedgerValidationError([
      {
        code: "CANNOT_REVERSE_REVERSAL",
        message: "反対仕訳は取消せません。必要なら新しい仕訳を登録してください",
      },
    ]);
  }
  if (options.reason.trim() === "") {
    throw new LedgerValidationError([
      { code: "VOID_REASON_REQUIRED", message: "取消の理由を入力してください" },
    ]);
  }
  return {
    entryDate: options.date,
    description: `取消 No.${entry.no}: ${entry.description}`,
    kind: "reversal",
    sourceKind: entry.sourceKind,
    sourceId: entry.sourceId ?? null,
    reversalOfId: entry.id,
    lines: entry.lines.map((line) => ({
      ...line,
      side: oppositeSide(line.side),
      memoTagIds: [...(line.memoTagIds ?? [])],
    })),
  };
}
