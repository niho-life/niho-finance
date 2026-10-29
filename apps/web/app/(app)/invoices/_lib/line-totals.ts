import type { InvoiceFormOptions } from "@niho-finance/db";
import {
  computeInvoiceTotals,
  LedgerValidationError,
  parseQuantity,
  parseYenInput,
  type CalendarDate,
  type InvoiceLineAmountInput,
  type InvoiceTotals,
  type TaxRateRule,
} from "@niho-finance/ledger";

/**
 * What the forms of a document and of a 定期請求 compute as the owner types (18 §3, §8, §14.5): the
 * same pure functions the server runs on save, so the screen and the stored totals agree. Pure: the
 * forms run them in the browser, the tests in node.
 */

/** A line as the forms hold it (text). */
export interface LineValues {
  quantity: string;
  unitPrice: string;
  taxCategoryCode: string;
}

export interface DraftLineTotals {
  /** Per line: its amount input, or `null` while the quantity or the unit price is not a number. */
  parsed: (InvoiceLineAmountInput | null)[];
  /** The totals of the complete lines; `null` without a date or when a category has no rule. */
  totals: InvoiceTotals | null;
  /** The line index → why its tax category has no rule on the date. */
  ruleProblems: Map<number, string>;
  /** Some line has no quantity or unit price yet (it is left out of the totals). */
  incomplete: boolean;
}

/** The totals of the lines on the date's tax rules (one rounding per rate, 18 §3.2). */
export function draftLineTotals(
  lines: readonly LineValues[],
  options: {
    pricesIncludeTax: boolean;
    date: CalendarDate | null;
    taxRules: readonly TaxRateRule[];
  },
): DraftLineTotals {
  const parsed = lines.map((line): InvoiceLineAmountInput | null => {
    const quantity = parseQuantity(line.quantity);
    const unitPrice = parseYenInput(line.unitPrice, { allowNegative: true });
    return quantity === null || unitPrice === null
      ? null
      : { quantity, unitPrice, taxCategoryCode: line.taxCategoryCode };
  });
  const complete = parsed.flatMap((input, index) => (input ? [{ input, index }] : []));
  const ruleProblems = new Map<number, string>();
  let totals: InvoiceTotals | null = null;
  if (options.date) {
    try {
      totals = computeInvoiceTotals(
        complete.map((item) => item.input),
        {
          pricesIncludeTax: options.pricesIncludeTax,
          issueDate: options.date,
          taxRules: options.taxRules,
        },
      );
    } catch (caught) {
      if (!(caught instanceof LedgerValidationError)) throw caught;
      for (const item of caught.errors) {
        const line = item.lineIndex === undefined ? undefined : complete[item.lineIndex];
        if (line) ruleProblems.set(line.index, item.message);
      }
    }
  }
  return { parsed, totals, ruleProblems, incomplete: complete.length < lines.length };
}

/** 18 §8: the partner's revenue account when it is an active one, else 4040. */
export function defaultRevenueAccountId(options: InvoiceFormOptions, partnerId: string): string {
  const preferred = options.partners.find((partner) => partner.id === partnerId)?.defaultAccountId;
  const account = preferred
    ? options.revenueAccounts.find((item) => item.id === preferred)
    : undefined;
  return account?.isActive ? account.id : (options.defaults.revenueAccountId ?? "");
}

/** 18 §8: the account's segment, else the partner's, else 受託 (active ones only). */
export function defaultSegmentId(
  options: InvoiceFormOptions,
  accountId: string,
  partnerId: string,
): string {
  const active = new Set(
    options.segments.filter((segment) => segment.isActive).map((segment) => segment.id),
  );
  for (const segmentId of [
    options.revenueAccounts.find((account) => account.id === accountId)?.defaultSegmentId,
    options.partners.find((partner) => partner.id === partnerId)?.defaultSegmentId,
  ]) {
    if (segmentId && active.has(segmentId)) return segmentId;
  }
  return options.defaults.segmentId ?? "";
}
