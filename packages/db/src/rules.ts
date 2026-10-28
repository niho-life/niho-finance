/**
 * 設定 › ルール (15-statements §10): the rules that suggest or settle statement lines. Every write is
 * validated with the schemas in `schemas.ts` and against the rows it refers to, runs in one
 * transaction and appends to the audit log (`rule.*`). Rules are never deleted, only deactivated.
 * The conditions and the action are stored as JSON with amounts as strings (`rule-json.ts`).
 */
import {
  allowedStatementAccount,
  describeRuleAction,
  describeRuleMatch,
  matchesRule,
  type Money,
  type RuleAction,
  type RuleMatch,
  type RuleNames,
  type StatementDirection,
} from "@niho-finance/ledger";
import type { Rule } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate } from "./dates";
import { SettingsError } from "./errors";
import { newId } from "./ids";
import type { ActorOptions } from "./journal";
import {
  parseRuleAction,
  parseRuleMatch,
  ruleActionToJson,
  ruleMatchToJson,
  toSuggestRule,
} from "./rule-json";
import {
  ruleCreateSchema,
  ruleMatchSchema,
  ruleUpdateSchema,
  type RuleCreateInput,
  type RuleUpdateInput,
} from "./schemas";
import { settlePendingLines, type AutoSettleResult } from "./statements";
import { runInTransaction, type Tx } from "./transaction";

export { loadActiveRules } from "./rule-json";

export interface RuleRow {
  id: string;
  name: string | null;
  /** The name, or the summary of the conditions when it has none. */
  displayName: string;
  /** `null` = every wallet. */
  walletId: string | null;
  walletName: string | null;
  match: RuleMatch;
  action: RuleAction;
  /** 「摘要に「カクウフドウサン」 · 出金 · 50,000〜100,000」. */
  matchSummary: string;
  /** 「登録: 地代家賃 / 課税仕入 10% / 架空不動産 / 鎌倉」「振替 → 現金」「無視」. */
  actionSummary: string;
  autoPost: boolean;
  priority: number;
  hitCount: number;
  lastHitAt: Date | null;
  isActive: boolean;
  /** `false` when the stored JSON cannot be read: the rule matches nothing until it is saved again. */
  valid: boolean;
}

const EMPTY_MATCH: RuleMatch = {
  descriptionContains: null,
  descriptionRegex: null,
  counterpartyContains: null,
  amountMin: null,
  amountMax: null,
  sign: null,
};

const EMPTY_ACTION: RuleAction = {
  mode: "suggest",
  accountId: null,
  taxCategoryCode: null,
  partnerId: null,
  segmentId: null,
  descriptionTemplate: null,
  transferToWalletId: null,
  ignoredReason: null,
};

type RuleWithWallet = Rule & { wallet: { name: string } | null };

/** Names of the rows the rules refer to (accounts by name, as the table shows them). */
async function loadRuleNames(db: Db): Promise<RuleNames> {
  const select = { id: true, name: true } as const;
  const pairs = (rows: { id: string; name: string }[]) =>
    new Map(rows.map((row) => [row.id, row.name]));
  return {
    accounts: pairs(await db.account.findMany({ select })),
    partners: pairs(await db.partner.findMany({ select })),
    segments: pairs(await db.segment.findMany({ select })),
    wallets: pairs(await db.wallet.findMany({ select })),
  };
}

function toRuleRow(row: RuleWithWallet, names: RuleNames): RuleRow {
  const match = parseRuleMatch(row.match);
  const action = parseRuleAction(row.action);
  const valid = match !== null && action !== null;
  const matchSummary = match ? describeRuleMatch(match) : "条件を読めません";
  return {
    id: row.id,
    name: row.name,
    displayName: row.name ?? matchSummary,
    walletId: row.walletId,
    walletName: row.wallet?.name ?? null,
    match: match ?? EMPTY_MATCH,
    action: action ?? EMPTY_ACTION,
    matchSummary,
    actionSummary: action ? describeRuleAction(action, names) : "動作を読めません",
    autoPost: row.autoPost,
    priority: row.priority,
    hitCount: row.hitCount,
    lastHitAt: row.lastHitAt,
    isActive: row.isActive,
    valid,
  };
}

const withWallet = { wallet: { select: { name: true } } } as const;

/** Every rule (inactive ones too): the highest priority first, then by display name. */
export async function listRules(db: Db): Promise<RuleRow[]> {
  const rows = await db.rule.findMany({ include: withWallet, orderBy: { id: "asc" } });
  const names = await loadRuleNames(db);
  return rows
    .map((row) => toRuleRow(row, names))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.displayName.localeCompare(b.displayName, "ja") ||
        (a.id < b.id ? -1 : 1),
    );
}

export async function getRule(db: Db, id: string): Promise<RuleRow | null> {
  const row = await db.rule.findUnique({ where: { id }, include: withWallet });
  return row ? toRuleRow(row, await loadRuleNames(db)) : null;
}

/** Active rules (the settings index: 「有効 n 件」). */
export async function countActiveRules(db: Db): Promise<number> {
  return db.rule.count({ where: { isActive: true } });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface RuleValues {
  name: string | null;
  walletId: string | null;
  match: RuleMatch;
  action: RuleAction;
  autoPost: boolean;
  priority: number;
}

const DIRECTION_LABELS: Readonly<Record<StatementDirection, string>> = {
  in: "入金",
  out: "出金",
};

/** The rows a rule refers to must exist (and be usable where it posts). Errors name the field. */
async function assertRuleReferences(tx: Tx, rule: RuleValues): Promise<void> {
  if (rule.walletId) {
    const wallet = await tx.wallet.findUnique({ where: { id: rule.walletId } });
    if (!wallet) {
      throw new SettingsError("口座が見つかりません。一覧から選んでください", {
        field: "walletId",
      });
    }
  }
  const { action } = rule;
  if (action.accountId) {
    const field = "action.accountId";
    const account = await tx.account.findUnique({ where: { id: action.accountId } });
    if (!account) {
      throw new SettingsError("科目が見つかりません。一覧から選んでください", { field });
    }
    if (!account.isActive) {
      throw new SettingsError(
        `科目「${account.code} ${account.name}」は無効です。別の科目を選んでください`,
        { field },
      );
    }
    const wallets = await tx.wallet.findMany({
      where: { isActive: true },
      select: { accountId: true },
    });
    const walletAccountIds = new Set(wallets.map((wallet) => wallet.accountId));
    const directions: StatementDirection[] = rule.match.sign ? [rule.match.sign] : ["in", "out"];
    if (
      !directions.some((direction) => allowedStatementAccount(account, direction, walletAccountIds))
    ) {
      const reserved = ["in", "out"].every(
        (direction) =>
          !allowedStatementAccount(account, direction as StatementDirection, walletAccountIds),
      );
      throw new SettingsError(
        reserved
          ? `科目「${account.code} ${account.name}」は選べません。口座どうしの移動は動作を振替にしてください`
          : `科目「${account.code} ${account.name}」は${DIRECTION_LABELS[directions[0] ?? "out"]}には使えません。別の科目を選んでください`,
        { field },
      );
    }
  }
  if (action.taxCategoryCode) {
    const category = await tx.taxCategory.findUnique({
      where: { code: action.taxCategoryCode },
    });
    if (!category?.isActive) {
      throw new SettingsError("税区分が見つかりません。一覧から選んでください", {
        field: "action.taxCategoryCode",
      });
    }
  }
  if (action.partnerId) {
    const partner = await tx.partner.findUnique({ where: { id: action.partnerId } });
    if (!partner) {
      throw new SettingsError("取引先が見つかりません。一覧から選んでください", {
        field: "action.partnerId",
      });
    }
  }
  if (action.segmentId) {
    const segment = await tx.segment.findUnique({ where: { id: action.segmentId } });
    if (!segment) {
      throw new SettingsError("セグメントが見つかりません。一覧から選んでください", {
        field: "action.segmentId",
      });
    }
  }
  if (action.mode === "transfer" && action.transferToWalletId) {
    const field = "action.transferToWalletId";
    const target = await tx.wallet.findUnique({ where: { id: action.transferToWalletId } });
    if (!target) {
      throw new SettingsError("相手口座が見つかりません。一覧から選んでください", { field });
    }
    if (!target.isActive) {
      throw new SettingsError(`口座「${target.name}」は無効です。別の口座を選んでください`, {
        field,
      });
    }
    if (target.id === rule.walletId) {
      throw new SettingsError("相手口座はルールの口座と別の口座にしてください", { field });
    }
  }
}

function storedValues(rule: RuleValues) {
  return {
    name: rule.name,
    walletId: rule.walletId,
    match: ruleMatchToJson(rule.match),
    action: ruleActionToJson(rule.action),
    // A 候補 rule only fills the chips (15 §10): it never posts by itself.
    autoPost: rule.action.mode === "suggest" ? false : rule.autoPost,
    priority: rule.priority,
  };
}

/** ルールを追加 (15 §10). Audit `rule.create`. */
export async function createRule(
  db: Db,
  input: RuleCreateInput,
  options: ActorOptions,
): Promise<RuleRow> {
  const data = ruleCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await assertRuleReferences(tx, data);
    const row = await tx.rule.create({
      data: { id: newId(), ...storedValues(data) },
      include: withWallet,
    });
    const { wallet: _wallet, ...after } = row;
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "rule.create",
      entity: "rule",
      entityId: row.id,
      after,
    });
    return toRuleRow(row, await loadRuleNames(tx));
  });
}

/** JSON equality regardless of key order (jsonb reorders the keys it stores). */
function sameJson(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([key, item]) => [key, stable(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function notFound(): SettingsError {
  return new SettingsError("ルールが見つかりません。画面を読み込み直してください");
}

/** ルールの編集: only the given keys change; `match` / `action` are replaced as a whole. */
export async function updateRule(
  db: Db,
  id: string,
  input: RuleUpdateInput,
  options: ActorOptions,
): Promise<RuleRow> {
  const data = ruleUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.rule.findUnique({ where: { id }, include: withWallet });
    if (!current) throw notFound();
    const match = data.match ?? parseRuleMatch(current.match);
    const action = data.action ?? parseRuleAction(current.action);
    if (!match) {
      throw new SettingsError("条件を読めません。条件を入れ直してください", {
        field: "match.descriptionContains",
      });
    }
    if (!action) {
      throw new SettingsError("動作を読めません。動作を選び直してください", {
        field: "action.mode",
      });
    }
    const values: RuleValues = {
      name: data.name === undefined ? current.name : data.name,
      walletId: data.walletId === undefined ? current.walletId : data.walletId,
      match,
      action,
      autoPost: data.autoPost ?? current.autoPost,
      priority: data.priority ?? current.priority,
    };
    await assertRuleReferences(tx, values);
    const next = storedValues(values);
    const same =
      next.name === current.name &&
      next.walletId === current.walletId &&
      next.autoPost === current.autoPost &&
      next.priority === current.priority &&
      sameJson(next.match, current.match) &&
      sameJson(next.action, current.action);
    const names = await loadRuleNames(tx);
    if (same) return toRuleRow(current, names);
    const row = await tx.rule.update({ where: { id }, data: next, include: withWallet });
    const { wallet: _before, ...before } = current;
    const { wallet: _after, ...after } = row;
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "rule.update",
      entity: "rule",
      entityId: id,
      before,
      after,
    });
    return toRuleRow(row, names);
  });
}

/** 無効にする / 有効にする. Audit `rule.deactivate` / `rule.activate`. */
export async function setRuleActive(
  db: Db,
  id: string,
  isActive: boolean,
  options: ActorOptions,
): Promise<RuleRow> {
  return runInTransaction(db, async (tx) => {
    const current = await tx.rule.findUnique({ where: { id }, include: withWallet });
    if (!current) throw notFound();
    const names = await loadRuleNames(tx);
    if (current.isActive === isActive) return toRuleRow(current, names);
    const row = await tx.rule.update({ where: { id }, data: { isActive }, include: withWallet });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: isActive ? "rule.activate" : "rule.deactivate",
      entity: "rule",
      entityId: id,
      before: { isActive: current.isActive },
      after: { isActive: row.isActive },
    });
    return toRuleRow(row, names);
  });
}

// ---------------------------------------------------------------------------
// The pending lines a rule matches
// ---------------------------------------------------------------------------

export interface RuleMatchCount {
  count: number;
  /** Total of the matching money in (> 0). */
  inflow: Money;
  /** Total of the matching money out, as a positive amount. */
  outflow: Money;
}

async function pendingLinesOfActiveWallets(db: Db, walletId: string | null) {
  return db.walletTransaction.findMany({
    where: {
      status: "pending",
      wallet: { isActive: true },
      ...(walletId ? { walletId } : {}),
    },
    orderBy: [{ txnDate: "asc" }, { id: "asc" }],
  });
}

/**
 * 「いま一致する未処理 n 件」 (15 §10): pending lines of active wallets the conditions match, with the
 * totals in and out. Conditions as the Sheet sends them (strings); invalid ones match nothing.
 */
export async function countRuleMatches(
  db: Db,
  input: { walletId?: string | null; match: unknown },
): Promise<RuleMatchCount> {
  const empty: RuleMatchCount = { count: 0, inflow: 0n, outflow: 0n };
  const parsed = ruleMatchSchema.safeParse(input.match);
  if (!parsed.success) return empty;
  const walletId = input.walletId ? input.walletId : null;
  const rule = { walletId, match: parsed.data };
  const result = { ...empty };
  for (const row of await pendingLinesOfActiveWallets(db, walletId)) {
    const line = {
      id: row.id,
      walletId: row.walletId,
      txnDate: fromDbDate(row.txnDate),
      amount: row.amount,
      descriptionRaw: row.descriptionRaw,
      counterpartyRaw: row.counterpartyRaw,
    };
    if (!matchesRule(rule, line)) continue;
    result.count += 1;
    if (row.amount > 0n) result.inflow += row.amount;
    else result.outflow -= row.amount;
  }
  return result;
}

/**
 * 既存の未処理への適用 (15 §10): settles the pending lines whose suggestion this rule wins, the way
 * the automatic settlement on import does (`autoPosted = true`, one transaction per line, failures
 * left pending with the reason). A 候補 rule settles nothing. Audit `rule.apply` with the counts.
 */
export async function applyRuleToPending(
  db: Db,
  ruleId: string,
  options: ActorOptions,
): Promise<AutoSettleResult> {
  const row = await db.rule.findUnique({ where: { id: ruleId } });
  if (!row) throw notFound();
  if (!row.isActive) {
    throw new SettingsError("無効なルールは適用できません。先に有効にしてください");
  }
  const rule = toSuggestRule(row);
  if (!rule) {
    throw new SettingsError("ルールの条件か動作を読めません。編集して保存し直してください");
  }
  const result: AutoSettleResult = { registered: 0, transferred: 0, ignored: 0, failed: [] };
  if (rule.action.mode === "suggest") return result;
  const lines = (await pendingLinesOfActiveWallets(db, rule.walletId)).filter((line) =>
    matchesRule(rule, {
      id: line.id,
      walletId: line.walletId,
      txnDate: fromDbDate(line.txnDate),
      amount: line.amount,
      descriptionRaw: line.descriptionRaw,
      counterpartyRaw: line.counterpartyRaw,
    }),
  );
  const settled = await settlePendingLines(db, lines, {
    actor: options.actor,
    storeSuggestion: false,
    ruleId,
  });
  await appendAuditLog(db, {
    actor: options.actor,
    action: "rule.apply",
    entity: "rule",
    entityId: ruleId,
    after: {
      registered: settled.registered,
      transferred: settled.transferred,
      ignored: settled.ignored,
      failed: settled.failed.length,
    },
  });
  return settled;
}
