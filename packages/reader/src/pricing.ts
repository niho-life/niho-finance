import type { ReaderModel } from "./config";
import type { ProviderUsage, ReaderProvider } from "./provider";

/**
 * Prices per token in 10⁻⁹ USD (20-reader §9), so that costs stay integers. When a price changes,
 * change this table; usage rows already recorded keep the cost of their time.
 */
export interface TokenPrice {
  input: bigint;
  output: bigint;
}

export const READER_PRICES: Readonly<Record<ReaderModel | "recorded", TokenPrice>> = {
  // $0.10 / $0.50 per million tokens.
  "claude-haiku-5-5": { input: 100n, output: 500n },
  // $2 / $10 per million tokens.
  "claude-sonnet-5-5": { input: 2_000n, output: 10_000n },
  // Recorded answers cost nothing.
  recorded: { input: 0n, output: 0n },
};

/** Tokens a document is estimated to take, for the confirmation of a batch reading. */
export const ESTIMATED_TOKENS_PER_DOCUMENT: ProviderUsage = {
  inputTokens: 2_000,
  outputTokens: 1_000,
};

function tokens(count: number): bigint {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`token count ${String(count)} is not a non-negative integer`);
  }
  return BigInt(count);
}

/** Cost of one call in 10⁻⁹ USD. Throws for a model without a price. */
export function costNanoUsd(model: string, usage: ProviderUsage): bigint {
  const price = (READER_PRICES as Readonly<Record<string, TokenPrice | undefined>>)[model];
  if (!price) throw new RangeError(`no price for the reader model "${model}"`);
  return tokens(usage.inputTokens) * price.input + tokens(usage.outputTokens) * price.output;
}

/** Cost of a call made by `provider`: recorded answers are free whatever model recorded them. */
export function readingCostNanoUsd(
  provider: Pick<ReaderProvider, "provider" | "model">,
  usage: ProviderUsage,
): bigint {
  return costNanoUsd(provider.provider === "recorded" ? "recorded" : provider.model, usage);
}

export function estimatedCostPerDocumentNanoUsd(model: ReaderModel): bigint {
  return costNanoUsd(model, ESTIMATED_TOKENS_PER_DOCUMENT);
}

const NANO_PER_UNIT = 100_000n; // 10⁻⁴ USD, the last digit shown

/** `700000n` → `"$0.0007"`: four decimals, rounded half up, in integer arithmetic. */
export function formatUsd(nano: bigint): string {
  const negative = nano < 0n;
  const magnitude = negative ? -nano : nano;
  const units = (magnitude + NANO_PER_UNIT / 2n) / NANO_PER_UNIT;
  const dollars = units / 10_000n;
  const decimals = (units % 10_000n).toString().padStart(4, "0");
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative && units > 0n ? "-" : ""}$${grouped}.${decimals}`;
}
