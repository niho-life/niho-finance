import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DOCUMENT_MIMES,
  CSV_BOM,
  DOCUMENT_AUDIT_ACTION_LABELS,
  DOCUMENT_AUDIT_ACTIONS,
  DOCUMENT_INDEX_COLUMNS,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  DOCUMENT_LINK_KIND_LABELS,
  DOCUMENT_LINK_KINDS,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_SOURCE_LABELS,
  DOCUMENT_SOURCES,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUSES,
  DOCUMENT_TAB_LABELS,
  DOCUMENT_TABS,
  documentIndexCells,
  extensionForMime,
  isAcceptedDocumentMime,
  isPreviewableMime,
  isUnsortedDocument,
  normalizeDocumentMime,
  toCsv,
  type DocumentIndexRow,
} from "../src";

describe("document labels", () => {
  it("labels every value and nothing else", () => {
    const cases: [readonly string[], Readonly<Record<string, string>>][] = [
      [DOCUMENT_KINDS, DOCUMENT_KIND_LABELS],
      [DOCUMENT_SOURCES, DOCUMENT_SOURCE_LABELS],
      [DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS],
      [DOCUMENT_TABS, DOCUMENT_TAB_LABELS],
      [DOCUMENT_LINK_KINDS, DOCUMENT_LINK_KIND_LABELS],
      [DOCUMENT_AUDIT_ACTIONS, DOCUMENT_AUDIT_ACTION_LABELS],
    ];
    for (const [values, labels] of cases) {
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
      for (const value of values) {
        // Owner-facing: Japanese (or a product name), never the raw identifier.
        expect(labels[value], value).toBeTruthy();
        expect(labels[value], value).not.toBe(value);
      }
    }
  });

  it("uses the words of the screens", () => {
    expect(DOCUMENT_KIND_LABELS.invoice_out).toBe("発行した請求書の写し");
    expect(DOCUMENT_STATUS_LABELS).toEqual({
      inbox: "未紐づけ",
      linked: "紐づけ済み",
      voided: "無効",
    });
    expect(DOCUMENT_AUDIT_ACTION_LABELS["document.unlink"]).toBe("紐づけを外す");
    expect(DOCUMENT_MAX_BYTES).toBe(20_971_520);
  });

  it("calls a document 未整理 while its date, amount or partner is empty", () => {
    const sorted = {
      txnDate: "2026-11-07" as const,
      amount: 0n,
      partnerId: null,
      partnerName: "架空商店",
    };
    expect(isUnsortedDocument(sorted)).toBe(false);
    expect(
      isUnsortedDocument({ ...sorted, partnerId: "01JBZ00000000000000000000P", partnerName: null }),
    ).toBe(false);
    expect(isUnsortedDocument({ ...sorted, txnDate: null })).toBe(true);
    expect(isUnsortedDocument({ ...sorted, amount: null })).toBe(true);
    // Neither a partner of the master nor a free-text name.
    expect(isUnsortedDocument({ ...sorted, partnerName: null })).toBe(true);
  });
});

describe("document file formats", () => {
  it("keeps accepted types and drops parameters and case", () => {
    expect(normalizeDocumentMime("image/jpeg", "a.jpg")).toBe("image/jpeg");
    expect(normalizeDocumentMime("Image/PNG", "a.png")).toBe("image/png");
    expect(normalizeDocumentMime("text/csv; charset=utf-8", "a.csv")).toBe("text/csv");
    expect(normalizeDocumentMime("image/heif", "a.heif")).toBe("image/heif");
    // The type wins over the extension; the bytes are checked when the upload completes.
    expect(normalizeDocumentMime("application/pdf", "scan.jpg")).toBe("application/pdf");
  });

  it("decides from the extension when the browser's type says nothing", () => {
    expect(normalizeDocumentMime("", "IMG_0001.HEIC")).toBe("image/heic");
    expect(normalizeDocumentMime(undefined, "photo.jpeg")).toBe("image/jpeg");
    expect(normalizeDocumentMime("application/octet-stream", "invoice.pdf")).toBe(
      "application/pdf",
    );
    expect(normalizeDocumentMime("text/plain", "statement.csv")).toBe("text/csv");
    expect(normalizeDocumentMime("application/vnd.ms-excel", "statement.CSV")).toBe("text/csv");
    expect(normalizeDocumentMime("", "receipt.webp")).toBe("image/webp");
    expect(normalizeDocumentMime("", "noextension")).toBeNull();
    expect(normalizeDocumentMime("", "trailing.")).toBeNull();
    expect(normalizeDocumentMime("text/plain", "notes.txt")).toBeNull();
    expect(normalizeDocumentMime("application/vnd.ms-excel", "book.xls")).toBeNull();
  });

  it("accepts the common aliases and rejects other formats", () => {
    expect(normalizeDocumentMime("image/jpg", "a.jpg")).toBe("image/jpeg");
    expect(normalizeDocumentMime("text/comma-separated-values", "a.csv")).toBe("text/csv");
    expect(normalizeDocumentMime("image/gif", "a.gif")).toBeNull();
    expect(normalizeDocumentMime("image/svg+xml", "a.pdf")).toBeNull();
    expect(normalizeDocumentMime("text/html", "a.csv")).toBeNull();
    expect(normalizeDocumentMime("application/zip", "a.zip")).toBeNull();
  });

  it("maps every accepted type to an extension", () => {
    expect(ACCEPTED_DOCUMENT_MIMES.map((mime) => extensionForMime(mime))).toEqual([
      "jpg",
      "png",
      "webp",
      "heic",
      "heif",
      "pdf",
      "csv",
    ]);
    expect(extensionForMime("image/gif")).toBeNull();
    for (const mime of ACCEPTED_DOCUMENT_MIMES) {
      expect(isAcceptedDocumentMime(mime)).toBe(true);
      // The extension leads back to the same type.
      expect(normalizeDocumentMime("", `file.${extensionForMime(mime)}`)).toBe(mime);
    }
    expect(isAcceptedDocumentMime("image/gif")).toBe(false);
  });

  it("previews images and PDF but not HEIC or CSV", () => {
    expect(isPreviewableMime("image/jpeg")).toBe(true);
    expect(isPreviewableMime("image/png")).toBe(true);
    expect(isPreviewableMime("image/webp")).toBe(true);
    expect(isPreviewableMime("application/pdf")).toBe(true);
    expect(isPreviewableMime("image/heic")).toBe(false);
    expect(isPreviewableMime("text/csv")).toBe(false);
  });
});

describe("toCsv", () => {
  it("starts with a BOM and ends every record with CRLF", () => {
    expect(toCsv([])).toBe(CSV_BOM);
    expect(toCsv([["a", "b"], ["c"]])).toBe("\uFEFFa,b\r\nc\r\n");
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    expect(toCsv([["a,b", 'say "hi"', "two\nlines", "cr\r", "plain"]])).toBe(
      '\uFEFF"a,b","say ""hi""","two\nlines","cr\r",plain\r\n',
    );
  });

  it("writes empty cells and numbers as they are", () => {
    expect(toCsv([["", null, undefined, 0, 1_650n, -5]])).toBe("\uFEFF,,,0,1650,-5\r\n");
  });

  it("keeps spreadsheets from running text as a formula", () => {
    expect(toCsv([["=1+1", "+81", "-x", "@SUM(A1)", "\tx", '=HYPERLINK("x")', "a=b"]])).toBe(
      `\uFEFF"'=1+1","'+81","'-x","'@SUM(A1)","'\tx","'=HYPERLINK(""x"")",a=b\r\n`,
    );
  });
});

describe("documentIndexCells", () => {
  const row: DocumentIndexRow = {
    id: "01JBZ00000000000000000000A",
    txnDate: "2026-11-07",
    amount: 3_980n,
    partnerName: "架空商店",
    invoiceRegistrationNumber: null,
    kind: "receipt",
    status: "voided",
    voidReason: "重複",
    journalEntries: [
      { fiscalYearNo: 1, no: 12 },
      { fiscalYearNo: 1, no: 15 },
    ],
    walletTransactions: [
      { walletName: "架空カード", txnDate: "2026-11-07", amount: -3_980n },
      { walletName: "架空銀行 普通", txnDate: "2026-11-30", amount: 12_000n },
    ],
    originalName: "receipt.jpg",
    mime: "image/jpeg",
    sha256: "a".repeat(64),
    // 2026-11-07 10:12:34 in Japan.
    uploadedAt: new Date("2026-11-07T01:12:34.000Z"),
    uploadedBy: "owner",
    note: null,
  };

  it("follows the columns of the index", () => {
    const cells = documentIndexCells(row);
    expect(cells).toHaveLength(DOCUMENT_INDEX_COLUMNS.length);
    expect(
      Object.fromEntries(DOCUMENT_INDEX_COLUMNS.map((column, i) => [column, cells[i]])),
    ).toEqual({
      証憑ID: "01JBZ00000000000000000000A",
      取引年月日: "2026/11/07",
      取引金額: "3980",
      取引先: "架空商店",
      登録番号: "",
      種別: "領収書",
      状態: "無効",
      無効の理由: "重複",
      仕訳番号: "第1期 No.12 / 第1期 No.15",
      明細: "架空カード 2026/11/07 3,980 / 架空銀行 普通 2026/11/30 12,000",
      ファイル名: "receipt.jpg",
      形式: "image/jpeg",
      "SHA-256": "a".repeat(64),
      保存日時: "2026/11/07 10:12:34",
      保存者: "owner",
      メモ: "",
    });
  });

  it("leaves the items of an unsorted document empty", () => {
    const cells = documentIndexCells({
      ...row,
      txnDate: null,
      amount: null,
      partnerName: null,
      status: "inbox",
      voidReason: null,
      journalEntries: [],
      walletTransactions: [],
      // Midnight in Japan stays on the same day (00, not 24).
      uploadedAt: new Date("2026-11-30T15:00:00.000Z"),
    });
    expect(cells.slice(1, 4)).toEqual(["", "", ""]);
    expect(cells[6]).toBe("未紐づけ");
    expect(cells.slice(8, 10)).toEqual(["", ""]);
    expect(cells[13]).toBe("2026/12/01 00:00:00");
  });
});
