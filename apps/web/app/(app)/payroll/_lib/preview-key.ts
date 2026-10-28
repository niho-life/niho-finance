import { parseYenInput } from "@niho-finance/ledger";

/**
 * The amount a field means, for telling whether a preview still matches the form: `300000` and
 * `300,000` (the field reformats itself on blur) are the same request. Unreadable text stays as typed.
 */
export function amountKey(text: string): string {
  const amount = parseYenInput(text, { allowNegative: true });
  return amount === null ? text.trim() : String(amount);
}
