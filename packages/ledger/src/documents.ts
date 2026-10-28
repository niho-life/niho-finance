import type { CalendarDate } from "./date";
import { abs, formatYen, type Money } from "./money";

/**
 * Evidence (証憑) vocabulary shared by the repository, the API and the screens
 * (13-documents §8.2): owner-facing labels of the enum values (never shown raw, 05-ui-ux §4), the
 * accepted file formats, the link-candidate windows and the index (索引簿) CSV. Pure: no I/O.
 */

export const DOCUMENT_KINDS = [
  "receipt",
  "invoice_in",
  "invoice_out",
  "contract",
  "statement",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Readonly<Record<DocumentKind, string>> = {
  receipt: "領収書",
  invoice_in: "受領した請求書",
  invoice_out: "発行した請求書の写し",
  contract: "契約書",
  statement: "明細書",
  other: "その他",
};

export const DOCUMENT_SOURCES = ["upload", "camera", "email", "stripe", "generated"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const DOCUMENT_SOURCE_LABELS: Readonly<Record<DocumentSource, string>> = {
  upload: "アップロード",
  camera: "撮影",
  email: "メール",
  stripe: "Stripe",
  generated: "生成",
};

export const DOCUMENT_STATUSES = ["inbox", "linked", "voided"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const DOCUMENT_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  inbox: "未紐づけ",
  linked: "紐づけ済み",
  voided: "無効",
};

/**
 * Tabs of the list (13 §3.2). `inbox` (受信箱) holds the documents that still need work: not linked
 * yet, or linked while 未整理 (`isUnsortedDocument`); never voided ones. `all` includes voided ones.
 */
export const DOCUMENT_TABS = ["inbox", "all", "voided"] as const;
export type DocumentTab = (typeof DOCUMENT_TABS)[number];

export const DOCUMENT_TAB_LABELS: Readonly<Record<DocumentTab, string>> = {
  inbox: "受信箱",
  all: "すべて",
  voided: "無効",
};

/** What a document can be linked to (`DocumentLink` has exactly one of the three targets). */
export const DOCUMENT_LINK_KINDS = ["journal_entry", "wallet_transaction", "invoice"] as const;
export type DocumentLinkKind = (typeof DOCUMENT_LINK_KINDS)[number];

export const DOCUMENT_LINK_KIND_LABELS: Readonly<Record<DocumentLinkKind, string>> = {
  journal_entry: "仕訳",
  wallet_transaction: "明細",
  invoice: "請求書",
};

/** Audit log actions of the evidence module (13 §1). */
export const DOCUMENT_AUDIT_ACTIONS = [
  "document.create",
  "document.update",
  "document.link",
  "document.unlink",
  "document.void",
  "document.export",
  "records_policy.save",
] as const;
export type DocumentAuditAction = (typeof DOCUMENT_AUDIT_ACTIONS)[number];

export const DOCUMENT_AUDIT_ACTION_LABELS: Readonly<Record<DocumentAuditAction, string>> = {
  "document.create": "保存",
  "document.update": "変更",
  "document.link": "紐づけ",
  "document.unlink": "紐づけを外す",
  "document.void": "無効",
  "document.export": "索引簿の書き出し",
  "records_policy.save": "規程の保存",
};

/**
 * Link candidates (13 §4) lie within ± this many days of the transaction date: lines and entries of
 * the same |amount|, or, while the amount is empty, pending lines of any amount.
 */
export const DOCUMENT_CANDIDATE_WINDOW_DAYS = 7;
/** With an amount but no transaction date: from this many days before the upload day to that day. */
export const DOCUMENT_UNDATED_CANDIDATE_DAYS = 30;
/** Without an amount or a transaction date: from this many days before the upload day to the next day. */
export const DOCUMENT_UNPRICED_CANDIDATE_DAYS = 7;
/** Candidates shown per kind (statement lines / entries). */
export const DOCUMENT_CANDIDATE_LIMIT = 10;

/** One file is at most 20 MB. */
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 未整理: one of the three items that 規程 第10条 requires to be recorded is still empty — the
 * transaction date, the amount, or the partner (neither a partner of the master nor a free-text
 * name). Such a document stays in the inbox even when linked, until all three are recorded.
 * Empty dates and amounts never match a search on that item (13 §3.2).
 */
export function isUnsortedDocument(document: {
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerId: string | null;
  partnerName: string | null;
}): boolean {
  return (
    document.txnDate === null ||
    document.amount === null ||
    (document.partnerId === null && document.partnerName === null)
  );
}

// ---------------------------------------------------------------------------
// File formats (13 §6)
// ---------------------------------------------------------------------------

export const ACCEPTED_DOCUMENT_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/csv",
] as const;
export type DocumentMime = (typeof ACCEPTED_DOCUMENT_MIMES)[number];

export function isAcceptedDocumentMime(value: unknown): value is DocumentMime {
  return (
    typeof value === "string" && (ACCEPTED_DOCUMENT_MIMES as readonly string[]).includes(value)
  );
}

const EXTENSION_BY_MIME: Readonly<Record<DocumentMime, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "text/csv": "csv",
};

const MIME_BY_EXTENSION: Readonly<Record<string, DocumentMime>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  csv: "text/csv",
};

/** Non-standard names some systems report for an accepted format (e.g. Android's CSV type). */
const MIME_ALIASES: Readonly<Record<string, DocumentMime>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "text/comma-separated-values": "text/csv",
  "text/x-csv": "text/csv",
  "application/csv": "text/csv",
};

/**
 * Browser `File.type`s that say nothing reliable about the file: the extension decides. Windows
 * reports CSV as `application/vnd.ms-excel` when Excel is installed, and HEIC is often blank.
 */
const UNINFORMATIVE_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "text/plain",
  "application/vnd.ms-excel",
]);

function extensionOf(filename: string): string | null {
  const name = filename.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1) : null;
}

/**
 * The accepted MIME type of an uploaded file from the browser's `type` and the file name, or `null`
 * when the format is not accepted. The bytes are checked separately when the upload completes.
 */
export function normalizeDocumentMime(
  type: string | null | undefined,
  filename: string | null | undefined,
): DocumentMime | null {
  const base = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (isAcceptedDocumentMime(base)) return base;
  const alias = MIME_ALIASES[base];
  if (alias) return alias;
  if (!UNINFORMATIVE_TYPES.has(base)) return null;
  const extension = extensionOf(filename ?? "");
  return extension === null ? null : (MIME_BY_EXTENSION[extension] ?? null);
}

/** File extension (without the dot) for an accepted MIME type, `null` otherwise. */
export function extensionForMime(mime: string): string | null {
  return isAcceptedDocumentMime(mime) ? EXTENSION_BY_MIME[mime] : null;
}

const PREVIEWABLE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

/** Browsers show these inline (`<img>` / `<iframe>`); HEIC and CSV are opened as files instead. */
export function isPreviewableMime(mime: string): boolean {
  return PREVIEWABLE_MIMES.has(mime);
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180)
// ---------------------------------------------------------------------------

export type CsvCell = string | number | bigint | null | undefined;

/** The byte order mark that makes Excel read the file as UTF-8. */
export const CSV_BOM = "\uFEFF";

/** A text cell starting with one of these is read as a formula by spreadsheets (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function csvField(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  // Numbers are written as they are: they cannot carry a formula.
  if (typeof cell !== "string") return String(cell);
  if (FORMULA_START.test(cell)) return `"'${cell.replaceAll('"', '""')}"`;
  return NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * CSV text (RFC 4180): fields with a comma, a double quote or a line break are quoted, quotes are
 * doubled, every record ends with CRLF and the text starts with a BOM. Text cells that a spreadsheet
 * would run as a formula (`=` `+` `-` `@`, tab, CR) are quoted and prefixed with `'`.
 */
export function toCsv(rows: Iterable<readonly CsvCell[]>): string {
  let text = CSV_BOM;
  for (const row of rows) text += `${row.map(csvField).join(",")}\r\n`;
  return text;
}

// ---------------------------------------------------------------------------
// Index (索引簿, 13 §7)
// ---------------------------------------------------------------------------

export const DOCUMENT_INDEX_COLUMNS = [
  "証憑ID",
  "取引年月日",
  "取引金額",
  "取引先",
  "登録番号",
  "種別",
  "状態",
  "無効の理由",
  "仕訳番号",
  "明細",
  "ファイル名",
  "形式",
  "SHA-256",
  "保存日時",
  "保存者",
  "メモ",
] as const;

/** One document of the index, as the repository loads it. */
export interface DocumentIndexRow {
  id: string;
  txnDate: CalendarDate | null;
  /** Tax-inclusive whole yen. */
  amount: Money | null;
  /** The partner master's name, or the free-text name. */
  partnerName: string | null;
  invoiceRegistrationNumber: string | null;
  kind: DocumentKind;
  status: DocumentStatus;
  voidReason: string | null;
  /** Linked entries (第 n 期 No. m). */
  journalEntries: readonly { fiscalYearNo: number; no: number }[];
  /** Linked statement lines; `amount` is signed as stored. */
  walletTransactions: readonly { walletName: string; txnDate: CalendarDate; amount: Money }[];
  originalName: string | null;
  mime: string;
  sha256: string;
  uploadedAt: Date;
  uploadedBy: string;
  note: string | null;
}

const JST_DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `2026/11/07 10:12:34` in Japan time. */
function formatJapanDateTime(at: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    JST_DATE_TIME.formatToParts(at).find((item) => item.type === type)?.value ?? "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function slashDate(date: CalendarDate): string {
  return date.replaceAll("-", "/");
}

/** The cells of one index row, in the order of `DOCUMENT_INDEX_COLUMNS`. */
export function documentIndexCells(row: DocumentIndexRow): string[] {
  return [
    row.id,
    row.txnDate === null ? "" : slashDate(row.txnDate),
    row.amount === null ? "" : row.amount.toString(),
    row.partnerName ?? "",
    row.invoiceRegistrationNumber ?? "",
    DOCUMENT_KIND_LABELS[row.kind],
    DOCUMENT_STATUS_LABELS[row.status],
    row.voidReason ?? "",
    row.journalEntries.map((entry) => `第${entry.fiscalYearNo}期 No.${entry.no}`).join(" / "),
    row.walletTransactions
      .map((line) => `${line.walletName} ${slashDate(line.txnDate)} ${formatYen(abs(line.amount))}`)
      .join(" / "),
    row.originalName ?? "",
    row.mime,
    row.sha256,
    formatJapanDateTime(row.uploadedAt),
    row.uploadedBy,
    row.note ?? "",
  ];
}
