/**
 * 受け渡しパッケージ (14-reports §15): one zip per fiscal year for the tax accountant — the books
 * (S7's CSV and PDF), the fixed assets and consumption tax, the statements of a closed year (#15),
 * the index of the documents (13 §7) and, optionally, the document files. Every file comes from the
 * existing exports; this module only plans the entries, writes README.txt and manifest.json, and
 * streams the zip (`writeHandoverPackage`). Pure: the PDFs and the document files come in through
 * functions, and the zip goes out through `sink`.
 */
import {
  DEPRECIATION_METHOD_LABELS,
  DOCUMENT_INDEX_COLUMNS,
  documentIndexCells,
  FISCAL_YEAR_STATUS_LABELS,
  toCsv,
  type CalendarDate,
  type DepreciationMethod,
  type DocumentIndexRow,
  type FiscalYearStatus,
  type Money,
} from "@niho-finance/ledger";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { csvText, encodeCsv, type CsvCell } from "./csv";
import { archiveFileName, type ArchiveDocument } from "./exports/documents-archive";
import { freeeJournalRows } from "./exports/freee";
import { yayoiJournalRows } from "./exports/yayoi";
import {
  accountDetailsCsv,
  accountDetailsCsvRows,
  buildAccountDetails,
} from "./financial-statements/account-details";
import {
  buildConsumptionTaxSummary,
  consumptionTaxCsv,
  consumptionTaxCsvRows,
} from "./financial-statements/consumption-tax";
import { EtaxCharacterError } from "./financial-statements/etax/jis";
import { buildHot010Files } from "./financial-statements/etax/hot010";
import {
  buildFinancialStatements,
  type FinancialStatementsReport,
} from "./financial-statements/report";
import type { FixedAssetRegisterRow } from "./financial-statements/schedules";
import type { FinancialStatementsSource } from "./financial-statements/source";
import { compactDate, reportFileName, slashDate, slashPeriod } from "./format";
import { buildGeneralLedger, LEDGER_CSV_HEADER, ledgerCsvRows } from "./general-ledger";
import { journalCsvRows, journalEntries } from "./journal";
import type { ReportPeriod } from "./period";
import { compareAccounts, type ReportSource } from "./source";

// ---------------------------------------------------------------------------
// Constants (§15.2, §15.4)
// ---------------------------------------------------------------------------

export const HANDOVER_PACKAGE_FORMAT = "niho-finance-handover-package";
/** The version of the package's layout (manifest.json). */
export const HANDOVER_PACKAGE_VERSION = 1;
/** The books count as 2 MB in the estimate (§15.4). */
export const HANDOVER_BOOKS_ESTIMATE_BYTES = 2 * 1024 * 1024;
/** Up to this estimate the screen makes the zip itself; above it a job does (§15.4). */
export const HANDOVER_DIRECT_LIMIT_BYTES = 20 * 1024 * 1024;

export const HANDOVER_README_PATH = "README.txt";
export const HANDOVER_MANIFEST_PATH = "manifest.json";
export const HANDOVER_INDEX_PATH = "documents/index.csv";
/** The index column after the 13 §7 columns. */
export const HANDOVER_PACKAGED_FILE_COLUMN = "パッケージ内のファイル";
/** What the column says when the storage did not return the file. */
export const HANDOVER_FILE_UNAVAILABLE = "（取得できませんでした）";

export const HANDOVER_FORMATS = {
  utf8Csv: "UTF-8（BOM 付き）・CSV",
  sjisCsv: "Shift_JIS・CSV",
  pdf: "PDF",
} as const;

/** Size estimate of a package: the books plus the documents' files when they are included. */
export function handoverEstimateBytes(input: {
  includeDocuments: boolean;
  documentBytes: number;
}): number {
  return HANDOVER_BOOKS_ESTIMATE_BYTES + (input.includeDocuments ? input.documentBytes : 0);
}

/** `direct` (the screen makes and returns it) or `job` (Cloud Tasks → the jobs service). */
export function handoverDelivery(estimateBytes: number): "direct" | "job" {
  return estimateBytes <= HANDOVER_DIRECT_LIMIT_BYTES ? "direct" : "job";
}

/** `handover_fy1_20261102-20270331.zip` (ASCII). */
export function handoverZipName(year: {
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
}): string {
  return `handover_fy${year.no}_${compactDate(year.startDate)}-${compactDate(year.endDate)}.zip`;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One generated file of the package (the books, closing and statements folders). */
export interface HandoverPackageEntry {
  /** ASCII path in the zip. */
  path: string;
  /** 「仕訳帳」 */
  description: string;
  /** 「UTF-8（BOM 付き）・CSV」 */
  format: string;
  /** CSV data rows (the header excluded); absent for a PDF. */
  rows?: number;
  content: Uint8Array;
}

/** One document of the year: its index row and, when files are included, a way to read it. */
export interface HandoverDocument {
  /** The row of the index (13 §7). */
  index: DocumentIndexRow;
  /** `documents/files/<id>.<ext>` (`handoverDocumentPath`). */
  path: string;
  mime: string;
  byteSize: number;
  /** The stored file, or `null` when the storage cannot return it. Called once, one at a time. */
  fetch: () => Promise<Uint8Array | null>;
}

export interface HandoverFiscalYear {
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  status: FiscalYearStatus;
}

export interface HandoverPackagePlan {
  company: string;
  fiscalYear: HandoverFiscalYear;
  createdAt: Date;
  /** The audit log actor of the request (README 作成者). */
  createdBy: string;
  includeDocuments: boolean;
  /** The generated files in zip order (`planHandoverBooks`). */
  entries: readonly HandoverPackageEntry[];
  /** The year's documents (S7's choice: `loadDocumentsForArchive`), voided ones included. */
  documents: readonly HandoverDocument[];
  /** Notes for README 注意 besides the standard ones (e.g. why HOT010 is not included). */
  notes?: readonly string[];
}

/** `documents/files/<id>.<ext>`: the name of S7's documents archive under `documents/`. */
export function handoverDocumentPath(document: ArchiveDocument): string {
  return `documents/${archiveFileName(document)}`;
}

// ---------------------------------------------------------------------------
// Rows that no other export shapes
// ---------------------------------------------------------------------------

/** The columns of a fixed asset row (#14's `loadFixedAssetLedger`) that the CSV writes. */
export interface HandoverFixedAssetRow {
  name: string;
  accountCode: string;
  accountName: string;
  acquisitionDate: CalendarDate;
  cost: Money;
  method: DepreciationMethod;
  usefulLifeYears: number | null;
  openingBookValue: Money;
  increase: Money;
  decrease: Money;
  depreciation: Money;
  closingBookValue: Money;
  accumulated: Money;
  disposedAt: CalendarDate | null;
  isDepreciableAssetTaxed: boolean;
  isSpecialSmallAsset: boolean;
}

export const FIXED_ASSET_LEDGER_CSV_HEADER = [
  "資産",
  "科目コード",
  "科目",
  "取得日",
  "取得価額",
  "償却方法",
  "耐用年数",
  "期首帳簿価額",
  "当期増加",
  "当期減少",
  "当期償却額",
  "期末帳簿価額",
  "減価償却累計額",
  "除却日",
  "償却資産税",
  "特例",
] as const;

/** 固定資産台帳 (§15.2): one row per asset, the header alone when there is none. */
export function fixedAssetLedgerCsvRows(rows: readonly HandoverFixedAssetRow[]): CsvCell[][] {
  const out: CsvCell[][] = [[...FIXED_ASSET_LEDGER_CSV_HEADER]];
  for (const row of rows) {
    out.push([
      row.name,
      row.accountCode,
      row.accountName,
      slashDate(row.acquisitionDate),
      row.cost,
      DEPRECIATION_METHOD_LABELS[row.method],
      row.usefulLifeYears ?? "",
      row.openingBookValue,
      row.increase,
      row.decrease,
      row.depreciation,
      row.closingBookValue,
      row.accumulated,
      row.disposedAt ? slashDate(row.disposedAt) : "",
      row.isDepreciableAssetTaxed ? "対象" : "対象外",
      row.isSpecialSmallAsset ? "該当" : "",
    ]);
  }
  return out;
}

/**
 * 総勘定元帳 for every account (§15.2): S7's ledger CSV (14 §8) of each account with a balance or a
 * movement, in code order, one under the other, with 科目コード・科目 in front. One header row.
 */
export function handoverGeneralLedgerCsvRows(
  source: ReportSource,
  period: ReportPeriod,
): CsvCell[][] {
  const rows: CsvCell[][] = [["科目コード", "科目", ...LEDGER_CSV_HEADER]];
  for (const account of [...source.accounts].sort(compareAccounts)) {
    const report = buildGeneralLedger(source, period, { accountId: account.id });
    if (report.empty) continue;
    for (const row of ledgerCsvRows(report).slice(1))
      rows.push([account.code, account.name, ...row]);
  }
  return rows;
}

/**
 * 証憑の索引簿 (§15.2): the 13 §7 columns plus 「パッケージ内のファイル」 — the file's path when it is in
 * the zip, 「（取得できませんでした）」 when the storage did not return it, empty when the package has
 * no files (`packaged` is `null`).
 */
export function handoverDocumentIndexRows(
  documents: readonly Pick<HandoverDocument, "index" | "path">[],
  packaged: { missing: ReadonlySet<string> } | null,
): string[][] {
  const rows: string[][] = [[...DOCUMENT_INDEX_COLUMNS, HANDOVER_PACKAGED_FILE_COLUMN]];
  for (const document of documents) {
    const file =
      packaged === null
        ? ""
        : packaged.missing.has(document.index.id)
          ? HANDOVER_FILE_UNAVAILABLE
          : document.path;
    rows.push([...documentIndexCells(document.index), file]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The book files of a year
// ---------------------------------------------------------------------------

/** What only the screens' code can build (14 §3–§4 tables, the PDFs of `apps/web`). */
export interface HandoverScreenOutputs {
  /** `trialBalanceCsvRows` of the whole company for the year; `count` = its account rows. */
  trialBalanceCsv: { rows: CsvCell[][]; count: number };
  trialBalancePdf: () => Promise<Uint8Array>;
  /** `monthlyCsvRows` of the whole company for the year; `count` = its data rows. */
  monthlyCsv: { rows: CsvCell[][]; count: number };
  /** 計算書類 (17 §4), the same PDF as `/closing/statements`. */
  statementsPdf: (report: FinancialStatementsReport) => Promise<Uint8Array>;
}

export interface HandoverBooksInput {
  source: FinancialStatementsSource;
  fiscalYearId: string;
  /** #14's `loadFixedAssetLedger(db, fiscalYearId).rows`. */
  fixedAssets: readonly HandoverFixedAssetRow[];
  /** `loadFixedAssetRegister(db, fiscalYearId)`, given to `buildFinancialStatements` (17 §10). */
  fixedAssetRegister: readonly FixedAssetRegisterRow[];
  screens: HandoverScreenOutputs;
}

export interface HandoverBooks {
  entries: HandoverPackageEntry[];
  /** README 注意 lines about what was left out. */
  notes: string[];
}

function utf8Csv(rows: readonly (readonly CsvCell[])[]): Uint8Array {
  return encodeCsv(csvText(rows), "utf8");
}

/** The whole fiscal year, whole company (the period every file of the package covers). */
export function handoverPeriod(source: ReportSource, fiscalYearId: string): ReportPeriod {
  const fiscalYear = source.fiscalYears.find((year) => year.id === fiscalYearId);
  if (!fiscalYear) throw new Error(`reports: fiscal year ${fiscalYearId} is not in the source`);
  return {
    fiscalYear,
    preset: "year",
    from: fiscalYear.startDate,
    to: fiscalYear.endDate,
    segmentId: null,
  };
}

/**
 * The generated files of the year in zip order (§15.2): books/, closing/ and — for a closed year —
 * statements/. HOT010 is left out (with the reason in `notes`) when a name has a character e-Tax
 * does not accept.
 */
export async function planHandoverBooks(input: HandoverBooksInput): Promise<HandoverBooks> {
  const { source, fiscalYearId, screens } = input;
  const period = handoverPeriod(source, fiscalYearId);
  const year = period.fiscalYear;
  const name = (report: string, extension: string) =>
    reportFileName(report, year.startDate, year.endDate, extension);
  const range = { from: year.startDate, to: year.endDate };
  const entries: HandoverPackageEntry[] = [];
  const notes: string[] = [];

  const journal = journalCsvRows(journalEntries(source, period, "all"));
  entries.push({
    path: `books/${name("journal", "csv")}`,
    description: "仕訳帳（取消済みの仕訳と反対仕訳を含む）",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: journal.length - 1,
    content: utf8Csv(journal),
  });
  const ledger = handoverGeneralLedgerCsvRows(source, period);
  entries.push({
    path: `books/${name("general-ledger", "csv")}`,
    description: "総勘定元帳（動きのある全科目を科目コードの順に）",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: ledger.length - 1,
    content: utf8Csv(ledger),
  });
  entries.push({
    path: `books/${name("trial-balance", "pdf")}`,
    description: "試算表（全社・期首〜期末）",
    format: HANDOVER_FORMATS.pdf,
    content: await screens.trialBalancePdf(),
  });
  entries.push({
    path: `books/${name("trial-balance", "csv")}`,
    description: "試算表（全社・期首〜期末）",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: screens.trialBalanceCsv.count,
    content: utf8Csv(screens.trialBalanceCsv.rows),
  });
  entries.push({
    path: `books/${name("monthly", "csv")}`,
    description: "月次推移（全社）",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: screens.monthlyCsv.count,
    content: utf8Csv(screens.monthlyCsv.rows),
  });
  const freee = freeeJournalRows(source, range);
  entries.push({
    path: `books/${name("journal-freee", "csv")}`,
    description: "仕訳（freee 会計の仕訳インポート形式）",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: freee.length - 1,
    content: utf8Csv(freee),
  });
  const yayoi = yayoiJournalRows(source, range);
  entries.push({
    path: `books/${name("journal-yayoi", "csv")}`,
    description: "仕訳（弥生会計の仕訳日記帳の形式。見出し行なし）",
    format: HANDOVER_FORMATS.sjisCsv,
    rows: yayoi.length,
    content: encodeCsv(csvText(yayoi), "sjis"),
  });

  const assets = fixedAssetLedgerCsvRows(input.fixedAssets);
  entries.push({
    path: `closing/${name("fixed-assets", "csv")}`,
    description: "固定資産台帳",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: assets.length - 1,
    content: utf8Csv(assets),
  });
  const summary = buildConsumptionTaxSummary(source, year.id);
  const tax = consumptionTaxCsv(summary);
  entries.push({
    path: `closing/${tax.fileName}`,
    description:
      year.consumptionTax === "exempt" ? "消費税の集計（免税の期。概算は参考）" : "消費税の集計",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: consumptionTaxCsvRows(summary).length - 1,
    content: tax.bytes,
  });

  if (year.status !== "closed") return { entries, notes };
  const report = buildFinancialStatements(source, year.id, {
    fixedAssets: input.fixedAssetRegister,
  });
  if (report.empty) {
    notes.push("この期には仕訳がないため、決算書は入っていません。");
    return { entries, notes };
  }
  entries.push({
    path: `statements/${name("financial-statements", "pdf")}`,
    description:
      "計算書類（貸借対照表・損益計算書・株主資本等変動計算書・個別注記表・附属明細書・事業報告）",
    format: HANDOVER_FORMATS.pdf,
    content: await screens.statementsPdf(report),
  });
  const details = buildAccountDetails(source, year.id);
  const detailsCsv = accountDetailsCsv(details);
  entries.push({
    path: `statements/${detailsCsv.fileName}`,
    description: "勘定科目内訳明細書の元データ",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: accountDetailsCsvRows(details).length - 1,
    content: detailsCsv.bytes,
  });
  try {
    for (const file of buildHot010Files(report)) {
      entries.push({
        path: `statements/etax/${file.fileName}`,
        description: "財務諸表 CSV（e-Tax の HOT010 Ver.3.0）",
        format: HANDOVER_FORMATS.sjisCsv,
        rows: file.rows.length,
        content: file.bytes,
      });
    }
  } catch (error) {
    if (!(error instanceof EtaxCharacterError)) throw error;
    notes.push(
      `財務諸表 CSV（e-Tax）は入れていません。${error.message}。決算書の画面で直してから作り直します。`,
    );
  }
  return { entries, notes };
}

// ---------------------------------------------------------------------------
// README and manifest
// ---------------------------------------------------------------------------

/** One file of the zip as listed in README 中身 and manifest.json. */
export interface HandoverListedFile {
  path: string;
  description: string;
  format: string;
  rows?: number;
  bytes: number;
  sha256: string;
}

export interface HandoverManifest {
  format: typeof HANDOVER_PACKAGE_FORMAT;
  version: typeof HANDOVER_PACKAGE_VERSION;
  createdAt: string;
  createdBy: string;
  company: string;
  fiscalYear: HandoverFiscalYear;
  includeDocuments: boolean;
  documents: { count: number; files: number; missing: string[] };
  /** Every file of the zip except README.txt and manifest.json, in zip order. */
  files: HandoverListedFile[];
}

const JST_MINUTE = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `2027/05/10 14:03` (JST). */
export function handoverDateTime(at: Date): string {
  const parts = Object.fromEntries(
    JST_MINUTE.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

/** The text of README.txt (§15.3), before the BOM and CRLF. */
export function handoverReadme(
  plan: Pick<
    HandoverPackagePlan,
    "company" | "fiscalYear" | "createdAt" | "createdBy" | "includeDocuments" | "notes"
  >,
  files: readonly HandoverListedFile[],
  missingDocuments: number,
): string {
  const year = plan.fiscalYear;
  const lines = [
    "受け渡しパッケージ",
    `会社: ${plan.company}`,
    `期間: 第${year.no}期 ${slashPeriod(year.startDate, year.endDate)}（${FISCAL_YEAR_STATUS_LABELS[year.status]}）`,
    `作成: ${handoverDateTime(plan.createdAt)}（作成者 ${plan.createdBy}）`,
    "",
    "■ 中身",
  ];
  for (const file of files) {
    lines.push(file.path);
    const rows = file.rows === undefined ? "" : `${file.rows} 件。`;
    lines.push(`  ${file.description}。${file.format}。${rows}SHA-256 ${file.sha256}`);
  }
  lines.push("■ 形式");
  lines.push(
    "- CSV は特記のない限り UTF-8（BOM 付き）・CRLF。カンマ・ダブルクォート・改行を含む値はダブルクォートで囲む。金額は符号付きの整数（円）、日付は YYYY/MM/DD。",
  );
  const sjis = files.filter((file) => file.format === HANDOVER_FORMATS.sjisCsv);
  if (sjis.length > 0) {
    lines.push(`- Shift_JIS のファイル: ${sjis.map((file) => file.path).join("・")}`);
  }
  lines.push(
    `- ${HANDOVER_INDEX_PATH} は証憑の索引簿。末尾の列「${HANDOVER_PACKAGED_FILE_COLUMN}」が documents/files/ のファイルと 1 対 1 で対応する。`,
  );
  lines.push(
    `- ${HANDOVER_MANIFEST_PATH} は機械向けの一覧（パス・件数・バイト数・SHA-256）。この README と manifest.json 自身は一覧に含めない。`,
  );
  lines.push("■ 注意");
  if (!plan.includeDocuments) {
    lines.push("- 証憑のファイルは含めていません（索引簿だけ）。");
  } else if (missingDocuments > 0) {
    lines.push(
      `- 証憑 ${missingDocuments} 件のファイルを取得できませんでした（索引簿の「${HANDOVER_PACKAGED_FILE_COLUMN}」を参照）。`,
    );
  }
  lines.push(
    year.status === "closed"
      ? "- 決算書は締めた期だけ入ります。"
      : "- 決算書は締めた期だけ入ります（この期はまだ締めていないため入っていません）。",
  );
  for (const note of plan.notes ?? []) lines.push(`- ${note}`);
  lines.push("- このパッケージは作成時点の帳簿から作りました。後から訂正した仕訳は入りません。");
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

/** Receives the zip in order; `final` marks the last chunk. Awaited before the next chunk. */
export type HandoverSink = (chunk: Uint8Array, final: boolean) => void | Promise<void>;

export interface HandoverPackageResult {
  /** Files in the zip, README.txt and manifest.json included. */
  fileCount: number;
  /** Bytes of the zip. */
  bytes: number;
  /** Documents of the year (rows of the index). */
  documentCount: number;
  /** Document files in the zip. */
  documentFileCount: number;
  /** Documents whose file the storage did not return (included files only). */
  missingDocumentIds: string[];
  manifest: HandoverManifest;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A copy backed by a plain ArrayBuffer (the DOM typing of `BufferSource` rejects a shared one).
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const MIME_LABELS: Readonly<Record<string, string>> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/heic": "HEIC",
  "image/webp": "WebP",
};

/** Text is deflated; PDFs and the documents (already compressed) are stored. */
function isCompressible(path: string): boolean {
  return /\.(csv|txt|json)$/i.test(path);
}

const encoder = new TextEncoder();

/**
 * Writes the package as a zip to `sink` (§15.6): the generated files, then each document file
 * (fetched one at a time and dropped once written), the index, README.txt and manifest.json. The
 * index, README and manifest come last because they say which document files could be fetched and
 * carry every file's SHA-256; README 中身 lists exactly the zip's other entries in the same order.
 */
export async function writeHandoverPackage(
  plan: HandoverPackagePlan,
  sink: HandoverSink,
): Promise<HandoverPackageResult> {
  const queue: { chunk: Uint8Array; final: boolean }[] = [];
  let failure: Error | null = null;
  let bytes = 0;
  const zip = new Zip((error, chunk, final) => {
    if (error) failure = error;
    else queue.push({ chunk, final });
  });
  const drain = async () => {
    if (failure) throw failure;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      bytes += next.chunk.byteLength;
      await sink(next.chunk, next.final);
    }
  };
  let fileCount = 0;
  const add = async (path: string, content: Uint8Array) => {
    const file = isCompressible(path)
      ? new ZipDeflate(path, { level: 6 })
      : new ZipPassThrough(path);
    file.mtime = plan.createdAt;
    zip.add(file);
    file.push(content, true);
    fileCount += 1;
    await drain();
  };

  const listed: HandoverListedFile[] = [];
  for (const entry of plan.entries) {
    listed.push({
      path: entry.path,
      description: entry.description,
      format: entry.format,
      ...(entry.rows === undefined ? {} : { rows: entry.rows }),
      bytes: entry.content.byteLength,
      sha256: await sha256Hex(entry.content),
    });
    await add(entry.path, entry.content);
  }

  const missing = new Set<string>();
  let documentFileCount = 0;
  if (plan.includeDocuments) {
    for (const document of plan.documents) {
      const content = await document.fetch();
      if (!content) {
        missing.add(document.index.id);
        continue;
      }
      listed.push({
        path: document.path,
        description: `証憑のファイル（証憑ID ${document.index.id}）`,
        format: `元の形式（${MIME_LABELS[document.mime] ?? document.mime}）`,
        bytes: content.byteLength,
        sha256: await sha256Hex(content),
      });
      await add(document.path, content);
      documentFileCount += 1;
    }
  }

  const indexRows = handoverDocumentIndexRows(
    plan.documents,
    plan.includeDocuments ? { missing } : null,
  );
  const index = encoder.encode(toCsv(indexRows));
  listed.push({
    path: HANDOVER_INDEX_PATH,
    description: "証憑の索引簿（無効にした証憑を含む）",
    format: HANDOVER_FORMATS.utf8Csv,
    rows: indexRows.length - 1,
    bytes: index.byteLength,
    sha256: await sha256Hex(index),
  });
  await add(HANDOVER_INDEX_PATH, index);

  const missingDocumentIds = [...missing];
  const readme = encodeCsv(handoverReadme(plan, listed, missing.size), "utf8");
  await add(HANDOVER_README_PATH, readme);
  const manifest: HandoverManifest = {
    format: HANDOVER_PACKAGE_FORMAT,
    version: HANDOVER_PACKAGE_VERSION,
    createdAt: plan.createdAt.toISOString(),
    createdBy: plan.createdBy,
    company: plan.company,
    fiscalYear: { ...plan.fiscalYear },
    includeDocuments: plan.includeDocuments,
    documents: {
      count: plan.documents.length,
      files: documentFileCount,
      missing: missingDocumentIds,
    },
    files: listed,
  };
  await add(HANDOVER_MANIFEST_PATH, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  zip.end();
  await drain();
  return {
    fileCount,
    bytes,
    documentCount: plan.documents.length,
    documentFileCount,
    missingDocumentIds,
    manifest,
  };
}

/** The whole zip in memory (the screen's direct download, up to the 20 MB estimate). */
export async function handoverPackageBytes(
  plan: HandoverPackagePlan,
): Promise<{ zip: Uint8Array; result: HandoverPackageResult }> {
  const chunks: Uint8Array[] = [];
  const result = await writeHandoverPackage(plan, (chunk) => {
    chunks.push(chunk);
  });
  const zip = new Uint8Array(result.bytes);
  let offset = 0;
  for (const chunk of chunks) {
    zip.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { zip, result };
}
