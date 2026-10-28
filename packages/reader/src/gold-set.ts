import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalendarDate } from "@niho-finance/ledger";
import { z } from "zod";
import { compareWithExpected, type ReadingComparison } from "./match";
import {
  isReadableMime,
  ReaderError,
  type ProviderUsage,
  type ReadableMime,
  type ReaderErrorCode,
  type ReaderProvider,
} from "./provider";
import { parseReading, type Reading } from "./reading";
import { validateReading, type ReadingIssue } from "./validate";

/**
 * The gold set (20-reader §12): ten fictional receipts and invoices under `fixtures/receipts`
 * with their expected readings. Used by the tests and by `npm run eval` / `npm run record`; not
 * part of the package's public API.
 */

export const GOLD_SET_DIR = fileURLToPath(new URL("../fixtures/receipts/", import.meta.url));

/** "Today" for validating the gold set, so that its dates never become future or old. */
export const GOLD_SET_TODAY: CalendarDate = "2026-10-31";

export interface GoldSetEntry {
  id: string;
  file: string;
  mime: ReadableMime;
  bytes: Uint8Array;
  sha256: string;
  expected: Reading;
}

const expectedFileSchema = z.record(
  z.string(),
  z.object({ file: z.string(), mime: z.string(), reading: z.unknown() }),
);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The fixtures in id order, with their bytes and expected readings (`expected.json`). */
export function loadGoldSet(dir: string = GOLD_SET_DIR): GoldSetEntry[] {
  const expected = expectedFileSchema.parse(
    JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as unknown,
  );
  return Object.entries(expected)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => {
      if (!isReadableMime(entry.mime)) throw new Error(`${id}: ${entry.mime} is not readable`);
      const bytes = new Uint8Array(readFileSync(join(dir, entry.file)));
      return {
        id,
        file: entry.file,
        mime: entry.mime,
        bytes,
        sha256: sha256Hex(bytes),
        expected: parseReading(entry.reading),
      };
    });
}

export interface GoldSetResult {
  id: string;
  file: string;
  /** Set when the answer could not be read (the screen shows "読み取れず"). */
  error: { code: ReaderErrorCode; message: string } | null;
  comparison: ReadingComparison | null;
  issues: ReadingIssue[];
  usage: ProviderUsage | null;
}

/** Reads every fixture with `reader`, compares with the expected reading and validates. */
export async function evaluateGoldSet(
  reader: ReaderProvider,
  entries: readonly GoldSetEntry[],
): Promise<GoldSetResult[]> {
  const results: GoldSetResult[] = [];
  for (const entry of entries) {
    const base = { id: entry.id, file: entry.file };
    try {
      const { raw, usage } = await reader.read(entry);
      const reading = parseReading(raw);
      results.push({
        ...base,
        error: null,
        comparison: compareWithExpected(reading, entry.expected),
        issues: validateReading(reading, { today: GOLD_SET_TODAY }),
        usage,
      });
    } catch (error) {
      if (!(error instanceof ReaderError)) throw error;
      results.push({
        ...base,
        error: { code: error.code, message: error.message },
        comparison: null,
        issues: [],
        usage: error.usage,
      });
    }
  }
  return results;
}

export interface GoldSetSummary {
  count: number;
  date: number;
  total: number;
  rates: number;
  registrationNumber: number;
  issuerName: number;
  /** Date, total and breakdown all match. */
  matched: number;
  failed: number;
  /** Mismatches (or failures) the owner is told about: a warning, an error or "読み取れず". */
  flaggedMismatches: number;
  /** At least 8 of 10 match and every mismatch is flagged (20-reader §12). */
  passed: boolean;
}

export const GOLD_SET_REQUIRED_MATCHES = 8;

export function summarizeGoldSet(results: readonly GoldSetResult[]): GoldSetSummary {
  const count = (pick: (comparison: ReadingComparison) => boolean) =>
    results.filter((result) => result.comparison !== null && pick(result.comparison)).length;
  const mismatches = results.filter((result) => !result.comparison?.all);
  const flaggedMismatches = mismatches.filter(
    (result) => result.error !== null || result.issues.length > 0,
  ).length;
  const matched = count((comparison) => comparison.all);
  return {
    count: results.length,
    date: count((comparison) => comparison.date),
    total: count((comparison) => comparison.total),
    rates: count((comparison) => comparison.rates),
    registrationNumber: count((comparison) => comparison.registrationNumber),
    issuerName: count((comparison) => comparison.issuerName),
    matched,
    failed: results.filter((result) => result.error !== null).length,
    flaggedMismatches,
    passed: matched >= GOLD_SET_REQUIRED_MATCHES && flaggedMismatches === mismatches.length,
  };
}
