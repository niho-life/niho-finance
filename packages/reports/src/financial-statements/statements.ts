/**
 * The lines of 貸借対照表・損益計算書・株主資本等変動計算書 (17-financial-statements §4.1–§4.3), in the
 * order and depth of the e-Tax code table. The screens, the PDF and HOT010 CSV are all made from
 * these lines, so their numbers cannot differ.
 *
 * A line is shown when it has an amount, is an ancestor of one (a title or a parent item), or is a
 * total of §4.1. Amounts are aggregated per code (現金 and 普通預金 make one 現金及び預金), on the
 * normal side (assets and expenses debit-positive; 減価償却累計額 is negative). A custom item gets the
 * code of the title it goes under plus `-1`, `-2`, … (in account code order) and is placed at the end
 * of that title's subtree, before its total.
 */
import { normalSide, type CalendarDate, type Money } from "@niho-finance/ledger";
import {
  incomeSubtotals,
  INCOME_STATEMENT_GROUPS,
  MONEY_OPS,
  type GroupTotals,
  type IncomeStatementGroup,
  type IncomeSubtotals,
} from "../statements";
import type { EtaxCodeTable, EtaxEdition, EtaxTotalSpec } from "./etax/editions";
import { etaxCodeSection, type AccountEtaxCode } from "./etax/mapping";
import type { FinancialStatementsAccount } from "./source";

export type StatementLineKind = "title" | "amount" | "total";

export interface StatementLine {
  /** The table's code, or a custom item's branch code (`10E200010-1`). */
  code: string;
  /** 17 §4.1 rule 5: the account's name for one account, the table's name otherwise. */
  label: string;
  /** 階層番号 of the code table (a custom item: its title's + 1). */
  depth: number;
  kind: StatementLineKind;
  /** On the normal side of the statement; `null` for titles. */
  amount: Money | null;
  /**
   * Shown on the screen and in the PDF: every amount and total, and the titles that are section
   * headings (rule 6). HOT010 CSV has every line.
   */
  visible: boolean;
  /** Indent on the screen and in the PDF: the number of visible ancestors. */
  indent: number;
  /** The accounts the amount comes from. */
  accountIds: readonly string[];
}

/** An account's amount on the statement's normal side. */
export interface AccountAmount {
  account: FinancialStatementsAccount;
  amount: Money;
}

interface Placed {
  /** Where it sits in the table: the code, or the title of a custom item. */
  tableCode: string;
  position: number;
  branch: boolean;
  /** Final code (branches numbered after aggregation). */
  code: string;
  amount: Money;
  accounts: FinancialStatementsAccount[];
  section: string | null;
}

function compareCodes(a: { code: string }, b: { code: string }): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function ancestors(table: EtaxCodeTable, position: number): number[] {
  const chain: number[] = [];
  let parent = table.parents[position] ?? -1;
  while (parent !== -1) {
    chain.push(parent);
    parent = table.parents[parent] ?? -1;
  }
  return chain;
}

function requirePosition(table: EtaxCodeTable, code: string): number {
  const position = table.positions.get(code);
  if (position === undefined) {
    throw new Error(`reports: code ${code} is not in the ${table.statement} table`);
  }
  return position;
}

export interface StatementLayoutInput {
  table: EtaxCodeTable;
  headings: readonly string[];
  totals: readonly EtaxTotalSpec[];
  amounts: readonly AccountAmount[];
  codes: ReadonlyMap<string, AccountEtaxCode>;
  /** The income subtotals (PL). */
  incomeSubtotals?: IncomeSubtotals<Money>;
}

export interface StatementLayout {
  lines: StatementLine[];
  /** Every total of the layout by code (shown or not). */
  totals: ReadonlyMap<string, Money>;
  /** Custom items: account id → branch code. */
  branchCodes: ReadonlyMap<string, string>;
}

/** Lays out one statement (BS or PL) from the accounts' amounts (17 §4.1). */
export function layoutStatement(input: StatementLayoutInput): StatementLayout {
  const { table } = input;
  const placed = new Map<string, Placed>();
  for (const { account, amount } of input.amounts) {
    const code = input.codes.get(account.id);
    if (!code || amount === 0n) continue;
    const key = code.branch ? `${code.code}|${account.id}` : code.code;
    const current = placed.get(key);
    if (current) {
      current.amount += amount;
      current.accounts.push(account);
      continue;
    }
    placed.set(key, {
      tableCode: code.code,
      position: requirePosition(table, code.code),
      branch: code.branch,
      code: code.code,
      amount,
      accounts: [account],
      section: etaxCodeSection(code.code),
    });
  }
  // 0 の科目は出さない (an aggregate of 0 too).
  const entries = [...placed.values()].filter((entry) => entry.amount !== 0n);
  for (const entry of entries) entry.accounts.sort(compareCodes);

  // Branch numbers per title, in account code order.
  const branchCodes = new Map<string, string>();
  const byTitle = new Map<string, Placed[]>();
  for (const entry of entries) {
    if (!entry.branch) continue;
    const list = byTitle.get(entry.tableCode) ?? [];
    list.push(entry);
    byTitle.set(entry.tableCode, list);
  }
  for (const list of byTitle.values()) {
    list.sort((a, b) => compareCodes(a.accounts[0]!, b.accounts[0]!));
    list.forEach((entry, i) => {
      entry.code = `${entry.tableCode}-${i + 1}`;
      branchCodes.set(entry.accounts[0]!.id, entry.code);
    });
  }

  // Totals (17 §4.1 table).
  const totals = new Map<string, Money>();
  const shownTotals = new Map<string, { spec: EtaxTotalSpec; amount: Money }>();
  for (const spec of input.totals) {
    let amount: Money = 0n;
    let inScope = false;
    const value = spec.value;
    if ("income" in value) {
      amount = input.incomeSubtotals?.[value.income] ?? 0n;
      inScope = true;
    } else {
      let contains: (entry: Placed) => boolean;
      if ("sections" in value) {
        contains = (entry) =>
          entry.section !== null &&
          value.sections.some((prefix) => entry.section!.startsWith(prefix));
      } else {
        const start = requirePosition(table, value.subtree);
        const end = table.subtreeEnds[start] ?? start + 1;
        contains = (entry) => entry.position >= start && entry.position < end;
      }
      for (const entry of entries) {
        if (!contains(entry)) continue;
        amount += entry.amount;
        inScope = true;
      }
    }
    totals.set(spec.code, amount);
    if (spec.always || inScope) shownTotals.set(spec.code, { spec, amount });
  }

  // The rows of the table to show: amounts, totals, and every ancestor of them.
  const direct = new Map<number, Placed>();
  for (const entry of entries) if (!entry.branch) direct.set(entry.position, entry);
  const selected = new Set<number>();
  const select = (position: number) => {
    selected.add(position);
    for (const parent of ancestors(table, position)) selected.add(parent);
  };
  for (const entry of entries) select(entry.position);
  for (const code of shownTotals.keys()) select(requirePosition(table, code));

  // Where the custom items go: before the title's total (a total row one level down in its
  // subtree), else after the subtree.
  const before = new Map<number, Placed[]>();
  const after = new Map<number, Placed[]>();
  for (const list of byTitle.values()) {
    const first = list[0]!;
    const start = first.position;
    const depth = table.rows[start]!.depth;
    const end = table.subtreeEnds[start] ?? start + 1;
    let anchor = -1;
    for (let p = start + 1; p < end; p += 1) {
      const row = table.rows[p]!;
      if (row.total && row.depth === depth + 1) anchor = p;
    }
    if (anchor !== -1) before.set(anchor, list);
    else after.set(end - 1, list);
  }

  const lines: StatementLine[] = [];
  const linePositions: number[][] = [];
  const pushCustom = (list: readonly Placed[] | undefined) => {
    for (const entry of list ?? []) {
      const title = table.rows[entry.position]!;
      lines.push({
        code: entry.code,
        label: entry.accounts[0]!.name,
        depth: title.depth + 1,
        kind: "amount",
        amount: entry.amount,
        visible: true,
        indent: 0,
        accountIds: entry.accounts.map((account) => account.id),
      });
      linePositions.push([entry.position, ...ancestors(table, entry.position)]);
    }
  };
  table.rows.forEach((row, position) => {
    pushCustom(before.get(position));
    if (selected.has(position)) {
      const total = shownTotals.get(row.code);
      const entry = direct.get(position);
      const accountIds = entry ? entry.accounts.map((account) => account.id) : [];
      if (total) {
        lines.push({
          code: row.code,
          label: total.spec.label ?? row.label,
          depth: row.depth,
          kind: "total",
          amount: total.amount,
          visible: true,
          indent: 0,
          accountIds,
        });
      } else if (entry) {
        lines.push({
          code: row.code,
          label: entry.accounts.length === 1 ? entry.accounts[0]!.name : row.label,
          depth: row.depth,
          kind: "amount",
          amount: entry.amount,
          visible: true,
          indent: 0,
          accountIds,
        });
      } else {
        lines.push({
          code: row.code,
          label: row.label,
          depth: row.depth,
          kind: "title",
          amount: null,
          visible: input.headings.includes(row.code),
          indent: 0,
          accountIds: [],
        });
      }
      linePositions.push(ancestors(table, position));
    }
    pushCustom(after.get(position));
  });

  // A heading whose only visible content is one line of the same name stands aside (売上高 / 売上高).
  const lineAt = new Map<number, number>();
  lines.forEach((line, i) => {
    const position = table.positions.get(line.code);
    if (position !== undefined) lineAt.set(position, i);
  });
  lines.forEach((line, i) => {
    if (line.kind !== "title" || !line.visible) return;
    const position = table.positions.get(line.code)!;
    const descendants = lines.filter(
      (other, j) => j !== i && other.visible && linePositions[j]!.includes(position),
    );
    if (descendants.length === 1 && descendants[0]!.label === line.label) line.visible = false;
  });
  lines.forEach((line, i) => {
    line.indent = linePositions[i]!.filter((position) => {
      const at = lineAt.get(position);
      return at !== undefined && lines[at]!.visible && at !== i;
    }).length;
  });

  return { lines, totals, branchCodes };
}

// ---------------------------------------------------------------------------
// 貸借対照表・損益計算書
// ---------------------------------------------------------------------------

export interface FinancialBalanceSheet {
  /** 期末日 (or 成立の日 for the opening balance sheet). */
  asOf: CalendarDate;
  lines: StatementLine[];
  assets: Money;
  liabilities: Money;
  netAssets: Money;
  liabilitiesAndNetAssets: Money;
  branchCodes: ReadonlyMap<string, string>;
}

export interface FinancialIncomeStatement {
  from: CalendarDate;
  to: CalendarDate;
  lines: StatementLine[];
  groupTotals: GroupTotals<Money>;
  subtotals: IncomeSubtotals<Money>;
  /** 売上高 */
  sales: Money;
  netIncome: Money;
  branchCodes: ReadonlyMap<string, string>;
}

/** The normal-side amount of an account from debit − credit. */
export function normalAmount(account: FinancialStatementsAccount, net: Money): Money {
  return normalSide(account.kind) === "debit" ? net : -net;
}

/** The standard 繰越利益剰余金 account. */
export const RETAINED_EARNINGS_ACCOUNT_CODE = "3200";

const BALANCE_SHEET_KINDS = new Set(["asset", "liability", "equity"]);
const INCOME_KINDS = new Set(["revenue", "expense"]);

export interface BalanceSheetInput {
  edition: EtaxEdition;
  asOf: CalendarDate;
  accounts: readonly FinancialStatementsAccount[];
  codes: ReadonlyMap<string, AccountEtaxCode>;
  /** debit − credit per account through `asOf`. */
  net: ReadonlyMap<string, Money>;
  /** Earlier years' profit not closed yet + this year's net income (added to 繰越利益剰余金). */
  profit: Money;
}

/** A synthetic 繰越利益剰余金 when the chart has none (the profit still has to show). */
function retainedEarningsAccount(
  accounts: readonly FinancialStatementsAccount[],
  edition: EtaxEdition,
  codes: Map<string, AccountEtaxCode>,
): FinancialStatementsAccount {
  const existing = accounts.find(
    (account) => account.code === RETAINED_EARNINGS_ACCOUNT_CODE && account.kind === "equity",
  );
  if (existing) return existing;
  const synthetic: FinancialStatementsAccount = {
    id: "",
    code: RETAINED_EARNINGS_ACCOUNT_CODE,
    name: "繰越利益剰余金",
    kind: "equity",
    group: "shareholders_equity",
    isCashLike: false,
    isActive: true,
    sortOrder: 0,
    eTaxCode: null,
  };
  const code = edition.layout.retainedEarningsCode;
  codes.set(synthetic.id, {
    accountId: synthetic.id,
    statement: "BS",
    code,
    branch: false,
    tableLabel: "繰越利益剰余金",
    origin: "standard",
    problem: null,
  });
  return synthetic;
}

export function buildBalanceSheet(input: BalanceSheetInput): FinancialBalanceSheet {
  const codes = new Map(input.codes);
  const retained = retainedEarningsAccount(input.accounts, input.edition, codes);
  const amounts: AccountAmount[] = [];
  let retainedSeen = false;
  for (const account of input.accounts) {
    if (!BALANCE_SHEET_KINDS.has(account.kind)) continue;
    let amount = normalAmount(account, input.net.get(account.id) ?? 0n);
    if (account.id === retained.id) {
      amount += input.profit;
      retainedSeen = true;
    }
    amounts.push({ account, amount });
  }
  if (!retainedSeen) amounts.push({ account: retained, amount: input.profit });

  const layout = layoutStatement({
    table: input.edition.tables.BS,
    headings: input.edition.layout.headings,
    totals: input.edition.layout.balanceSheetTotals,
    amounts,
    codes,
  });
  const total = (code: string) => layout.totals.get(code) ?? 0n;
  const keys = input.edition.layout.keyTotals;
  return {
    asOf: input.asOf,
    lines: layout.lines,
    assets: total(keys.assets),
    liabilities: total(keys.liabilities),
    netAssets: total(keys.netAssets),
    liabilitiesAndNetAssets: total(keys.liabilitiesAndNetAssets),
    branchCodes: layout.branchCodes,
  };
}

export interface IncomeStatementInput {
  edition: EtaxEdition;
  from: CalendarDate;
  to: CalendarDate;
  accounts: readonly FinancialStatementsAccount[];
  codes: ReadonlyMap<string, AccountEtaxCode>;
  /** debit − credit per account within the year (closing entries left out). */
  net: ReadonlyMap<string, Money>;
}

function isIncomeStatementGroup(group: string): group is IncomeStatementGroup {
  return (INCOME_STATEMENT_GROUPS as readonly string[]).includes(group);
}

export function buildIncomeStatement(input: IncomeStatementInput): FinancialIncomeStatement {
  const amounts: AccountAmount[] = [];
  const groupTotals = {} as GroupTotals<Money>;
  for (const group of INCOME_STATEMENT_GROUPS) groupTotals[group] = 0n;
  for (const account of input.accounts) {
    if (!INCOME_KINDS.has(account.kind)) continue;
    const amount = normalAmount(account, input.net.get(account.id) ?? 0n);
    amounts.push({ account, amount });
    if (isIncomeStatementGroup(account.group)) groupTotals[account.group] += amount;
  }
  const subtotals = incomeSubtotals(groupTotals, MONEY_OPS);
  const layout = layoutStatement({
    table: input.edition.tables.PL,
    headings: input.edition.layout.headings,
    totals: input.edition.layout.incomeStatementTotals,
    amounts,
    codes: input.codes,
    incomeSubtotals: subtotals,
  });
  return {
    from: input.from,
    to: input.to,
    lines: layout.lines,
    groupTotals,
    subtotals,
    sales: groupTotals.sales,
    netIncome: subtotals.netIncome,
    branchCodes: layout.branchCodes,
  };
}

/** The two sides of the 勘定式 (資産の部 | 負債の部・純資産の部) and the bottom row of each. */
export interface BalanceSheetSides {
  assets: StatementLine[];
  liabilitiesAndNetAssets: StatementLine[];
  /** 資産合計 */
  assetsTotal: StatementLine | null;
  /** 負債純資産合計 */
  liabilitiesAndNetAssetsTotal: StatementLine | null;
}

/** Splits the visible lines for a 勘定式 layout (PDF, 決算公告). */
export function balanceSheetSides(
  sheet: FinancialBalanceSheet,
  edition: EtaxEdition,
): BalanceSheetSides {
  const assetsCode = edition.layout.keyTotals.assets;
  const rightCode = edition.layout.keyTotals.liabilitiesAndNetAssets;
  const visible = sheet.lines.filter((line) => line.visible);
  const isAsset = (line: StatementLine) => etaxCodeSection(line.code)?.startsWith("A") ?? false;
  return {
    assets: visible.filter((line) => isAsset(line) && line.code !== assetsCode),
    liabilitiesAndNetAssets: visible.filter((line) => !isAsset(line) && line.code !== rightCode),
    assetsTotal: visible.find((line) => line.code === assetsCode) ?? null,
    liabilitiesAndNetAssetsTotal: visible.find((line) => line.code === rightCode) ?? null,
  };
}
