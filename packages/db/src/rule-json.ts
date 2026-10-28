/**
 * `Rule.match` / `Rule.action` as stored (01-domain-model §2, 15-statements §10): JSON whose amounts
 * are decimal strings (never JSON numbers). Rows are validated when read; a broken row matches
 * nothing. Shared by the rules repository, the statements repository and the seed.
 */
import {
  describeRuleMatch,
  RULE_MODES,
  type RuleAction,
  type RuleMatch,
  type SuggestRule,
} from "@niho-finance/ledger";
import type { Prisma, Rule } from "@prisma/client";
import { z } from "zod";
import type { Db } from "./audit";

const text = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const yen = z
  .string()
  .regex(/^\d{1,15}$/)
  .nullable()
  .optional()
  .transform((value) => (value === null || value === undefined ? null : BigInt(value)));

const storedMatchSchema = z.object({
  descriptionContains: text,
  descriptionRegex: text,
  counterpartyContains: text,
  amountMin: yen,
  amountMax: yen,
  sign: z
    .enum(["in", "out"])
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

const storedActionSchema = z.object({
  mode: z.enum(RULE_MODES),
  accountId: text,
  taxCategoryCode: text,
  partnerId: text,
  segmentId: text,
  descriptionTemplate: text,
  transferToWalletId: text,
  ignoredReason: text,
});

/** The stored conditions, or `null` when the JSON is broken. */
export function parseRuleMatch(json: Prisma.JsonValue): RuleMatch | null {
  const result = storedMatchSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** The stored action, or `null` when the JSON is broken. */
export function parseRuleAction(json: Prisma.JsonValue): RuleAction | null {
  const result = storedActionSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function ruleMatchToJson(match: RuleMatch): Prisma.InputJsonObject {
  return {
    descriptionContains: match.descriptionContains,
    descriptionRegex: match.descriptionRegex,
    counterpartyContains: match.counterpartyContains,
    amountMin: match.amountMin === null ? null : match.amountMin.toString(),
    amountMax: match.amountMax === null ? null : match.amountMax.toString(),
    sign: match.sign,
  };
}

export function ruleActionToJson(action: RuleAction): Prisma.InputJsonObject {
  return {
    mode: action.mode,
    accountId: action.accountId,
    taxCategoryCode: action.taxCategoryCode,
    partnerId: action.partnerId,
    segmentId: action.segmentId,
    descriptionTemplate: action.descriptionTemplate,
    transferToWalletId: action.transferToWalletId,
    ignoredReason: action.ignoredReason,
  };
}

/** A stored rule as `suggest` takes it, or `null` when its JSON is broken. */
export function toSuggestRule(
  row: Pick<Rule, "id" | "walletId" | "match" | "action" | "autoPost" | "priority">,
): SuggestRule | null {
  const match = parseRuleMatch(row.match);
  const action = parseRuleAction(row.action);
  if (!match || !action) return null;
  return {
    id: row.id,
    walletId: row.walletId,
    match,
    action,
    autoPost: row.autoPost,
    priority: row.priority,
  };
}

/** The display name of a rule: its name, or the summary of its conditions (「ルール 家賃」). */
export function ruleDisplayName(row: Pick<Rule, "name" | "match">): string {
  if (row.name) return row.name;
  const match = parseRuleMatch(row.match);
  return match ? describeRuleMatch(match) : "条件を読めないルール";
}

/** The active rules with valid JSON (broken rows are left out: they never match). */
export async function loadActiveRules(db: Db): Promise<SuggestRule[]> {
  const rows = await db.rule.findMany({
    where: { isActive: true },
    orderBy: [{ priority: "desc" }, { id: "asc" }],
  });
  return rows.flatMap((row) => {
    const rule = toSuggestRule(row);
    return rule ? [rule] : [];
  });
}
