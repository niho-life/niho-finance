import { createHash } from "node:crypto";
import type { DocumentIndexRow } from "@niho-finance/ledger";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  fixedAssetLedgerCsvRows,
  handoverDelivery,
  handoverDocumentIndexRows,
  handoverDocumentPath,
  handoverEstimateBytes,
  handoverGeneralLedgerCsvRows,
  handoverPackageBytes,
  handoverPeriod,
  handoverZipName,
  HANDOVER_DIRECT_LIMIT_BYTES,
  HANDOVER_FILE_UNAVAILABLE,
  HANDOVER_INDEX_PATH,
  HANDOVER_MANIFEST_PATH,
  HANDOVER_README_PATH,
  planHandoverBooks,
  writeHandoverPackage,
  type ArchiveDocument,
  type FinancialStatementsSource,
  type HandoverDocument,
  type HandoverFixedAssetRow,
  type HandoverManifest,
  type HandoverPackagePlan,
  type HandoverScreenOutputs,
} from "../src";
import { BOOK, CLOSED_BOOK, FY1, FY2 } from "./financial-statements/fixture";

/*
 * 受け渡しパッケージ (14-reports §15.6) on the fictional company of the statements tests: README 中身
 * = the zip's entries, manifest SHA-256 = the contents, index rows ↔ documents/files/ (included /
 * not included / not fetchable), statements only for a closed year, and the streamed zip unzips to
 * the inputs.
 */

const encoder = new TextEncoder();
// Keeps the BOM (TextDecoder drops it by default), so that the tests can see it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const strFromU8 = (bytes: Uint8Array): string => decoder.decode(bytes);
const CREATED_AT = new Date("2027-05-10T05:03:00Z");

/** Stand-ins for the screens' outputs (the PDFs are rendered by apps/web). */
const SCREENS: HandoverScreenOutputs = {
  trialBalanceCsv: {
    rows: [
      ["区分", "科目"],
      ["流動資産", "普通預金"],
    ],
    count: 1,
  },
  trialBalancePdf: () => Promise.resolve(encoder.encode("%PDF-1.4 trial balance")),
  monthlyCsv: {
    rows: [
      ["科目コード", "科目"],
      ["4100", "売上高"],
    ],
    count: 1,
  },
  statementsPdf: (report) =>
    Promise.resolve(encoder.encode(`%PDF-1.4 statements ${report.company.name}`)),
};

const ASSET: HandoverFixedAssetRow = {
  name: "架空のノートパソコン",
  accountCode: "1510",
  accountName: "工具器具備品",
  acquisitionDate: "2026-12-01",
  cost: 330_000n,
  method: "straight_line",
  usefulLifeYears: 4,
  openingBookValue: 0n,
  increase: 330_000n,
  decrease: 0n,
  depreciation: 27_500n,
  closingBookValue: 302_500n,
  accumulated: 27_500n,
  disposedAt: null,
  isDepreciableAssetTaxed: true,
  isSpecialSmallAsset: false,
};

async function books(source: FinancialStatementsSource, fiscalYearId: string) {
  return planHandoverBooks({
    source,
    fiscalYearId,
    fixedAssets: [ASSET],
    fixedAssetRegister: [],
    screens: SCREENS,
  });
}

function indexRow(id: string, overrides: Partial<DocumentIndexRow> = {}): DocumentIndexRow {
  return {
    id,
    txnDate: "2026-12-01",
    amount: 33_000n,
    partnerName: "架空電器株式会社",
    invoiceRegistrationNumber: null,
    kind: "receipt",
    status: "linked",
    voidReason: null,
    journalEntries: [{ fiscalYearNo: 1, no: 3 }],
    walletTransactions: [],
    originalName: `${id}.pdf`,
    mime: "application/pdf",
    sha256: "0".repeat(64),
    uploadedAt: new Date("2026-12-01T01:00:00Z"),
    uploadedBy: "owner@example.com",
    note: null,
    ...overrides,
  };
}

function archiveOf(row: DocumentIndexRow): ArchiveDocument {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: "領収書",
    txnDate: row.txnDate,
    amount: row.amount,
    partnerName: row.partnerName,
    invoiceRegistrationNumber: row.invoiceRegistrationNumber,
    originalName: row.originalName,
    storageKey: `documents/${row.id}`,
    sha256: row.sha256,
    mime: row.mime,
    status: row.status,
    statusLabel: "紐づけ済み",
    entryNos: [],
    walletTransactionIds: [],
  };
}

/** Three documents; `files` maps an id to its bytes (absent = the storage cannot return it). */
function documents(files: Record<string, Uint8Array>): {
  list: HandoverDocument[];
  fetched: string[];
} {
  const fetched: string[] = [];
  const rows = [
    indexRow("doc-a"),
    indexRow("doc-b", { mime: "image/png", originalName: "receipt.PNG" }),
    indexRow("doc-c", { status: "voided", voidReason: "重複して保存した" }),
  ];
  const list = rows.map((row) => ({
    index: row,
    path: handoverDocumentPath(archiveOf(row)),
    mime: row.mime,
    byteSize: files[row.id]?.byteLength ?? 1000,
    fetch: () => {
      fetched.push(row.id);
      return Promise.resolve(files[row.id] ?? null);
    },
  }));
  return { list, fetched };
}

async function plan(
  overrides: Partial<HandoverPackagePlan> & { source?: FinancialStatementsSource } = {},
): Promise<HandoverPackagePlan> {
  const { source = CLOSED_BOOK, ...rest } = overrides;
  const year = source.fiscalYears.find((candidate) => candidate.id === FY1.id) ?? FY1;
  const planned = await books(source, year.id);
  return {
    company: source.company.name,
    fiscalYear: {
      no: year.no,
      startDate: year.startDate,
      endDate: year.endDate,
      status: year.status,
    },
    createdAt: CREATED_AT,
    createdBy: "owner@example.com",
    includeDocuments: false,
    entries: planned.entries,
    documents: [],
    notes: planned.notes,
    ...rest,
  };
}

function readmeOf(zip: Record<string, Uint8Array>): string {
  const bytes = zip[HANDOVER_README_PATH];
  if (!bytes) throw new Error("README.txt is missing");
  return strFromU8(bytes);
}

/** The paths listed under ■ 中身 (each followed by an indented description line). */
function listedPaths(readme: string): string[] {
  const lines = readme.split("\r\n");
  const start = lines.indexOf("■ 中身");
  const end = lines.indexOf("■ 形式");
  return lines.slice(start + 1, end).filter((line) => !line.startsWith("  "));
}

function manifestOf(zip: Record<string, Uint8Array>): HandoverManifest {
  const bytes = zip[HANDOVER_MANIFEST_PATH];
  if (!bytes) throw new Error("manifest.json is missing");
  return JSON.parse(strFromU8(bytes)) as HandoverManifest;
}

function indexOf(zip: Record<string, Uint8Array>): string[][] {
  const bytes = zip[HANDOVER_INDEX_PATH];
  if (!bytes) throw new Error("documents/index.csv is missing");
  const text = strFromU8(bytes);
  expect(text.startsWith("﻿")).toBe(true);
  return text
    .slice(1)
    .split("\r\n")
    .filter((line) => line !== "")
    .map((line) => line.split(","));
}

describe("planHandoverBooks", () => {
  it("puts the statements of a closed year in the plan", async () => {
    const { entries, notes } = await books(CLOSED_BOOK, FY1.id);
    expect(entries.map((entry) => entry.path)).toEqual([
      "books/journal_20261102-20270331.csv",
      "books/general-ledger_20261102-20270331.csv",
      "books/trial-balance_20261102-20270331.pdf",
      "books/trial-balance_20261102-20270331.csv",
      "books/monthly_20261102-20270331.csv",
      "books/journal-freee_20261102-20270331.csv",
      "books/journal-yayoi_20261102-20270331.csv",
      "closing/fixed-assets_20261102-20270331.csv",
      "closing/consumption-tax_20261102-20270331.csv",
      "statements/financial-statements_20261102-20270331.pdf",
      "statements/account-details_20261102-20270331.csv",
      "statements/etax/HOT010_3.0_BS.csv",
      "statements/etax/HOT010_3.0_PL.csv",
      "statements/etax/HOT010_3.0_SS.csv",
      "statements/etax/HOT010_3.0_NT.csv",
    ]);
    expect(notes).toEqual([]);
    const pdf = entries.find((entry) => entry.path.startsWith("statements/financial-statements"));
    expect(strFromU8(pdf!.content)).toBe("%PDF-1.4 statements 架空商事株式会社");
  });

  it("leaves the statements out of a year that is not closed", async () => {
    expect(FY2.status).toBe("open");
    const { entries } = await books(BOOK, FY2.id);
    expect(entries.some((entry) => entry.path.startsWith("statements/"))).toBe(false);
    expect(entries.map((entry) => entry.path)).toContain(
      "closing/consumption-tax_20270401-20280331.csv",
    );
    const open = {
      ...CLOSED_BOOK,
      fiscalYears: CLOSED_BOOK.fiscalYears.map((year) =>
        year.id === FY1.id ? { ...year, status: "closing" as const } : year,
      ),
    };
    const closing = await books(open, FY1.id);
    expect(closing.entries.some((entry) => entry.path.startsWith("statements/"))).toBe(false);
  });

  it("leaves HOT010 out with the reason when a name has a character e-Tax refuses", async () => {
    const source: FinancialStatementsSource = {
      ...CLOSED_BOOK,
      company: { ...CLOSED_BOOK.company, name: "𠮷野架空商事株式会社" },
    };
    const { entries, notes } = await books(source, FY1.id);
    expect(entries.some((entry) => entry.path.startsWith("statements/etax/"))).toBe(false);
    expect(entries.some((entry) => entry.path.startsWith("statements/financial-statements"))).toBe(
      true,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("財務諸表 CSV（e-Tax）は入れていません");
    expect(notes[0]).toContain("𠮷");
  });

  it("counts the data rows of the CSV files", async () => {
    const { entries } = await books(CLOSED_BOOK, FY1.id);
    const journal = entries.find((entry) => entry.path.startsWith("books/journal_"));
    const text = strFromU8(journal!.content);
    expect(text.startsWith("﻿")).toBe(true);
    expect(journal!.rows).toBe(text.split("\r\n").filter((line) => line !== "").length - 1);
    const yayoi = entries.find((entry) => entry.path.startsWith("books/journal-yayoi_"));
    // Shift_JIS, no header row: every line is a data row.
    expect(yayoi!.content[0]).not.toBe(0xef);
    expect(yayoi!.rows).toBeGreaterThan(0);
  });
});

describe("rows of the package", () => {
  it("writes the fixed assets, the header alone without assets", () => {
    expect(fixedAssetLedgerCsvRows([])).toHaveLength(1);
    const [header, row] = fixedAssetLedgerCsvRows([ASSET]);
    expect(header).toHaveLength(16);
    expect(row).toEqual([
      "架空のノートパソコン",
      "1510",
      "工具器具備品",
      "2026/12/01",
      330_000n,
      "定額法",
      4,
      0n,
      330_000n,
      0n,
      27_500n,
      302_500n,
      27_500n,
      "",
      "対象",
      "",
    ]);
  });

  it("stacks the ledger of every account with a movement, in code order", () => {
    const rows = handoverGeneralLedgerCsvRows(CLOSED_BOOK, handoverPeriod(CLOSED_BOOK, FY1.id));
    expect(rows[0]?.slice(0, 3)).toEqual(["科目コード", "科目", "日付"]);
    const codes = rows.slice(1).map((row) => String(row[0]));
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain("1510");
    // Every account starts with 繰越 and ends with 合計.
    const firstOf1510 = rows.findIndex((row) => row[0] === "1510");
    expect(rows[firstOf1510]?.[4]).toBe("繰越");
    const of1510 = rows.filter((row) => row[0] === "1510");
    expect(of1510.at(-1)?.[4]).toBe("合計");
  });

  it("adds the file column to the 13 §7 index", () => {
    const { list } = documents({});
    const without = handoverDocumentIndexRows(list, null);
    expect(without[0]?.at(-1)).toBe("パッケージ内のファイル");
    expect(without[0]).toHaveLength(17);
    expect(without.slice(1).map((row) => row.at(-1))).toEqual(["", "", ""]);
    const withFiles = handoverDocumentIndexRows(list, { missing: new Set(["doc-b"]) });
    expect(withFiles.slice(1).map((row) => row.at(-1))).toEqual([
      "documents/files/doc-a.pdf",
      HANDOVER_FILE_UNAVAILABLE,
      "documents/files/doc-c.pdf",
    ]);
  });

  it("estimates the size and picks direct or job", () => {
    expect(handoverEstimateBytes({ includeDocuments: false, documentBytes: 50_000_000 })).toBe(
      2 * 1024 * 1024,
    );
    const big = handoverEstimateBytes({ includeDocuments: true, documentBytes: 19 * 1024 * 1024 });
    expect(big).toBeGreaterThan(HANDOVER_DIRECT_LIMIT_BYTES);
    expect(handoverDelivery(big)).toBe("job");
    expect(handoverDelivery(HANDOVER_DIRECT_LIMIT_BYTES)).toBe("direct");
    expect(handoverZipName(FY1)).toBe("handover_fy1_20261102-20270331.zip");
  });
});

describe("writeHandoverPackage", () => {
  it("lists in README exactly the zip's entries, in order, with matching SHA-256", async () => {
    const files = {
      "doc-a": encoder.encode("%PDF-1.4 doc-a"),
      "doc-b": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      "doc-c": encoder.encode("%PDF-1.4 doc-c"),
    };
    const { list } = documents(files);
    const { zip, result } = await handoverPackageBytes(
      await plan({ includeDocuments: true, documents: list }),
    );
    const unzipped = unzipSync(zip);
    const names = Object.keys(unzipped);
    expect(names.slice(-2)).toEqual([HANDOVER_README_PATH, HANDOVER_MANIFEST_PATH]);
    const readme = readmeOf(unzipped);
    expect(readme.startsWith("﻿受け渡しパッケージ\r\n")).toBe(true);
    expect(readme).toContain("会社: 架空商事株式会社\r\n");
    expect(readme).toContain("期間: 第1期 2026/11/02 – 2027/03/31（締め済み）\r\n");
    expect(readme).toContain("作成: 2027/05/10 14:03（作成者 owner@example.com）\r\n");
    expect(listedPaths(readme)).toEqual(names.slice(0, -2));
    expect(names).toContain("documents/files/doc-b.png");

    const manifest = manifestOf(unzipped);
    expect(manifest.files.map((file) => file.path)).toEqual(names.slice(0, -2));
    for (const file of manifest.files) {
      const content = unzipped[file.path]!;
      const sha256 = createHash("sha256").update(content).digest("hex");
      expect(file.sha256).toBe(sha256);
      expect(file.bytes).toBe(content.byteLength);
      expect(readme).toContain(`SHA-256 ${sha256}`);
    }
    expect(manifest.fiscalYear).toEqual({
      no: 1,
      startDate: "2026-11-02",
      endDate: "2027-03-31",
      status: "closed",
    });
    expect(result.fileCount).toBe(names.length);
    expect(result.bytes).toBe(zip.byteLength);
    expect(result.documentFileCount).toBe(3);
  });

  it("matches the index rows and documents/files/ one to one", async () => {
    const files = {
      "doc-a": encoder.encode("%PDF-1.4 doc-a"),
      "doc-b": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "doc-c": encoder.encode("%PDF-1.4 doc-c"),
    };
    const { list } = documents(files);
    const unzipped = unzipSync(
      (await handoverPackageBytes(await plan({ includeDocuments: true, documents: list }))).zip,
    );
    const index = indexOf(unzipped);
    const column = index[0]!.length - 1;
    const packaged = index.slice(1).map((row) => row[column]);
    const inZip = Object.keys(unzipped).filter((name) => name.startsWith("documents/files/"));
    expect(packaged).toEqual(inZip);
    expect(index.slice(1).map((row) => row[0])).toEqual(["doc-a", "doc-b", "doc-c"]);
    expect(index.find((row) => row[0] === "doc-c")?.[6]).toBe("無効");
  });

  it("writes only the index without files, and fetches nothing", async () => {
    const { list, fetched } = documents({ "doc-a": encoder.encode("x") });
    const unzipped = unzipSync(
      (await handoverPackageBytes(await plan({ includeDocuments: false, documents: list }))).zip,
    );
    expect(fetched).toEqual([]);
    expect(Object.keys(unzipped).some((name) => name.startsWith("documents/files/"))).toBe(false);
    const index = indexOf(unzipped);
    expect(index).toHaveLength(4);
    expect(index.slice(1).map((row) => row.at(-1))).toEqual(["", "", ""]);
    const readme = readmeOf(unzipped);
    expect(readme).toContain("- 証憑のファイルは含めていません（索引簿だけ）。\r\n");
  });

  it("marks a file the storage does not return, and counts it in README", async () => {
    const { list, fetched } = documents({
      "doc-a": encoder.encode("%PDF-1.4 doc-a"),
      "doc-c": encoder.encode("%PDF-1.4 doc-c"),
    });
    const { zip, result } = await handoverPackageBytes(
      await plan({ includeDocuments: true, documents: list }),
    );
    expect(fetched).toEqual(["doc-a", "doc-b", "doc-c"]);
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped).filter((name) => name.startsWith("documents/files/"))).toEqual([
      "documents/files/doc-a.pdf",
      "documents/files/doc-c.pdf",
    ]);
    const index = indexOf(unzipped);
    expect(index.find((row) => row[0] === "doc-b")?.at(-1)).toBe(HANDOVER_FILE_UNAVAILABLE);
    const readme = readmeOf(unzipped);
    expect(readme).toContain(
      "- 証憑 1 件のファイルを取得できませんでした（索引簿の「パッケージ内のファイル」を参照）。\r\n",
    );
    expect(listedPaths(readme)).not.toContain("documents/files/doc-b.png");
    expect(result.missingDocumentIds).toEqual(["doc-b"]);
    expect(manifestOf(unzipped).documents).toEqual({ count: 3, files: 2, missing: ["doc-b"] });
  });

  it("says in README that an open year has no statements", async () => {
    const year = BOOK.fiscalYears.find((candidate) => candidate.id === FY2.id)!;
    const planned = await books(BOOK, FY2.id);
    const unzipped = unzipSync(
      (
        await handoverPackageBytes({
          company: BOOK.company.name,
          fiscalYear: { ...year },
          createdAt: CREATED_AT,
          createdBy: "owner@example.com",
          includeDocuments: false,
          entries: planned.entries,
          documents: [],
        })
      ).zip,
    );
    expect(Object.keys(unzipped).some((name) => name.startsWith("statements/"))).toBe(false);
    const readme = readmeOf(unzipped);
    expect(readme).toContain("（進行中）");
    expect(readme).toContain("この期はまだ締めていないため入っていません");
    expect(indexOf(unzipped)).toHaveLength(1);
  });

  it("streams chunks that unzip to the same bytes as the inputs", async () => {
    const files = {
      "doc-a": new Uint8Array(200_000).map((_, i) => (i * 7) % 251),
      "doc-b": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      "doc-c": encoder.encode("%PDF-1.4 doc-c"),
    };
    const { list } = documents(files);
    const input = await plan({ includeDocuments: true, documents: list });
    const chunks: Uint8Array[] = [];
    const finals: boolean[] = [];
    const result = await writeHandoverPackage(input, async (chunk, final) => {
      await Promise.resolve();
      chunks.push(chunk);
      finals.push(final);
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(finals.filter(Boolean)).toHaveLength(1);
    expect(finals.at(-1)).toBe(true);
    const zip = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      zip.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(zip.byteLength).toBe(result.bytes);
    const unzipped = unzipSync(zip);
    for (const entry of input.entries) expect(unzipped[entry.path]).toEqual(entry.content);
    for (const document of list) {
      expect(unzipped[document.path]).toEqual(files[document.index.id as keyof typeof files]);
    }
    // The same plan gives the same contents (direct download and job write the same files).
    const again = unzipSync((await handoverPackageBytes(input)).zip);
    expect(Object.keys(again)).toEqual(Object.keys(unzipped));
    for (const name of Object.keys(unzipped)) expect(again[name]).toEqual(unzipped[name]);
  });
});
