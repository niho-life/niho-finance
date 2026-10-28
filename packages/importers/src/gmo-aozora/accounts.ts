import type { GmoAccount } from "./types";

/** 普通預金（有利息）・普通預金（決済用）: the accounts a wallet can be connected to. */
const ORDINARY_ACCOUNT_TYPES = new Set(["01", "02"]);

/** A yen ordinary deposit account (科目 01 / 02, JPY): the only kind 口座の選択 offers. */
export function isYenOrdinaryAccount(account: GmoAccount): boolean {
  return ORDINARY_ACCOUNT_TYPES.has(account.accountTypeCode) && account.currencyCode === "JPY";
}

/**
 * The account as the screens show it (19-bank-api §1.1): 「支店名 科目名 ••••末尾 4 桁」, e.g.
 * 「架空第一支店 普通預金（有利息） ••••9999」. Neither the account ID nor the whole number is
 * shown; without a number the last 4 characters of the account ID stand in, without a branch name
 * it is left out.
 */
export function maskAccountLabel(account: GmoAccount): string {
  const number = account.accountNumber?.trim() || account.accountId.trim();
  return [account.branchName?.trim(), account.accountTypeName.trim(), `••••${number.slice(-4)}`]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" ");
}
