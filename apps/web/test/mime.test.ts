import { describe, expect, it } from "vitest";
import { matchesDeclaredMime, sniffDocumentMime } from "@/lib/storage/mime";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
/** An ISO BMFF `ftyp` box with a major brand and compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + compatible.length * 4;
  return concat(
    bytes(0, 0, 0, size),
    text("ftyp"),
    text(major),
    bytes(0, 0, 0, 0),
    ...compatible.map(text),
  );
};

describe("sniffDocumentMime", () => {
  it("recognizes the image signatures", () => {
    expect(sniffDocumentMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
    expect(sniffDocumentMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      "image/png",
    );
    expect(
      sniffDocumentMime(concat(text("RIFF"), bytes(0x24, 0, 0, 0), text("WEBPVP8 "), bytes(0, 0))),
    ).toBe("image/webp");
  });

  it("recognizes HEIC and HEIF by their ftyp brands, but not AVIF", () => {
    expect(sniffDocumentMime(ftyp("heic", "mif1", "heic"))).toBe("image/heic");
    expect(sniffDocumentMime(ftyp("mif1", "mif1", "heic"))).toBe("image/heic");
    expect(sniffDocumentMime(ftyp("mif1", "mif1"))).toBe("image/heic");
    expect(sniffDocumentMime(ftyp("avif", "mif1", "miaf"))).toBeNull();
    expect(sniffDocumentMime(ftyp("mif1", "avif", "miaf"))).toBeNull();
    expect(sniffDocumentMime(ftyp("isom", "mp41"))).toBeNull();
  });

  it("recognizes PDF, also after a few leading bytes", () => {
    expect(sniffDocumentMime(text("%PDF-1.7\n%âãÏÓ\n"))).toBe("application/pdf");
    expect(sniffDocumentMime(concat(bytes(0xef, 0xbb, 0xbf), text("%PDF-1.4\n")))).toBe(
      "application/pdf",
    );
    expect(sniffDocumentMime(text("%PDX-1.7"))).toBe("text/csv");
  });

  it("takes UTF-8 and Shift_JIS text as CSV", () => {
    expect(sniffDocumentMime(text("\uFEFF日付,金額,摘要\r\n2026/11/07,3980,架空ストア\r\n"))).toBe(
      "text/csv",
    );
    // 「日付,金額」 in Shift_JIS (a bank's CSV); not valid UTF-8.
    const shiftJis = bytes(0x93, 0xfa, 0x95, 0x74, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a, 0x0d, 0x0a);
    expect(new TextDecoder("shift_jis").decode(shiftJis)).toBe("日付,金額\r\n");
    expect(sniffDocumentMime(shiftJis)).toBe("text/csv");
  });

  it("rejects binary data, empty files and other formats", () => {
    expect(sniffDocumentMime(new Uint8Array())).toBeNull();
    expect(sniffDocumentMime(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBeNull(); // zip / xlsx
    expect(sniffDocumentMime(concat(text("GIF89a"), bytes(0x01, 0x00, 0x01, 0x00)))).toBeNull();
    expect(sniffDocumentMime(bytes(0x41, 0x00, 0x42))).toBeNull();
    // Neither UTF-8 nor Shift_JIS.
    expect(sniffDocumentMime(bytes(0x41, 0xff, 0xfe, 0x42))).toBeNull();
  });
});

describe("matchesDeclaredMime", () => {
  it("compares the declared type with the bytes", () => {
    expect(matchesDeclaredMime("image/jpeg", "image/jpeg")).toBe(true);
    expect(matchesDeclaredMime("image/jpeg", "image/png")).toBe(false);
    expect(matchesDeclaredMime("text/csv", "application/pdf")).toBe(false);
    expect(matchesDeclaredMime("image/heif", "image/heic")).toBe(true);
    expect(matchesDeclaredMime("image/heic", "image/heic")).toBe(true);
    expect(matchesDeclaredMime("application/pdf", null)).toBe(false);
  });
});
