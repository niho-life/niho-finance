/**
 * 資金繰り (21-cashflow): the 90-day forecast of 現預金 (one line: the total of the cash-like
 * accounts) from the posted entries, the recurring items, the tax / social-insurance deadlines and
 * the invoices. Pure functions: `@niho-finance/db` loads the inputs (`loadCashflowInputs`), nothing
 * is stored (§1 derive, don't sync), and no entry is ever posted from a recurring item.
 */
import {
  addDays,
  normalSide,
  recurringOccurrences,
  type CalendarDate,
  type Money,
  type RecurringFrequency,
  type WalletKind,
} from "@niho-finance/ledger";
import type { UnassignedCash } from "./cash";
import type { CsvCell } from "./csv";
import { slashDate } from "./format";
import { fiscalYearOn } from "./period";
import {
  indexSource,
  requireAccount,
  type ReportAccount,
  type ReportFiscalYear,
  type ReportSource,
  type ReportWallet,
  type SourceIndex,
} from "./source";

/** The forecast runs from the start to 90 days after it (91 points, §1). */
export const CASHFLOW_DAYS = 90;

export type CashflowFrequency = RecurringFrequency;

/** A recurring item (§2) as the forecast reads it. */
export interface CashflowRecurringItem {
  id: string;
  name: string;
  /** Signed from the wallet's point of view: deposits are positive. */
  amount: Money;
  frequency: CashflowFrequency;
  /** 1–31; 31 is 末日, and a day the month does not have is its last day (2/30 → 2/28). */
  dayOfMonth: number;
  /** 1–12 for yearly items; `null` for monthly ones. */
  monthOfYear: number | null;
  startDate: CalendarDate;
  /** Inclusive; `null` = no end. */
  endDate: CalendarDate | null;
  /** `null` = no wallet (the screens never create one; it is left out of the line). */
  walletId: string | null;
  accountId: string;
  /** Inactive items are not in the forecast. */
  isActive: boolean;
}

/** An open payment deadline (§3.3). */
export interface CashflowDeadline {
  date: CalendarDate;
  title: string;
  /** The payment in positive yen, or `null` while it is unknown (a mark on the line only). */
  amount: Money | null;
}

/** The unpaid rest of an invoice (§3.1): issued (receivable) or received (payable). */
export interface CashflowInvoice {
  /** 支払期日; `null` when the invoice has none. */
  date: CalendarDate | null;
  /** Positive yen. */
  amount: Money;
  /** 請求番号と取引先 */
  label: string;
}

/**
 * Everything besides the book. `null` = not connected yet (it is noted under 「入っていないもの」),
 * an empty list = connected with nothing in it (no note).
 */
export interface CashflowInputs {
  recurring: readonly CashflowRecurringItem[];
  deadlines: readonly CashflowDeadline[] | null;
  receivables: readonly CashflowInvoice[] | null;
  payables: readonly CashflowInvoice[] | null;
}

export type CashflowEventKind = "entry" | "recurring" | "deadline" | "receivable" | "payable";

/** 種類 of a row of 予定の一覧 (§6). */
export const CASHFLOW_EVENT_KIND_LABELS: Readonly<Record<CashflowEventKind, string>> = {
  entry: "取引",
  recurring: "定期取引",
  deadline: "納付",
  receivable: "請求",
  payable: "請求",
};

/** Same day: 仕訳 → 定期取引 → 納付 → 請求 (§6). */
const EVENT_ORDER: Readonly<Record<CashflowEventKind, number>> = {
  entry: 0,
  recurring: 1,
  deadline: 2,
  receivable: 3,
  payable: 3,
};

/** A row of 予定の一覧. */
export interface CashflowEvent {
  /** Unique within the forecast (React keys). */
  key: string;
  date: CalendarDate;
  kind: CashflowEventKind;
  /** 定期取引の名前 / 期限の題名 / 請求番号と取引先 / 仕訳の摘要. */
  label: string;
  /** 仕訳の No. (entries only). */
  entryNo: number | null;
  /** 口座 (recurring items only). */
  walletName: string | null;
  /** Signed change of 現預金; `null` = 金額未定 (a deadline without its amount). */
  amount: Money | null;
  /** 現預金 after this row (earlier rows of the same day included); `null` when `amount` is. */
  balance: Money | null;
}

export interface CashflowPoint {
  date: CalendarDate;
  balance: Money;
}

export interface CashflowOpeningWallet {
  walletId: string;
  name: string;
  kind: WalletKind;
  balance: Money;
}

/** 起点の内訳 (§6): the cash-like wallets (14-reports §6 order) and cash no wallet owns. */
export interface CashflowOpening {
  date: CalendarDate;
  /** = the home's 現預金 and the cash tab's total on the same day. */
  total: Money;
  wallets: CashflowOpeningWallet[];
  unassigned: UnassignedCash[];
}

/** 「入っていないもの」 (§3.1) as data; the screens write the sentences. */
export type CashflowNote =
  | { kind: "noRecurring" }
  | { kind: "deadlinesNotConnected" }
  | { kind: "deadlinesWithoutAmount"; count: number }
  | { kind: "receivablesNotConnected" }
  | { kind: "receivablesOverdue"; count: number; amount: Money }
  | { kind: "receivablesWithoutDate"; count: number; amount: Money }
  | { kind: "payablesNotConnected" }
  | { kind: "cardUnpaid"; walletId: string; walletName: string; amount: Money }
  | { kind: "recurringWithoutCashEffect"; count: number }
  | { kind: "recurringAlreadyBooked"; count: number }
  | { kind: "recurringWithoutWallet"; count: number };

export interface CashflowForecast {
  start: CalendarDate;
  /** start + days (90 日後). */
  end: CalendarDate;
  opening: CashflowOpening;
  /** start … end (days + 1 points). */
  dates: CalendarDate[];
  /** 現預金 at the end of each day of `dates` (the first one is the opening total). */
  balances: Money[];
  /** 予定の一覧 in the order of §6 (rows that do not move 現預金 are left out). */
  events: CashflowEvent[];
  /** Deadlines without an amount: a mark on the line, the line does not move. */
  marks: { date: CalendarDate; title: string }[];
  /** The lowest day (the earliest one on a tie). */
  lowest: CashflowPoint;
  /** The first day below 0 (exactly 0 is not below), or `null`. */
  firstNegative: CashflowPoint | null;
  /** 90 日後 */
  final: CashflowPoint;
  notes: CashflowNote[];
  /** Active recurring items (whether or not they fall in the period). */
  activeRecurringCount: number;
}

// ---------------------------------------------------------------------------
// The start (§1)
// ---------------------------------------------------------------------------

/**
 * The start of the forecast: today, or the first day of the books when they start later (the same
 * rule as the home's 「時点」, 14-reports §9).
 */
export function forecastStartDate(
  fiscalYears: readonly ReportFiscalYear[],
  today: CalendarDate,
): CalendarDate {
  const fiscalYear = fiscalYearOn(fiscalYears, today);
  return fiscalYear && today < fiscalYear.startDate ? fiscalYear.startDate : today;
}

// ---------------------------------------------------------------------------
// Recurring items (§2.1, §3.2)
// ---------------------------------------------------------------------------

/**
 * The dates of an item (§2.1): the rule lives in `@niho-finance/ledger` (the registration of an
 * occurrence, 21 §10, uses it too) and is re-exported here for the forecast's callers.
 */
export { recurringOccurrences };

/** What `recurringCashEffect` needs of the book. */
export interface CashEffectSource {
  accounts: readonly Pick<ReportAccount, "id" | "isCashLike">[];
  wallets: readonly Pick<ReportWallet, "id" | "accountId">[];
}

/**
 * The change of 現預金 of one occurrence (§3.2): the item is the entry 「口座の科目 ⇄ 科目」, and only
 * its cash-like side counts: `(wallet's account is cash ? amount : 0) − (account is cash ? amount : 0)`.
 * A card payment is 0 (the card's debt grows), a Stripe payout to the bank is 0 (cash moves inside
 * 現預金). `null` when the item has no wallet (or the wallet is not in the book).
 */
export function recurringCashEffect(
  item: Pick<CashflowRecurringItem, "amount" | "walletId" | "accountId">,
  source: CashEffectSource,
): Money | null {
  if (item.walletId === null) return null;
  const wallet = source.wallets.find((candidate) => candidate.id === item.walletId);
  if (!wallet) return null;
  const isCash = (accountId: string) =>
    source.accounts.find((account) => account.id === accountId)?.isCashLike ?? false;
  return (
    (isCash(wallet.accountId) ? item.amount : 0n) - (isCash(item.accountId) ? item.amount : 0n)
  );
}

// ---------------------------------------------------------------------------
// The forecast (§3, §4, §6)
// ---------------------------------------------------------------------------

function bucketKey(accountId: string, subAccountId: string | null): string {
  return `${accountId}\u0000${subAccountId ?? ""}`;
}

interface Bucket {
  account: ReportAccount;
  subAccountId: string | null;
  /** debit − credit through the start. */
  net: Money;
}

/** debit − credit through `date` of the cash-like accounts and the wallets' accounts. */
function bucketsOn(
  index: SourceIndex,
  source: ReportSource,
  date: CalendarDate,
): Map<string, Bucket> {
  const walletAccounts = new Set(source.wallets.map((wallet) => wallet.accountId));
  const buckets = new Map<string, Bucket>();
  for (const entry of index.entries) {
    if (entry.entryDate > date) continue;
    for (const line of entry.lines) {
      const account = requireAccount(index, line.accountId);
      if (!account.isCashLike && !walletAccounts.has(account.id)) continue;
      const k = bucketKey(account.id, line.subAccountId);
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = { account, subAccountId: line.subAccountId, net: 0n };
        buckets.set(k, bucket);
      }
      bucket.net += line.side === "debit" ? line.amount : -line.amount;
    }
  }
  return buckets;
}

/** On the account's normal side: money held for cash, money owed for a card. */
function walletBalance(
  index: SourceIndex,
  buckets: ReadonlyMap<string, Bucket>,
  wallet: ReportWallet,
): Money {
  const account = requireAccount(index, wallet.accountId);
  const sign = normalSide(account.kind) === "debit" ? 1n : -1n;
  return sign * (buckets.get(bucketKey(wallet.accountId, wallet.subAccountId))?.net ?? 0n);
}

/** The same numbers as `buildCashReport` with `to` = the start (14-reports §6). */
function openingOf(
  index: SourceIndex,
  source: ReportSource,
  buckets: ReadonlyMap<string, Bucket>,
  date: CalendarDate,
): CashflowOpening {
  const owned = new Set<string>();
  const wallets: CashflowOpeningWallet[] = [];
  for (const wallet of source.wallets) {
    if (!wallet.isActive) continue;
    if (!requireAccount(index, wallet.accountId).isCashLike) continue;
    owned.add(bucketKey(wallet.accountId, wallet.subAccountId));
    wallets.push({
      walletId: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      balance: walletBalance(index, buckets, wallet),
    });
  }
  let total: Money = 0n;
  const unassigned: UnassignedCash[] = [];
  for (const [k, bucket] of buckets) {
    if (!bucket.account.isCashLike) continue;
    total += bucket.net;
    if (owned.has(k) || bucket.net === 0n) continue;
    const sub = bucket.subAccountId ? index.subAccountsById.get(bucket.subAccountId) : undefined;
    unassigned.push({
      accountId: bucket.account.id,
      accountName: bucket.account.name,
      subAccountId: bucket.subAccountId,
      subAccountName: sub?.name ?? null,
      balance: bucket.net,
    });
  }
  const subOrder = (id: string | null) => {
    const sub = id ? index.subAccountsById.get(id) : undefined;
    return sub ? { sortOrder: sub.sortOrder, name: sub.name } : { sortOrder: -1, name: "" };
  };
  unassigned.sort((a, b) => {
    const codeA = index.accountsById.get(a.accountId)?.code ?? "";
    const codeB = index.accountsById.get(b.accountId)?.code ?? "";
    if (codeA !== codeB) return codeA < codeB ? -1 : 1;
    const subA = subOrder(a.subAccountId);
    const subB = subOrder(b.subAccountId);
    return subA.sortOrder - subB.sortOrder || subA.name.localeCompare(subB.name, "ja");
  });
  return { date, total, wallets, unassigned };
}

function compareEvents(a: CashflowEvent, b: CashflowEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const rank = EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind];
  if (rank !== 0) return rank;
  if (a.kind === "entry" && b.kind === "entry") return (a.entryNo ?? 0) - (b.entryNo ?? 0);
  const byName = a.label.localeCompare(b.label, "ja");
  if (byName !== 0) return byName;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function sumOf(invoices: readonly CashflowInvoice[]): Money {
  let total: Money = 0n;
  for (const invoice of invoices) total += invoice.amount;
  return total;
}

/**
 * The forecast from `start` to `start + days` (§3, §4, §6). The start value is the book through the
 * start day; the start day's own recurring items are not counted (they belong to its entries and
 * statements), nor are those that fell due before it, nor those an entry of their day already books.
 */
export function buildCashflowForecast(
  source: ReportSource,
  inputs: CashflowInputs,
  options: { start: CalendarDate; days?: number },
): CashflowForecast {
  const { start } = options;
  const days = options.days ?? CASHFLOW_DAYS;
  const end = addDays(start, days);
  const inPeriod = (date: CalendarDate) => date > start && date <= end;
  const index = indexSource(source);
  const buckets = bucketsOn(index, source, start);
  const opening = openingOf(index, source, buckets, start);
  const walletsById = new Map(source.wallets.map((wallet) => [wallet.id, wallet]));
  const isCashAccount = (accountId: string) =>
    index.accountsById.get(accountId)?.isCashLike ?? false;
  const events: CashflowEvent[] = [];

  // Entries dated after the start: their change of 現預金 on their day. A voided entry and its
  // reversal on the same day net to 0 and are left out together; so is any entry that moves cash
  // between cash-like accounts only.
  const periodEntries = index.entries.filter((entry) => inPeriod(entry.entryDate));
  const cancelled = new Set<string>();
  for (const entry of periodEntries) {
    if (!entry.reversalOfId) continue;
    const original = index.entriesById.get(entry.reversalOfId);
    if (original && original.entryDate === entry.entryDate) {
      cancelled.add(entry.id);
      cancelled.add(original.id);
    }
  }
  // The accounts of each day's entries: an occurrence whose two accounts an entry of its day
  // already has is booked (a pay run confirmed ahead, a rent registered ahead) and not counted twice.
  const bookedAccounts = new Map<CalendarDate, Set<string>[]>();
  for (const entry of periodEntries) {
    if (cancelled.has(entry.id)) continue;
    const day = bookedAccounts.get(entry.entryDate) ?? [];
    day.push(new Set(entry.lines.map((line) => line.accountId)));
    bookedAccounts.set(entry.entryDate, day);
  }
  const isBooked = (date: CalendarDate, a: string, b: string) =>
    (bookedAccounts.get(date) ?? []).some((accounts) => accounts.has(a) && accounts.has(b));
  for (const entry of periodEntries) {
    if (cancelled.has(entry.id)) continue;
    let net: Money = 0n;
    for (const line of entry.lines) {
      if (isCashAccount(line.accountId)) net += line.side === "debit" ? line.amount : -line.amount;
    }
    if (net === 0n) continue;
    events.push({
      key: `entry:${entry.id}`,
      date: entry.entryDate,
      kind: "entry",
      label: entry.description,
      entryNo: entry.no,
      walletName: null,
      amount: net,
      balance: null,
    });
  }

  // Recurring items (§3.2): only active ones; those that do not move 現預金 are noted instead.
  const active = inputs.recurring.filter((item) => item.isActive);
  const occurrencesById = new Map(
    active.map((item) => [item.id, recurringOccurrences(item, { after: start, through: end })]),
  );
  let withoutWallet = 0;
  let withoutCashEffect = 0;
  let alreadyBooked = 0;
  for (const item of active) {
    const dates = occurrencesById.get(item.id) ?? [];
    if (dates.length === 0) continue;
    const effect = recurringCashEffect(item, source);
    if (effect === null) {
      withoutWallet += 1;
      continue;
    }
    if (effect === 0n) {
      withoutCashEffect += 1;
      continue;
    }
    const wallet = item.walletId ? walletsById.get(item.walletId) : undefined;
    const walletName = wallet?.name ?? null;
    for (const date of dates) {
      if (wallet && isBooked(date, wallet.accountId, item.accountId)) {
        alreadyBooked += 1;
        continue;
      }
      events.push({
        key: `recurring:${item.id}:${date}`,
        date,
        kind: "recurring",
        label: item.name,
        entryNo: null,
        walletName,
        amount: effect,
        balance: null,
      });
    }
  }

  // Deadlines (§3.3): a payment on the due date, or only a mark while the amount is unknown.
  let withoutAmount = 0;
  const marks: { date: CalendarDate; title: string }[] = [];
  (inputs.deadlines ?? []).forEach((deadline, i) => {
    if (!inPeriod(deadline.date)) return;
    if (deadline.amount === null) {
      withoutAmount += 1;
      marks.push({ date: deadline.date, title: deadline.title });
    }
    events.push({
      key: `deadline:${deadline.date}:${i}`,
      date: deadline.date,
      kind: "deadline",
      label: deadline.title,
      entryNo: null,
      walletName: null,
      amount: deadline.amount === null ? null : -deadline.amount,
      balance: null,
    });
  });

  // Invoices (§3.1): receivables on their due date (past-due and undated ones are left out — a due
  // date on the start day counts as past due, the start day's money is in its entries); payables
  // on their due date, past-due and undated ones on the day after the start (seen early).
  const overdue: CashflowInvoice[] = [];
  const undated: CashflowInvoice[] = [];
  (inputs.receivables ?? []).forEach((invoice, i) => {
    if (invoice.date === null) undated.push(invoice);
    else if (invoice.date <= start) overdue.push(invoice);
    else if (invoice.date <= end) {
      events.push({
        key: `receivable:${i}`,
        date: invoice.date,
        kind: "receivable",
        label: invoice.label,
        entryNo: null,
        walletName: null,
        amount: invoice.amount,
        balance: null,
      });
    }
  });
  const nextDay = addDays(start, 1);
  (inputs.payables ?? []).forEach((invoice, i) => {
    const date = invoice.date === null || invoice.date <= start ? nextDay : invoice.date;
    if (date > end) return;
    events.push({
      key: `payable:${i}`,
      date,
      kind: "payable",
      label: invoice.label,
      entryNo: null,
      walletName: null,
      amount: -invoice.amount,
      balance: null,
    });
  });

  events.sort(compareEvents);
  let running = opening.total;
  const deltas = new Map<CalendarDate, Money>();
  for (const event of events) {
    if (event.amount === null) continue;
    running += event.amount;
    event.balance = running;
    deltas.set(event.date, (deltas.get(event.date) ?? 0n) + event.amount);
  }

  const dates: CalendarDate[] = [];
  const balances: Money[] = [];
  let balance = opening.total;
  for (let day = 0; day <= days; day += 1) {
    const date = addDays(start, day);
    if (day > 0) balance += deltas.get(date) ?? 0n;
    dates.push(date);
    balances.push(balance);
  }
  const point = (i: number): CashflowPoint => ({
    date: dates[i] ?? start,
    balance: balances[i] ?? opening.total,
  });
  let lowestIndex = 0;
  balances.forEach((value, i) => {
    if (value < (balances[lowestIndex] ?? value)) lowestIndex = i;
  });
  const negativeIndex = balances.findIndex((value) => value < 0n);

  // Cards with debt on the start day and no recurring item paying them in the period (§3.1).
  const paysCard = (card: ReportWallet) =>
    active.some((item) => {
      if ((occurrencesById.get(item.id) ?? []).length === 0) return false;
      const wallet = item.walletId ? walletsById.get(item.walletId) : undefined;
      const fromCash =
        item.accountId === card.accountId && !!wallet && isCashAccount(wallet.accountId);
      const toCard = item.walletId === card.id && isCashAccount(item.accountId);
      return fromCash || toCard;
    });
  const cardNotes: CashflowNote[] = [];
  for (const wallet of source.wallets) {
    if (!wallet.isActive || wallet.kind !== "card") continue;
    const owed = walletBalance(index, buckets, wallet);
    if (owed > 0n && !paysCard(wallet)) {
      cardNotes.push({
        kind: "cardUnpaid",
        walletId: wallet.id,
        walletName: wallet.name,
        amount: owed,
      });
    }
  }

  const notes: CashflowNote[] = [];
  if (active.length === 0) notes.push({ kind: "noRecurring" });
  if (inputs.deadlines === null) notes.push({ kind: "deadlinesNotConnected" });
  if (withoutAmount > 0) notes.push({ kind: "deadlinesWithoutAmount", count: withoutAmount });
  if (inputs.receivables === null) notes.push({ kind: "receivablesNotConnected" });
  if (overdue.length > 0) {
    notes.push({ kind: "receivablesOverdue", count: overdue.length, amount: sumOf(overdue) });
  }
  if (undated.length > 0) {
    notes.push({ kind: "receivablesWithoutDate", count: undated.length, amount: sumOf(undated) });
  }
  if (inputs.payables === null) notes.push({ kind: "payablesNotConnected" });
  notes.push(...cardNotes);
  if (withoutCashEffect > 0) {
    notes.push({ kind: "recurringWithoutCashEffect", count: withoutCashEffect });
  }
  if (withoutWallet > 0) notes.push({ kind: "recurringWithoutWallet", count: withoutWallet });
  if (alreadyBooked > 0) notes.push({ kind: "recurringAlreadyBooked", count: alreadyBooked });

  return {
    start,
    end,
    opening,
    dates,
    balances,
    events,
    marks,
    lowest: point(lowestIndex),
    firstNegative: negativeIndex >= 0 ? point(negativeIndex) : null,
    final: point(days),
    notes,
    activeRecurringCount: active.length,
  };
}

// ---------------------------------------------------------------------------
// 予定の一覧 as text and CSV (§6)
// ---------------------------------------------------------------------------

/** 内容 of a row: 「No. 12 摘要」 for an entry, the name / title / invoice otherwise. */
export function cashflowEventText(
  event: Pick<CashflowEvent, "kind" | "label" | "entryNo">,
): string {
  return event.kind === "entry" && event.entryNo !== null
    ? `No. ${event.entryNo} ${event.label}`
    : event.label;
}

export const CASHFLOW_CSV_HEADER = ["日付", "内容", "種類", "口座", "入出金", "残高"] as const;

/**
 * 予定の一覧 as CSV rows (§6): the header, the start row (今日の現預金) and the rows. An amount still
 * unknown leaves 入出金 and 残高 empty.
 */
export function cashflowCsvRows(forecast: CashflowForecast): CsvCell[][] {
  const rows: CsvCell[][] = [
    [...CASHFLOW_CSV_HEADER],
    [slashDate(forecast.start), "今日の現預金", "", "", null, forecast.opening.total],
  ];
  for (const event of forecast.events) {
    rows.push([
      slashDate(event.date),
      cashflowEventText(event),
      CASHFLOW_EVENT_KIND_LABELS[event.kind],
      event.walletName ?? "",
      event.amount,
      event.balance,
    ]);
  }
  return rows;
}
