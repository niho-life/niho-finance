/**
 * The daily backup (14-reports §11.5): the book as JSON, CSV and beancount. S8's job writes the
 * files to GCS; the settings page zips them. Amounts are strings in JSON, dates `YYYY-MM-DD`.
 */
import type { CalendarDate, Money } from "@niho-finance/ledger";
import { zipSync } from "fflate";
import { csvText } from "../csv";
import { journalCsvRows, journalEntries } from "../journal";
import type { ReportPeriod } from "../period";
import type { ReportSource } from "../source";
import { buildBeancount } from "./beancount";

export interface BackupWalletTransaction {
  id: string;
  walletId: string;
  txnDate: CalendarDate;
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw: string | null;
  balanceAfter: Money | null;
  externalId: string;
  status: string;
  journalEntryId: string | null;
  ignoredReason: string | null;
}

export interface BackupDocument {
  id: string;
  kind: string;
  storageKey: string;
  sha256: string;
  mime: string;
  byteSize: number;
  originalName: string | null;
  uploadedAt: Date;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerId: string | null;
  partnerName: string | null;
  invoiceRegistrationNumber: string | null;
  status: string;
  journalEntryIds: readonly string[];
  walletTransactionIds: readonly string[];
}

export interface BackupTaxRateRule {
  taxCategoryCode: string;
  effectiveFrom: CalendarDate;
  effectiveTo: CalendarDate | null;
  ratePercent: number;
  deductiblePercent: number | null;
  enabled: boolean;
}

/** Everything the backup needs beyond the reports' source. */
export interface BackupSource extends ReportSource {
  settings: {
    company: Record<string, unknown>;
    taxRateRules: readonly BackupTaxRateRule[];
    partners: readonly Record<string, unknown>[];
    wallets: readonly Record<string, unknown>[];
  };
  walletTransactions: readonly BackupWalletTransaction[];
  documents: readonly BackupDocument[];
}

export interface BackupFile {
  path: string;
  content: Uint8Array;
  contentType: string;
}

export interface BackupManifest {
  exportedAt: string;
  company: string;
  fiscalYears: { no: number; startDate: CalendarDate; endDate: CalendarDate; status: string }[];
  files: { path: string; bytes: number; sha256: string; rows?: number }[];
}

/** JSON with bigint as decimal strings and Date as ISO text. */
export function backupJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A copy backed by a plain ArrayBuffer (the DOM typing of `BufferSource` rejects a shared one).
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const encoder = new TextEncoder();

function wholeBook(source: ReportSource): ReportPeriod | null {
  const years = [...source.fiscalYears].sort((a, b) => a.no - b.no);
  const first = years[0];
  const last = years[years.length - 1];
  if (!first || !last) return null;
  return {
    fiscalYear: first,
    preset: "custom",
    from: first.startDate,
    to: last.endDate,
    segmentId: null,
  };
}

export async function buildBackupFiles(
  source: BackupSource,
  options: { now: Date },
): Promise<BackupFile[]> {
  const period = wholeBook(source);
  const text = (path: string, content: string, contentType: string): BackupFile => ({
    path,
    content: encoder.encode(content),
    contentType,
  });
  const files: BackupFile[] = [];
  const rowCounts = new Map<string, number>();

  files.push(
    text(
      "settings.json",
      backupJson({
        company: source.settings.company,
        fiscalYears: source.fiscalYears,
        accounts: source.accounts,
        subAccounts: source.subAccounts,
        taxCategories: source.taxCategories,
        taxRateRules: source.settings.taxRateRules,
        segments: source.segments,
        partners: source.settings.partners,
        memoTags: source.memoTags,
        wallets: source.settings.wallets,
      }),
      "application/json",
    ),
  );
  const entries = [...source.entries].sort((a, b) =>
    a.entryDate === b.entryDate ? a.no - b.no : a.entryDate < b.entryDate ? -1 : 1,
  );
  files.push(text("journal-entries.json", backupJson(entries), "application/json"));
  rowCounts.set("journal-entries.json", entries.length);

  if (period) {
    const journal = journalEntries(source, period, "all");
    const csvRows = journalCsvRows(journal);
    files.push(text("journal.csv", "﻿" + csvText(csvRows), "text/csv; charset=utf-8"));
    rowCounts.set("journal.csv", csvRows.length - 1);
    files.push(
      text(
        "ledger.beancount",
        buildBeancount(source, { from: period.from, to: period.to }),
        "text/plain; charset=utf-8",
      ),
    );
  }
  files.push(
    text("wallet-transactions.json", backupJson(source.walletTransactions), "application/json"),
  );
  rowCounts.set("wallet-transactions.json", source.walletTransactions.length);
  files.push(text("documents.json", backupJson(source.documents), "application/json"));
  rowCounts.set("documents.json", source.documents.length);

  const manifest: BackupManifest = {
    exportedAt: options.now.toISOString(),
    company: source.company.name,
    fiscalYears: [...source.fiscalYears]
      .sort((a, b) => a.no - b.no)
      .map((year) => ({
        no: year.no,
        startDate: year.startDate,
        endDate: year.endDate,
        status: year.status,
      })),
    files: await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        bytes: file.content.byteLength,
        sha256: await sha256Hex(file.content),
        ...(rowCounts.has(file.path) ? { rows: rowCounts.get(file.path) } : {}),
      })),
    ),
  };
  return [text("manifest.json", backupJson(manifest), "application/json"), ...files];
}

/** A zip (stored, no compression needed for a download) of backup or archive files. */
export function zipFiles(files: readonly BackupFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.path] = file.content;
  return zipSync(entries, { level: 6 });
}
