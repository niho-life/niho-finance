import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  corporateNumberCheckDigit,
  corporateNumberProblem,
  invoiceRegistrationNumberProblem,
  isValidCorporateNumber,
  isValidInvoiceRegistrationNumber,
  normalizeCorporateNumber,
  normalizeInvoiceRegistrationNumber,
} from "../src";

/**
 * Independent reference of the check digit (国税庁「法人番号の指定」の計算式) used to build
 * fictional test numbers. No real number appears in this file.
 */
function referenceCheckDigit(base: string): number {
  const digits = [...base].reverse().map(Number);
  const weighted = digits.reduce(
    (total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 2),
    0,
  );
  return 9 - (weighted % 9);
}

function fictionalCorporateNumber(base: string): string {
  return `${referenceCheckDigit(base)}${base}`;
}

const base12 = fc.stringMatching(/^\d{12}$/);

describe("corporate number (法人番号)", () => {
  it("computes the check digit from the 12-digit base", () => {
    // Bases that no registry assigns (registry office code 0000).
    expect(corporateNumberCheckDigit("000000000000")).toBe(9);
    expect(corporateNumberCheckDigit("000000000001")).toBe(8);
    expect(corporateNumberCheckDigit("000000000010")).toBe(7);
    expect(corporateNumberCheckDigit("000000000100")).toBe(8);
    expect(corporateNumberCheckDigit("000000001000")).toBe(7);
    expect(() => corporateNumberCheckDigit("12345")).toThrow(RangeError);
  });

  it("accepts every number built with the reference formula", () => {
    fc.assert(
      fc.property(base12, (base) => {
        const number = fictionalCorporateNumber(base);
        expect(corporateNumberCheckDigit(base)).toBe(referenceCheckDigit(base));
        expect(isValidCorporateNumber(number)).toBe(true);
        expect(corporateNumberProblem(number)).toBeNull();
      }),
    );
  });

  it("rejects a wrong check digit", () => {
    fc.assert(
      fc.property(base12, fc.integer({ min: 0, max: 9 }), (base, digit) => {
        fc.pre(digit !== referenceCheckDigit(base));
        expect(isValidCorporateNumber(`${digit}${base}`)).toBe(false);
      }),
    );
    expect(corporateNumberProblem("1000000000000")).toContain("検査用数字");
  });

  it("rejects anything that is not 13 digits", () => {
    expect(isValidCorporateNumber("900000000000")).toBe(false);
    expect(isValidCorporateNumber("90000000000000")).toBe(false);
    expect(isValidCorporateNumber("900000000000a")).toBe(false);
    expect(corporateNumberProblem("123")).toBe("法人番号は 13 桁の数字です");
  });

  it("normalizes full-width digits, spaces and hyphens", () => {
    expect(normalizeCorporateNumber("９０００ ０００-０００‐０００")).toBe("9000000000000");
    expect(normalizeCorporateNumber(" 9000-0000-0000-0 ")).toBe("9000000000000");
  });
});

describe("invoice registration number (登録番号)", () => {
  it("is T followed by a valid 13-digit number", () => {
    fc.assert(
      fc.property(base12, (base) => {
        const number = `T${fictionalCorporateNumber(base)}`;
        expect(isValidInvoiceRegistrationNumber(number)).toBe(true);
        expect(invoiceRegistrationNumberProblem(number)).toBeNull();
      }),
    );
    expect(isValidInvoiceRegistrationNumber("T9000000000000")).toBe(true);
    expect(isValidInvoiceRegistrationNumber("9000000000000")).toBe(false);
    expect(isValidInvoiceRegistrationNumber("T1000000000000")).toBe(false);
    expect(invoiceRegistrationNumberProblem("T1000000000000")).toContain("検査用数字");
    expect(invoiceRegistrationNumberProblem("X9000000000000")).toBe(
      "登録番号は T に続く 13 桁の数字です",
    );
  });

  it("normalizes a lower-case or full-width T and separators", () => {
    expect(normalizeInvoiceRegistrationNumber("t9000-0000-0000-0")).toBe("T9000000000000");
    expect(normalizeInvoiceRegistrationNumber(`Ｔ９${"０".repeat(12)}`)).toBe("T9000000000000");
  });
});
