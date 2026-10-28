import { describe, expect, it } from "vitest";
import {
  CSV_FORMAT_LABELS,
  CSV_FORMATS,
  detectCsvFormat,
  parseStatement,
} from "../src/csv/registry";
import { parseCsvTable } from "../src/csv/table";
import {
  CSV_FORMAT_KEYS,
  IMPORT_SOURCES,
  type CsvFormatKey,
  type GenericCsvConfig,
} from "../src/types";

function table(...lines: string[]): string[][] {
  return parseCsvTable(lines.join("\n"));
}

/** A 全銀 data record: 19 cells, with the given cells replaced. */
function zenginData(cells: Record<number, string>): string {
  const row = ["2", "00001", "081102", "081102", "1", "11", "1000", "0"];
  while (row.length < 19) row.push("");
  for (const [index, value] of Object.entries(cells)) row[Number(index)] = value;
  return row.join(",");
}

const ZENGIN_HEADER =
  "1,03,0,081201,081101,081130,9999,ﾃｽﾄｷﾞﾝｺｳ,999,ﾃｽﾄｼﾃﾝ,1,1234567,ｶ)ﾃｽﾄｶｲｼｬ,1,1000";

describe("CSV_FORMATS", () => {
  it("lists the formats in the order of the select and of detection", () => {
    expect(CSV_FORMATS.map((format) => format.key)).toEqual<CsvFormatKey[]>([
      "gmo_aozora_zengin",
      "docomo_smtb",
      "rakuten_card",
      "generic",
    ]);
  });

  it("keeps CSV_FORMAT_KEYS (for input schemas) in the same order, beside the import sources", () => {
    expect(CSV_FORMAT_KEYS).toEqual(CSV_FORMATS.map((format) => format.key));
    expect(IMPORT_SOURCES).toEqual(["csv", "stripe", "api"]);
  });

  it("names every format and the wallets it applies to", () => {
    expect(CSV_FORMAT_LABELS).toEqual({
      gmo_aozora_zengin: "GMO あおぞらネット銀行 全銀 CSV",
      docomo_smtb: "ドコモ SMTB ネット銀行（旧 住信 SBI ネット銀行）",
      rakuten_card: "楽天カード（e-NAVI）",
      generic: "汎用",
    });
    expect(
      Object.fromEntries(CSV_FORMATS.map((format) => [format.key, format.walletKinds])),
    ).toEqual({
      gmo_aozora_zengin: ["bank"],
      docomo_smtb: ["bank"],
      rakuten_card: ["card"],
      generic: ["bank", "card", "other"],
    });
  });
});

describe("detectCsvFormat", () => {
  it("returns null for an unknown header and for an empty file", () => {
    expect(detectCsvFormat(table("取引日,摘要,金額"))).toBeNull();
    expect(detectCsvFormat([])).toBeNull();
  });

  it("never picks the generic format", () => {
    expect(CSV_FORMATS.find((format) => format.key === "generic")?.detect(table("a,b"))).toBe(
      false,
    );
  });

  it("recognizes a 全銀 file with only the header and the trailer", () => {
    expect(detectCsvFormat(table(ZENGIN_HEADER, "8,0,0,0,0,1,1000", "9"))).toBe(
      "gmo_aozora_zengin",
    );
  });

  it("does not take a 全銀 header with another 種別コード", () => {
    expect(detectCsvFormat(table(ZENGIN_HEADER.replace("1,03,", "1,01,"), zenginData({})))).toBe(
      null,
    );
  });

  it("absorbs spaces and full-width characters in the ドコモ SMTB header, after a preamble", () => {
    const rows = table(
      "口座番号,1234567",
      "",
      "日付, 内容 ,出金金額（円）,入金金額（円）,残高（円）,メモ,",
      "2026/11/01,テスト,100,,900,",
    );
    expect(detectCsvFormat(rows)).toBe("docomo_smtb");
    const statement = parseStatement({ table: rows, format: "docomo_smtb" });
    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]?.raw).toEqual(["2026/11/01", "テスト", "100", "", "900", ""]);
  });

  it("ignores the month columns of the 楽天カード header", () => {
    expect(
      detectCsvFormat(
        table("利用日,利用店名･商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,3月支払金額"),
      ),
    ).toBe("rakuten_card");
  });
});

describe("GMO あおぞら 全銀", () => {
  const parse = (...lines: string[]) =>
    parseStatement({ table: table(...lines), format: "gmo_aozora_zengin" });

  it("reads an unknown 取引区分 as its code and falls back to it for the description", () => {
    const { rows } = parse(ZENGIN_HEADER, zenginData({ 5: "99" }), "8,1,1000,0,0,1,2000", "9");
    expect(rows[0]).toMatchObject({ category: "99", descriptionRaw: "99", counterpartyRaw: null });
  });

  it("leaves the category empty without a 取引区分", () => {
    const { rows } = parse(ZENGIN_HEADER, zenginData({ 5: "" }), "8,1,1000,0,0,1,2000", "9");
    expect(rows[0]).toMatchObject({ category: null, descriptionRaw: "" });
  });

  it("keeps the rows it can read and lists the others with their reason", () => {
    const statement = parse(
      ZENGIN_HEADER,
      zenginData({ 4: "3" }),
      zenginData({ 2: "081131" }),
      zenginData({ 3: "0811" }),
      zenginData({ 6: "1000.5" }),
      zenginData({ 6: "-1000" }),
      "2,00009,081102,081102,1,11,1000",
      "5,unknown",
      zenginData({ 6: "500" }),
      "8,1,500,0,0,1,1500",
      "9",
      zenginData({}),
    );
    expect(statement.failures.map(({ rowNumber, reason }) => [rowNumber, reason])).toEqual([
      [2, "入払区分が読めません"],
      [3, "日付が読めません"],
      [4, "起算日が読めません"],
      [5, "金額が読めません"],
      [6, "金額が読めません"],
      [7, "列が足りません（18 列が要ります）"],
      [8, "データ区分が読めません（1・2・8・9 のどれでもありません）"],
      [12, "エンドレコードの後の行です"],
    ]);
    expect(statement.failures[0]?.raw).toHaveLength(19);
    expect(statement.rows.map((row) => [row.amount, row.balanceAfter])).toEqual([[500n, 1500n]]);
    expect(statement.warnings).toEqual([]);
  });

  it("makes the balances negative when the header and trailer say 貸越", () => {
    const statement = parse(
      ZENGIN_HEADER.replace(/,1,1000$/, ",2,1000"),
      zenginData({ 4: "2", 6: "500" }),
      "8,0,0,1,500,2,1500",
      "9",
    );
    expect(statement.openingBalance).toBe(-1000n);
    expect(statement.closingBalance).toBe(-1500n);
    expect(statement.rows[0]?.balanceAfter).toBe(-1500n);
    expect(statement.warnings).toEqual([]);
  });

  it("reads rows without a header but cannot give them balances", () => {
    const statement = parse(zenginData({}), "9");
    expect(statement.rows[0]?.balanceAfter).toBeNull();
    expect(statement.openingBalance).toBeNull();
    expect(statement.period).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    expect(statement.warnings).toEqual([
      "ヘッダの行がありません。取引前残高がないので残高を積めません",
    ]);
  });

  it("warns when the trailer is missing", () => {
    expect(parse(ZENGIN_HEADER, zenginData({})).warnings).toEqual([
      "トレーラの行がありません。ファイルが途中で切れていないか確かめてください",
    ]);
  });

  it("warns about a header or trailer it cannot read", () => {
    expect(
      parse("1,03,0,081201,081101,081130", zenginData({}), "8,1,1000,0,0,1,1000").warnings,
    ).toEqual(["1 行目のヘッダの列が足りません（15 列が要ります）"]);
    expect(parse(ZENGIN_HEADER, zenginData({}), "8,x,1000,0,0,1,2000").warnings).toEqual([
      "3 行目のトレーラの件数・合計・取引後残高が読めません",
    ]);
    expect(parse(ZENGIN_HEADER, zenginData({}), "8,1,1000").warnings).toEqual([
      "3 行目のトレーラの列が足りません（7 列が要ります）",
    ]);
  });

  it("refuses a second account in the same file", () => {
    const statement = parse(
      ZENGIN_HEADER,
      zenginData({}),
      "8,1,1000,0,0,1,2000",
      ZENGIN_HEADER,
      zenginData({}),
      "8,1,1000,0,0,1,2000",
      "9",
    );
    expect(statement.rows).toHaveLength(1);
    expect(statement.failures.map(({ rowNumber, reason }) => [rowNumber, reason])).toEqual([
      [4, "2 つ目の口座のヘッダです（1 つのファイルで取り込めるのは 1 口座です）"],
      [5, "別の口座の明細です（1 つのファイルで取り込めるのは 1 口座です）"],
    ]);
    expect(statement.warnings).toEqual([]);
  });

  it("keeps the header's period for a file without transactions", () => {
    const statement = parse(ZENGIN_HEADER, "8,0,0,0,0,1,1000", "9");
    expect(statement.rows).toEqual([]);
    expect(statement.period).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(statement.warnings).toEqual([]);
  });
});

describe("ドコモ SMTB", () => {
  const HEADER = "日付,内容,出金金額(円),入金金額(円),残高(円),メモ";
  const parse = (...lines: string[]) =>
    parseStatement({ table: table(...lines), format: "docomo_smtb" });

  it("lists rows it cannot read with their reason", () => {
    const statement = parse(
      HEADER,
      "2026/11/01,両方空,,,1000,",
      "2026/11/02,金額不正,1.5,,1000,",
      "2026/11/03,残高不正,100,,abc,",
      "2026/11/31,日付不正,100,,900,",
      "2026/11/04,短い,100",
      "2026/11/05,入出金両方,100,300,1200,",
    );
    expect(statement.failures.map(({ rowNumber, reason }) => [rowNumber, reason])).toEqual([
      [2, "金額が読めません"],
      [3, "金額が読めません"],
      [4, "残高が読めません"],
      [5, "日付が読めません"],
      [6, "列が足りません（5 列が要ります）"],
    ]);
    expect(statement.rows.map((row) => [row.amount, row.balanceAfter])).toEqual([[200n, 1200n]]);
  });

  it("fails clearly when chosen for a file without its header", () => {
    const statement = parse("", "取引日,摘要,金額", "2026/11/01,テスト,100");
    expect(statement.rows).toEqual([]);
    expect(statement.failures).toEqual([
      {
        rowNumber: 2,
        reason:
          "ヘッダ行（日付、内容、出金金額(円)、入金金額(円)、残高(円)、メモ）が見つかりません",
        raw: ["取引日", "摘要", "金額"],
      },
    ]);
  });
});

describe("楽天カード", () => {
  const HEADER = "利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額";
  const parse = (...lines: string[]) =>
    parseStatement({ table: table(...lines), format: "rakuten_card" });

  it("skips rows without a 利用日 and fails rows it cannot read", () => {
    const statement = parse(
      HEADER,
      "2026/11/01,テストカフェ,本人,,1200,0,1200",
      ",合計,,,1200,0,1200",
      "2026/11/41,不正な日付,本人,1回払い,100,0,100",
      "2026/11/02,金額なし,本人,1回払い,,0,",
      "2026/11/03,短い,本人",
    );
    expect(statement.rows.map((row) => [row.amount, row.category])).toEqual([[-1200n, null]]);
    expect(statement.failures.map(({ rowNumber, reason }) => [rowNumber, reason])).toEqual([
      [4, "日付が読めません"],
      [5, "金額が読めません"],
      [6, "列が足りません（5 列が要ります）"],
    ]);
  });
});

describe("汎用", () => {
  const signed: GenericCsvConfig = {
    headerRows: 1,
    columns: { date: 0, description: 1, amount: 2 },
  };
  const parse = (config: GenericCsvConfig | null, ...lines: string[]) =>
    parseStatement({ table: table(...lines), format: "generic", config });

  it.each<[string, GenericCsvConfig | null]>([
    ["汎用の形式には列の対応が要ります", null],
    [
      "金額（符号付き）と出金・入金は、どちらか一方だけを選んでください",
      { headerRows: 1, columns: { date: 0, description: 1, amount: 2, deposit: 3 } },
    ],
    [
      "金額（符号付き）か、出金・入金の列を選んでください",
      { headerRows: 1, columns: { date: 0, description: 1 } },
    ],
    [
      "列の番号は 0 以上の整数で指定してください",
      { headerRows: 1, columns: { date: -1, description: 1, amount: 2 } },
    ],
    [
      "列の番号は 0 以上の整数で指定してください",
      { headerRows: 1, columns: { date: 0, description: 1.5, amount: 2 } },
    ],
    [
      "ヘッダ行の数は 0 以上の整数で指定してください",
      { headerRows: -1, columns: { date: 0, description: 1, amount: 2 } },
    ],
    [
      "並びは 自動・古い順・新しい順 のどれかを選んでください",
      {
        headerRows: 1,
        columns: { date: 0, description: 1, amount: 2 },
        order: "newest" as unknown as "asc",
      },
    ],
  ])("throws %j for an invalid mapping", (message, config) => {
    expect(() => parse(config, "a,b,c")).toThrow(new RangeError(message));
  });

  it("fails rows shorter than the mapped columns", () => {
    const statement = parse(
      { headerRows: 1, columns: { date: 0, description: 1, amount: 2, counterparty: 4 } },
      "日付,摘要,金額,残高,相手",
      "2026/11/01,テスト,100,1000",
    );
    expect(statement.failures).toEqual([
      {
        rowNumber: 2,
        reason: "列が足りません（5 列が要ります）",
        raw: ["2026/11/01", "テスト", "100", "1000"],
      },
    ]);
  });

  it("inverts a positive-is-outflow amount and skips the configured header rows", () => {
    const statement = parse(
      { ...signed, headerRows: 2, invertSign: true },
      "カード利用明細",
      "利用日,利用先,利用金額",
      "2026/11/01,テスト,1200",
      "2026/11/02,返品,-200",
    );
    expect(statement.rows.map((row) => [row.txnDate, row.amount])).toEqual([
      ["2026-11-01", -1200n],
      ["2026-11-02", 200n],
    ]);
  });

  it("reads a deposit-only mapping and blank rows in between", () => {
    const statement = parse(
      { headerRows: 0, columns: { date: 0, description: 1, deposit: 2 } },
      "2026/11/01,入金,1000",
      ",,",
      "2026/11/02,空,",
    );
    expect(statement.rows.map((row) => row.amount)).toEqual([1000n]);
    expect(statement.failures.map(({ rowNumber, reason }) => [rowNumber, reason])).toEqual([
      [3, "金額が読めません"],
    ]);
  });

  it("takes the defaults for a saved mapping without headerRows and order", () => {
    const saved = JSON.parse(
      '{"columns":{"date":0,"description":1,"amount":2},"order":null}',
    ) as GenericCsvConfig;
    const statement = parse(saved, "日付,摘要,金額", "2026/11/02,b,2", "2026/11/01,a,1");
    expect(statement.rows.map((row) => row.descriptionRaw)).toEqual(["a", "b"]);
    expect(statement.failures).toEqual([]);
  });

  it("follows a forced order and computes the period from the rows", () => {
    const statement = parse(
      { ...signed, order: "desc" },
      "日付,摘要,金額",
      "2026/11/05,b,2",
      "2026/11/09,a,1",
    );
    expect(statement.rows.map((row) => row.descriptionRaw)).toEqual(["a", "b"]);
    expect(statement.period).toEqual({ from: "2026-11-05", to: "2026-11-09" });
  });
});

describe("parseStatement", () => {
  it("rejects an unknown format key", () => {
    expect(() =>
      parseStatement({ table: [], format: "toString" as unknown as CsvFormatKey }),
    ).toThrow(RangeError);
  });

  it("returns an empty statement for an empty file", () => {
    expect(parseStatement({ table: [], format: "rakuten_card" })).toEqual({
      format: "rakuten_card",
      rows: [],
      failures: [],
      warnings: [],
      openingBalance: null,
      closingBalance: null,
      period: null,
    });
  });

  it("leaves external IDs to parseStatement: a format's own parse returns them empty", () => {
    const format = CSV_FORMATS.find((item) => item.key === "rakuten_card");
    const parsed = format?.parse(
      table("利用日,利用店名・商品名,利用者,支払方法,利用金額", "2026/11/01,a,本人,1回払い,1"),
      null,
    );
    expect(parsed?.rows[0]?.externalId).toBe("");
  });
});
