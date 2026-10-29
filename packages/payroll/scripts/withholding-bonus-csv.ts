/**
 * CSV snapshot of the NTA bonus withholding table (賞与に対する源泉徴収税額の算出率の表, dumped cell
 * for cell by xls-to-csv.py) → the JSON of `data/<year>/withholding-bonus.json` (22-payroll §10.1).
 * Pure: no I/O. `build-withholding-bonus-table.ts` reads and writes the files, and
 * `test/withholding-bonus-table.test.ts` proves the committed JSON equals this conversion.
 *
 * The amounts of the sheet are in 千円 and become yen (× 1,000). The 0% row has only 「未満」, the
 * last row only 「以上」, and 乙欄 has a range on a few rows only. Every row is classified; a header
 * other than 甲欄 0〜6 人・7 人以上 + 乙欄, an unexpected cell, a gap or an overlap in a column, or a
 * rate that does not increase throws, so a changed layout never turns into a silently wrong table.
 *
 * Runs under `node --experimental-strip-types`: explicit `.ts` specifiers, no enums, no parameter
 * properties, and no imports from `src/` (whose imports are extensionless).
 */
import { parseCsv } from "./withholding-csv.ts";

export interface BonusWithholdingSource {
  url: string;
  fetchedAt: string;
  sha256: string;
  note: string;
}

/** The downloaded originals (docs/research/payroll-sources.md §8), by year of payment. */
export const BONUS_WITHHOLDING_SOURCES: Readonly<Record<number, BonusWithholdingSource>> = {
  2026: {
    url: "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/15-16.xls",
    fetchedAt: "2026-10-29",
    sha256: "e74e6ba66623b67d8d478dfcc8187f702742e6e75554feebd948dd5b7beea9cf",
    note: "国税庁 令和8年分 賞与に対する源泉徴収税額の算出率の表の Excel を scripts/xls-to-csv.py で data/2026/source/withholding-bonus.csv にし、scripts/build-withholding-bonus-table.ts で生成した（表の千円を円にした）。検算用 PDF: https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/15-16.pdf（SHA-256 5ab9d7d875ccb14769862757b4f8e027178925dae6e8ac40f903b1d55a9ae71b）",
  },
  2027: {
    url: "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/15-16.xls",
    fetchedAt: "2026-10-29",
    sha256: "8acbf38e76bf41584ab90ff1cd663ed688c9b468fb0b1f68498934ca2a78e6bf",
    note: "国税庁 令和9年分 賞与に対する源泉徴収税額の算出率の表の Excel を scripts/xls-to-csv.py で data/2027/source/withholding-bonus.csv にし、scripts/build-withholding-bonus-table.ts で生成した（表の千円を円にした）。検算用 PDF: https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/15-16.pdf（SHA-256 32b90d4ee9f9c05b9997afc531a3009031db7113c6b24ec22dc6901f109e661b）",
  },
};

/** `from` 以上 `to` 未満 in yen; `null` is an open end. */
export interface BonusRangeJson {
  from: number | null;
  to: number | null;
}

export interface BonusRowJson {
  ratePercent: string;
  kou: BonusRangeJson[];
  otsu: BonusRangeJson | null;
}

export interface BonusWithholdingJson {
  kind: "withholding-bonus";
  id: string;
  title: string;
  effectiveFrom: string;
  effectiveTo: string;
  legalBasis: string;
  source: BonusWithholdingSource;
  rows: BonusRowJson[];
}

// Column layout of the snapshot: [1] rate (%), [3..18] 甲欄 0〜7 人以上 as (以上, 未満) pairs,
// [19, 20] 乙欄 (以上, 未満).
const RATE = 1;
const KOU_FIRST = 3;
const KOU_COLUMNS = 8;
const OTSU = KOU_FIRST + KOU_COLUMNS * 2;
const LAST_COLUMN = OTSU + 1;

const THOUSANDS = /^\d+$/;
const RATE_TEXT = /^\d+(?:\.\d+)?$/;
const BELOW = "千円未満";
const FROM_ON = "千円以上";

/** Trimmed cell (`trim` also removes the ideographic space U+3000). */
function cell(row: readonly string[], column: number): string {
  return (row[column] ?? "").trim();
}

/** Full-width digits to ASCII and all spaces removed, for the header texts. */
function squeeze(text: string): string {
  return text
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "");
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((value) => value.trim() === "");
}

type Fail = (record: number | null, problem: string) => never;

/** A whole number of 千円 → yen. */
function thousands(text: string, record: number, fail: Fail): number {
  if (!THOUSANDS.test(text)) return fail(record, `"${text}" is not a whole number of 千円`);
  const value = Number(text) * 1000;
  if (!Number.isSafeInteger(value)) return fail(record, `"${text}" 千円 is out of range`);
  return value;
}

/**
 * One (以上, 未満) pair: `82 / 千円未満` (below 82,000), `3495 / 千円以上` (from 3,495,000), `82 / 94`
 * (from 82,000 below 94,000), or two blanks (`null`: no range on this row).
 */
function range(
  row: readonly string[],
  column: number,
  record: number,
  fail: Fail,
): BonusRangeJson | null {
  const from = cell(row, column);
  const to = cell(row, column + 1);
  if (from === "" && to === "") return null;
  if (to === BELOW) return { from: null, to: thousands(from, record, fail) };
  if (to === FROM_ON) return { from: thousands(from, record, fail), to: null };
  const lower = thousands(from, record, fail);
  const upper = thousands(to, record, fail);
  if (upper <= lower) fail(record, `the range ${from}〜${to} 千円 is empty`);
  return { from: lower, to: upper };
}

/** `"2.042"` → [2042n, 1000n]: exact, for comparing rates without floating point. */
function decimal(text: string): [bigint, bigint] {
  const [whole = "", fraction = ""] = text.split(".");
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}

function rateLess(a: string, b: string): boolean {
  const [an, ad] = decimal(a);
  const [bn, bd] = decimal(b);
  return an * bd < bn * ad;
}

/** The ranges of a column down the rows: open start, contiguous, open end. */
function checkColumn(
  ranges: readonly { range: BonusRangeJson; record: number }[],
  label: string,
  fail: Fail,
): void {
  if (ranges.length < 2) fail(null, `${label}: at least 2 rows are needed`);
  ranges.forEach(({ range: current, record }, index) => {
    const first = index === 0;
    const last = index === ranges.length - 1;
    if (first !== (current.from === null)) {
      fail(record, `${label}: only the first row may be 「未満」 only`);
    }
    if (last !== (current.to === null)) {
      fail(record, `${label}: only the last row may be 「以上」 only`);
    }
    const previous = ranges[index - 1];
    if (previous && current.from !== previous.range.to) {
      fail(
        record,
        `${label}: the row must start at ${previous.range.to} 円 (no gap or overlap with the row before)`,
      );
    }
  });
}

/**
 * Converts the CSV snapshot of `year`. Throws on any unexpected row or broken invariant: header
 * labels 0人〜6人・7人以上 and 乙, every data row with a rate and the 8 甲欄 ranges, rates strictly
 * increasing, each column (甲欄 0〜7 人以上 and 乙欄) contiguous from 「未満」 to 「以上」.
 */
export function convertWithholdingBonusCsv(csvText: string, year: number): BonusWithholdingJson {
  const source = BONUS_WITHHOLDING_SOURCES[year];
  if (!source) throw new Error(`withholding-bonus-csv: no source registered for ${year}`);
  const rows = parseCsv(csvText);
  const fail: Fail = (record, problem) => {
    const where = record === null ? "" : `, record ${record + 1}`;
    throw new Error(`withholding-bonus ${year} CSV${where}: ${problem}`);
  };

  // Header: title, legal basis, the column labels.
  const title = squeeze(rows[0]?.[RATE] ?? "");
  const era = /^賞与に対する源泉徴収税額の算出率の表（令和(\d+)年分）$/.exec(title);
  if (!era) return fail(0, `"${title}" is not 賞与に対する源泉徴収税額の算出率の表（令和N年分）`);
  if (Number(era[1]) + 2018 !== year) fail(0, `the table is 令和${era[1]}年分, not ${year}`);
  const basis = /^（(.+)）$/.exec(squeeze(rows[1]?.[RATE] ?? ""));
  if (!basis?.[1]) return fail(1, "is not the legal basis in brackets（…告示…）");

  const labelIndex = rows.findIndex((row) => squeeze(cell(row, KOU_FIRST)) === "0人");
  if (labelIndex < 0) return fail(null, 'no header row labelled "0人"');
  const labels = rows[labelIndex]!;
  for (let column = 0; column < KOU_COLUMNS; column++) {
    const expected = column === KOU_COLUMNS - 1 ? `${column}人以上` : `${column}人`;
    if (squeeze(cell(labels, KOU_FIRST + column * 2)) !== expected) {
      fail(labelIndex, `甲欄 column ${column + 1} must be labelled ${expected}`);
    }
  }
  const kindRow = rows.slice(0, labelIndex).find((row) => cell(row, KOU_FIRST) === "甲");
  if (!kindRow || cell(kindRow, OTSU) !== "乙") fail(null, "the header must name 甲 and 乙");
  const unitIndex = rows.findIndex((row) => cell(row, RATE) === "%");
  if (unitIndex <= labelIndex) return fail(null, 'no unit row ("%", "千円") after the labels');
  const units = rows[unitIndex]!;
  for (let column = KOU_FIRST; column <= LAST_COLUMN; column++) {
    if (cell(units, column) !== "千円") fail(unitIndex, "every range column must be in 千円");
  }
  const boundsRow = rows[unitIndex - 1]!;
  for (let column = KOU_FIRST; column <= LAST_COLUMN; column++) {
    const expected = (column - KOU_FIRST) % 2 === 0 ? "以上" : "未満";
    if (cell(boundsRow, column) !== expected) fail(unitIndex - 1, `column must be ${expected}`);
  }

  // Data rows: up to the notes 「(注)」.
  const notesIndex = rows.findIndex(
    (row, record) => record > unitIndex && /^\(注\)/.test(cell(row, RATE)),
  );
  if (notesIndex < 0) return fail(rows.length - 1, 'no notes row "(注)" after the table');
  const table: (BonusRowJson & { record: number })[] = [];
  for (let record = unitIndex + 1; record < notesIndex; record++) {
    const row = rows[record]!;
    if (isBlankRow(row)) continue;
    if (row.slice(LAST_COLUMN + 1).some((value) => value.trim() !== "")) {
      fail(record, "has a value to the right of 乙欄");
    }
    if (cell(row, 0) !== "" || cell(row, RATE + 1) !== "") {
      fail(record, "has a value outside the rate and the ranges");
    }
    const ratePercent = cell(row, RATE);
    if (!RATE_TEXT.test(ratePercent)) fail(record, `rate "${ratePercent}" is not a percentage`);
    const kou = Array.from({ length: KOU_COLUMNS }, (_, column) => {
      const value = range(row, KOU_FIRST + column * 2, record, fail);
      if (!value) return fail(record, `甲欄 column ${column + 1} has no range`);
      return value;
    });
    table.push({ record, ratePercent, kou, otsu: range(row, OTSU, record, fail) });
  }
  if (table.length === 0) return fail(unitIndex, "no table rows");

  table.forEach((row, index) => {
    const previous = table[index - 1];
    if (previous && !rateLess(previous.ratePercent, row.ratePercent)) {
      fail(
        row.record,
        `the rate ${row.ratePercent}% must be greater than ${previous.ratePercent}%`,
      );
    }
  });
  for (let column = 0; column < KOU_COLUMNS; column++) {
    checkColumn(
      table.map((row) => ({ range: row.kou[column]!, record: row.record })),
      `甲欄 column ${column + 1}`,
      fail,
    );
  }
  checkColumn(
    table.flatMap((row) => (row.otsu ? [{ range: row.otsu, record: row.record }] : [])),
    "乙欄",
    fail,
  );

  return {
    kind: "withholding-bonus",
    id: `withholding-bonus-${year}`,
    title,
    effectiveFrom: `${year}-01-01`,
    effectiveTo: `${year}-12-31`,
    legalBasis: basis[1],
    source: {
      url: source.url,
      fetchedAt: source.fetchedAt,
      sha256: source.sha256,
      note: source.note,
    },
    rows: table.map(({ ratePercent, kou, otsu }) => ({ ratePercent, kou, otsu })),
  };
}
