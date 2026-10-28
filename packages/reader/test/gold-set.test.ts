import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isValidInvoiceRegistrationNumber, sum } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import { defaultRecordingsPath } from "../src/config";
import {
  evaluateGoldSet,
  GOLD_SET_DIR,
  GOLD_SET_TODAY,
  loadGoldSet,
  summarizeGoldSet,
} from "../src/gold-set";
import { createRecordedReader, loadRecordingFile } from "../src/recorded";
import { validateReading } from "../src/validate";

const entries = loadGoldSet();
const recordings = loadRecordingFile(defaultRecordingsPath());

describe("the gold set (20-reader §12)", () => {
  it("has seven images and three PDFs, each small", () => {
    expect(entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `r${String(index + 1).padStart(2, "0")}`),
    );
    expect(entries.filter((entry) => entry.mime.startsWith("image/"))).toHaveLength(7);
    expect(entries.filter((entry) => entry.mime === "application/pdf")).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.bytes.byteLength).toBeLessThanOrEqual(200 * 1024);
    }
    const files = readdirSync(GOLD_SET_DIR).filter((file) => /^r\d{2}\./.test(file));
    expect(files.sort()).toEqual(entries.map((entry) => entry.file));
    expect(statSync(join(GOLD_SET_DIR, "expected.json")).isFile()).toBe(true);
  });

  it("expects fictional, consistent readings", () => {
    const numbers = entries.flatMap((entry) => entry.expected.registrationNumber ?? []);
    expect(numbers).toHaveLength(9);
    expect(new Set(numbers).size).toBe(9);
    for (const number of numbers) {
      expect(isValidInvoiceRegistrationNumber(number)).toBe(true);
      expect(number.slice(2, 12)).toBe("9999999999");
    }
    for (const { id, expected } of entries) {
      expect(expected.issuerName, id).toMatch(/^架空/);
      expect(
        expected.transactionDate! >= "2026-10-01" && expected.transactionDate! <= "2026-10-27",
      ).toBe(true);
      expect(sum(expected.rates.map((rate) => rate.inclusiveAmount)), id).toBe(
        expected.totalAmount,
      );
      expect(validateReading(expected, { today: GOLD_SET_TODAY }), id).toEqual([]);
    }
    const mixed = entries.filter(({ expected }) => {
      const rates = new Set(expected.rates.map((rate) => rate.ratePercent));
      return rates.has(8) && rates.has(10);
    });
    expect(mixed.length).toBeGreaterThanOrEqual(2);
    const exclusiveInvoices = entries.filter(
      ({ mime, expected }) =>
        mime === "application/pdf" && expected.rates.every((rate) => !rate.taxIncluded),
    );
    expect(exclusiveInvoices.length).toBeGreaterThanOrEqual(2);
  });

  it("has a recorded answer for every fixture", () => {
    expect(Object.keys(recordings.responses).sort()).toEqual(
      entries.map((entry) => entry.sha256).sort(),
    );
    for (const entry of entries) {
      expect(recordings.responses[entry.sha256]?.fixture).toBe(entry.id);
    }
  });

  it("reads 8 or more fixtures right, and warns about every one it reads wrong", async () => {
    const results = await evaluateGoldSet(createRecordedReader({ recordings }), entries);
    const summary = summarizeGoldSet(results);

    expect(summary.matched).toBeGreaterThanOrEqual(8);
    expect(summary.failed).toBe(0);
    const mismatches = results.filter((result) => !result.comparison?.all);
    for (const result of mismatches) {
      expect(result.issues.length, result.id).toBeGreaterThan(0);
    }
    expect(summary.passed).toBe(true);

    // The synthetic recording: r05 misreads the total, r07 the 8% line.
    if (recordings.model === "synthetic") {
      const byId = new Map(results.map((result) => [result.id, result]));
      expect(mismatches.map((result) => result.id)).toEqual(["r05", "r07"]);
      expect(byId.get("r05")?.comparison).toMatchObject({ total: false, rates: true });
      expect(byId.get("r05")?.issues.map((issue) => issue.code)).toEqual(["rates_sum"]);
      expect(byId.get("r07")?.comparison).toMatchObject({ total: true, rates: false });
      expect(byId.get("r07")?.issues.map((issue) => issue.code)).toEqual(["rates_sum", "rate_tax"]);
      // r03's number is printed with hyphens and normalized.
      expect(byId.get("r03")?.comparison?.registrationNumber).toBe(true);
    }
  });
});
