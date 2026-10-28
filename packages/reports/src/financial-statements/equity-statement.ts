/**
 * 株主資本等変動計算書 (17-financial-statements §4.3, §5.3): the vertical form — per item 当期首残高 →
 * 当期変動額 (新株の発行 / 剰余金の配当 / 当期純利益) → 当期末残高, in the order and depth of the SS
 * code table. An item that is 0 throughout is left out; an item without movements shows its opening
 * and closing balances only. その他利益剰余金 is a heading only (its total rows SS0901–SS0999 would
 * repeat 繰越利益剰余金 for a company that has nothing else).
 */
import type { Money } from "@niho-finance/ledger";
import type { EtaxEdition, EtaxEquityBlock } from "./etax/editions";

export interface EquityItem {
  /** 当期首残高 */
  opening: Money;
  /** 新株の発行 */
  issuance: Money;
  /** 剰余金の配当 (negative) */
  dividends: Money;
  /** 当期純利益 */
  netIncome: Money;
  /** Movements that should not happen (3200 credited outside the closing entries). */
  other: Money;
  /** 当期末残高 */
  closing: Money;
}

export function equityItem(opening: Money, movements: Partial<EquityItem> = {}): EquityItem {
  const issuance = movements.issuance ?? 0n;
  const dividends = movements.dividends ?? 0n;
  const netIncome = movements.netIncome ?? 0n;
  const other = movements.other ?? 0n;
  return {
    opening,
    issuance,
    dividends,
    netIncome,
    other,
    closing: opening + issuance + dividends + netIncome + other,
  };
}

export function addEquityItems(...items: EquityItem[]): EquityItem {
  const sum = (key: keyof EquityItem) => items.reduce((total, item) => total + item[key], 0n);
  return {
    opening: sum("opening"),
    issuance: sum("issuance"),
    dividends: sum("dividends"),
    netIncome: sum("netIncome"),
    other: sum("other"),
    closing: sum("closing"),
  };
}

/** 当期変動額合計 */
export function changeTotal(item: EquityItem): Money {
  return item.issuance + item.dividends + item.netIncome + item.other;
}

export interface EquityStatementLine {
  code: string;
  label: string;
  depth: number;
  kind: "title" | "amount";
  amount: Money | null;
}

export interface EquityStatement {
  /** 資本金 */
  capital: EquityItem;
  /** 資本準備金 */
  capitalReserve: EquityItem;
  /** 繰越利益剰余金 (3200 + earlier years' profit) */
  carriedForward: EquityItem;
  /** 資本剰余金合計 */
  capitalSurplusTotal: EquityItem;
  /** 利益剰余金合計 */
  retainedEarningsTotal: EquityItem;
  /** 株主資本合計 */
  shareholdersEquityTotal: EquityItem;
  /** 純資産合計 */
  netAssetsTotal: EquityItem;
  lines: EquityStatementLine[];
}

function isZeroItem(item: EquityItem): boolean {
  return (
    item.opening === 0n &&
    item.closing === 0n &&
    item.issuance === 0n &&
    item.dividends === 0n &&
    item.netIncome === 0n &&
    item.other === 0n
  );
}

function hasMovement(item: EquityItem): boolean {
  return (
    changeTotal(item) !== 0n ||
    item.issuance !== 0n ||
    item.dividends !== 0n ||
    item.netIncome !== 0n
  );
}

export function buildEquityStatement(
  edition: EtaxEdition,
  items: { capital: EquityItem; capitalReserve: EquityItem; carriedForward: EquityItem },
): EquityStatement {
  const codes = edition.layout.equity;
  const capitalSurplusTotal = addEquityItems(items.capitalReserve);
  const retainedEarningsTotal = addEquityItems(items.carriedForward);
  const shareholdersEquityTotal = addEquityItems(
    items.capital,
    capitalSurplusTotal,
    retainedEarningsTotal,
  );
  const netAssetsTotal = addEquityItems(shareholdersEquityTotal);

  const amounts = new Map<string, Money>();
  const titles = new Set<string>();
  const block = (spec: EtaxEquityBlock, item: EquityItem): boolean => {
    if (isZeroItem(item)) return false;
    titles.add(spec.title);
    amounts.set(spec.opening, item.opening);
    amounts.set(spec.closing, item.closing);
    if (hasMovement(item)) {
      titles.add(spec.changes);
      amounts.set(spec.changeTotal, changeTotal(item));
      if (spec.issuance && item.issuance !== 0n) amounts.set(spec.issuance, item.issuance);
      if (spec.dividends && item.dividends !== 0n) amounts.set(spec.dividends, item.dividends);
      if (spec.netIncome && item.netIncome !== 0n) amounts.set(spec.netIncome, item.netIncome);
    }
    return true;
  };
  const capital = block(codes.capital, items.capital);
  const reserve = block(codes.capitalReserve, items.capitalReserve);
  if (reserve) {
    titles.add(codes.capitalSurplus);
    block(codes.capitalSurplusTotal, capitalSurplusTotal);
  }
  const carried = block(codes.carriedForward, items.carriedForward);
  if (carried) {
    titles.add(codes.retainedEarnings);
    titles.add(codes.otherRetainedEarnings);
    block(codes.retainedEarningsTotal, retainedEarningsTotal);
  }
  const shareholders = block(codes.shareholdersEquityTotal, shareholdersEquityTotal);
  if (capital || reserve || carried || shareholders) titles.add(codes.root);
  block(codes.netAssetsTotal, netAssetsTotal);

  const lines: EquityStatementLine[] = [];
  for (const row of edition.tables.SS.rows) {
    if (titles.has(row.code)) {
      lines.push({
        code: row.code,
        label: row.label,
        depth: row.depth,
        kind: "title",
        amount: null,
      });
      continue;
    }
    const amount = amounts.get(row.code);
    if (amount !== undefined) {
      lines.push({ code: row.code, label: row.label, depth: row.depth, kind: "amount", amount });
    }
  }
  return {
    ...items,
    capitalSurplusTotal,
    retainedEarningsTotal,
    shareholdersEquityTotal,
    netAssetsTotal,
    lines,
  };
}
