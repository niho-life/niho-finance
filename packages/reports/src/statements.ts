/**
 * The shape of the statements (14-reports §3, §4): the balance sheet's sections and the income
 * statement's groups and subtotals, laid out as rows over any value type (an amount, a vector of
 * months, a trial-balance cell). The trial balance and the monthly trend share this.
 */
import { ACCOUNT_GROUP_LABELS, type AccountGroup } from "@niho-finance/ledger";
import type { ReportAccount, ReportSubAccount } from "./source";

/** Arithmetic over the value type of a statement. */
export interface VectorOps<T> {
  zero(): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  isZero(a: T): boolean;
}

export type StatementRowKind =
  "section" | "group" | "account" | "subAccount" | "subtotal" | "total";

export interface StatementRow<T> {
  kind: StatementRowKind;
  /** Stable within a statement (React keys, tests). */
  key: string;
  label: string;
  /** 0 for sections and totals, 1 for groups and subtotals, 2 for accounts, 3 for sub-accounts. */
  level: number;
  value: T;
  code?: string;
  accountId?: string;
  subAccountId?: string | null;
  group?: AccountGroup;
}

export interface AccountValue<T> {
  account: ReportAccount;
  /** On the account's normal side (assets / expenses debit-positive, the rest credit-positive). */
  value: T;
  /** Breakdown by sub-account (`null` = lines without one), in the order to show. */
  subAccounts?: readonly { subAccount: ReportSubAccount | null; value: T }[];
}

export const BALANCE_SHEET_SECTIONS = [
  { key: "assets", label: "資産", groups: ["current_assets", "fixed_assets", "deferred_assets"] },
  { key: "liabilities", label: "負債", groups: ["current_liabilities", "fixed_liabilities"] },
  { key: "equity", label: "純資産", groups: ["shareholders_equity"] },
] as const satisfies readonly { key: string; label: string; groups: readonly AccountGroup[] }[];

export const INCOME_STATEMENT_GROUPS = [
  "sales",
  "cost_of_sales",
  "sga",
  "non_operating_income",
  "non_operating_expenses",
  "extraordinary_income",
  "extraordinary_losses",
  "income_taxes",
] as const satisfies readonly AccountGroup[];
export type IncomeStatementGroup = (typeof INCOME_STATEMENT_GROUPS)[number];

export const INCOME_SUBTOTAL_KEYS = [
  "grossProfit",
  "operatingIncome",
  "ordinaryIncome",
  "pretaxIncome",
  "netIncome",
] as const;
export type IncomeSubtotalKey = (typeof INCOME_SUBTOTAL_KEYS)[number];

export const INCOME_SUBTOTAL_LABELS: Readonly<Record<IncomeSubtotalKey, string>> = {
  grossProfit: "売上総利益",
  operatingIncome: "営業利益",
  ordinaryIncome: "経常利益",
  pretaxIncome: "税引前当期純利益",
  netIncome: "当期純利益",
};

/** The subtotal shown after each group (14-reports §3). */
const SUBTOTAL_AFTER: Partial<Record<IncomeStatementGroup, IncomeSubtotalKey>> = {
  cost_of_sales: "grossProfit",
  sga: "operatingIncome",
  non_operating_expenses: "ordinaryIncome",
  extraordinary_losses: "pretaxIncome",
  income_taxes: "netIncome",
};

export const NET_INCOME_LABEL = INCOME_SUBTOTAL_LABELS.netIncome;
export const PRIOR_PERIODS_PROFIT_LABEL = "前期以前の損益（決算振替前）";

export type GroupTotals<T> = Record<IncomeStatementGroup, T>;
export type IncomeSubtotals<T> = Record<IncomeSubtotalKey, T>;

export interface IncomeStatementLayout<T> {
  rows: StatementRow<T>[];
  groupTotals: GroupTotals<T>;
  subtotals: IncomeSubtotals<T>;
}

function sumValues<T>(values: readonly AccountValue<T>[], ops: VectorOps<T>): T {
  return values.reduce((total, row) => ops.add(total, row.value), ops.zero());
}

function accountRows<T>(values: readonly AccountValue<T>[], prefix: string): StatementRow<T>[] {
  const rows: StatementRow<T>[] = [];
  for (const row of values) {
    rows.push({
      kind: "account",
      key: `${prefix}:${row.account.id}`,
      label: row.account.name,
      level: 2,
      value: row.value,
      code: row.account.code,
      accountId: row.account.id,
      group: row.account.group,
    });
    for (const sub of row.subAccounts ?? []) {
      rows.push({
        kind: "subAccount",
        key: `${prefix}:${row.account.id}:${sub.subAccount?.id ?? "none"}`,
        label: sub.subAccount?.name ?? "（補助科目なし）",
        level: 3,
        value: sub.value,
        code: row.account.code,
        accountId: row.account.id,
        subAccountId: sub.subAccount?.id ?? null,
        group: row.account.group,
      });
    }
  }
  return rows;
}

/** Income statement subtotals from the group totals (02-accounting-rules §2 order). */
export function incomeSubtotals<T>(groups: GroupTotals<T>, ops: VectorOps<T>): IncomeSubtotals<T> {
  const grossProfit = ops.sub(groups.sales, groups.cost_of_sales);
  const operatingIncome = ops.sub(grossProfit, groups.sga);
  const ordinaryIncome = ops.sub(
    ops.add(operatingIncome, groups.non_operating_income),
    groups.non_operating_expenses,
  );
  const pretaxIncome = ops.sub(
    ops.add(ordinaryIncome, groups.extraordinary_income),
    groups.extraordinary_losses,
  );
  const netIncome = ops.sub(pretaxIncome, groups.income_taxes);
  return { grossProfit, operatingIncome, ordinaryIncome, pretaxIncome, netIncome };
}

/**
 * Lays out the income statement: each group with accounts, its total on the group row, and the
 * five subtotals at their places. Groups without accounts are left out; the subtotals always show.
 * Values are on the normal side, so profit = revenue − expenses.
 */
export function layoutIncomeStatement<T>(
  values: readonly AccountValue<T>[],
  ops: VectorOps<T>,
): IncomeStatementLayout<T> {
  const byGroup = new Map<AccountGroup, AccountValue<T>[]>();
  for (const row of values) {
    const list = byGroup.get(row.account.group) ?? [];
    list.push(row);
    byGroup.set(row.account.group, list);
  }
  const groupTotals = {} as GroupTotals<T>;
  for (const group of INCOME_STATEMENT_GROUPS) {
    groupTotals[group] = sumValues(byGroup.get(group) ?? [], ops);
  }
  const subtotals = incomeSubtotals(groupTotals, ops);

  const rows: StatementRow<T>[] = [];
  for (const group of INCOME_STATEMENT_GROUPS) {
    const list = (byGroup.get(group) ?? [])
      .slice()
      .sort((a, b) =>
        a.account.code < b.account.code ? -1 : a.account.code > b.account.code ? 1 : 0,
      );
    if (list.length > 0) {
      rows.push({
        kind: "group",
        key: `group:${group}`,
        label: ACCOUNT_GROUP_LABELS[group],
        level: 1,
        value: groupTotals[group],
        group,
      });
      rows.push(...accountRows(list, "pl"));
    }
    const subtotal = SUBTOTAL_AFTER[group];
    if (subtotal) {
      rows.push({
        kind: subtotal === "netIncome" ? "total" : "subtotal",
        key: `subtotal:${subtotal}`,
        label: INCOME_SUBTOTAL_LABELS[subtotal],
        level: subtotal === "netIncome" ? 0 : 1,
        value: subtotals[subtotal],
      });
    }
  }
  return { rows, groupTotals, subtotals };
}

export interface BalanceSheetTotals<T> {
  assets: T;
  liabilities: T;
  /** Shareholders' equity accounts + prior periods' profit + net income. */
  equity: T;
  liabilitiesAndEquity: T;
}

export interface BalanceSheetLayout<T> {
  rows: StatementRow<T>[];
  totals: BalanceSheetTotals<T>;
}

/**
 * Lays out the balance sheet: 資産 / 負債 / 純資産 with their groups and totals. Net income (the
 * year to date) and the profit of earlier years not yet transferred to retained earnings are
 * rows of 純資産 (14-reports §3).
 */
export function layoutBalanceSheet<T>(
  values: readonly AccountValue<T>[],
  ops: VectorOps<T>,
  extras: { netIncome: T; priorPeriodsProfit: T },
): BalanceSheetLayout<T> {
  const byGroup = new Map<AccountGroup, AccountValue<T>[]>();
  for (const row of values) {
    const list = byGroup.get(row.account.group) ?? [];
    list.push(row);
    byGroup.set(row.account.group, list);
  }
  const rows: StatementRow<T>[] = [];
  const sectionTotals = {} as Record<(typeof BALANCE_SHEET_SECTIONS)[number]["key"], T>;

  for (const section of BALANCE_SHEET_SECTIONS) {
    let total = ops.zero();
    const sectionRows: StatementRow<T>[] = [];
    for (const group of section.groups) {
      const list = (byGroup.get(group) ?? [])
        .slice()
        .sort((a, b) =>
          a.account.code < b.account.code ? -1 : a.account.code > b.account.code ? 1 : 0,
        );
      if (list.length === 0) continue;
      const groupTotal = sumValues(list, ops);
      total = ops.add(total, groupTotal);
      sectionRows.push({
        kind: "group",
        key: `group:${group}`,
        label: ACCOUNT_GROUP_LABELS[group],
        level: 1,
        value: groupTotal,
        group,
      });
      sectionRows.push(...accountRows(list, "bs"));
    }
    if (section.key === "equity") {
      if (!ops.isZero(extras.priorPeriodsProfit)) {
        sectionRows.push({
          kind: "subtotal",
          key: "equity:priorPeriodsProfit",
          label: PRIOR_PERIODS_PROFIT_LABEL,
          level: 1,
          value: extras.priorPeriodsProfit,
        });
        total = ops.add(total, extras.priorPeriodsProfit);
      }
      sectionRows.push({
        kind: "subtotal",
        key: "equity:netIncome",
        label: NET_INCOME_LABEL,
        level: 1,
        value: extras.netIncome,
      });
      total = ops.add(total, extras.netIncome);
    }
    sectionTotals[section.key] = total;
    rows.push({
      kind: "section",
      key: `section:${section.key}`,
      label: section.label,
      level: 0,
      value: total,
    });
    rows.push(...sectionRows);
    rows.push({
      kind: "total",
      key: `total:${section.key}`,
      label: `${section.label} 合計`,
      level: 0,
      value: total,
    });
  }
  const liabilitiesAndEquity = ops.add(sectionTotals.liabilities, sectionTotals.equity);
  rows.push({
    kind: "total",
    key: "total:liabilitiesAndEquity",
    label: "負債・純資産 合計",
    level: 0,
    value: liabilitiesAndEquity,
  });
  return {
    rows,
    totals: {
      assets: sectionTotals.assets,
      liabilities: sectionTotals.liabilities,
      equity: sectionTotals.equity,
      liabilitiesAndEquity,
    },
  };
}

export const MONEY_OPS: VectorOps<bigint> = {
  zero: () => 0n,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  isZero: (a) => a === 0n,
};

/** Element-wise arithmetic over vectors of amounts (one per column). */
export function vectorOps(length: number): VectorOps<bigint[]> {
  return {
    zero: () => Array.from({ length }, () => 0n),
    add: (a, b) => a.map((value, i) => value + (b[i] ?? 0n)),
    sub: (a, b) => a.map((value, i) => value - (b[i] ?? 0n)),
    isZero: (a) => a.every((value) => value === 0n),
  };
}
