import type { CalendarDate } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import { parseReading, type Reading } from "../src/reading";
import {
  READING_ISSUE_CODES,
  validateReading,
  type ReadingIssueCode,
  type ReadingRegistry,
  type ReadingValidationContext,
} from "../src/validate";

const TODAY: CalendarDate = "2026-10-28";

function reading(overrides: Record<string, unknown> = {}): Reading {
  return parseReading({
    documentType: "receipt",
    legible: true,
    issuerName: "架空食堂",
    registrationNumber: "T8999999999901",
    transactionDate: "2026-10-02",
    currency: "JPY",
    totalAmount: 2500,
    rates: [{ ratePercent: 10, amount: 2500, taxIncluded: true, taxAmount: 227 }],
    description: "飲食代",
    ...overrides,
  });
}

function rate(ratePercent: number, amount: number, taxIncluded: boolean, taxAmount: number | null) {
  return { ratePercent, amount, taxIncluded, taxAmount };
}

const REGISTERED: ReadingRegistry = {
  status: "registered",
  name: "架空食堂株式会社",
  registeredOn: "2023-10-01",
  endedOn: null,
  endReason: null,
};

function codes(value: Reading, context: Partial<ReadingValidationContext> = {}): string[] {
  return validateReading(value, { today: TODAY, ...context }).map((issue) => issue.code);
}

function only(value: Reading, context: Partial<ReadingValidationContext> = {}) {
  const issues = validateReading(value, { today: TODAY, ...context });
  expect(issues).toHaveLength(1);
  return issues[0];
}

describe("validateReading (20-reader §4)", () => {
  it("finds nothing in a consistent reading of a registered issuer", () => {
    expect(validateReading(reading(), { today: TODAY, registry: REGISTERED })).toEqual([]);
  });

  const cases: [ReadingIssueCode, Reading, Partial<ReadingValidationContext>][] = [
    ["illegible", reading({ legible: false }), {}],
    ["currency", reading({ currency: "USD" }), {}],
    ["date_missing", reading({ transactionDate: null }), {}],
    ["date_future", reading({ transactionDate: "2026-11-07" }), {}],
    ["date_old", reading({ transactionDate: "2024-10-27" }), {}],
    ["total_missing", reading({ totalAmount: null, rates: [] }), {}],
    ["total_range", reading({ totalAmount: 0, rates: [rate(10, 0, true, 0)] }), {}],
    ["rates_missing", reading({ rates: [] }), {}],
    ["rates_sum", reading({ totalAmount: 2400 }), {}],
    ["rate_tax", reading({ rates: [rate(10, 2500, true, 250)] }), {}],
    ["registration_format", reading({ registrationNumber: "T12345" }), {}],
    ["registration_check_digit", reading({ registrationNumber: "T8999999999902" }), {}],
    ["registration_not_found", reading(), { registry: null }],
    [
      "registration_inactive",
      reading(),
      { registry: { ...REGISTERED, status: "not_registered", registeredOn: "2027-04-01" } },
    ],
    ["duplicate", reading(), { duplicates: [{ documentId: "doc_1", label: "r01.png" }] }],
  ];

  it.each(cases)("raises %s alone", (code, value, context) => {
    expect(codes(value, context)).toEqual([code]);
  });

  it("covers every issue code", () => {
    expect(cases.map(([code]) => code).sort()).toEqual([...READING_ISSUE_CODES].sort());
  });

  it("writes the messages of the design (amounts grouped, dates with slashes)", () => {
    expect(only(reading({ currency: "usd" }))).toMatchObject({
      severity: "warning",
      field: "currency",
      message: "円以外の通貨です（USD）。金額は円にして入れてください",
    });
    expect(only(reading({ transactionDate: "2062-11-07" }))?.message).toBe(
      "取引年月日が未来です（2062/11/07）。読み違いがないか確かめてください",
    );
    expect(
      only(
        reading({
          totalAmount: 3930,
          rates: [rate(8, 2980, true, 220), rate(10, 1000, true, 90)],
        }),
      ),
    ).toMatchObject({
      field: "rates",
      message: "税率ごとの内訳の合計（3,980 円）が合計（3,930 円）と合いません",
    });
    expect(only(reading({ totalAmount: 1100, rates: [rate(10, 1100, true, 120)] }))?.message).toBe(
      "10% の消費税額（120 円）が対価から計算した額（100 円）と合いません",
    );
    expect(
      only(reading({ transactionDate: "2026-10-07" }), {
        registry: { ...REGISTERED, status: "not_registered", registeredOn: "2027-04-01" },
      })?.message,
    ).toBe("取引年月日（2026/10/07）にはこの番号は登録されていません（登録 2027/04/01）");
    expect(
      only(reading(), {
        duplicates: [
          { documentId: "doc_1", label: "receipt-1107.jpg" },
          { documentId: "doc_2", label: "receipt-1107-2.jpg" },
        ],
      })?.message,
    ).toBe("同じ発行者・日付・金額の証憑があります（receipt-1107.jpg、receipt-1107-2.jpg）");
  });

  it("names the end of an expired or revoked registration", () => {
    const expired = only(reading(), {
      registry: {
        ...REGISTERED,
        status: "not_registered",
        endedOn: "2025-03-31",
        endReason: "expired",
      },
    });
    expect(expired?.message).toBe(
      "取引年月日（2026/10/02）にはこの番号は登録されていません（失効 2025/03/31）",
    );
    expect(
      validateReading(reading({ transactionDate: null }), {
        today: TODAY,
        registry: {
          ...REGISTERED,
          status: "not_registered",
          endedOn: "2026-06-30",
          endReason: "revoked",
        },
      }).map((issue) => issue.message),
    ).toEqual([
      "取引年月日を読み取れませんでした",
      "この番号は登録されていません（取消 2026/06/30）",
    ]);
  });

  it("makes the registration number's format and check digit errors, the rest warnings", () => {
    expect(only(reading({ registrationNumber: "T12345" }))).toMatchObject({
      severity: "error",
      field: "registrationNumber",
    });
    expect(only(reading({ registrationNumber: "T8999999999902" }))?.severity).toBe("error");
    expect(
      validateReading(reading({ legible: false, transactionDate: null, totalAmount: null }), {
        today: TODAY,
        registry: null,
      }).every((issue) => issue.severity === "warning"),
    ).toBe(true);
  });

  it("does not look the registry up for a missing or malformed number", () => {
    expect(codes(reading({ registrationNumber: null }), { registry: null })).toEqual([]);
    expect(codes(reading({ registrationNumber: "T8999999999902" }), { registry: null })).toEqual([
      "registration_check_digit",
    ]);
  });

  it("allows the printed tax to differ from the computed tax by 1 yen", () => {
    // 2,500 × 10/110 = 227.27…: 227 truncated, 228 rounded up.
    expect(codes(reading({ rates: [rate(10, 2500, true, 228)] }))).toEqual([]);
    expect(codes(reading({ rates: [rate(10, 2500, true, 226)] }))).toEqual([]);
    expect(codes(reading({ rates: [rate(10, 2500, true, 229)] }))).toEqual(["rate_tax"]);
    // Tax-exclusive: 12,000 × 10% = 1,200.
    const exclusive = (tax: number) =>
      reading({ totalAmount: 12000 + tax, rates: [rate(10, 12000, false, tax)] });
    expect(codes(exclusive(1200))).toEqual([]);
    expect(codes(exclusive(1198))).toEqual(["rate_tax"]);
  });

  it("checks each rate's tax on its own", () => {
    const issues = validateReading(
      reading({
        totalAmount: 1350,
        rates: [rate(8, 470, true, 40), rate(10, 880, true, 90)],
      }),
      { today: TODAY },
    );
    expect(issues.map((issue) => issue.message)).toEqual([
      "8% の消費税額（40 円）が対価から計算した額（34 円）と合いません",
      "10% の消費税額（90 円）が対価から計算した額（80 円）と合いません",
    ]);
  });

  it("dates: today is fine, two years ago to the day is fine, a day earlier is old", () => {
    expect(codes(reading({ transactionDate: TODAY }))).toEqual([]);
    expect(codes(reading({ transactionDate: "2024-10-28" }))).toEqual([]);
    expect(codes(reading({ transactionDate: "2024-10-27" }))).toEqual(["date_old"]);
    // 29 Feb has no day two years earlier: 28 Feb is the limit.
    const leap = (date: string) =>
      validateReading(reading({ transactionDate: date }), { today: "2028-02-29" }).map(
        (issue) => issue.code,
      );
    expect(leap("2026-02-28")).toEqual([]);
    expect(leap("2026-02-27")).toEqual(["date_old"]);
  });

  it("flags a total above 100 million yen", () => {
    expect(
      codes(reading({ totalAmount: 100_000_001, rates: [rate(10, 100_000_001, true, null)] })),
    ).toEqual(["total_range"]);
    expect(
      codes(reading({ totalAmount: 100_000_000, rates: [rate(10, 100_000_000, true, null)] })),
    ).toEqual([]);
  });

  it("skips the amount checks for another currency (amounts are not proposed)", () => {
    expect(codes(reading({ currency: "USD", totalAmount: 0, rates: [] }))).toEqual(["currency"]);
  });
});
