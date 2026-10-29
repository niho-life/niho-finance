import type { EntryFormOptions, StatementRow } from "@niho-finance/db";
import {
  addDays,
  allowedStatementAccount,
  dateParts,
  descriptionKey,
  firstOpenDate,
  formatYen,
  getTaxCategory,
  statementDirection,
  walletAccountIdsOf,
  type AccountKind,
  type CalendarDate,
  type StatementDirection,
  type TransferCandidate,
} from "@niho-finance/ledger";

/*
 * The client side of /statements (15 §3–§9): rows as the page passes them (money as text: bigint
 * stays on the server), the draft each pending row keeps until it is settled, and the pure helpers
 * the row, the dialogs and the keyboard share.
 */

export type ClientCandidate = Omit<TransferCandidate, "amount"> & { amount: string };

export type ClientStatementRow = Omit<StatementRow, "amount" | "candidates" | "settledAt"> & {
  /** Signed: money into the wallet is positive. */
  amount: string;
  candidates: ClientCandidate[];
};

/** The choices of the dialogs (from `loadEntryFormOptions`). */
export type StatementOptions = Pick<
  EntryFormOptions,
  "accounts" | "taxCategories" | "partners" | "segments" | "wallets" | "fiscalYears"
>;

export type Account = StatementOptions["accounts"][number];

/** What the row will do with Enter. */
export type DraftMode = "register" | "transfer" | "ignore";

/**
 * The chips of a pending row as the owner leaves them: they start from the suggestion and stay in
 * the browser until the row is settled (15 §4).
 */
export interface RowDraft {
  mode: DraftMode;
  accountId: string;
  taxCategoryCode: string;
  partnerId: string;
  segmentId: string;
  /** The entry's 摘要. */
  description: string;
  transferToWalletId: string;
  /** `txn:<id>` / `entry:<id>`: the candidate to link; "" → only the wallet. */
  counterpart: string;
  ignoredReason: string;
  /** The owner changed a chip: the rule's hit is not counted. */
  edited: boolean;
  /** Fields chosen by hand: a new 科目 no longer refills them (11 §4). */
  touched: { taxCategoryCode: boolean; segmentId: boolean };
}

export type ChipField = "account" | "taxCategory" | "partner" | "segment";

export function amountOf(row: { amount: string }): bigint {
  return BigInt(row.amount);
}

export function directionOf(row: { amount: string }): StatementDirection {
  return statementDirection(amountOf(row));
}

/** 「12,340」 for money in, 「−12,340」 (U+2212) for money out; never red (05 §3). */
export function signedAmount(value: bigint | string): string {
  const amount = typeof value === "string" ? BigInt(value) : value;
  return amount < 0n ? `−${formatYen(-amount)}` : formatYen(amount);
}

/** `MM/DD`, or `YYYY/MM/DD` when the year is not this year's. */
export function shortDate(date: CalendarDate, thisYear: number): string {
  const { year, month, day } = dateParts(date);
  const md = `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
  return year === thisYear ? md : `${year}/${md}`;
}

export function initialDraft(row: ClientStatementRow): RowDraft {
  const suggestion = row.suggestion;
  const candidate = suggestion?.candidate;
  return {
    mode: amountOf(row) === 0n ? "ignore" : (suggestion?.mode ?? "register"),
    accountId: suggestion?.accountId ?? "",
    taxCategoryCode: suggestion?.taxCategoryCode ?? "",
    partnerId: suggestion?.partnerId ?? "",
    segmentId: suggestion?.segmentId ?? "",
    description: suggestion?.description ?? row.descriptionRaw.slice(0, 200),
    transferToWalletId: suggestion?.transferToWalletId ?? "",
    counterpart: candidate ? `${candidate.kind}:${candidate.id}` : "",
    ignoredReason: suggestion?.ignoredReason ?? "",
    edited: false,
    touched: { taxCategoryCode: false, segmentId: false },
  };
}

/** A tax category fits the line: 入金 → 売上側 or 対象外, 出金 → 仕入側 or 対象外. */
export function taxFits(code: string | null | undefined, direction: StatementDirection): boolean {
  if (!code) return false;
  const category = getTaxCategory(code);
  if (!category) return false;
  return (
    category.direction === "none" ||
    category.direction === (direction === "in" ? "sales" : "purchase")
  );
}

const KIND_ORDER: Readonly<Record<StatementDirection, readonly AccountKind[]>> = {
  out: ["expense", "asset", "liability"],
  in: ["revenue", "asset", "liability", "equity"],
};

/**
 * The accounts a line can be registered to (15 §5): 出金 費用 → 現預金以外の資産 → 負債, 入金 収益 →
 * 資産 → 負債 → 純資産. Wallets' accounts, cash and 仮受・仮払 are left out (money between wallets
 * is a transfer).
 */
export function accountChoices(
  direction: StatementDirection,
  options: Pick<StatementOptions, "accounts" | "wallets">,
): { kind: AccountKind; accounts: Account[] }[] {
  const walletAccountIds = walletAccountIdsOf(options.wallets);
  const usable = options.accounts.filter((account) =>
    allowedStatementAccount(account, direction, walletAccountIds),
  );
  return KIND_ORDER[direction]
    .map((kind) => ({ kind, accounts: usable.filter((account) => account.kind === kind) }))
    .filter((group) => group.accounts.length > 0);
}

/** A new 科目: the 税区分 and セグメント not chosen by hand follow its defaults (11 §4). */
export function withAccount(
  draft: RowDraft,
  accountId: string,
  context: {
    direction: StatementDirection;
    accounts: ReadonlyMap<string, Account>;
    walletSegmentId: string | null;
  },
): RowDraft {
  const account = context.accounts.get(accountId);
  const next: RowDraft = { ...draft, accountId };
  if (
    !draft.touched.taxCategoryCode &&
    taxFits(account?.defaultTaxCategoryCode, context.direction)
  ) {
    next.taxCategoryCode = account?.defaultTaxCategoryCode ?? next.taxCategoryCode;
  }
  if (!draft.touched.segmentId) {
    const segment = account?.defaultSegmentId ?? context.walletSegmentId;
    if (segment) next.segmentId = segment;
  }
  return next;
}

/** Names for the chips and the dialogs. */
export interface Lookups {
  accounts: Map<string, Account>;
  taxCategories: Map<string, string>;
  partners: Map<string, string>;
  segments: Map<string, string>;
  wallets: Map<string, StatementOptions["wallets"][number]>;
}

export function buildLookups(options: StatementOptions): Lookups {
  return {
    accounts: new Map(options.accounts.map((account) => [account.id, account])),
    taxCategories: new Map(options.taxCategories.map((category) => [category.code, category.name])),
    partners: new Map(options.partners.map((partner) => [partner.id, partner.name])),
    segments: new Map(options.segments.map((segment) => [segment.id, segment.name])),
    wallets: new Map(options.wallets.map((wallet) => [wallet.id, wallet])),
  };
}

/** What Enter does on a pending row (15 §5). */
export type PrimaryPlan =
  | { kind: "register" }
  | { kind: "edit" }
  | { kind: "transfer"; counterpart: string }
  | { kind: "transferDialog" }
  | { kind: "ignore" };

export function primaryPlan(row: ClientStatementRow, draft: RowDraft): PrimaryPlan {
  if (amountOf(row) === 0n || draft.mode === "ignore") return { kind: "ignore" };
  if (draft.mode === "transfer") {
    if (draft.counterpart) return { kind: "transfer", counterpart: draft.counterpart };
    // A rule's 振替 without a candidate posts to the wallet alone (15 §8), so does a recurring
    // item's (its other wallet is set, 21-cashflow §10.6); otherwise the dialog.
    const decided = row.suggestion?.sources.transfer;
    const fromRule = !draft.edited && (decided === "rule" || decided === "recurring");
    if (draft.transferToWalletId && fromRule) {
      return { kind: "transfer", counterpart: `wallet:${draft.transferToWalletId}` };
    }
    return { kind: "transferDialog" };
  }
  return draft.accountId ? { kind: "register" } : { kind: "edit" };
}

export const PRIMARY_LABELS: Readonly<Record<DraftMode, string>> = {
  register: "登録",
  transfer: "振替",
  ignore: "無視",
};

/** The rule that made the chips, while the owner has not changed them (its hit is counted). */
export function ruleIdOf(row: ClientStatementRow, draft: RowDraft): string {
  return !draft.edited && row.suggestion?.source === "rule" ? (row.suggestion.ruleId ?? "") : "";
}

/** The input of 登録 with the row's chips (one line: the whole amount). */
export function registerInput(row: ClientStatementRow, draft: RowDraft) {
  return {
    description: draft.description,
    partnerId: draft.partnerId,
    ruleId: ruleIdOf(row, draft),
    lines: [
      {
        accountId: draft.accountId,
        amount: "",
        taxCategoryCode: draft.taxCategoryCode,
        segmentId: draft.segmentId,
        partnerId: "",
        description: "",
      },
    ],
  };
}

/** Where a server error of a row belongs (15 §5: under the chips). */
export const ROW_ERROR_LABELS: Readonly<Record<string, string>> = {
  "lines.0.accountId": "科目",
  "lines.0.taxCategoryCode": "税区分",
  "lines.0.segmentId": "セグメント",
  "lines.0.partnerId": "取引先",
  partnerId: "取引先",
  description: "摘要",
  counterpart: "相手",
  fee: "手数料",
};

export const CHIP_ERROR_FIELDS: Readonly<Record<ChipField, string>> = {
  account: "lines.0.accountId",
  taxCategory: "lines.0.taxCategoryCode",
  partner: "lines.0.partnerId",
  segment: "lines.0.segmentId",
};

/**
 * 「摘要に含む」 proposed by 「ルールにする」 (15 §5): the description in NFKC without digits and
 * dates, spaces collapsed. Bank prefixes like 「振込」 stay: the owner can shorten it.
 */
export function ruleKeyText(description: string): string {
  const text = description
    .normalize("NFKC")
    .replace(/\d{1,4}[/.\-年]\d{1,2}([/.\-月]\d{1,2}日?)?/gu, " ")
    .replace(/\d+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text === "" || descriptionKey(text) === ""
    ? description.trim().slice(0, 100)
    : text.slice(0, 100);
}

/** The date a reversal gets: the line's date, or the first open date when it is closed (11 §5). */
export function reversalDateOf(
  date: CalendarDate,
  fiscalYears: StatementOptions["fiscalYears"],
): CalendarDate {
  const year = fiscalYears.find((item) => item.startDate <= date && item.endDate >= date);
  if (!year?.lockedThrough || date > year.lockedThrough) return date;
  return firstOpenDate(year) ?? addDays(year.lockedThrough, 1);
}
