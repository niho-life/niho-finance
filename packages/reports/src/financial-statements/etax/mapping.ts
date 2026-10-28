/**
 * 勘定科目コード of each account (17-financial-statements §6.2–§6.4). In this order: the account's
 * override (`Account.eTaxCode`) when the edition's table has it and its section fits the group; the
 * edition's default mapping by the account's code (`{ under }` = a custom item); otherwise a custom
 * item under the group's title, reported in the 確認. A title code means "a custom item under it":
 * the statements give it a branch number (`10E200010-1`).
 */
import { ACCOUNT_GROUP_LABELS, type AccountGroup } from "@niho-finance/ledger";
import {
  codeRow,
  ETAX_STATEMENT_NAMES,
  type EtaxCodeRow,
  type EtaxEdition,
  type StatementGroup,
} from "./editions";

/** The code sections each group may use (chars 3–5 of the code, 17 §6.3). */
export const GROUP_CODE_SECTIONS: Readonly<Record<StatementGroup, readonly string[]>> = {
  current_assets: ["A10"],
  fixed_assets: ["A21", "A22", "A23"],
  deferred_assets: ["A30"],
  current_liabilities: ["B10"],
  fixed_liabilities: ["B20"],
  shareholders_equity: ["C10", "C11", "C12", "C13"],
  sales: ["D10"],
  cost_of_sales: ["E10"],
  sga: ["E20"],
  non_operating_income: ["D20"],
  non_operating_expenses: ["E30"],
  extraordinary_income: ["D30"],
  extraordinary_losses: ["E40"],
  income_taxes: ["F10"],
};

const BALANCE_SHEET_GROUPS: readonly AccountGroup[] = [
  "current_assets",
  "fixed_assets",
  "deferred_assets",
  "current_liabilities",
  "fixed_liabilities",
  "shareholders_equity",
];

export type StatementOfGroup = "BS" | "PL";

/** BS / PL for the statement groups, `null` for internal transactions. */
export function statementOfGroup(group: AccountGroup): StatementOfGroup | null {
  if (group === "internal") return null;
  return BALANCE_SHEET_GROUPS.includes(group) ? "BS" : "PL";
}

/** `10A100020` → `A10`; a branch (`10E200010-1`) has its parent's section. `null` otherwise. */
export function etaxCodeSection(code: string): string | null {
  const match = /^\d{2}([A-Z]\d{2})\d{4}(?:-\d+)?$/.exec(code);
  return match?.[1] ?? null;
}

/** Full-width letters and digits → half-width, trimmed and upper-cased (what the form accepts). */
export function normalizeEtaxCodeInput(input: string): string {
  return input.normalize("NFKC").trim().toUpperCase();
}

function isComputedTotal(edition: EtaxEdition, statement: StatementOfGroup, code: string): boolean {
  const specs =
    statement === "BS" ? edition.layout.balanceSheetTotals : edition.layout.incomeStatementTotals;
  return specs.some((spec) => spec.code === code && !spec.accountsMayUse);
}

type CodeCheck =
  | { ok: true; row: EtaxCodeRow }
  | {
      ok: false;
      reason: "branch" | "unknown" | "other_statement" | "section" | "total";
      row?: EtaxCodeRow;
    };

function checkCode(group: StatementGroup, code: string, edition: EtaxEdition): CodeCheck {
  if (code.includes("-")) return { ok: false, reason: "branch" };
  const statement = statementOfGroup(group) ?? "BS";
  const row = codeRow(edition.tables[statement], code);
  if (!row) {
    const other = statement === "BS" ? "PL" : "BS";
    const inOther = codeRow(edition.tables[other], code);
    return inOther
      ? { ok: false, reason: "other_statement", row: inOther }
      : { ok: false, reason: "unknown" };
  }
  const section = etaxCodeSection(code);
  if (section === null || !GROUP_CODE_SECTIONS[group].includes(section)) {
    return { ok: false, reason: "section", row };
  }
  if (isComputedTotal(edition, statement, code)) return { ok: false, reason: "total", row };
  return { ok: true, row };
}

function groupLabel(group: AccountGroup): string {
  return ACCOUNT_GROUP_LABELS[group];
}

/**
 * Checks an override typed on 設定 › 勘定科目: `null` when it can be saved (empty = back to the
 * standard code), otherwise the reason to show.
 */
export function validateEtaxCodeOverride(
  account: { group: AccountGroup },
  input: string,
  edition: EtaxEdition,
): string | null {
  const code = normalizeEtaxCodeInput(input);
  if (code === "") return null;
  if (account.group === "internal") {
    return "内部取引の科目は決算書に出ないので、勘定科目コードは使えません";
  }
  const check = checkCode(account.group, code, edition);
  if (check.ok) return null;
  switch (check.reason) {
    case "branch":
      return "枝番のついたコードは使えません。枝番は決算書を作るときに自動で付きます";
    case "unknown":
      return `勘定科目コード「${code}」は${edition.label}のコード表にありません`;
    case "other_statement": {
      const own = ETAX_STATEMENT_NAMES[statementOfGroup(account.group) ?? "BS"];
      const other =
        own === ETAX_STATEMENT_NAMES.BS ? ETAX_STATEMENT_NAMES.PL : ETAX_STATEMENT_NAMES.BS;
      return `勘定科目コード「${code}」は${other}のコードです。${own}のコードを入れてください`;
    }
    case "section":
      return `勘定科目コード「${code} ${check.row?.label ?? ""}」は科目の区分（${groupLabel(account.group)}）に合いません`;
    case "total":
      return `「${check.row?.label ?? code}」は合計の行のコードなので使えません`;
  }
}

export const ETAX_CODE_ORIGINS = ["standard", "override", "custom", "fallback"] as const;
/** 標準 / 個別に設定 / 独自科目 / 独自科目（コードが決まっていない） */
export type EtaxCodeOrigin = (typeof ETAX_CODE_ORIGINS)[number];

export const ETAX_CODE_ORIGIN_LABELS: Readonly<Record<EtaxCodeOrigin, string>> = {
  standard: "標準",
  override: "個別に設定",
  custom: "独自科目",
  fallback: "独自科目（未設定）",
};

/**
 * Why the override or the default could not be used: `override_unusable` falls back to the default;
 * the others put the account under its group's title (§6.2 step 3) and are reported.
 */
export type EtaxCodeProblem =
  "override_unusable" | "override_section" | "default_missing" | "default_section";

export interface AccountEtaxCode {
  accountId: string;
  statement: StatementOfGroup;
  /** The table row the amount goes to; for a custom item (`branch`), the title it goes under. */
  code: string;
  /** A custom item: the statements number it `code-1`, `code-2`, … */
  branch: boolean;
  /** The table's name of `code`. */
  tableLabel: string;
  origin: EtaxCodeOrigin;
  problem: EtaxCodeProblem | null;
}

interface MappableAccount {
  id: string;
  code: string;
  group: AccountGroup;
  eTaxCode: string | null;
}

function target(
  account: MappableAccount,
  statement: StatementOfGroup,
  row: EtaxCodeRow,
  origin: EtaxCodeOrigin,
  problem: EtaxCodeProblem | null,
  forceBranch = false,
): AccountEtaxCode {
  return {
    accountId: account.id,
    statement,
    code: row.code,
    branch: forceBranch || row.title,
    tableLabel: row.label,
    origin: (forceBranch || row.title) && origin === "standard" ? "custom" : origin,
    problem,
  };
}

/** The code of one account in an edition; `null` for internal accounts (never on the statements). */
export function resolveAccountEtaxCode(
  account: MappableAccount,
  edition: EtaxEdition,
): AccountEtaxCode | null {
  const group = account.group;
  if (group === "internal") return null;
  const statement = statementOfGroup(group);
  if (statement === null) return null;
  const table = edition.tables[statement];
  const fallback = (problem: EtaxCodeProblem): AccountEtaxCode => {
    const code = edition.layout.groupFallbackCodes[group];
    const row = codeRow(table, code);
    if (!row) throw new Error(`reports: fallback code ${code} is not in the ${statement} table`);
    return target(account, statement, row, "fallback", problem, true);
  };

  let problem: EtaxCodeProblem | null = null;
  const override = account.eTaxCode ? normalizeEtaxCodeInput(account.eTaxCode) : "";
  if (override !== "") {
    const check = checkCode(group, override, edition);
    if (check.ok) return target(account, statement, check.row, "override", null);
    if (check.reason === "section") return fallback("override_section");
    problem = "override_unusable";
  }

  const mapped = edition.defaultMapping[account.code];
  if (mapped === undefined) return fallback(problem ?? "default_missing");
  if (typeof mapped === "string") {
    const check = checkCode(group, mapped, edition);
    if (check.ok) return target(account, statement, check.row, "standard", problem);
    return fallback(check.reason === "section" ? "default_section" : "default_missing");
  }
  const row = codeRow(table, mapped.under);
  const section = etaxCodeSection(mapped.under);
  if (!row) return fallback("default_missing");
  if (section === null || !GROUP_CODE_SECTIONS[group].includes(section)) {
    return fallback("default_section");
  }
  return target(account, statement, row, "custom", problem, true);
}

/** Codes of every account (internal ones left out), by account id. */
export function resolveAccountEtaxCodes(
  accounts: readonly MappableAccount[],
  edition: EtaxEdition,
): Map<string, AccountEtaxCode> {
  const codes = new Map<string, AccountEtaxCode>();
  for (const account of accounts) {
    const code = resolveAccountEtaxCode(account, edition);
    if (code) codes.set(account.id, code);
  }
  return codes;
}

/** Owner-facing note on a code's problem (the 勘定科目コード table and the 確認). */
export function etaxCodeProblemMessage(
  problem: EtaxCodeProblem,
  account: { eTaxCode: string | null; group: AccountGroup },
  edition: EtaxEdition,
): string {
  switch (problem) {
    case "override_unusable":
      return `個別に設定したコード「${account.eTaxCode ?? ""}」は${edition.label}で使えないため、標準のコードで出します`;
    case "override_section":
      return `個別に設定したコード「${account.eTaxCode ?? ""}」が科目の区分（${groupLabel(account.group)}）に合わないため、独自科目として出します`;
    case "default_missing":
      return `勘定科目コードが決まっていないため、${groupLabel(account.group)}の独自科目として出します`;
    case "default_section":
      return `標準のコードが科目の区分（${groupLabel(account.group)}）に合わないため、独自科目として出します`;
  }
}

/** One row of the 勘定科目コード table (17 §3 item 5, §6.4). */
export interface AccountEtaxCodeView {
  accountId: string;
  accountCode: string;
  accountName: string;
  groupLabel: string;
  /** `10A100020`, a branch `10E200010-1`, or 「10E200010 の枝番」 before a branch is numbered. */
  displayCode: string;
  /** The table's name (a custom item: the title it goes under). */
  tableLabel: string;
  origin: EtaxCodeOrigin;
  originLabel: string;
  /** Why the override or the default was not used, or `null`. */
  note: string | null;
}

export function accountEtaxCodeViews(
  accounts: readonly (MappableAccount & { name: string })[],
  edition: EtaxEdition,
  /** Branch codes the statements gave (account id → `10E200010-1`). */
  branchCodes: ReadonlyMap<string, string> = new Map(),
): AccountEtaxCodeView[] {
  const views: AccountEtaxCodeView[] = [];
  const sorted = [...accounts].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const account of sorted) {
    const code = resolveAccountEtaxCode(account, edition);
    if (!code) continue;
    views.push({
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      groupLabel: groupLabel(account.group),
      displayCode: code.branch ? (branchCodes.get(account.id) ?? `${code.code} の枝番`) : code.code,
      tableLabel: code.tableLabel,
      origin: code.origin,
      originLabel: ETAX_CODE_ORIGIN_LABELS[code.origin],
      note: code.problem ? etaxCodeProblemMessage(code.problem, account, edition) : null,
    });
  }
  return views;
}
