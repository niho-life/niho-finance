/**
 * CSV snapshot of the NTA monthly withholding table (給与所得の源泉徴収税額表 月額表, dumped cell
 * for cell by xls-to-csv.py) → the JSON of `data/<year>/withholding-monthly.json`
 * (22-payroll §3.1). Pure: no I/O. `build-withholding-table.ts` reads and writes the files, and
 * `test/withholding-table.test.ts` proves the committed JSON equals this conversion.
 *
 * Every row is classified; anything unexpected, a gap between rows, a column count other than
 * 甲欄 0〜7 人 + 乙欄, a broken monotonicity or a formula that does not line up with the points
 * throws, so a changed layout never turns into a silently wrong table.
 *
 * Runs under `node --experimental-strip-types`: explicit `.ts` specifiers, no enums, no parameter
 * properties, and no imports from `src/` (whose imports are extensionless).
 */

export interface WithholdingSource {
  url: string;
  fetchedAt: string;
  sha256: string;
  note: string;
}

/** The downloaded originals (docs/research/payroll-sources.md §1), by year of payment. */
export const WITHHOLDING_SOURCES: Readonly<Record<number, WithholdingSource>> = {
  2026: {
    url: "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/01-07.xls",
    fetchedAt: "2026-10-28",
    sha256: "50aafa072df1bb6b6aa253a021f7cc246265c3f2393f9988ee01ad121bc4f310",
    note: "国税庁 令和8年分 源泉徴収税額表 月額表の Excel（表 1〜7 ページ）を scripts/xls-to-csv.py で data/2026/source/withholding-monthly.csv にし、scripts/build-withholding-table.ts で生成した。検算用 PDF: https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/data/01-07.pdf（SHA-256 c583c9c33cb4e99f4a1505431f2aa768a585b84f09bb9bfb6929b0e8b0c37699）",
  },
  2027: {
    url: "https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/01-07.xlsx",
    fetchedAt: "2026-10-28",
    sha256: "f2f331de1207ae0da6a3f416c7ad233de9411b0210a65e928c39527f1791fea5",
    note: "国税庁 令和9年分 源泉徴収税額表 月額表の Excel を scripts/xls-to-csv.py で data/2027/source/withholding-monthly.csv にし、scripts/build-withholding-table.ts で生成した。検算用 PDF: https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2027/data/01-07.pdf（SHA-256 9de9d1564dfcf00922b33feaa508dbffde97516d98c9ae2aeecae3be4aa810d6）",
  },
};

export interface WithholdingSegmentJson {
  over: number;
  under: number | null;
  ratePercent: string;
}

export interface WithholdingJson {
  kind: "withholding-monthly";
  id: string;
  title: string;
  effectiveFrom: string;
  effectiveTo: string;
  legalBasis: string;
  source: WithholdingSource;
  lowBand: { below: number; otsuRatePercent: string };
  bands: { from: number; to: number; kou: number[]; otsu: number }[];
  kouPoints: { at: number; kou: number[] }[];
  kouSegments: WithholdingSegmentJson[];
  otsuPoints: { at: number; otsu: number }[];
  otsuSegments: WithholdingSegmentJson[];
  extraDependentDeduction: number;
}

/** Parses RFC 4180 CSV (quotes, doubled quotes, CRLF or LF). A leading BOM is ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = text.startsWith("﻿") ? 1 : 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (quoted) {
      if (char !== '"') {
        field += char;
        index += 1;
      } else if (text.charAt(index + 1) === '"') {
        field += '"';
        index += 2;
      } else {
        quoted = false;
        index += 1;
        const next = text.charAt(index);
        if (next !== "," && next !== "\r" && next !== "\n" && next !== "") {
          throw new Error(`CSV record ${rows.length + 1}: text after a closing quote`);
        }
      }
    } else if (char === '"') {
      if (field !== "") throw new Error(`CSV record ${rows.length + 1}: a quote inside a field`);
      quoted = true;
      index += 1;
    } else if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
    } else if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += char === "\r" && text.charAt(index + 1) === "\n" ? 2 : 1;
    } else {
      field += char;
      index += 1;
    }
  }
  if (quoted) throw new Error(`CSV record ${rows.length + 1}: an unterminated quoted field`);
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Column layout of the snapshot: [0] row number, [1] 以上, [2] 未満, [3..10] 甲欄 0〜7 人, [11] 乙欄.
const FROM = 1;
const TO = 2;
const KOU_FIRST = 3;
const KOU_COLUMNS = 8;
const OTSU = KOU_FIRST + KOU_COLUMNS;
const KOU_TEXT = KOU_FIRST;

const YEN = String.raw`(\d{1,3}(?:,\d{3})*)`;
const RATE = String.raw`(\d+(?:\.\d+)?)`;
const INTEGER = /^\d+$/;
const POINT = new RegExp(`^${YEN}円$`);
const OVER = new RegExp(`^${YEN}円を超え$`);
const UNDER = new RegExp(`^${YEN}円に満た$`);
const BOUNDED_TAIL = "ない金額";
const OPEN_TAIL = "る金額";
const KOU_FORMULA = new RegExp(
  `^${YEN}円の場合の税額に、その月の社会保険料等控除後の給与等の金額のうち${YEN}円を超える金額の${RATE}％に相当する金額を加算した金額$`,
);
const OTSU_FORMULA = new RegExp(
  `^${YEN}円に、その月の社会保険料等控除後の給与等の金額のうち${YEN}円を超える金額の${RATE}％に相当する金額を加算した金額$`,
);
const LOW_BAND_OTSU = new RegExp(
  `^その月の社会保険料等控除後の給与等の金額の${RATE}％に相当する金額$`,
);
const DEDUCTION = new RegExp(`人ごとに${YEN}円`, "g");

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

function yen(text: string): number {
  const digits = text.replace(/,/g, "");
  const value = Number(digits);
  if (!INTEGER.test(digits) || !Number.isSafeInteger(value)) {
    throw new Error(`"${text}" is not a whole number of yen`);
  }
  return value;
}

function isBlank(row: readonly string[], except: readonly number[] = []): boolean {
  return row.every(
    (value, column) => column === 0 || except.includes(column) || value.trim() === "",
  );
}

function kouCells(row: readonly string[]): string[] {
  return Array.from({ length: KOU_COLUMNS }, (_, offset) => cell(row, KOU_FIRST + offset));
}

interface Segment {
  record: number;
  over: number;
  under: number | null;
  tail: string | null;
  texts: string[];
}

interface OtsuFormula {
  record: number;
  base: number;
  over: number;
  ratePercent: string;
}

/**
 * Converts the CSV snapshot of `year`. Throws on any unexpected row or broken invariant:
 * bands contiguous from the low band to the first point, 甲欄 non-increasing across dependents,
 * 乙欄 ≥ 甲欄 0 人, tax non-decreasing down the rows, points strictly increasing, 甲 and 乙 formula
 * segments contiguous from the first point to open-ended with each lower end on a point.
 */
export function convertWithholdingCsv(csvText: string, year: number): WithholdingJson {
  const source = WITHHOLDING_SOURCES[year];
  if (!source) throw new Error(`withholding-csv: no source registered for ${year}`);
  const rows = parseCsv(csvText);
  const fail: Fail = (record, problem) => {
    const where = record === null ? "" : `, record ${record + 1}`;
    throw new Error(`withholding-monthly ${year} CSV${where}: ${problem}`);
  };

  rows.forEach((row, record) => {
    if (row.slice(OTSU + 1).some((value) => value.trim() !== "")) {
      fail(record, "has a value to the right of 乙欄");
    }
    const number = cell(row, 0);
    if (number !== "" && !INTEGER.test(number))
      fail(record, `row number "${number}" is not a number`);
  });

  // Header: title, legal basis and the 0〜7 人 labels.
  const title = squeeze(rows[0]?.[FROM] ?? "");
  const era = /^給与所得の源泉徴収税額表（令和(\d+)年分）$/.exec(title);
  if (!era) return fail(0, `"${title}" is not 給与所得の源泉徴収税額表（令和N年分）`);
  if (Number(era[1]) + 2018 !== year) fail(0, `the table is 令和${era[1]}年分, not ${year}`);
  const basis = /^月額表（(.+)）$/.exec(squeeze(rows[1]?.[FROM] ?? ""));
  if (!basis?.[1]) return fail(1, "is not 月額表（告示）");

  const lowIndex = rows.findIndex((row) => cell(row, TO) === "円未満");
  if (lowIndex < 0) return fail(rows.length - 1, 'no row "円未満" (the low band)');
  const labelRows = rows
    .slice(0, lowIndex)
    .filter((row) => kouCells(row).every((value, count) => squeeze(value) === `${count}人`));
  if (labelRows.length !== 1) fail(null, "the header must have one row labelled 0人〜7人");
  const labels = labelRows[0]!.filter((value) => /^\d+人$/.test(squeeze(value)));
  if (labels.length !== KOU_COLUMNS) fail(null, `甲欄 must have ${KOU_COLUMNS} columns (0〜7 人)`);

  // Low band: below N 円 甲欄 is 0 and 乙欄 is a rate.
  const low = rows[lowIndex]!;
  if (!INTEGER.test(cell(low, FROM))) fail(lowIndex, "the low band has no upper end");
  if (kouCells(low).some((value) => value !== "0"))
    fail(lowIndex, "甲欄 of the low band must be 0");
  const lowRate = LOW_BAND_OTSU.exec(cell(low, OTSU));
  if (!lowRate?.[1]) return fail(lowIndex, "乙欄 of the low band is not a rate");
  const lowBand = { below: yen(cell(low, FROM)), otsuRatePercent: lowRate[1] };

  // Bands: every row up to the first point is blank or a full table row.
  const firstPoint = rows.findIndex(
    (row, record) => record > lowIndex && POINT.test(cell(row, FROM)),
  );
  if (firstPoint < 0) return fail(lowIndex, "no point row (e.g. 740,000円) after the bands");
  const bands: WithholdingJson["bands"] = [];
  for (let record = lowIndex + 1; record < firstPoint; record++) {
    const row = rows[record]!;
    if (isBlank(row)) continue;
    const numbers = [cell(row, FROM), cell(row, TO), ...kouCells(row), cell(row, OTSU)];
    if (!numbers.every((value) => INTEGER.test(value))) {
      fail(record, "is neither blank nor a row of 以上・未満・甲欄 0〜7 人・乙欄");
    }
    const [from, to, ...rest] = numbers.map(yen);
    const otsu = rest.pop()!;
    bands.push({ from: from!, to: to!, kou: rest, otsu });
  }

  // Formula part: points, 甲欄 segments (…を超え / …に満た / text) and 乙欄 formulas.
  const kouPoints: WithholdingJson["kouPoints"] = [];
  const otsuPoints: WithholdingJson["otsuPoints"] = [];
  const segments: Segment[] = [];
  const otsuFormulas = new Map<number, OtsuFormula>();
  let current: Segment | null = null;
  let notesFrom = -1;
  for (let record = firstPoint; record < rows.length && notesFrom < 0; record++) {
    const row = rows[record]!;
    const label = cell(row, FROM);
    const kouText = cell(row, KOU_TEXT);
    const otsuText = cell(row, OTSU);
    const units = row.slice(1).filter((value) => value.trim() !== "");
    if (units.length === 0 || units.every((value) => value.trim() === "円")) continue;

    const point = POINT.exec(label);
    if (point?.[1]) {
      const kou = kouCells(row);
      if (!kou.every((value) => INTEGER.test(value)) || cell(row, TO) !== "") {
        fail(record, "a point row must have 甲欄 0〜7 人 as numbers");
      }
      if (otsuText !== "" && !INTEGER.test(otsuText))
        fail(record, "乙欄 of a point is not a number");
      const at = yen(point[1]);
      kouPoints.push({ at, kou: kou.map(yen) });
      if (otsuText !== "") otsuPoints.push({ at, otsu: yen(otsuText) });
      current = null;
      continue;
    }
    const over = OVER.exec(label);
    if (over?.[1]) {
      if (!isBlank(row, [FROM, KOU_TEXT])) fail(record, "unexpected cells on a …円を超え row");
      current = { record, over: yen(over[1]), under: null, tail: null, texts: [] };
      if (kouText !== "") current.texts.push(kouText);
      segments.push(current);
      continue;
    }
    const under = UNDER.exec(label);
    if (under?.[1]) {
      if (!current || current.under !== null || !isBlank(row, [FROM])) {
        fail(record, "a …円に満た row must follow one …円を超え row");
      }
      current.under = yen(under[1]);
      continue;
    }
    if (label === BOUNDED_TAIL || label === OPEN_TAIL) {
      if (!current || current.tail !== null || !isBlank(row, [FROM, KOU_TEXT])) {
        fail(record, `"${label}" must close one segment`);
      }
      current.tail = label;
      if (kouText !== "") current.texts.push(kouText);
      if (label === OPEN_TAIL) notesFrom = record + 1;
      continue;
    }
    if (label === "" && kouText !== "" && isBlank(row, [KOU_TEXT])) {
      if (!current) fail(record, "a 甲欄 formula text outside a segment");
      current.texts.push(kouText);
      continue;
    }
    if (label === "" && otsuText !== "" && isBlank(row, [OTSU])) {
      const formula = OTSU_FORMULA.exec(otsuText);
      if (!formula?.[1] || !formula[2] || !formula[3]) {
        return fail(record, `乙欄 text "${otsuText}" is not a formula`);
      }
      const parsed = {
        record,
        base: yen(formula[1]),
        over: yen(formula[2]),
        ratePercent: formula[3],
      };
      const seen = otsuFormulas.get(parsed.over);
      if (seen && (seen.base !== parsed.base || seen.ratePercent !== parsed.ratePercent)) {
        fail(record, `乙欄 formulas above ${parsed.over} 円 disagree`);
      }
      if (!seen) otsuFormulas.set(parsed.over, parsed);
      continue;
    }
    fail(record, "is not a row of the formula part (point, …を超え, …に満た, formula text)");
  }
  if (notesFrom < 0) return fail(rows.length - 1, `no open-ended "${OPEN_TAIL}" row`);

  // 甲欄 segments: the text of each must name its own lower end; the ends must be the points.
  const kouSegments = segments.map((segment): WithholdingSegmentJson => {
    const formula = KOU_FORMULA.exec(segment.texts.join(""));
    if (!formula?.[1] || !formula[2] || !formula[3]) {
      return fail(segment.record, `the formula "${segment.texts.join("")}" is not recognised`);
    }
    if (yen(formula[1]) !== segment.over || yen(formula[2]) !== segment.over) {
      fail(segment.record, `the formula does not start at ${segment.over} 円`);
    }
    if ((segment.under === null) !== (segment.tail === OPEN_TAIL)) {
      fail(segment.record, "the upper end and the closing text disagree");
    }
    return { over: segment.over, under: segment.under, ratePercent: formula[3] };
  });
  checkSegments(kouSegments, kouPoints, "甲欄", fail);

  // 乙欄 segments: one formula from each 乙欄 point, its base equal to the point's tax.
  const otsuSegments = [...otsuFormulas.values()]
    .sort((a, b) => a.over - b.over)
    .map((formula, index, all): WithholdingSegmentJson => {
      const point = otsuPoints[index];
      if (!point || point.at !== formula.over || point.otsu !== formula.base) {
        fail(
          formula.record,
          `乙欄 formula ${formula.base} 円 + over ${formula.over} 円 has no point`,
        );
      }
      return {
        over: formula.over,
        under: all[index + 1]?.over ?? null,
        ratePercent: formula.ratePercent,
      };
    });
  checkSegments(otsuSegments, otsuPoints, "乙欄", fail);
  if (otsuPoints[0]?.at !== kouPoints[0]?.at)
    fail(firstPoint, "乙欄 and 甲欄 points must start together");

  checkBands(bands, lowBand.below, kouPoints, otsuPoints, fail);

  // Notes: 1 人ごとに N 円 (beyond 7 dependents, and per secondary dependent for 乙欄).
  const deductions = rows
    .slice(notesFrom)
    .flatMap((row) => row.flatMap((value) => [...value.matchAll(DEDUCTION)].map((m) => m[1] ?? "")))
    .map(yen);
  const deduction = deductions[0];
  if (deduction === undefined || deductions.length < 2 || deductions.some((d) => d !== deduction)) {
    fail(notesFrom, "the notes must state one amount per extra dependent (1人ごとにN円)");
  }

  return {
    kind: "withholding-monthly",
    id: `withholding-monthly-${year}`,
    title: `${title}月額表`,
    effectiveFrom: `${year}-01-01`,
    effectiveTo: `${year}-12-31`,
    legalBasis: basis[1],
    source: {
      url: source.url,
      fetchedAt: source.fetchedAt,
      sha256: source.sha256,
      note: source.note,
    },
    lowBand,
    bands,
    kouPoints,
    kouSegments,
    otsuPoints,
    otsuSegments,
    extraDependentDeduction: deduction,
  };
}

type Fail = (record: number | null, problem: string) => never;

function checkSegments(
  segments: readonly WithholdingSegmentJson[],
  points: readonly { at: number }[],
  column: string,
  fail: Fail,
): void {
  if (points.length === 0 || segments.length !== points.length) {
    fail(null, `${column}: one formula segment is needed from each point`);
  }
  points.forEach((point, index) => {
    if (index > 0 && point.at <= points[index - 1]!.at)
      fail(null, `${column}: points must increase`);
    const segment = segments[index]!;
    const next = points[index + 1]?.at ?? null;
    if (segment.over !== point.at || segment.under !== next) {
      fail(
        0,
        `${column}: the segment over ${segment.over} 円 must run from ${point.at} to ${next ?? "no limit"}`,
      );
    }
  });
}

function checkBands(
  bands: WithholdingJson["bands"],
  below: number,
  kouPoints: WithholdingJson["kouPoints"],
  otsuPoints: WithholdingJson["otsuPoints"],
  fail: Fail,
): void {
  if (bands.length === 0) fail(null, "no table rows");
  let previous: { kou: number[]; otsu: number } | null = null;
  let end = below;
  for (const band of bands) {
    const where = `the row ${band.from}〜${band.to}`;
    if (band.from !== end) fail(null, `${where} must start at ${end} (no gap or overlap)`);
    if (band.to <= band.from) fail(null, `${where} is empty`);
    checkRow(band.kou, band.otsu, where, fail);
    if (previous) checkNotDecreasing(previous, band, where, fail);
    previous = band;
    end = band.to;
  }
  if (kouPoints[0]?.at !== end) fail(null, `the rows must end at the first point (${end})`);
  for (const point of kouPoints) {
    const where = `the point ${point.at}`;
    const otsu = otsuPoints.find((candidate) => candidate.at === point.at)?.otsu ?? null;
    checkRow(point.kou, otsu, where, fail);
    checkNotDecreasing(previous!, { kou: point.kou, otsu: otsu ?? previous!.otsu }, where, fail);
    previous = { kou: point.kou, otsu: otsu ?? previous!.otsu };
  }
}

function checkRow(kou: readonly number[], otsu: number | null, where: string, fail: Fail): void {
  if (kou.length !== KOU_COLUMNS) fail(null, `${where}: 甲欄 must have ${KOU_COLUMNS} columns`);
  kou.forEach((value, index) => {
    if (index > 0 && value > kou[index - 1]!)
      fail(null, `${where}: 甲欄 must not increase with dependents`);
  });
  if (otsu !== null && otsu < kou[0]!) fail(null, `${where}: 乙欄 must not be less than 甲欄 0 人`);
}

function checkNotDecreasing(
  previous: { kou: readonly number[]; otsu: number },
  current: { kou: readonly number[]; otsu: number },
  where: string,
  fail: Fail,
): void {
  const lower = current.kou.some((value, index) => value < previous.kou[index]!);
  if (lower || current.otsu < previous.otsu)
    fail(null, `${where}: tax must not fall from the row before`);
}
