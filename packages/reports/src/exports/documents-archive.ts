/**
 * 証憑一式 (14-reports §10): a zip with an index CSV (the search keys of 電子帳簿保存法 and the
 * entry numbers) and the files. The files come from S6's storage through `fetchFile`; a file that
 * cannot be fetched stays in the index and is left out of the zip (`missing`).
 */
import type { CalendarDate, Money } from "@niho-finance/ledger";
import { csvText } from "../csv";
import { slashDate } from "../format";
import { zipFiles, type BackupFile } from "./backup";

export interface ArchiveDocument {
  id: string;
  kind: string;
  kindLabel: string;
  txnDate: CalendarDate | null;
  amount: Money | null;
  partnerName: string | null;
  invoiceRegistrationNumber: string | null;
  originalName: string | null;
  storageKey: string;
  sha256: string;
  mime: string;
  status: string;
  statusLabel: string;
  /** Numbers of the linked entries. */
  entryNos: readonly number[];
  walletTransactionIds: readonly string[];
}

export interface DocumentsArchiveOptions {
  /** Returns the bytes of a document, or `null` when it cannot be fetched. */
  fetchFile?: (document: ArchiveDocument) => Promise<Uint8Array | null>;
}

export interface DocumentsArchive {
  zip: Uint8Array;
  indexCsv: string;
  /** Documents whose file could not be included. */
  missing: string[];
  fileCount: number;
}

export const DOCUMENTS_INDEX_HEADER = [
  "証憑 ID",
  "種類",
  "日付",
  "金額",
  "取引先",
  "登録番号",
  "仕訳 No.",
  "明細",
  "ファイル名",
  "SHA-256",
  "状態",
] as const;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/webp": "webp",
};

/** `files/<id>.<ext>`: stable, ASCII, unique. */
export function archiveFileName(document: ArchiveDocument): string {
  const fromName = document.originalName?.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase();
  const extension = EXTENSIONS[document.mime] ?? fromName ?? "bin";
  return `files/${document.id}.${extension}`;
}

export function documentsIndexRows(
  documents: readonly ArchiveDocument[],
): (string | bigint | number)[][] {
  const rows: (string | bigint | number)[][] = [[...DOCUMENTS_INDEX_HEADER]];
  for (const document of documents) {
    rows.push([
      document.id,
      document.kindLabel,
      document.txnDate ? slashDate(document.txnDate) : "",
      document.amount ?? "",
      document.partnerName ?? "",
      document.invoiceRegistrationNumber ?? "",
      document.entryNos.join("|"),
      document.walletTransactionIds.join("|"),
      archiveFileName(document),
      document.sha256,
      document.statusLabel,
    ]);
  }
  return rows;
}

export async function buildDocumentsArchive(
  documents: readonly ArchiveDocument[],
  options: DocumentsArchiveOptions = {},
): Promise<DocumentsArchive> {
  const indexCsv = "﻿" + csvText(documentsIndexRows(documents));
  const files: BackupFile[] = [
    { path: "index.csv", content: new TextEncoder().encode(indexCsv), contentType: "text/csv" },
  ];
  const missing: string[] = [];
  for (const document of documents) {
    const content = options.fetchFile ? await options.fetchFile(document) : null;
    if (!content) {
      missing.push(document.id);
      continue;
    }
    files.push({ path: archiveFileName(document), content, contentType: document.mime });
  }
  return { zip: zipFiles(files), indexCsv, missing, fileCount: files.length - 1 };
}
