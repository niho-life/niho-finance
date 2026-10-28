import type { OpeningPreview } from "@niho-finance/db";
import { formatYen } from "@niho-finance/ledger";

/** One row of the opening entries table (Step 5): an entry with its debit and credit side. */
export interface OpeningEntryView {
  key: string;
  no: number | null;
  date: string;
  description: string;
  debit: { account: string; sub: string | null }[];
  credit: { account: string; sub: string | null }[];
  amount: string;
}

/** Serializable (amounts as text) for client components. */
export interface OpeningPreviewView {
  entries: OpeningEntryView[];
  debitTotal: string;
  creditTotal: string;
}

export function toOpeningPreviewView(preview: OpeningPreview): OpeningPreviewView {
  return {
    entries: preview.entries.map((entry, index) => {
      const debit = entry.lines.filter((line) => line.side === "debit");
      const amount = debit.reduce((total, line) => total + line.amount, 0n);
      const side = (lines: typeof entry.lines) =>
        lines.map((line) => ({ account: line.accountName, sub: line.subAccountName }));
      return {
        key: `${entry.no ?? "new"}-${index}`,
        no: entry.no,
        date: entry.entryDate,
        description: entry.description,
        debit: side(debit),
        credit: side(entry.lines.filter((line) => line.side === "credit")),
        amount: formatYen(amount),
      };
    }),
    debitTotal: formatYen(preview.debitTotal),
    creditTotal: formatYen(preview.creditTotal),
  };
}
