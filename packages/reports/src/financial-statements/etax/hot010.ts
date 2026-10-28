/**
 * 財務諸表 CSV, HOT010 Ver.3.0 (17-financial-statements §5; 国税庁「CSV 形式データのレコードの内容等」).
 * One file per statement: Shift_JIS, CRLF, no BOM, 5 columns (種別又は勘定科目 ・ 内容又は金額等 ・
 * 行区分 ・ 階層番号 ・ 勘定科目コード). Rows 1–5 are A (the statement) / B (法人名) / C1 / C2 (the
 * period) / the statement's name; the rest are the lines of the statement — the same lines as the
 * screens and the PDF. Before encoding, the rows are checked against the code table: 階層番号 never
 * jumps by 2 or more, a code appears once (except the repeatable ones of NT), the row kinds hold.
 */
import { zipFiles } from "../../exports/backup";
import { encodeCsv } from "../../csv";
import { reportFileName } from "../../format";
import type { FinancialStatementsReport } from "../report";
import type { StatementLine } from "../statements";
import {
  codeRow,
  ETAX_STATEMENTS,
  ETAX_STATEMENT_NAMES,
  type EtaxCodeTable,
  type EtaxRowKind,
  type EtaxStatement,
} from "./editions";
import { EtaxTextConverter } from "./jis";

export const HOT010_FORM = "HOT010";
export const HOT010_VERSION = "3.0";
export const HOT010_COLUMN_COUNT = 5;
/** 法人名: full width, 50 characters at most. */
export const HOT010_NAME_MAX_LENGTH = 50;
/** An amount: 16 characters at most, the minus sign included. */
export const HOT010_AMOUNT_MAX_LENGTH = 16;
export const HOT010_CODE_MAX_LENGTH = 20;

/** `HOT010_3.0_BS.csv` */
export function hot010FileName(statement: EtaxStatement): string {
  return `${HOT010_FORM}_${HOT010_VERSION}_${statement}.csv`;
}

/** One line of a statement before the text conversion. */
export interface Hot010SourceRow {
  label: string;
  /** An amount, a text (`2`), or `null` (a title). */
  value: bigint | string | null;
  rowKind: EtaxRowKind;
  depth: number;
  code: string;
  /** Text values may break lines (they are quoted). */
  multiline?: boolean;
}

/** One data row as written (texts converted to full width). */
export interface Hot010Row {
  label: string;
  value: string;
  rowKind: EtaxRowKind;
  depth: number;
  code: string;
}

export interface Hot010File {
  statement: EtaxStatement;
  fileName: string;
  /** The data rows (row 6 onwards). */
  rows: Hot010Row[];
  /** With CRLF line ends (a trailing CRLF included). */
  text: string;
  /** Shift_JIS */
  bytes: Uint8Array;
}

function statementRows(lines: readonly StatementLine[]): Hot010SourceRow[] {
  return lines.map((line) => ({
    label: line.label,
    value: line.kind === "title" ? null : line.amount,
    rowKind: line.kind === "title" ? "T" : "1",
    depth: line.depth,
    code: line.code,
  }));
}

/** The lines of each statement (§5.3). */
export function hot010SourceRows(
  report: FinancialStatementsReport,
  statement: EtaxStatement,
): Hot010SourceRow[] {
  const { edition } = report;
  switch (statement) {
    case "BS":
      return statementRows(report.balanceSheet.lines);
    case "PL":
      return statementRows(report.incomeStatement.lines);
    case "SS":
      return report.equityStatement.lines.map((line) => ({
        label: line.label,
        value: line.kind === "title" ? null : line.amount,
        rowKind: line.kind === "title" ? "T" : "1",
        depth: line.depth,
        code: line.code,
      }));
    case "NT": {
      const table = edition.tables.NT;
      const codes = edition.layout.notes;
      const row = (code: string, value: string | null, label?: string): Hot010SourceRow => {
        const tableRow = codeRow(table, code);
        if (!tableRow) throw new Error(`reports: NT code ${code} is not in the table`);
        return {
          label: label ?? tableRow.label,
          value,
          rowKind: tableRow.title ? "T" : (tableRow.rowKind ?? "2"),
          depth: tableRow.depth,
          code,
          multiline: true,
        };
      };
      const rows: Hot010SourceRow[] = [];
      for (const section of report.notes.sections) {
        if (section.code === codes.accountingPolicies) {
          rows.push(row(section.code, section.body));
          for (const item of section.items) rows.push(row(item.code, item.body));
        } else if (section.code === codes.equityNote) {
          rows.push(row(section.code, section.body));
          rows.push(row(codes.shareClasses, ""));
          rows.push(row(codes.issuedShares, ""));
          rows.push(row(codes.commonShares, ""));
          rows.push(row(codes.commonSharesAtEnd, `${report.notes.issuedShares ?? ""}株`));
        } else if (section.code === codes.otherNotes) {
          // One set (NT1201 with its NT1202 / NT1203) per item: a set cannot repeat its items.
          for (const item of section.items) {
            rows.push(row(codes.otherNotes, null));
            rows.push(row(codes.otherNoteTitle, item.title));
            rows.push(row(codes.otherNoteBody, item.body));
          }
        }
      }
      return rows;
    }
  }
}

function parseBranch(code: string): { base: string; branch: number } | null {
  const match = /^(.+)-(\d+)$/.exec(code);
  if (!match) return null;
  const branch = Number(match[2]);
  return Number.isSafeInteger(branch) && branch > 0 ? { base: match[1]!, branch } : null;
}

/**
 * Checks the data rows against §5.2: 階層番号 ≥ 2 and never more than 1 deeper than the row above
 * (the first row is 2), codes from the table (or a branch of one) used once unless repeatable,
 * titles as `T` without a value, amounts as plain integers. Throws on the first violation: it means
 * a bug in the statements, never something the owner can fix.
 */
export function assertHot010Rows(
  statement: EtaxStatement,
  rows: readonly Hot010Row[],
  table: EtaxCodeTable,
): void {
  const fail = (i: number, why: string): never => {
    throw new Error(`reports: HOT010 ${statement} row ${i + 6} (${rows[i]?.code ?? ""}): ${why}`);
  };
  let previousDepth = 1;
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    if (!Number.isInteger(row.depth) || row.depth < 2) fail(i, `depth ${row.depth} is below 2`);
    if (row.depth > previousDepth + 1) {
      fail(i, `depth ${row.depth} jumps from ${previousDepth}`);
    }
    previousDepth = row.depth;
    if (row.code.length === 0 || row.code.length > HOT010_CODE_MAX_LENGTH) fail(i, "code length");
    const branch = parseBranch(row.code);
    const tableRow = codeRow(table, branch ? branch.base : row.code);
    if (!tableRow) fail(i, "the code is not in the table");
    if (seen.has(row.code) && !(tableRow?.repeat && !branch)) fail(i, "the code appears twice");
    seen.add(row.code);
    switch (row.rowKind) {
      case "T":
        if (row.value !== "") fail(i, "a title row has a value");
        break;
      case "1":
        if (!/^-?\d+$/.test(row.value) || row.value.length > HOT010_AMOUNT_MAX_LENGTH) {
          fail(i, `amount ${row.value} is not a plain integer of 16 characters at most`);
        }
        break;
      case "2":
        break;
    }
    if (tableRow?.title && !branch && row.rowKind !== "T") fail(i, "a title item must be T");
  });
}

function quoteValue(value: string): string {
  return value.includes("\r\n") ? `"${value}"` : value;
}

function fileText(header: readonly string[][], rows: readonly Hot010Row[]): string {
  const lines = header.map((cells) => cells.join(","));
  for (const row of rows) {
    const cells = [row.label, quoteValue(row.value), row.rowKind, String(row.depth), row.code];
    if (cells.length !== HOT010_COLUMN_COUNT)
      throw new Error("reports: HOT010 row is not 5 columns");
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function buildFile(
  report: FinancialStatementsReport,
  statement: EtaxStatement,
  converter: EtaxTextConverter,
): Omit<Hot010File, "bytes"> {
  const name = converter.convert(report.company.name, "法人名");
  if ([...name].length > HOT010_NAME_MAX_LENGTH) {
    throw new Error(`法人名は全角${HOT010_NAME_MAX_LENGTH}文字以内です（e-Tax の財務諸表 CSV）`);
  }
  const header = [
    ["A", statement, "", "", ""],
    ["B", name, "", "", ""],
    ["C1", report.fiscalYear.startDate, "", "", ""],
    ["C2", report.fiscalYear.endDate, "", "", ""],
    [ETAX_STATEMENT_NAMES[statement], "", "", "", ""],
  ];
  const where = statement === "NT" ? "注記" : "科目";
  const rows = hot010SourceRows(report, statement).map((source): Hot010Row => {
    const label = converter.convert(source.label, `${where}「${source.label}」`);
    let value = "";
    if (typeof source.value === "bigint") value = source.value.toString();
    else if (typeof source.value === "string") {
      value = converter.convert(source.value, `${where}「${source.label}」`, {
        multiline: source.multiline ?? false,
      });
    }
    return { label, value, rowKind: source.rowKind, depth: source.depth, code: source.code };
  });
  assertHot010Rows(statement, rows, report.edition.tables[statement]);
  return { statement, fileName: hot010FileName(statement), rows, text: fileText(header, rows) };
}

/**
 * The CSV of one statement. Throws `EtaxCharacterError` when a name or a note has a character
 * e-Tax does not accept (the screen shows which and where).
 */
export function buildHot010File(
  report: FinancialStatementsReport,
  statement: EtaxStatement,
): Hot010File {
  const converter = new EtaxTextConverter();
  const file = buildFile(report, statement, converter);
  converter.throwIfAny();
  return { ...file, bytes: encodeCsv(file.text, "sjis") };
}

/** The four CSV files; every character problem of all four is reported at once. */
export function buildHot010Files(report: FinancialStatementsReport): Hot010File[] {
  const converter = new EtaxTextConverter();
  const files = ETAX_STATEMENTS.map((statement) => buildFile(report, statement, converter));
  converter.throwIfAny();
  return files.map((file) => ({ ...file, bytes: encodeCsv(file.text, "sjis") }));
}

/** `etax-hot010_20261102-20270331.zip` (ASCII). */
export function hot010ZipFileName(report: FinancialStatementsReport): string {
  return reportFileName(
    "etax-hot010",
    report.fiscalYear.startDate,
    report.fiscalYear.endDate,
    "zip",
  );
}

/** The four files in one zip (17 §5.1). */
export function buildHot010Zip(report: FinancialStatementsReport): {
  fileName: string;
  bytes: Uint8Array;
  files: Hot010File[];
} {
  const files = buildHot010Files(report);
  const bytes = zipFiles(
    files.map((file) => ({ path: file.fileName, content: file.bytes, contentType: "text/csv" })),
  );
  return { fileName: hot010ZipFileName(report), bytes, files };
}
