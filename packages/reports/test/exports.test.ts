import { describe, expect, it } from "vitest";
import {
  csvText,
  encodeCsv,
  FREEE_HEADER,
  freeeJournalRows,
  pairLines,
  YAYOI_COLUMN_COUNT,
  yayoiJournalRows,
} from "../src";
import { BOOK, ENTRIES, FY1 } from "./fixtures/book";
import { expectGolden } from "./support/golden";

const range = { from: FY1.startDate, to: FY1.endDate };

describe("pairLines", () => {
  it("pairs the i-th debit with the i-th credit", () => {
    const voucher = ENTRIES.find((e) => e.id === "e17")!;
    const rows = pairLines(voucher);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.debit?.accountId).toBe("acc:1100");
    expect(rows[0]!.credit?.accountId).toBe("acc:1200");
    expect(rows[1]!.debit?.accountId).toBe("acc:5400");
    expect(rows[1]!.credit).toBeNull();
    expect(pairLines(ENTRIES.find((e) => e.id === "e1")!)).toHaveLength(1);
  });
});

describe("freeeJournalRows", () => {
  const rows = freeeJournalRows(BOOK, range);

  it("starts with the header and keeps one 伝票番号 per entry", () => {
    expect(rows[0]).toEqual([...FREEE_HEADER]);
    expect(rows[0]).toHaveLength(33);
    for (const row of rows) expect(row).toHaveLength(33);
    const byNo = new Map<string, number>();
    for (const row of rows.slice(1)) byNo.set(row[2]!, (byNo.get(row[2]!) ?? 0) + 1);
    expect(byNo.get("2")).toBe(2);
    expect(byNo.get("17")).toBe(2);
    expect(byNo.get("1")).toBe(1);
  });

  it("fills the sides, the tax names and the state", () => {
    const capital = rows.find((row) => row[2] === "1")!;
    expect(capital.slice(0, 4)).toEqual(["[明細行]", "2026/11/02", "1", ""]);
    expect(capital.slice(4, 18)).toEqual([
      "普通預金",
      "1100",
      "架空銀行 普通",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "50000",
      "対象外",
      "0",
    ]);
    expect(capital.slice(18, 32)).toEqual([
      "資本金",
      "3000",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "50000",
      "対象外",
      "0",
    ]);
    expect(capital[32]).toBe("資本金の払込");

    const cloud = rows.find((row) => row[2] === "3")!;
    expect(cloud.slice(4, 18)).toEqual([
      "通信費",
      "5320",
      "",
      "架空クラウド株式会社",
      "",
      "",
      "",
      "定期",
      "プラットフォーム",
      "",
      "",
      "1650",
      "課対仕入10%",
      "150",
    ]);
    const voided = rows.find((row) => row[2] === "12")!;
    expect(voided[32]).toBe("書籍代（取消済み）");
    const reversal = rows.find((row) => row[2] === "13")!;
    expect(reversal[32]).toBe("取消 No.12: 書籍代");
    const adjusting = rows.find((row) => row[2] === "23")!;
    expect(adjusting[3]).toBe("1");
    const secondRow = rows.filter((row) => row[2] === "17")[1]!;
    expect(secondRow.slice(4, 18)[0]).toBe("支払手数料");
    expect(secondRow.slice(18, 32)).toEqual(Array.from({ length: 14 }, () => ""));
  });

  it("matches the golden file", () => {
    expectGolden("freee.csv", csvText(rows));
  });
});

describe("yayoiJournalRows", () => {
  const rows = yayoiJournalRows(BOOK, range);

  it("has 25 columns, no header, and the voucher flags", () => {
    for (const row of rows) expect(row).toHaveLength(YAYOI_COLUMN_COUNT);
    expect(rows[0]!.slice(0, 4)).toEqual(["2000", "1", "", "2026/11/02"]);
    const founding = rows.filter((row) => row[1] === "2");
    expect(founding.map((row) => row[0])).toEqual(["2110", "2101"]);
    expect(founding[1]!.slice(10, 16)).toEqual(["", "", "", "対象外", "0", "0"]);
    const receipt = rows.filter((row) => row[1] === "17");
    expect(receipt.map((row) => row[0])).toEqual(["2110", "2101"]);
    const adjusting = rows.find((row) => row[1] === "23")!;
    expect(adjusting[2]).toBe("本決");
    expect(adjusting.slice(19, 25)).toEqual(["0", "", "No.23 ・ 登録済み", "0", "0", "no"]);
    const reversal = rows.find((row) => row[1] === "13")!;
    expect(reversal[21]).toBe("No.13 ・ 反対仕訳（No.12 の取消）");
    expect(rows.find((row) => row[1] === "12")![16]).toBe("書籍代（取消済み）");
  });

  it("encodes as Shift_JIS and matches the golden file", () => {
    const text = csvText(rows);
    expectGolden("yayoi.csv", text);
    const bytes = encodeCsv(text, "sjis");
    expect(bytes.length).toBeLessThan(new TextEncoder().encode(text).length);
    expectGolden("yayoi.sjis.csv", bytes);
  });
});
