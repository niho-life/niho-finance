import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { beancountAccountName, beancountComponent, buildBeancount } from "../src";
import { BOOK, FY1, FY1_TOTALS, FY2 } from "./fixtures/book";
import { expectGolden } from "./support/golden";

function beanCheckPath(): string | null {
  try {
    return execFileSync("which", ["bean-check"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Runs `bean-check` when it is installed; returns its errors or `null` when it is not. */
function beanCheck(text: string): string | null {
  const binary = beanCheckPath();
  if (!binary) {
    console.warn("[reports] bean-check is not installed: the beancount output is not validated");
    return null;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "niho-finance-beancount-"));
  const file = path.join(dir, "book.beancount");
  writeFileSync(file, text);
  try {
    execFileSync(binary, [file], { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string };
    return `${stdout ?? ""}${stderr ?? ""}` || String(error);
  }
}

describe("beancount names", () => {
  it("maps kinds to roots and codes to components", () => {
    const bank = BOOK.accounts.find((a) => a.code === "1100")!;
    expect(beancountAccountName(bank)).toBe("Assets:1100-普通預金");
    expect(beancountAccountName(bank, "架空銀行 普通")).toBe("Assets:1100-普通預金:架空銀行-普通");
    const internal = BOOK.accounts.find((a) => a.code === "9000")!;
    expect(beancountAccountName(internal)).toBe("Equity:Internal:9000-内部取引");
    const sales = BOOK.accounts.find((a) => a.code === "4010")!;
    expect(beancountAccountName(sales)).toBe("Income:4010-売上高-会費");
    expect(beancountComponent("a: b / c")).toBe("A-b-c");
    expect(beancountComponent("kamakura")).toBe("Kamakura");
    expect(beancountComponent("＊")).toBe("X");
  });
});

describe("buildBeancount", () => {
  const whole = buildBeancount(BOOK, { from: FY1.startDate, to: FY2.endDate });

  it("writes options, opens, transactions and balance assertions", () => {
    expect(whole).toContain('option "title" "架空商会株式会社"');
    expect(whole).toContain("2026-11-02 open Assets:1100-普通預金 JPY");
    expect(whole).toContain("2026-11-02 open Assets:1100-普通預金:架空銀行-普通 JPY");
    expect(whole).toContain('2026-11-02 * "資本金の払込" ^e1');
    expect(whole).toContain('2026-11-05 * "架空クラウド株式会社" "クラウドサービス利用料" ^e3');
    expect(whole).toContain('2026-12-15 * "取消 No.12: 書籍代" ^e13 ^e12');
    expect(whole).toContain('  status: "voided"');
    expect(whole).toContain('  void_reason: "金額の誤り"');
    expect(whole).toContain("  reversal_of: 12");
    expect(whole).toContain('    segment: "kamakura"');
    expect(whole).toContain("    tax_amount: 8000");
    expect(whole).toContain(`2028-04-01 balance Assets:1100-普通預金`);
    expect(whole).toMatch(new RegExp(`balance Assets:1100-普通預金\\s+${FY1_TOTALS.bank} JPY`));
    expect(whole).toMatch(/balance Liabilities:2400-役員借入金\s+-256300 JPY/);
    expect(whole).toMatch(/balance Equity:Internal:9000-内部取引\s+0 JPY/);
    expect(whole).not.toContain("Equity:Opening-Balances");
    expectGolden("book.beancount", whole);
  });

  it("passes bean-check (when installed)", () => {
    const result = beanCheck(whole);
    if (result !== null) expect(result).toBe("");
  });

  it("summarises earlier entries into an opening transaction for a later year", () => {
    const second = buildBeancount(BOOK, { from: FY2.startDate, to: FY2.endDate });
    expect(second).toContain("2026-11-02 open Equity:Opening-Balances JPY");
    expect(second).toContain('2027-04-01 * "期首残高"');
    expect(second).toMatch(new RegExp(`Equity:Opening-Balances\\s+-${FY1_TOTALS.netIncome} JPY`));
    expect(second).not.toContain("^e23");
    expect(second).toContain("^e1\n");
    expect(second).toMatch(/2028-04-01 balance Assets:1000-現金\s+5500 JPY/);
    const result = beanCheck(second);
    if (result !== null) expect(result).toBe("");
  });
});
