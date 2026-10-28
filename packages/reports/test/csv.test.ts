import { describe, expect, it } from "vitest";
import { csvText, encodeCsv, halfWidthLength, truncateHalfWidth } from "../src";

describe("csvText", () => {
  it("quotes only what needs it and ends lines with CRLF", () => {
    const text = csvText([
      ["日付", "摘要", "金額"],
      ["2026/11/02", 'a "b", c', 50_000n],
      ["2026/11/03", "改行\nあり", -1n],
      [null, undefined, 0],
    ]);
    expect(text).toBe(
      '日付,摘要,金額\r\n2026/11/02,"a ""b"", c",50000\r\n2026/11/03,"改行\nあり",-1\r\n,,0\r\n',
    );
  });
});

describe("encodeCsv", () => {
  it("adds a BOM for UTF-8 and none for Shift_JIS", () => {
    const utf8 = encodeCsv("弥生", "utf8");
    expect([...utf8.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(utf8.slice(3))).toBe("弥生");
    const sjis = encodeCsv("弥生", "sjis");
    expect([...sjis]).toEqual([0x96, 0xed, 0x90, 0xb6]);
  });
});

describe("half-width widths", () => {
  it("counts CJK as 2 columns and cuts without splitting a character", () => {
    expect(halfWidthLength("abc")).toBe(3);
    expect(halfWidthLength("摘要 1")).toBe(6);
    expect(halfWidthLength("ｶﾅ")).toBe(2);
    expect(truncateHalfWidth("あいうえお", 7)).toBe("あいう");
    expect(truncateHalfWidth("abcdef", 4)).toBe("abcd");
  });
});
