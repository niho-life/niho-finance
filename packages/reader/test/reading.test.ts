import { describe, expect, it } from "vitest";
import { ReaderError } from "../src/provider";
import {
  fromStoredReading,
  parseReading,
  READING_JSON_SCHEMA,
  toStoredReading,
  type Reading,
} from "../src/reading";

const RAW = {
  documentType: "receipt",
  legible: true,
  issuerName: "架空食堂",
  registrationNumber: "T8999999999901",
  transactionDate: "2026-10-02",
  currency: "JPY",
  totalAmount: 2500,
  rates: [{ ratePercent: 10, amount: 2500, taxIncluded: true, taxAmount: 227 }],
  description: "飲食代",
};

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...structuredClone(RAW), ...overrides };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ReaderError ? error.code : "other";
  }
}

describe("READING_JSON_SCHEMA (20-reader §3)", () => {
  /** Every object schema in the tree. */
  function objects(node: unknown): Record<string, unknown>[] {
    if (Array.isArray(node)) return node.flatMap(objects);
    if (typeof node !== "object" || node === null) return [];
    const record = node as Record<string, unknown>;
    const own = record.type === "object" ? [record] : [];
    return [...own, ...Object.values(record).flatMap(objects)];
  }

  it("closes every object and requires every key", () => {
    const found = objects(READING_JSON_SCHEMA);
    expect(found).toHaveLength(2);
    for (const object of found) {
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required as string[])].sort()).toEqual(
        Object.keys(object.properties as object).sort(),
      );
    }
  });

  it("expresses null as anyOf, the date with format and the rate as an integer enum", () => {
    const { properties } = READING_JSON_SCHEMA;
    expect(properties.issuerName.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(properties.transactionDate.anyOf).toEqual([
      { type: "string", format: "date" },
      { type: "null" },
    ]);
    expect(properties.totalAmount.anyOf).toEqual([{ type: "integer" }, { type: "null" }]);
    expect(properties.rates.items.properties.ratePercent).toMatchObject({
      type: "integer",
      enum: [10, 8, 0],
    });
    expect(JSON.stringify(READING_JSON_SCHEMA)).not.toMatch(/minimum|maximum|maxLength|minLength/);
  });
});

describe("parseReading (20-reader §3)", () => {
  it("turns amounts into bigint and adds the tax-inclusive amount", () => {
    expect(parseReading(raw())).toEqual({
      documentType: "receipt",
      legible: true,
      issuerName: "架空食堂",
      registrationNumber: "T8999999999901",
      registrationNumberAsPrinted: "T8999999999901",
      transactionDate: "2026-10-02",
      transactionDateAsPrinted: "2026-10-02",
      currency: "JPY",
      totalAmount: 2500n,
      rates: [
        {
          ratePercent: 10,
          amount: 2500n,
          taxIncluded: true,
          taxAmount: 227n,
          inclusiveAmount: 2500n,
        },
      ],
      description: "飲食代",
    } satisfies Reading);
  });

  it("computes the inclusive amount of tax-exclusive lines with or without the printed tax", () => {
    const reading = parseReading(
      raw({
        rates: [
          { ratePercent: 10, amount: 12000, taxIncluded: false, taxAmount: 1200 },
          { ratePercent: 8, amount: 999, taxIncluded: false, taxAmount: null },
          { ratePercent: 0, amount: 500, taxIncluded: false, taxAmount: null },
        ],
      }),
    );
    expect(reading.rates.map((rate) => rate.inclusiveAmount)).toEqual([13200n, 1078n, 500n]);
  });

  it("normalizes the registration number and keeps it as printed", () => {
    const hyphenated = parseReading(raw({ registrationNumber: " T6-9999-9999-9903 " }));
    expect(hyphenated.registrationNumber).toBe("T6999999999903");
    expect(hyphenated.registrationNumberAsPrinted).toBe("T6-9999-9999-9903");
    expect(
      parseReading(raw({ registrationNumber: "Ｔ８９９９ ９９９９ ９９９０１" }))
        .registrationNumber,
    ).toBe("T8999999999901");
    expect(parseReading(raw({ registrationNumber: "   " })).registrationNumber).toBeNull();
    // A malformed number is kept for the validation to flag.
    expect(parseReading(raw({ registrationNumber: "T12345" })).registrationNumber).toBe("T12345");
  });

  it("trims and cuts the issuer name to 200 and the description to 60 characters", () => {
    const reading = parseReading(
      raw({ issuerName: `  ${"架".repeat(250)}  `, description: `${"𠮷".repeat(70)}` }),
    );
    expect(Array.from(reading.issuerName ?? "")).toHaveLength(200);
    expect(Array.from(reading.description ?? "")).toHaveLength(60);
    expect(reading.description).toBe("𠮷".repeat(60));
    expect(parseReading(raw({ issuerName: " ", description: "" }))).toMatchObject({
      issuerName: null,
      description: null,
    });
  });

  it("drops a date that is not a calendar date but keeps the string", () => {
    for (const value of ["2026-02-30", "2026/10/02", "令和8年10月2日", "2026-10-2"]) {
      const reading = parseReading(raw({ transactionDate: value }));
      expect(reading.transactionDate).toBeNull();
      expect(reading.transactionDateAsPrinted).toBe(value);
    }
    expect(parseReading(raw({ transactionDate: null }))).toMatchObject({
      transactionDate: null,
      transactionDateAsPrinted: null,
    });
  });

  it("upper-cases the currency and reads an empty or yen currency as JPY", () => {
    expect(parseReading(raw({ currency: "usd" })).currency).toBe("USD");
    expect(parseReading(raw({ currency: "" })).currency).toBe("JPY");
    expect(parseReading(raw({ currency: "円" })).currency).toBe("JPY");
    expect(parseReading(raw({ currency: "￥" })).currency).toBe("JPY");
  });

  it("accepts nulls where the schema allows them", () => {
    const reading = parseReading(
      raw({
        issuerName: null,
        registrationNumber: null,
        transactionDate: null,
        totalAmount: null,
        rates: [],
        description: null,
      }),
    );
    expect(reading).toMatchObject({ totalAmount: null, rates: [], registrationNumber: null });
  });

  it.each([
    ["not an object", null],
    ["an array", [RAW]],
    [
      "a missing key",
      (() => {
        const value = raw();
        delete value.totalAmount;
        return value;
      })(),
    ],
    ["a wrong type", raw({ legible: "yes" })],
    ["an unknown document type", raw({ documentType: "ticket" })],
    ["a string amount", raw({ totalAmount: "2500" })],
    ["a negative total", raw({ totalAmount: -1 })],
    ["a fractional total", raw({ totalAmount: 2500.5 })],
    ["a total beyond the safe integers", raw({ totalAmount: 2 ** 53 })],
    [
      "a negative rate amount",
      raw({ rates: [{ ratePercent: 10, amount: -100, taxIncluded: true, taxAmount: null }] }),
    ],
    [
      "an unknown rate",
      raw({ rates: [{ ratePercent: 5, amount: 100, taxIncluded: true, taxAmount: null }] }),
    ],
    ["a null currency", raw({ currency: null })],
  ])("rejects %s as invalid_output", (_, value) => {
    expect(codeOf(() => parseReading(value))).toBe("invalid_output");
  });
});

describe("StoredReading", () => {
  it("round-trips through JSON with amounts as decimal strings", () => {
    const reading = parseReading(
      raw({
        rates: [
          { ratePercent: 8, amount: 8000, taxIncluded: false, taxAmount: 640 },
          { ratePercent: 10, amount: 1000, taxIncluded: false, taxAmount: null },
        ],
        totalAmount: 9740,
        transactionDate: "2026-02-30",
      }),
    );
    const stored = toStoredReading(reading);
    expect(stored.totalAmount).toBe("9740");
    expect(stored.rates[1]).toEqual({
      ratePercent: 10,
      amount: "1000",
      taxIncluded: false,
      taxAmount: null,
      inclusiveAmount: "1100",
    });
    const json = JSON.parse(JSON.stringify(stored)) as unknown;
    expect(fromStoredReading(json)).toEqual(reading);
  });

  it("returns null for a broken or old value", () => {
    const stored = toStoredReading(parseReading(raw())) as unknown as Record<string, unknown>;
    expect(fromStoredReading(null)).toBeNull();
    expect(fromStoredReading({ ...stored, totalAmount: 2500 })).toBeNull();
    expect(fromStoredReading({ ...stored, totalAmount: "-1" })).toBeNull();
    expect(fromStoredReading({ ...stored, transactionDate: "2026-13-01" })).toBeNull();
    expect(fromStoredReading({ ...stored, rates: [{ ratePercent: 10 }] })).toBeNull();
  });
});
