import { CHART_TEMPLATE } from "@niho-finance/ledger";
import { describe, expect, it } from "vitest";
import {
  accountEtaxCodeViews,
  buildFinancialStatements,
  codeRow,
  defineEtaxEdition,
  editionForFiscalYear,
  EtaxCharacterError,
  EtaxTextConverter,
  etaxCodeSection,
  filingDateOf,
  GROUP_CODE_SECTIONS,
  HOT010_2019_EDITION,
  isJisX0208Char,
  normalizeEtaxCodeInput,
  resolveAccountEtaxCode,
  statementOfGroup,
  toEtaxFullWidth,
  toEtaxText,
  validateEtaxCodeOverride,
} from "../../src";
import { ACCOUNTS, BOOK, FY1, FY2 } from "./fixture";

const edition = HOT010_2019_EDITION;

describe("the 2019 edition", () => {
  it("is labelled and in force from 2020-04-01", () => {
    expect(edition.id).toBe("hot010-3.0/2019");
    expect(edition.label).toBe("2019 年版・一般商工業");
    expect(edition.effectiveFrom).toBe("2020-04-01");
    expect(edition.tables.BS.rows).toHaveLength(586);
    expect(edition.tables.PL.rows).toHaveLength(827);
  });

  it("maps every account of the standard chart to a code of its table and section", () => {
    for (const account of CHART_TEMPLATE) {
      if (account.group === "internal") {
        expect(edition.defaultMapping[account.code], account.code).toBeUndefined();
        continue;
      }
      const mapped = edition.defaultMapping[account.code];
      expect(mapped, account.code).toBeDefined();
      const code = typeof mapped === "string" ? mapped : mapped!.under;
      const statement = statementOfGroup(account.group)!;
      expect(codeRow(edition.tables[statement], code), `${account.code} → ${code}`).toBeDefined();
      const section = etaxCodeSection(code)!;
      expect(GROUP_CODE_SECTIONS[account.group], `${account.code} → ${code}`).toContain(section);
      if (typeof mapped === "string") {
        // A plain code is a value-bearing row (custom items use `under`).
        expect(codeRow(edition.tables[statement], code)!.title, code).toBe(false);
      }
    }
  });

  it("only maps codes of the standard chart", () => {
    const chart = new Set(CHART_TEMPLATE.map((account) => account.code));
    for (const code of Object.keys(edition.defaultMapping))
      expect(chart.has(code), code).toBe(true);
  });

  it("refuses a layout code missing from its tables", () => {
    expect(() =>
      defineEtaxEdition({
        form: "HOT010",
        formVersion: "3.0",
        edition: "broken",
        industry: "10",
        effectiveFrom: "2030-04-01",
        tables: edition.tables,
        defaultMapping: edition.defaultMapping,
        layout: { ...edition.layout, retainedEarningsCode: "10C999999" },
      }),
    ).toThrow(/10C999999/);
  });
});

describe("editionForFiscalYear", () => {
  it("compares the edition with the filing date (the end of the year + 2 months)", () => {
    expect(filingDateOf({ endDate: "2027-03-31" })).toBe("2027-05-31");
    expect(filingDateOf({ endDate: "2027-12-31" })).toBe("2028-02-29");
    expect(filingDateOf({ endDate: "2027-02-28" })).toBe("2027-04-30");
    expect(filingDateOf({ endDate: "2027-06-15" })).toBe("2027-08-15");
    expect(editionForFiscalYear(FY1)).toBe(edition);
    expect(() => editionForFiscalYear({ endDate: "2019-12-31" })).toThrow(/使える版がありません/);
  });

  it("takes the latest edition in force", () => {
    const newer = defineEtaxEdition({
      form: "HOT010",
      formVersion: "3.0",
      edition: "2099",
      industry: "10",
      effectiveFrom: "2028-05-31",
      tables: edition.tables,
      defaultMapping: edition.defaultMapping,
      layout: edition.layout,
    });
    expect(editionForFiscalYear(FY1, [newer, edition])).toBe(edition);
    expect(editionForFiscalYear(FY2, [newer, edition])).toBe(newer);
  });
});

describe("validateEtaxCodeOverride", () => {
  const cash = { group: "current_assets" as const };
  const sga = { group: "sga" as const };

  it("accepts a code of the table in the group's section (full width too) and blank", () => {
    expect(validateEtaxCodeOverride(cash, "10A100020", edition)).toBeNull();
    expect(validateEtaxCodeOverride(cash, " １０ａ１０００２０ ", edition)).toBeNull();
    expect(validateEtaxCodeOverride(cash, "", edition)).toBeNull();
    expect(normalizeEtaxCodeInput("１０ａ１０００２０")).toBe("10A100020");
    // A title code means a custom item under it.
    expect(validateEtaxCodeOverride(sga, "10E200010", edition)).toBeNull();
  });

  it("explains why a code is refused", () => {
    expect(validateEtaxCodeOverride(sga, "10E200010-1", edition)).toBe(
      "枝番のついたコードは使えません。枝番は決算書を作るときに自動で付きます",
    );
    expect(validateEtaxCodeOverride(sga, "10E999999", edition)).toBe(
      "勘定科目コード「10E999999」は2019 年版・一般商工業のコード表にありません",
    );
    expect(validateEtaxCodeOverride(sga, "10E300020", edition)).toBe(
      "勘定科目コード「10E300020 支払利息」は科目の区分（販売費及び一般管理費）に合いません",
    );
    expect(validateEtaxCodeOverride(cash, "10E200180", edition)).toBe(
      "勘定科目コード「10E200180」は損益計算書のコードです。貸借対照表のコードを入れてください",
    );
    expect(validateEtaxCodeOverride(cash, "10A101160", edition)).toBe(
      "「流動資産合計」は合計の行のコードなので使えません",
    );
    expect(validateEtaxCodeOverride({ group: "internal" }, "10A100020", edition)).toMatch(
      /内部取引/,
    );
  });
});

describe("resolveAccountEtaxCode", () => {
  const account = (code: string, eTaxCode: string | null = null) => ({
    ...ACCOUNTS.find((a) => a.code === code)!,
    eTaxCode,
  });

  it("follows override → default → group title", () => {
    expect(resolveAccountEtaxCode(account("1100"), edition)).toMatchObject({
      code: "10A100020",
      branch: false,
      origin: "standard",
      tableLabel: "現金及び預金",
      problem: null,
    });
    expect(resolveAccountEtaxCode(account("5325"), edition)).toMatchObject({
      code: "10E200010",
      branch: true,
      origin: "custom",
    });
    expect(resolveAccountEtaxCode(account("5320", "10E201220"), edition)).toMatchObject({
      code: "10E201220",
      origin: "override",
    });
    expect(resolveAccountEtaxCode(account("5320", "10E200010"), edition)).toMatchObject({
      code: "10E200010",
      branch: true,
      origin: "override",
    });
    expect(resolveAccountEtaxCode(account("5320", "10X000000"), edition)).toMatchObject({
      code: "10E200180",
      origin: "standard",
      problem: "override_unusable",
    });
    expect(resolveAccountEtaxCode(account("5320", "10E300020"), edition)).toMatchObject({
      code: "10E200010",
      branch: true,
      origin: "fallback",
      problem: "override_section",
    });
    expect(
      resolveAccountEtaxCode(
        { id: "x", code: "1290", group: "current_assets", eTaxCode: null },
        edition,
      ),
    ).toMatchObject({
      code: "10A100010",
      branch: true,
      origin: "fallback",
      problem: "default_missing",
    });
    expect(
      resolveAccountEtaxCode({ id: "x", code: "5470", group: "sga", eTaxCode: null }, edition),
    ).toMatchObject({ code: "10E200010", origin: "fallback", problem: "default_section" });
    expect(resolveAccountEtaxCode(account("9000"), edition)).toBeNull();
  });

  it("lists the codes for the settings screen and the statements", () => {
    const views = accountEtaxCodeViews(ACCOUNTS, edition);
    expect(views.find((v) => v.accountCode === "9000")).toBeUndefined();
    expect(views.find((v) => v.accountCode === "1000")).toMatchObject({
      displayCode: "10A100020",
      tableLabel: "現金及び預金",
      originLabel: "標準",
      groupLabel: "流動資産",
      note: null,
    });
    expect(views.find((v) => v.accountCode === "5325")).toMatchObject({
      displayCode: "10E200010 の枝番",
      originLabel: "独自科目",
    });
    const report = buildFinancialStatements(BOOK, FY1.id);
    expect(report.codeViews.find((v) => v.accountCode === "5325")?.displayCode).toBe("10E200010-1");
  });
});

describe("JIS X 0208 (5.4)", () => {
  it("widens half-width text", () => {
    expect(toEtaxFullWidth("NIHO株式会社")).toBe("ＮＩＨＯ株式会社");
    expect(toEtaxFullWidth("A B")).toBe("Ａ　Ｂ");
    expect(toEtaxFullWidth("ｶﾞｷﾞｸﾞ ﾊﾟ")).toBe("ガギグ　パ");
    expect(toEtaxFullWidth("\"x\" 'y'")).toBe("”ｘ”　’ｙ’");
    expect(toEtaxFullWidth("1-2~3")).toBe("１－２～３");
  });

  it("replaces the look-alikes", () => {
    expect(toEtaxFullWidth("〜−‖¢£¬")).toBe("～－∥￠￡￢");
    expect(toEtaxText("10〜20", "注記")).toBe("１０～２０");
  });

  it("composes split voiced marks", () => {
    expect(toEtaxFullWidth("が")).toBe("が");
    expect(toEtaxFullWidth("゙")).toBe("゛");
  });

  it("turns machine-dependent characters into plain full-width text", () => {
    expect(toEtaxText("①", "注記")).toBe("（１）");
    expect(toEtaxText("⑳", "注記")).toBe("（２０）");
    expect(toEtaxText("Ⅰ", "注記")).toBe("（Ｉ）");
    expect(toEtaxText("㈱", "注記")).toBe("（株）");
    expect(toEtaxText("㎡", "注記")).toBe("ｍ２");
    expect(toEtaxText("№", "注記")).toBe("Ｎｏ");
  });

  it("knows the JIS X 0208 range", () => {
    expect(isJisX0208Char("亜")).toBe(true);
    expect(isJisX0208Char("熙")).toBe(true); // 84-6, the last of level 2
    expect(isJisX0208Char("　")).toBe(true);
    expect(isJisX0208Char("─")).toBe(true); // row 8
    expect(isJisX0208Char("①")).toBe(false); // NEC special (row 13)
    expect(isJisX0208Char("纊")).toBe(false); // NEC-selected IBM extension
    expect(isJisX0208Char("髙")).toBe(false); // IBM extension
    expect(isJisX0208Char("𠮷")).toBe(false); // outside Shift_JIS
    expect(isJisX0208Char("A")).toBe(false); // half width
  });

  it("collects what cannot be carried, with where", () => {
    const converter = new EtaxTextConverter();
    expect(converter.convert("𠮷野", "法人名")).toBe("𠮷野");
    converter.convert("髙橋😀", "科目「髙橋😀」");
    expect(converter.problems).toEqual([
      { char: "𠮷", codePoint: "U+20BB7", where: "法人名" },
      { char: "髙", codePoint: "U+9AD9", where: "科目「髙橋😀」" },
      { char: "😀", codePoint: "U+1F600", where: "科目「髙橋😀」" },
    ]);
    expect(() => converter.throwIfAny()).toThrow(EtaxCharacterError);
    expect(() => toEtaxText("𠮷", "法人名")).toThrow(
      "この文字は e-Tax で使えません: 「𠮷」（法人名）",
    );
  });

  it("keeps line breaks as CRLF only in text values", () => {
    const converter = new EtaxTextConverter();
    expect(converter.convert("1行目\n2行目", "注記", { multiline: true })).toBe("１行目\r\n２行目");
    expect(converter.convert("1行目\r\n2行目\t3", "科目")).toBe("１行目　２行目　３");
  });
});
