import { describe, expect, it } from "vitest";
import { decodeCsvBytes } from "../src/csv/decode";
import { CSV_FORMAT_LABELS, detectCsvFormat, parseStatement } from "../src/csv/registry";
import { parseCsvTable } from "../src/csv/table";
import {
  fixtureBytes,
  fixtureJson,
  GENERIC_BROKEN_CONFIG,
  GOLDEN_CASES,
  serializeStatement,
} from "./support/fixtures";

function readFixture(file: string): string[][] {
  return parseCsvTable(decodeCsvBytes(fixtureBytes(file)).text);
}

describe("golden fixtures (12-imports §3.1)", () => {
  for (const golden of GOLDEN_CASES) {
    describe(`${CSV_FORMAT_LABELS[golden.format]}: ${golden.file}`, () => {
      it(`decodes as ${golden.encoding}`, () => {
        expect(decodeCsvBytes(fixtureBytes(golden.file)).encoding).toBe(golden.encoding);
      });

      it(golden.detected === null ? "is not detected (chosen by hand)" : "is detected", () => {
        expect(detectCsvFormat(readFixture(golden.file))).toBe(golden.detected);
      });

      it(`matches ${golden.expected}`, () => {
        const statement = parseStatement({
          table: readFixture(golden.file),
          format: golden.format,
          config: golden.config,
        });
        expect(serializeStatement(statement)).toEqual(fixtureJson(golden.expected));
      });

      it("gives same-day look-alike rows different external IDs", () => {
        const { rows } = parseStatement({
          table: readFixture(golden.file),
          format: golden.format,
          config: golden.config,
        });
        const ids = rows.map((row) => row.externalId);
        expect(new Set(ids).size).toBe(rows.length);
        expect(ids.every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
        const lookAlikes = rows.filter(
          (row, index) =>
            rows.findIndex(
              (other) =>
                other.txnDate === row.txnDate &&
                other.amount === row.amount &&
                other.descriptionRaw === row.descriptionRaw &&
                other.counterpartyRaw === row.counterpartyRaw,
            ) !== index,
        );
        expect(lookAlikes.length).toBeGreaterThanOrEqual(1);
      });

      it("gives the same external IDs when the file is read again", () => {
        const read = (): string[] =>
          parseStatement({
            table: readFixture(golden.file),
            format: golden.format,
            config: golden.config,
          }).rows.map((row) => row.externalId);
        expect(read()).toEqual(read());
      });
    });
  }
});

describe("ドコモ SMTB in Shift_JIS", () => {
  it("decodes to the same text as its UTF-8 source (sample.utf8.csv, kept for review)", () => {
    const shiftJis = decodeCsvBytes(fixtureBytes("docomo_smtb/sample.csv"));
    const utf8 = decodeCsvBytes(fixtureBytes("docomo_smtb/sample.utf8.csv"));
    expect(utf8.encoding).toBe("utf-8");
    expect(shiftJis.text).toBe(utf8.text);
  });
});

describe("balance continuity warnings (12-imports §3.4)", () => {
  it("warns at the row after a missing one and still reads every row (ドコモ SMTB)", () => {
    const statement = parseStatement({
      table: readFixture("docomo_smtb/broken-balance.csv"),
      format: "docomo_smtb",
    });
    expect(statement.rows).toHaveLength(6);
    expect(statement.failures).toEqual([]);
    expect(statement.warnings).toEqual([
      "6 行目で残高がつながりません（前の残高 693,255 + 金額 12 ≠ 681,267）",
    ]);
  });

  it("carries the balance over a row without one and warns once (汎用)", () => {
    const statement = parseStatement({
      table: readFixture("generic/broken-balance.csv"),
      format: "generic",
      config: GENERIC_BROKEN_CONFIG,
    });
    expect(statement.rows).toHaveLength(5);
    expect(statement.rows[1]?.balanceAfter).toBeNull();
    expect(statement.warnings).toEqual([
      "5 行目で残高がつながりません（前の残高 577,560 + 金額 -35,000 ≠ 532,560）",
    ]);
  });

  it("checks the 全銀 trailer against the rows read from the header's balance", () => {
    const statement = parseStatement({
      table: readFixture("gmo_aozora_zengin/broken-balance.csv"),
      format: "gmo_aozora_zengin",
    });
    expect(statement.rows).toHaveLength(7);
    expect(statement.openingBalance).toBe(1_000_000n);
    expect(statement.closingBalance).toBe(1_412_655n);
    expect(statement.rows.at(-1)?.balanceAfter).toBe(1_432_655n);
    expect(statement.warnings).toEqual([
      "トレーラの出金 5 件・77,345 円と、読めた明細の出金 4 件・57,345 円が一致しません",
      "トレーラの取引後残高 1,412,655 円と、取引前残高から積んだ残高 1,432,655 円が一致しません",
    ]);
  });
});
