/**
 * The editions of e-Tax's code tables for 財務諸表 CSV (17-financial-statements §6.1). Each edition
 * is a folder `data/etax/<form>-<version>/<edition>/` that is never rewritten once added (the tests
 * pin its SHA-256). A fiscal year uses the latest edition whose `effectiveFrom` is on or before its
 * filing date (the end of the year + 2 months), so a new edition changes later years only.
 *
 * An edition is the code tables, the default mapping of the standard chart and the layout: the codes
 * the statements put their totals, headings and fixed rows on (they belong to the table's version).
 */
import type { AccountGroup, CalendarDate } from "@niho-finance/ledger";
import type { IncomeSubtotalKey } from "../../statements";
import { addMonths } from "../format";
import bs2019 from "../../../data/etax/hot010-3.0/2019/bs-10.json";
import mapping2019 from "../../../data/etax/hot010-3.0/2019/default-mapping.json";
import manifest2019 from "../../../data/etax/hot010-3.0/2019/manifest.json";
import nt2019 from "../../../data/etax/hot010-3.0/2019/nt.json";
import pl2019 from "../../../data/etax/hot010-3.0/2019/pl-10.json";
import ss2019 from "../../../data/etax/hot010-3.0/2019/ss.json";

export const ETAX_STATEMENTS = ["BS", "PL", "SS", "NT"] as const;
/** 財務諸表の種類: 貸借対照表 / 損益計算書 / 株主資本等変動計算書 / 個別注記表. */
export type EtaxStatement = (typeof ETAX_STATEMENTS)[number];

export const ETAX_STATEMENT_NAMES: Readonly<Record<EtaxStatement, string>> = {
  BS: "貸借対照表",
  PL: "損益計算書",
  SS: "株主資本等変動計算書",
  NT: "個別注記表",
};

/** 行区分: `1` 金額 / `2` 文字 / `T` タイトル. */
export type EtaxRowKind = "1" | "2" | "T";

export interface EtaxCodeRow {
  code: string;
  /** 階層番号 */
  depth: number;
  /** e-Tax 対応勘定科目の名前 (タイトル項目は標準ラベル). */
  label: string;
  /** タイトル項目: holds no value. */
  title: boolean;
  /** 合計の科目. */
  total: boolean;
  /** 行区分 of the standard form (SS / NT only). */
  rowKind: EtaxRowKind | null;
  /** 繰り返し設定可能コード: `group` is the head of a set, `item` a member. */
  repeat: "group" | "item" | null;
}

export interface EtaxCodeTable {
  statement: EtaxStatement;
  /** In the official presentation order (a depth tree). */
  rows: readonly EtaxCodeRow[];
  /** code → position in `rows`. */
  positions: ReadonlyMap<string, number>;
  /** position → the parent's position (−1 for a root). */
  parents: readonly number[];
  /** position → one past the last position of its subtree. */
  subtreeEnds: readonly number[];
}

/** Standard chart code → e-Tax code, or `{ under }`: a custom item under that title or total. */
export type EtaxDefaultMapping = Readonly<Record<string, string | { under: string }>>;

/** The groups that appear on the statements (internal transactions never do). */
export type StatementGroup = Exclude<AccountGroup, "internal">;

/** How a total of BS / PL is computed (17 §4.1 table). */
export type EtaxTotalValue =
  /** The lines whose code section starts with one of these (`A21`, `A`, …). */
  | { sections: readonly string[] }
  /** The lines in the subtree of this title. */
  | { subtree: string }
  /** One of S7's income subtotals. */
  | { income: IncomeSubtotalKey };

export interface EtaxTotalSpec {
  code: string;
  value: EtaxTotalValue;
  /** Shown even when nothing is in scope (資産合計, 当期純利益 …). */
  always?: boolean;
  /** Accounts may map to this code too (売上高): their amounts are part of the total. */
  accountsMayUse?: boolean;
  /** The name on the statements when the table's name is the heading's (その他利益剰余金合計). */
  label?: string;
}

/** One block of 株主資本等変動計算書 (a title and its rows). */
export interface EtaxEquityBlock {
  title: string;
  opening: string;
  changes: string;
  issuance?: string;
  dividends?: string;
  netIncome?: string;
  changeTotal: string;
  closing: string;
}

export interface EtaxLayout {
  /** The BS / PL titles shown on the screens and in the PDF (17 §4.1 rule 6). */
  headings: readonly string[];
  balanceSheetTotals: readonly EtaxTotalSpec[];
  incomeStatementTotals: readonly EtaxTotalSpec[];
  /** The totals the checks and the other documents read. */
  keyTotals: {
    /** 資産合計 */
    assets: string;
    /** 負債合計 */
    liabilities: string;
    /** 純資産合計 */
    netAssets: string;
    /** 負債純資産合計 */
    liabilitiesAndNetAssets: string;
    /** 販売費及び一般管理費合計 */
    sga: string;
  };
  /** §6.2 step 3: the title a group's unmapped account goes under (as a custom item). */
  groupFallbackCodes: Readonly<Record<StatementGroup, string>>;
  /** 繰越利益剰余金: 3200 + earlier years' profit + net income. */
  retainedEarningsCode: string;
  /** 資本準備金 */
  capitalReserveCode: string;
  /** Code section of 資本金. */
  capitalSection: string;
  /** 引当金の見出し (附属明細書 引当金の明細). */
  provisionTitles: readonly string[];
  equity: {
    root: string;
    capital: EtaxEquityBlock;
    capitalSurplus: string;
    capitalReserve: EtaxEquityBlock;
    capitalSurplusTotal: EtaxEquityBlock;
    retainedEarnings: string;
    otherRetainedEarnings: string;
    carriedForward: EtaxEquityBlock;
    retainedEarningsTotal: EtaxEquityBlock;
    shareholdersEquityTotal: EtaxEquityBlock;
    netAssetsTotal: EtaxEquityBlock;
  };
  notes: {
    accountingPolicies: string;
    depreciation: string;
    revenueRecognition: string;
    otherSignificant: string;
    policyChanges: string;
    presentationChanges: string;
    equityNote: string;
    shareClasses: string;
    issuedShares: string;
    commonShares: string;
    commonSharesAtEnd: string;
    otherNotes: string;
    otherNoteTitle: string;
    otherNoteBody: string;
  };
}

export interface EtaxEdition {
  /** `hot010-3.0/2019` */
  id: string;
  form: string;
  formVersion: string;
  edition: string;
  /** 業種番号 (10 一般商工業). */
  industry: string;
  /** Compared with the filing date of a fiscal year. */
  effectiveFrom: CalendarDate;
  /** 「2019 年版・一般商工業」 */
  label: string;
  tables: Readonly<Record<EtaxStatement, EtaxCodeTable>>;
  defaultMapping: EtaxDefaultMapping;
  layout: EtaxLayout;
}

const INDUSTRY_LABELS: Readonly<Record<string, string>> = { "10": "一般商工業" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(what: string): never {
  throw new Error(`reports: e-Tax code table ${what} is malformed`);
}

/** Checks and indexes a table read from the JSON (`{ statement, rows }`). */
export function parseCodeTable(json: unknown, statement: EtaxStatement): EtaxCodeTable {
  if (!isRecord(json) || !Array.isArray(json.rows)) invalid(statement);
  if (json.statement !== statement) invalid(`${statement} (statement ${String(json.statement)})`);
  const rows: EtaxCodeRow[] = json.rows.map((raw: unknown, i: number): EtaxCodeRow => {
    if (!isRecord(raw)) invalid(`${statement} row ${i}`);
    const { code, depth, label } = raw;
    if (typeof code !== "string" || typeof label !== "string") invalid(`${statement} row ${i}`);
    if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1) {
      invalid(`${statement} row ${i}`);
    }
    const rowKind = raw.rowKind;
    if (rowKind !== undefined && rowKind !== "1" && rowKind !== "2" && rowKind !== "T") {
      invalid(`${statement} row ${i}`);
    }
    const repeat = raw.repeat;
    if (repeat !== undefined && repeat !== "group" && repeat !== "item") {
      invalid(`${statement} row ${i}`);
    }
    return {
      code,
      depth,
      label,
      title: raw.title === true,
      total: raw.total === true,
      rowKind: rowKind ?? null,
      repeat: repeat ?? null,
    };
  });

  const positions = new Map<string, number>();
  const parents: number[] = [];
  const stack: number[] = [];
  rows.forEach((row, i) => {
    if (positions.has(row.code)) invalid(`${statement} (duplicate ${row.code})`);
    positions.set(row.code, i);
    while (stack.length > 0 && rows[stack[stack.length - 1]!]!.depth >= row.depth) stack.pop();
    parents.push(stack.length > 0 ? stack[stack.length - 1]! : -1);
    stack.push(i);
  });
  const subtreeEnds = rows.map((row, i) => {
    let end = i + 1;
    while (end < rows.length && rows[end]!.depth > row.depth) end += 1;
    return end;
  });
  return { statement, rows, positions, parents, subtreeEnds };
}

export function codeRow(table: EtaxCodeTable, code: string): EtaxCodeRow | undefined {
  const position = table.positions.get(code);
  return position === undefined ? undefined : table.rows[position];
}

function parseMapping(json: unknown): EtaxDefaultMapping {
  if (!isRecord(json) || !isRecord(json.accounts)) invalid("default mapping");
  const mapping: Record<string, string | { under: string }> = {};
  for (const [accountCode, value] of Object.entries(json.accounts)) {
    if (typeof value === "string") mapping[accountCode] = value;
    else if (isRecord(value) && typeof value.under === "string") {
      mapping[accountCode] = { under: value.under };
    } else invalid(`default mapping (${accountCode})`);
  }
  return mapping;
}

export interface EtaxEditionInput {
  form: string;
  formVersion: string;
  edition: string;
  industry: string;
  effectiveFrom: CalendarDate;
  /** The JSON of each table (`{ statement, rows }`) or an already parsed table. */
  tables: Readonly<Record<EtaxStatement, unknown>>;
  /** The JSON of `default-mapping.json` (`{ accounts }`) or a parsed mapping. */
  defaultMapping: unknown;
  layout: EtaxLayout;
}

function isParsedTable(value: unknown): value is EtaxCodeTable {
  return isRecord(value) && value.positions instanceof Map;
}

function layoutCodes(layout: EtaxLayout): { statement: EtaxStatement; code: string }[] {
  const codes: { statement: EtaxStatement; code: string }[] = [];
  for (const spec of layout.balanceSheetTotals) codes.push({ statement: "BS", code: spec.code });
  for (const spec of layout.incomeStatementTotals) codes.push({ statement: "PL", code: spec.code });
  const { sga, ...balanceSheetKeys } = layout.keyTotals;
  for (const code of Object.values(balanceSheetKeys)) codes.push({ statement: "BS", code });
  codes.push({ statement: "PL", code: sga });
  codes.push({ statement: "BS", code: layout.retainedEarningsCode });
  codes.push({ statement: "BS", code: layout.capitalReserveCode });
  for (const code of layout.provisionTitles) codes.push({ statement: "BS", code });
  for (const value of Object.values(layout.equity)) {
    if (typeof value === "string") codes.push({ statement: "SS", code: value });
    else {
      for (const code of Object.values(value)) {
        if (typeof code === "string") codes.push({ statement: "SS", code });
      }
    }
  }
  for (const code of Object.values(layout.notes)) codes.push({ statement: "NT", code });
  return codes;
}

/** Builds an edition and checks that every code of its layout is in its tables. */
export function defineEtaxEdition(input: EtaxEditionInput): EtaxEdition {
  const tables = {} as Record<EtaxStatement, EtaxCodeTable>;
  for (const statement of ETAX_STATEMENTS) {
    const table = input.tables[statement];
    tables[statement] = isParsedTable(table) ? table : parseCodeTable(table, statement);
  }
  const defaultMapping =
    isRecord(input.defaultMapping) && !("accounts" in input.defaultMapping)
      ? (input.defaultMapping as EtaxDefaultMapping)
      : parseMapping(input.defaultMapping);
  for (const { statement, code } of layoutCodes(input.layout)) {
    if (!tables[statement].positions.has(code)) {
      throw new Error(`reports: layout code ${code} is not in the ${statement} table`);
    }
  }
  for (const code of [
    ...input.layout.headings,
    ...Object.values(input.layout.groupFallbackCodes),
  ]) {
    if (!tables.BS.positions.has(code) && !tables.PL.positions.has(code)) {
      throw new Error(`reports: layout code ${code} is not in the BS or PL table`);
    }
  }
  const industry = INDUSTRY_LABELS[input.industry] ?? `業種番号 ${input.industry}`;
  return {
    id: `${input.form.toLowerCase()}-${input.formVersion}/${input.edition}`,
    form: input.form,
    formVersion: input.formVersion,
    edition: input.edition,
    industry: input.industry,
    effectiveFrom: input.effectiveFrom,
    label: `${input.edition} 年版・${industry}`,
    tables,
    defaultMapping,
    layout: input.layout,
  };
}

// ---------------------------------------------------------------------------
// HOT010 Ver.3.0 / 2019 年版・一般商工業
// ---------------------------------------------------------------------------

export const HOT010_2019_LAYOUT: EtaxLayout = {
  headings: [
    "10A000010", // 資産の部
    "10A100010", // 流動資産
    "10A200010", // 固定資産
    "10A210010", // 有形固定資産
    "10A220010", // 無形固定資産
    "10A230010", // 投資その他の資産
    "10A300010", // 繰延資産
    "10B000010", // 負債の部
    "10B100010", // 流動負債
    "10B200010", // 固定負債
    "10C000010", // 純資産の部
    "10C100010", // 株主資本
    "10C120010", // 資本剰余金
    "10C130010", // 利益剰余金
    "10C130030", // その他利益剰余金
    "10D100020", // 売上高
    "10E100020", // 売上原価
    "10E200010", // 販売費及び一般管理費
    "10D200010", // 営業外収益
    "10E300010", // 営業外費用
    "10D300010", // 特別利益
    "10E400010", // 特別損失
  ],
  balanceSheetTotals: [
    { code: "10A101160", value: { sections: ["A10"] } }, // 流動資産合計
    { code: "10A210950", value: { sections: ["A21"] } }, // 有形固定資産合計
    { code: "10A220330", value: { sections: ["A22"] } }, // 無形固定資産合計
    { code: "10A230880", value: { sections: ["A23"] } }, // 投資その他の資産合計
    { code: "10A200020", value: { sections: ["A21", "A22", "A23"] } }, // 固定資産合計
    { code: "10A300080", value: { sections: ["A30"] } }, // 繰延資産合計
    { code: "10A000020", value: { sections: ["A"] }, always: true }, // 資産合計
    { code: "10B101070", value: { sections: ["B10"] } }, // 流動負債合計
    { code: "10B200670", value: { sections: ["B20"] } }, // 固定負債合計
    { code: "10B000020", value: { sections: ["B"] }, always: true }, // 負債合計
    { code: "10C120040", value: { sections: ["C12"] } }, // 資本剰余金合計
    { code: "10C130380", value: { subtree: "10C130030" }, label: "その他利益剰余金合計" },
    { code: "10C130390", value: { sections: ["C13"] } }, // 利益剰余金合計
    { code: "10C100040", value: { sections: ["C10", "C11", "C12", "C13"] }, always: true }, // 株主資本合計
    { code: "10C000030", value: { sections: ["C"] }, always: true }, // 純資産合計
    { code: "10C000040", value: { sections: ["B", "C"] }, always: true }, // 負債純資産合計
  ],
  incomeStatementTotals: [
    { code: "10D100030", value: { sections: ["D10"] }, accountsMayUse: true }, // 売上高
    { code: "10E100030", value: { sections: ["E10"] }, accountsMayUse: true }, // 売上原価
    { code: "10F000010", value: { income: "grossProfit" }, always: true }, // 売上総利益
    { code: "10E201330", value: { sections: ["E20"] } }, // 販売費及び一般管理費合計
    { code: "10F000110", value: { income: "operatingIncome" }, always: true }, // 営業利益
    { code: "10D200740", value: { sections: ["D20"] } }, // 営業外収益合計
    { code: "10E300910", value: { sections: ["E30"] } }, // 営業外費用合計
    { code: "10F000130", value: { income: "ordinaryIncome" }, always: true }, // 経常利益
    { code: "10D300670", value: { sections: ["D30"] } }, // 特別利益合計
    { code: "10E401090", value: { sections: ["E40"] } }, // 特別損失合計
    { code: "10F000150", value: { income: "pretaxIncome" }, always: true }, // 税引前当期純利益
    { code: "10F100060", value: { sections: ["F10"] } }, // 法人税等
    { code: "10F000160", value: { income: "netIncome" }, always: true }, // 当期純利益
  ],
  keyTotals: {
    assets: "10A000020",
    liabilities: "10B000020",
    netAssets: "10C000030",
    liabilitiesAndNetAssets: "10C000040",
    sga: "10E201330",
  },
  groupFallbackCodes: {
    current_assets: "10A100010",
    fixed_assets: "10A230010",
    deferred_assets: "10A300010",
    current_liabilities: "10B100010",
    fixed_liabilities: "10B200010",
    shareholders_equity: "10C100010",
    sales: "10D100020",
    cost_of_sales: "10E100020",
    sga: "10E200010",
    non_operating_income: "10D200010",
    non_operating_expenses: "10E300010",
    extraordinary_income: "10D300010",
    extraordinary_losses: "10E400010",
    income_taxes: "10F100060",
  },
  retainedEarningsCode: "10C130370",
  capitalReserveCode: "10C120020",
  capitalSection: "C11",
  provisionTitles: ["10B100300", "10B200110"],
  equity: {
    root: "SS0100",
    capital: {
      title: "SS0200",
      opening: "SS0201",
      changes: "SS0202",
      issuance: "SS0203",
      changeTotal: "SS0298",
      closing: "SS0299",
    },
    capitalSurplus: "SS0300",
    capitalReserve: {
      title: "SS0400",
      opening: "SS0401",
      changes: "SS0402",
      issuance: "SS0403",
      changeTotal: "SS0498",
      closing: "SS0499",
    },
    capitalSurplusTotal: {
      title: "SS0600",
      opening: "SS0601",
      changes: "SS0602",
      issuance: "SS0603",
      changeTotal: "SS0698",
      closing: "SS0699",
    },
    retainedEarnings: "SS0700",
    otherRetainedEarnings: "SS0900",
    carriedForward: {
      title: "SS2000",
      opening: "SS2001",
      changes: "SS2002",
      dividends: "SS2005",
      netIncome: "SS2006",
      changeTotal: "SS2098",
      closing: "SS2099",
    },
    retainedEarningsTotal: {
      title: "SS2100",
      opening: "SS2101",
      changes: "SS2102",
      dividends: "SS2105",
      netIncome: "SS2106",
      changeTotal: "SS2198",
      closing: "SS2199",
    },
    shareholdersEquityTotal: {
      title: "SS2300",
      opening: "SS2301",
      changes: "SS2302",
      issuance: "SS2303",
      dividends: "SS2305",
      netIncome: "SS2306",
      changeTotal: "SS2398",
      closing: "SS2399",
    },
    netAssetsTotal: {
      title: "SS3100",
      opening: "SS3101",
      changes: "SS3102",
      issuance: "SS3103",
      dividends: "SS3105",
      netIncome: "SS3106",
      changeTotal: "SS3198",
      closing: "SS3199",
    },
  },
  notes: {
    accountingPolicies: "NT0201",
    depreciation: "NT0205",
    revenueRecognition: "NT0207",
    otherSignificant: "NT0208",
    policyChanges: "NT0213",
    presentationChanges: "NT0214",
    equityNote: "NT0501",
    shareClasses: "NT0502",
    issuedShares: "NT0503",
    commonShares: "NT0504",
    commonSharesAtEnd: "NT0508",
    otherNotes: "NT1201",
    otherNoteTitle: "NT1202",
    otherNoteBody: "NT1203",
  },
};

function manifestDate(value: unknown): CalendarDate {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid("manifest");
  return value as CalendarDate;
}

export const HOT010_2019_EDITION: EtaxEdition = defineEtaxEdition({
  form: manifest2019.form,
  formVersion: manifest2019.formVersion,
  edition: manifest2019.edition,
  industry: manifest2019.industry,
  effectiveFrom: manifestDate(manifest2019.effectiveFrom),
  tables: { BS: bs2019, PL: pl2019, SS: ss2019, NT: nt2019 },
  defaultMapping: mapping2019,
  layout: HOT010_2019_LAYOUT,
});

/** Every edition, oldest first. Add a new one here; never edit an existing folder. */
export const ETAX_EDITIONS: readonly EtaxEdition[] = [HOT010_2019_EDITION];

/** 提出日: the end of the fiscal year + 2 months (法人税の申告期限。延長はしない前提). */
export function filingDateOf(fiscalYear: { endDate: CalendarDate }): CalendarDate {
  return addMonths(fiscalYear.endDate, 2);
}

/** The latest edition in force on the fiscal year's filing date (17 §6.1). */
export function editionForFiscalYear(
  fiscalYear: { endDate: CalendarDate },
  editions: readonly EtaxEdition[] = ETAX_EDITIONS,
): EtaxEdition {
  const filingDate = filingDateOf(fiscalYear);
  let chosen: EtaxEdition | undefined;
  for (const edition of editions) {
    if (edition.effectiveFrom > filingDate) continue;
    if (!chosen || edition.effectiveFrom > chosen.effectiveFrom) chosen = edition;
  }
  if (!chosen) {
    throw new Error(`e-Tax の勘定科目コード表に、提出日 ${filingDate} に使える版がありません`);
  }
  return chosen;
}
