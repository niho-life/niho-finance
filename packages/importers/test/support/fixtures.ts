import { readFileSync } from "node:fs";
import type { GenericCsvConfig, ParsedStatement } from "../../src/types";
import type { StripeBalanceTransaction } from "../../src/stripe/types";

function fixtureUrl(path: string): URL {
  return new URL(`../fixtures/${path}`, import.meta.url);
}

/** The bytes of a fixture file under `test/fixtures`. */
export function fixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(fixtureUrl(path)));
}

export function fixtureJson(path: string): unknown {
  return JSON.parse(readFileSync(fixtureUrl(path), "utf8")) as unknown;
}

export function stripeFixture(name: "platform" | "kamakura"): StripeBalanceTransaction[] {
  return fixtureJson(`stripe/${name}.json`) as StripeBalanceTransaction[];
}

/**
 * A statement as JSON for the golden files: `bigint` → decimal string, `Date` → ISO string.
 * Nothing else is transformed, so any change in the parsed output changes this value.
 */
export function serializeStatement(statement: ParsedStatement): unknown {
  return JSON.parse(
    JSON.stringify(statement, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as unknown;
}

/** The generic fixtures' column mappings (as the screen would save them). */
export const GENERIC_SIGNED_CONFIG: GenericCsvConfig = {
  headerRows: 1,
  columns: { date: 0, description: 1, amount: 2, balance: 3, counterparty: 4 },
};

export const GENERIC_SPLIT_CONFIG: GenericCsvConfig = {
  headerRows: 1,
  columns: { date: 0, description: 1, withdrawal: 2, deposit: 3, balance: 4 },
  order: "auto",
};

export const GENERIC_BROKEN_CONFIG: GenericCsvConfig = {
  headerRows: 1,
  columns: { date: 0, description: 1, amount: 2, balance: 3 },
};

export interface GoldenCase {
  file: string;
  expected: string;
  format: ParsedStatement["format"];
  config: GenericCsvConfig | null;
  encoding: "utf-8" | "shift_jis";
  detected: ParsedStatement["format"] | null;
}

/** Every golden fixture with its expected output (`test/fixtures/<format>/*.json`). */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    file: "gmo_aozora_zengin/sample.csv",
    expected: "gmo_aozora_zengin/expected.json",
    format: "gmo_aozora_zengin",
    config: null,
    encoding: "utf-8",
    detected: "gmo_aozora_zengin",
  },
  {
    file: "docomo_smtb/sample.csv",
    expected: "docomo_smtb/expected.json",
    format: "docomo_smtb",
    config: null,
    encoding: "shift_jis",
    detected: "docomo_smtb",
  },
  {
    file: "rakuten_card/sample.csv",
    expected: "rakuten_card/expected.json",
    format: "rakuten_card",
    config: null,
    encoding: "utf-8",
    detected: "rakuten_card",
  },
  {
    file: "generic/sample.csv",
    expected: "generic/expected.json",
    format: "generic",
    config: GENERIC_SIGNED_CONFIG,
    encoding: "utf-8",
    detected: null,
  },
  {
    file: "generic/generic-split.csv",
    expected: "generic/generic-split.expected.json",
    format: "generic",
    config: GENERIC_SPLIT_CONFIG,
    encoding: "utf-8",
    detected: null,
  },
];
