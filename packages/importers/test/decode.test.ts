import { describe, expect, it } from "vitest";
import { decodeCsvBytes } from "../src/csv/decode";

const encoder = new TextEncoder();

describe("decodeCsvBytes (12-imports §3.2)", () => {
  it("reads UTF-8", () => {
    expect(decodeCsvBytes(encoder.encode("日付,金額\n"))).toEqual({
      text: "日付,金額\n",
      encoding: "utf-8",
    });
  });

  it("drops the UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("日付")]);
    expect(decodeCsvBytes(bytes)).toEqual({ text: "日付", encoding: "utf-8" });
  });

  it("reads ASCII as UTF-8", () => {
    expect(decodeCsvBytes(encoder.encode("a,b")).encoding).toBe("utf-8");
  });

  it("falls back to Shift_JIS, including cp932 vendor characters", () => {
    // 日付,① ＼1,000 in cp932: 93FA 9574 2C 8740 20 815F 31 2C 30 30 30
    const bytes = Buffer.from([
      0x93, 0xfa, 0x95, 0x74, 0x2c, 0x87, 0x40, 0x20, 0x81, 0x5f, 0x31, 0x2c, 0x30, 0x30, 0x30,
    ]);
    expect(decodeCsvBytes(bytes)).toEqual({ text: "日付,① ＼1,000", encoding: "shift_jis" });
  });

  it("reads half-width katakana in Shift_JIS", () => {
    // ｶﾅ = B6 C5
    expect(decodeCsvBytes(Buffer.from([0xb6, 0xc5]))).toEqual({
      text: "ｶﾅ",
      encoding: "shift_jis",
    });
  });
});
