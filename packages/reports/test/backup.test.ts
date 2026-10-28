import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildBackupFiles,
  buildDocumentsArchive,
  documentsIndexRows,
  zipFiles,
  type ArchiveDocument,
  type BackupManifest,
  type BackupSource,
} from "../src";
import { BOOK } from "./fixtures/book";

const decoder = new TextDecoder();

const source: BackupSource = {
  ...BOOK,
  settings: {
    company: { name: BOOK.company.name, foundedOn: BOOK.company.foundedOn },
    taxRateRules: [
      {
        taxCategoryCode: "sales_10",
        effectiveFrom: "2019-10-01",
        effectiveTo: null,
        ratePercent: 10,
        deductiblePercent: null,
        enabled: true,
      },
    ],
    partners: BOOK.partners.map((partner) => ({ ...partner, kind: "vendor" })),
    wallets: BOOK.wallets.map((wallet) => ({ ...wallet })),
  },
  walletTransactions: [
    {
      id: "wt1",
      walletId: "w:bank",
      txnDate: "2026-12-10",
      amount: -145n,
      descriptionRaw: "振込手数料",
      counterpartyRaw: null,
      balanceAfter: 60_459n,
      externalId: "x1",
      status: "registered",
      journalEntryId: "e11",
      ignoredReason: null,
    },
  ],
  documents: [],
};

describe("buildBackupFiles", () => {
  it("writes the manifest, settings, entries, journal CSV, beancount, statements and documents", async () => {
    const files = await buildBackupFiles(source, { now: new Date("2027-04-01T18:00:00Z") });
    expect(files.map((file) => file.path)).toEqual([
      "manifest.json",
      "settings.json",
      "journal-entries.json",
      "journal.csv",
      "ledger.beancount",
      "wallet-transactions.json",
      "documents.json",
    ]);
    const manifest = JSON.parse(decoder.decode(files[0]!.content)) as BackupManifest;
    expect(manifest.exportedAt).toBe("2027-04-01T18:00:00.000Z");
    expect(manifest.company).toBe("架空商会株式会社");
    expect(manifest.fiscalYears.map((year) => year.no)).toEqual([1, 2]);
    expect(manifest.files.find((f) => f.path === "journal-entries.json")?.rows).toBe(24);
    expect(manifest.files.find((f) => f.path === "wallet-transactions.json")?.rows).toBe(1);
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBe(files.find((f) => f.path === file.path)?.content.byteLength);
    }
    const entries = JSON.parse(decoder.decode(files[2]!.content)) as {
      no: number;
      lines: { amount: string }[];
    }[];
    expect(entries[0]).toMatchObject({ no: 1 });
    expect(entries[0]!.lines[0]!.amount).toBe("50000");
    const statements = JSON.parse(decoder.decode(files[5]!.content)) as { amount: string }[];
    expect(statements[0]!.amount).toBe("-145");
    expect([...files[3]!.content.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decoder.decode(files[3]!.content).startsWith("日付,No.")).toBe(true);
    expect(decoder.decode(files[4]!.content)).toContain("2028-04-01 balance");
  });

  it("zips the files so that they can be read back", async () => {
    const files = await buildBackupFiles(source, { now: new Date() });
    const zip = unzipSync(zipFiles(files));
    expect(Object.keys(zip).sort()).toEqual(files.map((f) => f.path).sort());
    expect(decoder.decode(zip["manifest.json"])).toContain('"company": "架空商会株式会社"');
  });
});

describe("buildDocumentsArchive", () => {
  const documents: ArchiveDocument[] = [
    {
      id: "doc1",
      kind: "receipt",
      kindLabel: "領収書",
      txnDate: "2026-11-10",
      amount: 3_300n,
      partnerName: "架空文具店",
      invoiceRegistrationNumber: null,
      originalName: "receipt.jpg",
      storageKey: "documents/doc1",
      sha256: "ab".repeat(32),
      mime: "image/jpeg",
      status: "linked",
      statusLabel: "紐づけ済み",
      entryNos: [4],
      walletTransactionIds: [],
    },
    {
      id: "doc2",
      kind: "invoice_in",
      kindLabel: "請求書（受取）",
      txnDate: "2026-11-15",
      amount: 88_000n,
      partnerName: "架空不動産株式会社",
      invoiceRegistrationNumber: "T9999999999999",
      originalName: null,
      storageKey: "documents/doc2",
      sha256: "cd".repeat(32),
      mime: "application/pdf",
      status: "inbox",
      statusLabel: "未紐づけ",
      entryNos: [],
      walletTransactionIds: ["wt9"],
    },
  ];

  it("indexes the search keys and the entry numbers", () => {
    const rows = documentsIndexRows(documents);
    expect(rows[0]![0]).toBe("証憑 ID");
    expect(rows[1]).toEqual([
      "doc1",
      "領収書",
      "2026/11/10",
      3_300n,
      "架空文具店",
      "",
      "4",
      "",
      "files/doc1.jpg",
      "ab".repeat(32),
      "紐づけ済み",
    ]);
    expect(rows[2]![8]).toBe("files/doc2.pdf");
  });

  it("includes the files it can fetch and lists the rest as missing", async () => {
    const archive = await buildDocumentsArchive(documents, {
      fetchFile: (document) =>
        Promise.resolve(document.id === "doc1" ? new TextEncoder().encode("jpeg bytes") : null),
    });
    expect(archive.fileCount).toBe(1);
    expect(archive.missing).toEqual(["doc2"]);
    const zip = unzipSync(archive.zip);
    expect(Object.keys(zip).sort()).toEqual(["files/doc1.jpg", "index.csv"]);
    expect(decoder.decode(zip["index.csv"])).toContain("doc2");
    const indexOnly = await buildDocumentsArchive(documents);
    expect(indexOnly.fileCount).toBe(0);
    expect(indexOnly.missing).toEqual(["doc1", "doc2"]);
  });
});
