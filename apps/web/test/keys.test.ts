import { describe, expect, it } from "vitest";
import { contentDisposition, isSafeDocumentKey, newDocumentKey } from "@/lib/storage/keys";

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

describe("newDocumentKey", () => {
  it("files by the month in Japan, with the extension of the type", () => {
    // 2026-11-01 00:30 in Japan.
    expect(newDocumentKey("application/pdf", new Date("2026-10-31T15:30:00Z"))).toMatch(
      new RegExp(`^documents/2026/11/${ULID}\\.pdf$`),
    );
    expect(newDocumentKey("image/jpeg", new Date("2026-12-31T14:59:59Z"))).toMatch(
      new RegExp(`^documents/2026/12/${ULID}\\.jpg$`),
    );
    expect(newDocumentKey("text/csv", new Date("2026-12-31T15:00:00Z"))).toMatch(
      new RegExp(`^documents/2027/01/${ULID}\\.csv$`),
    );
    expect(newDocumentKey("image/heic")).toMatch(/\.heic$/);
  });

  it("never repeats a key and never takes another type", () => {
    const now = new Date("2026-11-07T01:00:00Z");
    const keys = new Set(Array.from({ length: 100 }, () => newDocumentKey("image/png", now)));
    expect(keys.size).toBe(100);
    for (const key of keys) expect(isSafeDocumentKey(key)).toBe(true);
    expect(() => newDocumentKey("image/gif")).toThrow(RangeError);
  });
});

describe("isSafeDocumentKey", () => {
  it("accepts plain keys under documents/ only", () => {
    expect(isSafeDocumentKey("documents/2026/11/01JBZ0000000000000000000AA.pdf")).toBe(true);
    for (const key of [
      "",
      "documents",
      "documents/",
      "documents/../x",
      "documents/2026/..",
      "documents//x",
      "documents/.x",
      "documents/x y.pdf",
      "documents\\x",
      "Documents/x",
      `documents/${"a".repeat(300)}`,
    ]) {
      expect(isSafeDocumentKey(key), key).toBe(false);
    }
  });
});

describe("contentDisposition", () => {
  it("encodes the file name in UTF-8 with an optional ASCII fallback", () => {
    expect(contentDisposition("inline", "receipt.pdf")).toBe(
      "inline; filename*=UTF-8''receipt.pdf",
    );
    expect(contentDisposition("inline", "請求書's (1)*.pdf")).toBe(
      "inline; filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8%27s%20%281%29%2A.pdf",
    );
    expect(contentDisposition("attachment", "証憑索引簿.csv", 'index "1".csv')).toBe(
      `attachment; filename="index _1_.csv"; filename*=UTF-8''%E8%A8%BC%E6%86%91%E7%B4%A2%E5%BC%95%E7%B0%BF.csv`,
    );
  });
});
