import { daysBetween, type CalendarDate } from "./date";
import { abs, formatYen, type Money } from "./money";
import { isReservedAccount, walletAccountIdsOf } from "./simple-entry";
import { getTaxCategory } from "./tax-categories";
import type { AccountKind } from "./types";

/**
 * 明細の推定とルール (15-statements §4, §10). Pure: the repository loads the rules, the history of
 * settled lines, the partners, accounts, wallets and the transfer candidates, and `suggest` turns one
 * statement line into the initial chips and the primary action of its row.
 */

// ---------------------------------------------------------------------------
// States and modes
// ---------------------------------------------------------------------------

export const WALLET_TRANSACTION_STATUSES = [
  "pending",
  "registered",
  "transfer",
  "ignored",
] as const;
export type WalletTransactionStatus = (typeof WALLET_TRANSACTION_STATUSES)[number];

export const WALLET_TRANSACTION_STATUS_LABELS: Readonly<Record<WalletTransactionStatus, string>> = {
  pending: "未処理",
  registered: "登録済み",
  transfer: "振替",
  ignored: "無視",
};

/** What a rule does with the lines it matches (01 §2 Rule.action.mode). */
export const RULE_MODES = ["register", "transfer", "ignore", "suggest"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const RULE_MODE_LABELS: Readonly<Record<RuleMode, string>> = {
  register: "登録",
  transfer: "振替",
  ignore: "無視",
  suggest: "候補",
};

/** `in`: money into the wallet (amount > 0). `out`: money out of it (amount < 0). */
export type RuleSign = "in" | "out";

/** The conditions of a rule (15 §10); `null` = not set. All set conditions must hold (AND). */
export interface RuleMatch {
  descriptionContains: string | null;
  descriptionRegex: string | null;
  counterpartyContains: string | null;
  /** Bounds of |amount|, inclusive. */
  amountMin: Money | null;
  amountMax: Money | null;
  sign: RuleSign | null;
}

export interface RuleAction {
  mode: RuleMode;
  accountId: string | null;
  taxCategoryCode: string | null;
  partnerId: string | null;
  segmentId: string | null;
  /** The entry's 摘要; empty → the line's own description. */
  descriptionTemplate: string | null;
  transferToWalletId: string | null;
  ignoredReason: string | null;
}

export interface SuggestRule {
  id: string;
  /** `null` = every wallet. */
  walletId: string | null;
  match: RuleMatch;
  action: RuleAction;
  autoPost: boolean;
  priority: number;
}

/** One statement line (明細) as `suggest` and `matchesRule` see it. */
export interface StatementLine {
  id: string;
  walletId: string;
  txnDate: CalendarDate;
  /** Signed: money into the wallet is positive. */
  amount: Money;
  descriptionRaw: string;
  counterpartyRaw: string | null;
}

// ---------------------------------------------------------------------------
// Normalized text
// ---------------------------------------------------------------------------

/** NFKC (full-width ASCII and half-width kana fold to one form), lower-case, trimmed. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

/** `normalizeText` without any whitespace. */
function compactText(text: string): string {
  return normalizeText(text).replace(/\s+/gu, "");
}

/**
 * The key that tells two lines of the same kind apart from the rest (15 §4): normalized, then without
 * whitespace, digits and punctuation or symbols; letters (kana and kanji too) stay.
 * 「Vデビット GOOGLE CLOUD JAPAN 11/05」 and 「… 12/05」 share the key 「vデビットgooglecloudjapan」.
 */
export function descriptionKey(text: string): string {
  return normalizeText(text).replace(/[\s\d\p{P}\p{S}]/gu, "");
}

/**
 * 「摘要に含む」「振込人に含む」 (15 §10). A condition made only of letters (what 「ルールにする」
 * proposes: the key of the description) is looked up in the key of the text, so the dates and
 * numbers a bank adds between the words do not matter. A condition with digits or symbols
 * (「振込 2」「11/05」) is looked up in the normalized text without whitespace, so those still count.
 * Case, full-width / half-width and whitespace are ignored either way.
 */
function containsCondition(text: string, condition: string): boolean {
  const compact = compactText(condition);
  if (compact === "") return true;
  const key = descriptionKey(condition);
  if (key === compact) return descriptionKey(text).includes(key);
  return compactText(text).includes(compact);
}

/** A rule's regular expression is at most this long (15 §4). */
export const RULE_REGEX_MAX_LENGTH = 200;

function compileRuleRegex(source: string): RegExp | null {
  if (source.length > RULE_REGEX_MAX_LENGTH) return null;
  try {
    return new RegExp(source, "iu");
  } catch {
    return null;
  }
}

/** Whether a 「摘要の正規表現」 can be saved: it compiles with the `iu` flags and is ≤ 200 characters. */
export function isValidRuleRegex(source: string): boolean {
  return compileRuleRegex(source) !== null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/** Whether a rule has at least one condition (a rule without any never matches). */
export function hasRuleCondition(match: RuleMatch): boolean {
  return (
    !isBlank(match.descriptionContains) ||
    !isBlank(match.descriptionRegex) ||
    !isBlank(match.counterpartyContains) ||
    match.amountMin !== null ||
    match.amountMax !== null ||
    match.sign !== null
  );
}

/**
 * Whether a rule matches a line (15 §10): the wallet (`null` = any), the sign, |amount| within the
 * bounds, 「摘要に含む」, the regular expression on the normalized description (`iu`; an invalid one
 * never matches) and 「振込人に含む」 (no counterparty → no match). All set conditions must hold.
 */
export function matchesRule(
  rule: Pick<SuggestRule, "walletId" | "match">,
  line: StatementLine,
): boolean {
  const { match } = rule;
  if (!hasRuleCondition(match)) return false;
  if (rule.walletId !== null && rule.walletId !== line.walletId) return false;
  if (match.sign === "in" && !(line.amount > 0n)) return false;
  if (match.sign === "out" && !(line.amount < 0n)) return false;
  const size = abs(line.amount);
  if (match.amountMin !== null && size < match.amountMin) return false;
  if (match.amountMax !== null && size > match.amountMax) return false;
  if (!isBlank(match.descriptionContains)) {
    if (!containsCondition(line.descriptionRaw, match.descriptionContains ?? "")) return false;
  }
  if (!isBlank(match.descriptionRegex)) {
    const regex = compileRuleRegex(match.descriptionRegex ?? "");
    if (!regex) return false;
    try {
      if (!regex.test(normalizeText(line.descriptionRaw))) return false;
    } catch {
      return false;
    }
  }
  if (!isBlank(match.counterpartyContains)) {
    if (line.counterpartyRaw === null) return false;
    if (!containsCondition(line.counterpartyRaw, match.counterpartyContains ?? "")) return false;
  }
  return true;
}

/** The order rules are tried in: the highest priority first, then the oldest (ULIDs sort by creation). */
export function compareRules(
  a: Pick<SuggestRule, "id" | "priority">,
  b: Pick<SuggestRule, "id" | "priority">,
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Accounts a statement line can be registered to
// ---------------------------------------------------------------------------

export type StatementDirection = "in" | "out";

/** 入金 (amount ≥ 0 counts as in) or 出金. */
export function statementDirection(amount: Money): StatementDirection {
  return amount < 0n ? "out" : "in";
}

/**
 * The account kinds a line can be registered to (15 §1): 入金 is 収益・資産・負債・純資産 (capital and
 * loans paid in), 出金 is 費用・資産・負債 (prepayments, fixed assets, repaying payables and loans).
 */
export const STATEMENT_ACCOUNT_KINDS: Readonly<Record<StatementDirection, readonly AccountKind[]>> =
  {
    in: ["revenue", "asset", "liability", "equity"],
    out: ["expense", "asset", "liability"],
  };

/**
 * Whether an account can take a line of this direction: active, of an allowed kind, and not reserved
 * (`isReservedAccount`: a wallet's account, cash and deposits, 仮受・仮払消費税 — money between
 * wallets is a transfer).
 */
export function allowedStatementAccount(
  account: {
    id: string;
    code: string;
    kind: AccountKind;
    isCashLike?: boolean;
    isActive?: boolean;
  },
  direction: StatementDirection,
  walletAccountIds: ReadonlySet<string>,
): boolean {
  if (account.isActive === false) return false;
  if (!STATEMENT_ACCOUNT_KINDS[direction].includes(account.kind)) return false;
  return !isReservedAccount(account, walletAccountIds);
}

/** A tax category fits a direction: 入金 → 売上側 or 対象外, 出金 → 仕入側 or 対象外. */
function taxFits(code: string, direction: StatementDirection): boolean {
  const category = getTaxCategory(code);
  if (!category) return false;
  if (category.direction === "none") return true;
  return category.direction === (direction === "in" ? "sales" : "purchase");
}

// ---------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------

/** A settled line (registered or transfer, its entry posted), keyed by `descriptionKey`. */
export interface SuggestHistoryItem {
  walletId: string;
  key: string;
  txnDate: CalendarDate;
  mode: "register" | "transfer";
  accountId: string | null;
  taxCategoryCode: string | null;
  partnerId: string | null;
  segmentId: string | null;
  transferToWalletId: string | null;
}

export interface SuggestPartner {
  id: string;
  name: string;
  nameKana: string | null;
  defaultAccountId: string | null;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  isActive: boolean;
}

export interface SuggestAccount {
  id: string;
  code: string;
  kind: AccountKind;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  isCashLike: boolean;
  isActive: boolean;
}

export interface SuggestWallet {
  id: string;
  accountId: string;
  defaultSegmentId: string | null;
  isActive: boolean;
}

/**
 * The other side of a transfer (15 §8): a pending line of another wallet (`txn`) or a posted transfer
 * entry (`entry`). `walletId` is the other wallet; `amount` is signed as the other side sees it.
 */
export interface TransferCandidate {
  kind: "txn" | "entry";
  id: string;
  walletId: string;
  date: CalendarDate;
  amount: Money;
  description: string;
  /** The entry's number (`entry` candidates). */
  entryNo: number | null;
}

export interface SuggestContext {
  /** The active rules (any order: `compareRules` decides). */
  rules: readonly SuggestRule[];
  /** Settled lines by `descriptionKey`, newest first. */
  history: ReadonlyMap<string, readonly SuggestHistoryItem[]>;
  partners: readonly SuggestPartner[];
  accounts: ReadonlyMap<string, SuggestAccount>;
  wallets: ReadonlyMap<string, SuggestWallet>;
  /** The transfer candidates of this line. */
  candidates: readonly TransferCandidate[];
}

export type SuggestionSource = "rule" | "candidate" | "history" | "partner" | "default";

export interface Suggestion {
  /** The primary action of the row. */
  mode: "register" | "transfer" | "ignore";
  /** The stage that decided the suggestion; `none` when nothing was found. */
  source: SuggestionSource | "none";
  ruleId: string | null;
  /** The rule settles matching lines on import (§11). */
  autoPost: boolean;
  accountId: string | null;
  taxCategoryCode: string | null;
  partnerId: string | null;
  segmentId: string | null;
  /** The entry's 摘要 (a rule's template); `null` → the line's own description. */
  description: string | null;
  transferToWalletId: string | null;
  candidate: { kind: "txn" | "entry"; id: string } | null;
  ignoredReason: string | null;
  /** Where each chip came from: a rule's are drawn solid, the others dotted. */
  sources: {
    account: SuggestionSource | null;
    taxCategory: SuggestionSource | null;
    partner: SuggestionSource | null;
    segment: SuggestionSource | null;
    transfer: SuggestionSource | null;
  };
}

/** Days between the line and a candidate (absolute). */
function distance(date: CalendarDate, other: CalendarDate): number {
  return Math.abs(daysBetween(date, other));
}

/** The nearest candidate by date (then by id), optionally only those of one wallet. */
export function bestTransferCandidate(
  candidates: readonly TransferCandidate[],
  txnDate: CalendarDate,
  walletId?: string | null,
): TransferCandidate | null {
  let best: TransferCandidate | null = null;
  for (const candidate of candidates) {
    if (walletId && candidate.walletId !== walletId) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const a = distance(txnDate, candidate.date);
    const b = distance(txnDate, best.date);
    if (a < b || (a === b && candidate.id < best.id)) best = candidate;
  }
  return best;
}

/** Legal-form words left out of a partner's name before it is looked for in a description. */
const LEGAL_FORM_WORDS = [
  "一般社団法人",
  "株式会社",
  "合同会社",
  "有限会社",
  "カブシキガイシャ",
  "ゴウドウガイシャ",
  "ユウゲンガイシャ",
  "(株)",
  "(同)",
  "(有)",
].map(normalizeText);

/** Bank-style abbreviations: 「カ)カクウ」「カクウ(カ」, 「ド)…」「…(ド」 (normalized: ASCII parentheses). */
const BANK_LEGAL_FORM = /^(?:カ|ド|ユ)\)|\((?:カ|ド|ユ)$/gu;

/** A partner's name without its legal form, as a description key. */
export function partnerNameKey(name: string): string {
  let text = normalizeText(name);
  for (const word of LEGAL_FORM_WORDS) text = text.replaceAll(word, "");
  return descriptionKey(text.trim().replace(BANK_LEGAL_FORM, ""));
}

/** Keys shorter than this would match too many descriptions. */
const PARTNER_KEY_MIN_LENGTH = 3;

/** The partner named in the description or counterparty: the longest name (or kana) found wins. */
function findPartner(
  line: StatementLine,
  partners: readonly SuggestPartner[],
): SuggestPartner | null {
  const texts = [line.descriptionRaw, line.counterpartyRaw ?? ""].map(descriptionKey);
  let best: { partner: SuggestPartner; length: number } | null = null;
  for (const partner of partners) {
    if (!partner.isActive) continue;
    for (const name of [partner.name, partner.nameKana ?? ""]) {
      const key = partnerNameKey(name);
      if (key.length < PARTNER_KEY_MIN_LENGTH) continue;
      if (!texts.some((text) => text.includes(key))) continue;
      if (
        !best ||
        key.length > best.length ||
        (key.length === best.length && partner.id < best.partner.id)
      ) {
        best = { partner, length: key.length };
      }
    }
  }
  return best?.partner ?? null;
}

function emptySuggestion(): Suggestion {
  return {
    mode: "register",
    source: "none",
    ruleId: null,
    autoPost: false,
    accountId: null,
    taxCategoryCode: null,
    partnerId: null,
    segmentId: null,
    description: null,
    transferToWalletId: null,
    candidate: null,
    ignoredReason: null,
    sources: { account: null, taxCategory: null, partner: null, segment: null, transfer: null },
  };
}

interface Fields {
  accountId: string | null;
  taxCategoryCode: string | null;
  partnerId: string | null;
  segmentId: string | null;
}

/**
 * Fills the empty fields of a register suggestion from one stage; a field already set by an earlier
 * stage is never overwritten. Accounts that cannot take the line (direction, reserved, inactive) and
 * tax categories of the other direction are dropped; partners must be known and active.
 */
function fill(
  suggestion: Suggestion,
  fields: Partial<Fields>,
  source: SuggestionSource,
  line: StatementLine,
  context: SuggestContext,
  walletAccountIds: ReadonlySet<string>,
): void {
  const direction = statementDirection(line.amount);
  const { sources } = suggestion;
  if (suggestion.accountId === null && fields.accountId) {
    const account = context.accounts.get(fields.accountId);
    if (account && allowedStatementAccount(account, direction, walletAccountIds)) {
      suggestion.accountId = account.id;
      sources.account = source;
    }
  }
  if (suggestion.taxCategoryCode === null && fields.taxCategoryCode) {
    if (taxFits(fields.taxCategoryCode, direction)) {
      suggestion.taxCategoryCode = fields.taxCategoryCode;
      sources.taxCategory = source;
    }
  }
  if (suggestion.partnerId === null && fields.partnerId) {
    const partner = context.partners.find((item) => item.id === fields.partnerId);
    if (partner?.isActive) {
      suggestion.partnerId = partner.id;
      sources.partner = source;
    }
  }
  if (suggestion.segmentId === null && fields.segmentId) {
    suggestion.segmentId = fields.segmentId;
    sources.segment = source;
  }
}

function hasAnyField(suggestion: Suggestion): boolean {
  return (
    suggestion.accountId !== null ||
    suggestion.taxCategoryCode !== null ||
    suggestion.partnerId !== null ||
    suggestion.segmentId !== null
  );
}

/** A transfer target: another active wallet. */
function transferTarget(
  walletId: string | null,
  line: StatementLine,
  context: SuggestContext,
): string | null {
  if (!walletId || walletId === line.walletId) return null;
  return context.wallets.get(walletId)?.isActive ? walletId : null;
}

function applyRule(
  suggestion: Suggestion,
  rule: SuggestRule,
  line: StatementLine,
  context: SuggestContext,
  walletAccountIds: ReadonlySet<string>,
): void {
  const { action } = rule;
  suggestion.source = "rule";
  suggestion.ruleId = rule.id;
  suggestion.autoPost = rule.autoPost && action.mode !== "suggest";
  switch (action.mode) {
    case "register":
    case "suggest":
      suggestion.mode = "register";
      suggestion.description = isBlank(action.descriptionTemplate)
        ? null
        : action.descriptionTemplate;
      fill(suggestion, action, "rule", line, context, walletAccountIds);
      return;
    case "transfer": {
      suggestion.mode = "transfer";
      suggestion.transferToWalletId = transferTarget(action.transferToWalletId, line, context);
      suggestion.sources.transfer = "rule";
      const candidate = suggestion.transferToWalletId
        ? bestTransferCandidate(context.candidates, line.txnDate, suggestion.transferToWalletId)
        : null;
      suggestion.candidate = candidate ? { kind: candidate.kind, id: candidate.id } : null;
      return;
    }
    case "ignore":
      suggestion.mode = "ignore";
      suggestion.ignoredReason = isBlank(action.ignoredReason) ? null : action.ignoredReason;
      return;
  }
}

/** The settled line to copy: the newest of the same wallet, else the newest of any wallet. */
function historyItem(line: StatementLine, context: SuggestContext): SuggestHistoryItem | null {
  const key = descriptionKey(line.descriptionRaw);
  if (key === "") return null;
  const items = context.history.get(key) ?? [];
  return items.find((item) => item.walletId === line.walletId) ?? items[0] ?? null;
}

/**
 * The initial chips and primary action of a statement line (15 §4), in a fixed order where a later
 * stage never overwrites an earlier one:
 * 1. the first matching rule (`compareRules`); 2. else the nearest transfer candidate; 3. else the
 * newest settled line with the same `descriptionKey`; then, for a registration, 4. the partner named
 * in the description or counterparty (its defaults fill the empty fields), and 5. the account's
 * default tax category (when it fits the direction) and default segment, then the wallet's segment.
 * A line of 0 yen can only be ignored.
 */
export function suggest(line: StatementLine, context: SuggestContext): Suggestion {
  const suggestion = emptySuggestion();
  if (line.amount === 0n) {
    suggestion.mode = "ignore";
    return suggestion;
  }
  const walletAccountIds = walletAccountIdsOf(context.wallets.values());

  const rule = [...context.rules].sort(compareRules).find((item) => matchesRule(item, line));
  const candidate = rule ? null : bestTransferCandidate(context.candidates, line.txnDate);
  if (rule) {
    applyRule(suggestion, rule, line, context, walletAccountIds);
  } else if (candidate) {
    suggestion.mode = "transfer";
    suggestion.source = "candidate";
    suggestion.transferToWalletId = candidate.walletId;
    suggestion.candidate = { kind: candidate.kind, id: candidate.id };
    suggestion.sources.transfer = "candidate";
  } else {
    const item = historyItem(line, context);
    if (item?.mode === "transfer") {
      const target = transferTarget(item.transferToWalletId, line, context);
      if (target) {
        suggestion.mode = "transfer";
        suggestion.source = "history";
        suggestion.transferToWalletId = target;
        suggestion.sources.transfer = "history";
        const nearest = bestTransferCandidate(context.candidates, line.txnDate, target);
        suggestion.candidate = nearest ? { kind: nearest.kind, id: nearest.id } : null;
      }
    } else if (item) {
      fill(suggestion, item, "history", line, context, walletAccountIds);
      if (hasAnyField(suggestion)) suggestion.source = "history";
    }
  }
  if (suggestion.mode !== "register") return suggestion;

  // 4. 取引先の既定: the partner chosen so far, else the one named in the text.
  const partner =
    (suggestion.partnerId
      ? context.partners.find((item) => item.id === suggestion.partnerId)
      : undefined) ?? findPartner(line, context.partners);
  if (partner?.isActive) {
    const before = hasAnyField(suggestion);
    fill(
      suggestion,
      {
        partnerId: partner.id,
        accountId: partner.defaultAccountId,
        taxCategoryCode: partner.defaultTaxCategoryCode,
        segmentId: partner.defaultSegmentId,
      },
      "partner",
      line,
      context,
      walletAccountIds,
    );
    if (!before && hasAnyField(suggestion)) suggestion.source = "partner";
  }

  // 5. 科目の既定, then the wallet's segment.
  const before = hasAnyField(suggestion);
  const account = suggestion.accountId ? context.accounts.get(suggestion.accountId) : undefined;
  const wallet = context.wallets.get(line.walletId);
  fill(
    suggestion,
    {
      taxCategoryCode: account?.defaultTaxCategoryCode ?? null,
      segmentId: account?.defaultSegmentId ?? wallet?.defaultSegmentId ?? null,
    },
    "default",
    line,
    context,
    walletAccountIds,
  );
  if (!before && hasAnyField(suggestion)) suggestion.source = "default";
  return suggestion;
}

// ---------------------------------------------------------------------------
// Summaries of a rule (the table of 設定 › ルール and the display name, 15 §10)
// ---------------------------------------------------------------------------

/** Names of the rows a rule refers to (id → name). Unknown ids are shown as 「不明」. */
export interface RuleNames {
  accounts: ReadonlyMap<string, string>;
  partners: ReadonlyMap<string, string>;
  segments: ReadonlyMap<string, string>;
  wallets: ReadonlyMap<string, string>;
}

/** 「摘要に「カクウフドウサン」 · 出金 · 50,000〜100,000」. */
export function describeRuleMatch(match: RuleMatch): string {
  const parts: string[] = [];
  if (!isBlank(match.descriptionContains)) parts.push(`摘要に「${match.descriptionContains}」`);
  if (!isBlank(match.descriptionRegex)) parts.push(`摘要が /${match.descriptionRegex}/`);
  if (!isBlank(match.counterpartyContains)) parts.push(`振込人に「${match.counterpartyContains}」`);
  if (match.sign) parts.push(match.sign === "in" ? "入金" : "出金");
  const { amountMin: min, amountMax: max } = match;
  if (min !== null && max !== null) parts.push(`${formatYen(min)}〜${formatYen(max)}`);
  else if (min !== null) parts.push(`${formatYen(min)} 以上`);
  else if (max !== null) parts.push(`${formatYen(max)} 以下`);
  return parts.length > 0 ? parts.join(" · ") : "条件なし";
}

/** 「登録: 地代家賃 / 課税仕入 10% / 架空不動産 / 鎌倉」「振替 → 現金」「無視」「候補: 通信費」. */
export function describeRuleAction(action: RuleAction, names: RuleNames): string {
  const name = (map: ReadonlyMap<string, string>, id: string) => map.get(id) ?? "不明";
  switch (action.mode) {
    case "register":
    case "suggest": {
      const parts: string[] = [];
      if (action.accountId) parts.push(name(names.accounts, action.accountId));
      if (action.taxCategoryCode) {
        parts.push(getTaxCategory(action.taxCategoryCode)?.name ?? action.taxCategoryCode);
      }
      if (action.partnerId) parts.push(name(names.partners, action.partnerId));
      if (action.segmentId) parts.push(name(names.segments, action.segmentId));
      const label = RULE_MODE_LABELS[action.mode];
      return parts.length > 0 ? `${label}: ${parts.join(" / ")}` : label;
    }
    case "transfer":
      return action.transferToWalletId
        ? `振替 → ${name(names.wallets, action.transferToWalletId)}`
        : "振替";
    case "ignore":
      return isBlank(action.ignoredReason) ? "無視" : `無視（${action.ignoredReason}）`;
  }
}
