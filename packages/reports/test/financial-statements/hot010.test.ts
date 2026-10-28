import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import {
  assertHot010Rows,
  buildFinancialStatements,
  buildHot010File,
  buildHot010Files,
  buildHot010Zip,
  defineEtaxEdition,
  EtaxCharacterError,
  ETAX_STATEMENT_NAMES,
  HOT010_2019_EDITION,
  type EtaxEdition,
  type Hot010File,
} from "../../src";
import { expectGolden } from "../support/golden";
import { BOOK, FY1, FY2, withSource } from "./fixture";

const fy1 = buildFinancialStatements(BOOK, FY1.id);
const fy2 = buildFinancialStatements(BOOK, FY2.id);

/** Splits a CSV line on commas outside double quotes. */
function cells(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      out.push(current);
      current = "";
    } else current += char;
  }
  out.push(current);
  return out;
}

/** Records of a file (a quoted value may hold a CRLF). */
function records(text: string): string[][] {
  const lines: string[] = [];
  let buffer = "";
  for (const line of text.split("\r\n").slice(0, -1)) {
    buffer = buffer === "" ? line : `${buffer}\r\n${line}`;
    if ((buffer.match(/"/g)?.length ?? 0) % 2 === 0) {
      lines.push(buffer);
      buffer = "";
    }
  }
  expect(buffer).toBe("");
  return lines.map(cells);
}

function checkStructure(file: Hot010File, report = fy1) {
  expect(file.text.endsWith("\r\n")).toBe(true);
  expect(file.text.replaceAll("\r\n", "").includes("\n")).toBe(false);
  expect(file.text.replaceAll("\r\n", "").includes("\r")).toBe(false);
  expect([...file.bytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  expect(iconv.decode(Buffer.from(file.bytes), "Shift_JIS")).toBe(file.text);

  const rows = records(file.text);
  for (const row of rows) expect(row).toHaveLength(5);
  expect(rows[0]).toEqual(["A", file.statement, "", "", ""]);
  expect(rows[1]![0]).toBe("B");
  expect(rows[1]![1]).toBe("架空商事株式会社");
  expect(rows[2]).toEqual(["C1", report.fiscalYear.startDate, "", "", ""]);
  expect(rows[3]).toEqual(["C2", report.fiscalYear.endDate, "", "", ""]);
  expect(rows[4]).toEqual([ETAX_STATEMENT_NAMES[file.statement], "", "", "", ""]);

  const table = report.edition.tables[file.statement];
  let previous = 1;
  const seen = new Set<string>();
  for (const row of rows.slice(5)) {
    const [label, value, kind, depthText, code] = row as [string, string, string, string, string];
    const depth = Number(depthText);
    expect(depth).toBeGreaterThanOrEqual(2);
    expect(depth).toBeLessThanOrEqual(previous + 1);
    previous = depth;
    expect(["1", "2", "T"]).toContain(kind);
    if (kind === "T") expect(value).toBe("");
    if (kind === "1") expect(value).toMatch(/^-?\d{1,15}$/);
    expect(label.length).toBeGreaterThan(0);
    // No half-width text in the names (5.4); codes and amounts are half-width.
    expect(label).not.toMatch(/[\x20-\x7e]/);
    const base = code.replace(/-\d+$/, "");
    const tableRow = table.rows[table.positions.get(base) ?? -1];
    expect(tableRow, code).toBeDefined();
    if (seen.has(code)) expect(tableRow?.repeat).not.toBeNull();
    seen.add(code);
  }
  expect(file.rows).toHaveLength(rows.length - 5);
}

describe("buildHot010Files", () => {
  const files = buildHot010Files(fy1);

  it("makes the four files of HOT010 Ver.3.0", () => {
    expect(files.map((file) => file.fileName)).toEqual([
      "HOT010_3.0_BS.csv",
      "HOT010_3.0_PL.csv",
      "HOT010_3.0_SS.csv",
      "HOT010_3.0_NT.csv",
    ]);
  });

  it("matches the golden Shift_JIS files of 第 1 期", () => {
    for (const file of files) expectGolden(`hot010_fy1_${file.statement}.sjis.csv`, file.bytes);
  });

  it("matches the golden Shift_JIS files of 第 2 期", () => {
    for (const file of buildHot010Files(fy2)) {
      expectGolden(`hot010_fy2_${file.statement}.sjis.csv`, file.bytes);
    }
  });

  it("follows the record rules (5 columns, header rows, depth, codes, row kinds)", () => {
    for (const file of files) checkStructure(file);
    for (const file of buildHot010Files(fy2)) checkStructure(file, fy2);
  });

  it("carries the same numbers as the statements", () => {
    const bs = files.find((file) => file.statement === "BS")!;
    for (const line of fy1.balanceSheet.lines) {
      const row = bs.rows.find((r) => r.code === line.code)!;
      expect(row.value).toBe(line.amount === null ? "" : line.amount.toString());
    }
    const pl = files.find((file) => file.statement === "PL")!;
    expect(pl.rows.find((r) => r.code === "10F000160")?.value).toBe("-71884");
    expect(pl.rows.find((r) => r.code === "10E200010-1")).toMatchObject({
      label: "ソフトウェア利用料",
      rowKind: "1",
      depth: 3,
    });
  });

  it("writes the share count as full-width text and repeats その他の注記 as sets", () => {
    const nt = files.find((file) => file.statement === "NT")!;
    expect(nt.rows.find((r) => r.code === "NT0508")).toMatchObject({
      value: "１００００株",
      rowKind: "2",
    });
    expect(nt.rows.filter((r) => r.code === "NT1201").map((r) => r.rowKind)).toEqual(["T", "T"]);
    expect(nt.rows.filter((r) => r.code === "NT1202").map((r) => r.value)).toEqual([
      "重要な後発事象",
      "関連当事者との取引",
    ]);
    // A text with a line break is quoted, with CRLF inside.
    expect(nt.text).toContain('"代表取締役からの借入金があります。\r\n利息は付けていません。"');
    // Half-width digits of the notes become full-width.
    expect(nt.rows.find((r) => r.code === "NT0205")?.value).toContain("平成２８年４月１日");
  });

  it("writes one file on its own", () => {
    const ss = buildHot010File(fy1, "SS");
    expect(ss.bytes).toEqual(files[2]!.bytes);
  });

  it("zips the four files under an ASCII name", () => {
    const zip = buildHot010Zip(fy1);
    expect(zip.fileName).toBe("etax-hot010_20261102-20270331.zip");
    const entries = unzipSync(zip.bytes);
    expect(Object.keys(entries).sort()).toEqual(files.map((file) => file.fileName).sort());
    for (const file of files) expect(entries[file.fileName]).toEqual(file.bytes);
  });
});

describe("assertHot010Rows", () => {
  const table = HOT010_2019_EDITION.tables.BS;
  const ok = [
    { label: "資産の部", value: "", rowKind: "T" as const, depth: 2, code: "10A000010" },
    { label: "流動資産", value: "", rowKind: "T" as const, depth: 3, code: "10A100010" },
  ];

  it("accepts well-formed rows", () => {
    expect(() => assertHot010Rows("BS", ok, table)).not.toThrow();
  });

  it("rejects a depth that jumps by 2", () => {
    const rows = [
      ...ok,
      { label: "現金及び預金", value: "1", rowKind: "1" as const, depth: 5, code: "10A100020" },
    ];
    expect(() => assertHot010Rows("BS", rows, table)).toThrow(/jumps/);
  });

  it("rejects a repeated code, an unknown code, a title with a value, and a bad amount", () => {
    expect(() => assertHot010Rows("BS", [...ok, ok[1]!], table)).toThrow(/twice/);
    expect(() =>
      assertHot010Rows(
        "BS",
        [...ok, { label: "x", value: "1", rowKind: "1", depth: 4, code: "10Z999999" }],
        table,
      ),
    ).toThrow(/not in the table/);
    expect(() => assertHot010Rows("BS", [{ ...ok[0]!, value: "1" }], table)).toThrow(/title/);
    expect(() =>
      assertHot010Rows(
        "BS",
        [...ok, { label: "x", value: "1,000", rowKind: "1", depth: 4, code: "10A100020" }],
        table,
      ),
    ).toThrow(/plain integer/);
    expect(() => assertHot010Rows("BS", [{ ...ok[0]!, depth: 3 }], table)).toThrow(/jumps/);
  });
});

describe("characters e-Tax does not accept", () => {
  it("stops the export and says what and where", () => {
    const accounts = BOOK.accounts.map((account) =>
      account.code === "5320" ? { ...account, name: "通信費（髙橋回線）" } : account,
    );
    const source = withSource({
      company: { ...BOOK.company, name: "𠮷野商事株式会社" },
      accounts,
    });
    const report = buildFinancialStatements(source, FY1.id);
    let error: unknown;
    try {
      buildHot010Files(report);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EtaxCharacterError);
    const problems = (error as EtaxCharacterError).problems;
    expect(problems).toContainEqual({ char: "𠮷", codePoint: "U+20BB7", where: "法人名" });
    expect(problems).toContainEqual({
      char: "髙",
      codePoint: "U+9AD9",
      where: "科目「通信費（髙橋回線）」",
    });
    // Each problem once, even though the name is in all four files.
    expect(problems.filter((p) => p.where === "法人名")).toHaveLength(1);
    expect((error as Error).message).toContain("この文字は e-Tax で使えません");
  });

  it("converts the machine-dependent characters it can", () => {
    const source = withSource({ company: { ...BOOK.company, name: "架空商事㈱ NIHO①" } });
    const bs = buildHot010File(buildFinancialStatements(source, FY1.id), "BS");
    expect(bs.text.split("\r\n")[1]).toBe("B,架空商事（株）　ＮＩＨＯ（１）,,,");
  });
});

const dataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../data/etax/hot010-3.0/2019",
);

describe("code table editions", () => {
  it("never changes the files of the 2019 edition", () => {
    const pinned: Record<string, string> = {
      "bs-10.json": "7c705ab5aef89e1070cb5617afe0bc692638983dba7822c10acd880fa6c78f67",
      "default-mapping.json": "be701e61ac5660f1cfba48ee3cdf563141dc9d36e09ee39cb29610c4e88e4c36",
      "manifest.json": "1be457a7fb68a5343da2b55e2d448493b2359f9757bb5a348f7ce7de6049bb73",
      "nt.json": "340d3054c32c62c5913ed088f0dc5990d783c293a4881be34f6bd5eda5daeaa1",
      "pl-10.json": "048c5dddfa84330ab28175649a2ba461bbdbe51f9686ae3097d6a1ead92458b1",
      "ss.json": "e9940f82c135b7b636ef15fe65d2aeab96167c55260e2f5d9a31c19da78a7322",
    };
    for (const [file, sha256] of Object.entries(pinned)) {
      const actual = createHash("sha256")
        .update(readFileSync(path.join(dataDir, file)))
        .digest("hex");
      expect(actual, file).toBe(sha256);
    }
  });

  it("leaves earlier years' CSV byte-identical when a newer edition is added", () => {
    const newer: EtaxEdition = defineEtaxEdition({
      form: "HOT010",
      formVersion: "3.0",
      edition: "2099",
      industry: "10",
      effectiveFrom: "2028-05-01",
      tables: HOT010_2019_EDITION.tables,
      defaultMapping: { ...HOT010_2019_EDITION.defaultMapping, "5320": "10E201210" },
      layout: HOT010_2019_EDITION.layout,
    });
    const editions = [HOT010_2019_EDITION, newer];

    const fy1Before = buildHot010Files(fy1);
    const fy1After = buildHot010Files(buildFinancialStatements(BOOK, FY1.id, { editions }));
    expect(fy1After.map((file) => file.bytes)).toEqual(fy1Before.map((file) => file.bytes));

    const fy2Report = buildFinancialStatements(BOOK, FY2.id, { editions });
    expect(fy2Report.edition.edition).toBe("2099");
    const pl = buildHot010File(fy2Report, "PL");
    expect(pl.rows.find((r) => r.code === "10E201210")?.label).toBe("通信費");
    expect(pl.rows.some((r) => r.code === "10E200180")).toBe(false);
    expect(pl.bytes).not.toEqual(buildHot010File(fy2, "PL").bytes);
  });
});
