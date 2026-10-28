import type { EntryFormFiscalYear, EntryFormOptions } from "@niho-finance/db";
import {
  DEPRECIATION_METHOD_LABELS,
  displayDate,
  isCalendarDate,
  isDepreciableAccount,
  SMALL_ASSET_LIMIT,
  type DepreciationMethod,
  type Money,
} from "@niho-finance/ledger";

/*
 * Pieces shared by the fixed asset forms (16 §5.1–§5.3). Server-safe: no hooks.
 */

/** 即時償却 reads 「（少額）」 under 100,000 yen and 「（中小企業者の特例）」 from it (§4.1). */
export function methodLabel(method: DepreciationMethod, cost: Money | null): string {
  if (method !== "immediate") return DEPRECIATION_METHOD_LABELS[method];
  if (cost === null) return "即時償却（少額・中小企業者の特例）";
  return cost >= SMALL_ASSET_LIMIT ? "即時償却（中小企業者の特例）" : "即時償却（少額）";
}

/** 定額法・定率法 need a useful life (2–50). */
export function isLifeBased(method: DepreciationMethod | ""): boolean {
  return method === "straight_line" || method === "declining_balance";
}

/** The accounts fixed assets can be registered on (§5.4), active ones. */
export function depreciableAccounts(
  accounts: EntryFormOptions["accounts"],
): EntryFormOptions["accounts"] {
  return accounts.filter((account) => account.isActive && isDepreciableAccount(account));
}

export function fiscalYearContaining(
  date: string,
  years: readonly EntryFormFiscalYear[],
): EntryFormFiscalYear | null {
  if (!isCalendarDate(date)) return null;
  return years.find((year) => year.startDate <= date && year.endDate >= date) ?? null;
}

/** 締め済みの期の取得日 (§5.1): the year's depreciation can no longer be posted. */
export function closedYearNote(date: string, years: readonly EntryFormFiscalYear[]): string | null {
  const year = fiscalYearContaining(date, years);
  if (!year || year.status !== "closed") return null;
  return `第 ${year.no} 期は締め済みです。その期の償却は計上できません`;
}

/** What the server will say about a disposal date (§5.3), shown before sending. */
export function disposalDateProblem(
  date: string,
  years: readonly EntryFormFiscalYear[],
): string | null {
  if (!isCalendarDate(date)) return null;
  const year = fiscalYearContaining(date, years);
  if (!year) return `${displayDate(date)} を含む会計期間がありません`;
  if (year.status === "closing") {
    return `第 ${year.no} 期は決算整理中のため、この日付では除却・売却を登録できません。決算整理をやめるか、翌期の日付にしてください`;
  }
  if (year.status === "closed") return `第 ${year.no} 期は締め済みです。翌期の日付にしてください`;
  if (year.lockedThrough && date <= year.lockedThrough) {
    return `${displayDate(year.lockedThrough)} までは締めています。それより後の日付にしてください`;
  }
  return null;
}

/** 耐用年数のヒント (別表第一・第三, §5.1). */
const USEFUL_LIFE_HINTS: readonly [string, string][] = [
  ["パソコン（サーバー用を除く）", "4 年"],
  ["その他の電子計算機", "5 年"],
  ["複写機", "5 年"],
  ["冷暖房機器", "6 年"],
  ["事務机・いす・キャビネット（金属製）", "15 年"],
  ["事務机・いす・キャビネット（その他）", "8 年"],
  ["応接セット", "8 年"],
  ["ソフトウェア（自社で使うもの）", "5 年"],
  ["建物附属設備（電気設備・給排水設備）", "15 年"],
];

export function UsefulLifeHints() {
  return (
    <details className="text-[12px] text-muted">
      <summary className="cursor-pointer font-bold">耐用年数の目安</summary>
      <dl className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
        {USEFUL_LIFE_HINTS.map(([asset, life]) => (
          <div key={asset} className="contents">
            <dt className="min-w-0">{asset}</dt>
            <dd className="num text-right">{life}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5">
        耐用年数省令の別表第一・第三から。迷うときは税理士に確かめてください。
      </p>
    </details>
  );
}
