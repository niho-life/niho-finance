import type { EntryFormOptions, RuleRow } from "@niho-finance/db";
import { formatYenInput, type RuleMode, type RuleSign } from "@niho-finance/ledger";

/*
 * The values of the rule Sheet (15 §10) as the form holds them: text, as the repository's schemas
 * read them (amounts in whole yen, `""` = not set). Shared by the server pages (which turn a stored
 * rule into these) and the client Sheet.
 */

export interface RuleFormValues {
  name: string;
  /** "" = every wallet. */
  walletId: string;
  descriptionContains: string;
  descriptionRegex: string;
  counterpartyContains: string;
  amountMin: string;
  amountMax: string;
  /** "" = both. */
  sign: "" | RuleSign;
  mode: RuleMode;
  accountId: string;
  taxCategoryCode: string;
  partnerId: string;
  segmentId: string;
  descriptionTemplate: string;
  transferToWalletId: string;
  ignoredReason: string;
  autoPost: boolean;
  priority: string;
}

/** A rule as the table and the Sheet show it (dates and money as text). */
export interface ClientRule {
  id: string;
  displayName: string;
  walletName: string | null;
  matchSummary: string;
  actionSummary: string;
  autoPost: boolean;
  priority: number;
  hitCount: number;
  /** ISO timestamp of the last hit. */
  lastHitAt: string | null;
  isActive: boolean;
  valid: boolean;
  values: RuleFormValues;
}

export type RuleSheetOptions = Pick<
  EntryFormOptions,
  "accounts" | "taxCategories" | "partners" | "segments" | "wallets"
>;

export function emptyRuleValues(): RuleFormValues {
  return {
    name: "",
    walletId: "",
    descriptionContains: "",
    descriptionRegex: "",
    counterpartyContains: "",
    amountMin: "",
    amountMax: "",
    sign: "",
    mode: "register",
    accountId: "",
    taxCategoryCode: "",
    partnerId: "",
    segmentId: "",
    descriptionTemplate: "",
    transferToWalletId: "",
    ignoredReason: "",
    autoPost: false,
    priority: "0",
  };
}

const text = (value: string | null | undefined) => value ?? "";
const yen = (value: bigint | null) => (value === null ? "" : formatYenInput(value));

export function toClientRule(rule: RuleRow): ClientRule {
  return {
    id: rule.id,
    displayName: rule.displayName,
    walletName: rule.walletName,
    matchSummary: rule.matchSummary,
    actionSummary: rule.actionSummary,
    autoPost: rule.autoPost,
    priority: rule.priority,
    hitCount: rule.hitCount,
    lastHitAt: rule.lastHitAt ? rule.lastHitAt.toISOString() : null,
    isActive: rule.isActive,
    valid: rule.valid,
    values: {
      name: text(rule.name),
      walletId: text(rule.walletId),
      descriptionContains: text(rule.match.descriptionContains),
      descriptionRegex: text(rule.match.descriptionRegex),
      counterpartyContains: text(rule.match.counterpartyContains),
      amountMin: yen(rule.match.amountMin),
      amountMax: yen(rule.match.amountMax),
      sign: rule.match.sign ?? "",
      mode: rule.action.mode,
      accountId: text(rule.action.accountId),
      taxCategoryCode: text(rule.action.taxCategoryCode),
      partnerId: text(rule.action.partnerId),
      segmentId: text(rule.action.segmentId),
      descriptionTemplate: text(rule.action.descriptionTemplate),
      transferToWalletId: text(rule.action.transferToWalletId),
      ignoredReason: text(rule.action.ignoredReason),
      autoPost: rule.autoPost,
      priority: String(rule.priority),
    },
  };
}
