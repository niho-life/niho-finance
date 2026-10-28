import { findTemplateAccount } from "./chart-template";
import type { CalendarDate } from "./date";
import { LedgerValidationError, type LedgerError } from "./errors";
import { abs, formatYen, type Money } from "./money";
import {
  buildSimpleEntry,
  INPUT_TAX_ACCOUNT_CODE,
  isReservedAccount,
  OUTPUT_TAX_ACCOUNT_CODE,
  splitTaxInclusive,
  walletAccountIdsOf,
  type EntryAccount,
  type EntryWallet,
  type SimpleEntryContext,
} from "./simple-entry";
import { allowedStatementAccount, statementDirection, type StatementDirection } from "./suggest";
import type { JournalEntryInput, JournalLineInput, Side } from "./types";

/**
 * 明細の登録・振替 → journal entries (15-statements §1, §8, §9). Pure: the repository loads the
 * `SimpleEntryContext` of the fiscal year and posts the result through `postJournalEntry`, which
 * checks the ledger rules (balance, segments, the close).
 */

export interface StatementEntryLineInput {
  accountId: string;
  /** Tax-inclusive, > 0. */
  amount: Money;
  taxCategoryCode: string;
  segmentId: string | null;
  /** Blank → the entry's partner. */
  partnerId: string | null;
  description: string | null;
}

export interface StatementEntryInput {
  walletId: string;
  /** The statement line (WalletTransaction.id): the entry's `sourceId`. */
  sourceId: string;
  txnDate: CalendarDate;
  /** Signed, ≠ 0: money into the wallet is positive. */
  amount: Money;
  description: string;
  partnerId: string | null;
  /** One line, or several (分割, §9); their sum is |amount|. */
  lines: readonly StatementEntryLineInput[];
  memoTagIds?: readonly string[];
}

/** Collects the builder's problems so that one request reports all of them. */
class Problems {
  readonly errors: LedgerError[] = [];

  add(error: LedgerError): undefined {
    this.errors.push(error);
    return undefined;
  }

  catch<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof LedgerValidationError)) throw error;
      this.errors.push(...error.errors);
      return undefined;
    }
  }

  throwIfAny(): void {
    if (this.errors.length > 0) throw new LedgerValidationError(this.errors);
  }
}

function findWallet(
  walletId: string,
  context: SimpleEntryContext,
  problems: Problems,
): EntryWallet | undefined {
  const wallet = context.wallets.get(walletId);
  if (!wallet) {
    return problems.add({
      code: "UNKNOWN_WALLET",
      message: "口座が見つかりません。画面を読み込み直してください",
      field: "walletId",
    });
  }
  if (!wallet.isActive) {
    return problems.add({
      code: "UNKNOWN_WALLET",
      message: `口座「${wallet.name}」は無効です。設定 › 口座 で有効にしてください`,
      field: "walletId",
    });
  }
  return wallet;
}

const DIRECTION_KINDS: Readonly<Record<StatementDirection, string>> = {
  in: "収益・資産・負債・純資産",
  out: "費用・資産・負債",
};

function findAccount(
  accountId: string,
  direction: StatementDirection,
  field: string,
  context: SimpleEntryContext,
  walletAccountIds: ReadonlySet<string>,
  problems: Problems,
): EntryAccount | undefined {
  const account = context.accounts.get(accountId);
  if (!account) {
    return problems.add({
      code: "UNKNOWN_ACCOUNT",
      message: "勘定科目が見つかりません。一覧から選んでください",
      field,
    });
  }
  if (isReservedAccount(account, walletAccountIds)) {
    return problems.add({
      code: "ACCOUNT_NOT_ALLOWED",
      message: `勘定科目「${account.code} ${account.name}」は選べません。口座どうしの移動は振替にしてください`,
      field,
    });
  }
  if (!allowedStatementAccount(account, direction, walletAccountIds)) {
    return problems.add({
      code: "ACCOUNT_NOT_ALLOWED",
      message: `勘定科目「${account.code} ${account.name}」は${direction === "in" ? "入金" : "出金"}には選べません。${DIRECTION_KINDS[direction]}の科目を選んでください`,
      field,
    });
  }
  return account;
}

function standardAccount(
  code: string,
  context: SimpleEntryContext,
  problems: Problems,
): EntryAccount | undefined {
  for (const account of context.accounts.values()) if (account.code === code) return account;
  const name = findTemplateAccount(code)?.name ?? "";
  return problems.add({
    code: "STANDARD_ACCOUNT_MISSING",
    message: `勘定科目 ${code}（${name}）がありません。設定 › 勘定科目 で足してください`,
  });
}

function plainLine(
  side: Side,
  target: { accountId: string; subAccountId: string | null; segmentId: string | null },
  amount: Money,
  memoTagIds: string[],
): JournalLineInput {
  return {
    side,
    accountId: target.accountId,
    subAccountId: target.subAccountId,
    amount,
    taxCategoryCode: "na",
    taxAmount: 0n,
    segmentId: target.segmentId,
    partnerId: null,
    description: null,
    memoTagIds,
  };
}

/**
 * 登録 of a statement line (15 §1, §9) → one entry (`kind = normal`, `sourceKind = wallet_txn`, dated
 * on the line's date). 出金: [account lines (debit)…, 仮払消費税?, wallet (credit |amount|)].
 * 入金: [wallet (debit |amount|), account lines (credit)…, 仮受消費税?]. Each account line's
 * tax-inclusive amount is split like the transaction forms (`splitTaxInclusive`, 経過措置 included);
 * in tax-exclusive years the tax of all lines goes to one 仮払 / 仮受 line. The lines must add up to
 * |amount| (`UNBALANCED` on `lines`). Every problem is reported at once with its field.
 */
export function buildStatementEntry(
  input: StatementEntryInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  const problems = new Problems();
  const tags = [...(input.memoTagIds ?? [])];
  const direction = statementDirection(input.amount);
  const walletAccountIds = walletAccountIdsOf(context.wallets.values());
  const wallet = findWallet(input.walletId, context, problems);
  if (input.amount === 0n) {
    problems.add({
      code: "INVALID_AMOUNT",
      message: "金額が 0 円の明細は無視だけできます",
    });
  }
  if (input.lines.length === 0) {
    problems.add({ code: "TOO_FEW_LINES", message: "行を 1 行以上入れてください", field: "lines" });
  }

  const side: Side = direction === "out" ? "debit" : "credit";
  let total = 0n;
  let taxLineTotal = 0n;
  const accountLines: JournalLineInput[] = [];
  input.lines.forEach((line, index) => {
    const field = (name: string) => `lines.${index}.${name}`;
    total += line.amount;
    const account = findAccount(
      line.accountId,
      direction,
      field("accountId"),
      context,
      walletAccountIds,
      problems,
    );
    if (line.amount <= 0n) {
      problems.add({
        code: "INVALID_AMOUNT",
        message: "金額は 1 円以上にしてください",
        field: field("amount"),
      });
      return;
    }
    const split = problems.catch(() =>
      splitTaxInclusive(line.amount, line.taxCategoryCode, input.txnDate, {
        accountingMethod: context.accountingMethod,
        taxRules: context.taxRules,
        field: field("taxCategoryCode"),
      }),
    );
    if (!account || !split) return;
    taxLineTotal += split.taxLineAmount;
    accountLines.push({
      side,
      accountId: account.id,
      subAccountId: null,
      amount: split.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxAmount: split.taxAmount,
      segmentId: line.segmentId,
      partnerId: line.partnerId ?? input.partnerId,
      description: line.description,
      memoTagIds: tags,
    });
  });
  const size = abs(input.amount);
  if (input.lines.length > 0 && input.amount !== 0n && total !== size) {
    problems.add({
      code: "UNBALANCED",
      message: `行の合計 ${formatYen(total)} 円が明細の金額 ${formatYen(size)} 円と合いません`,
      field: "lines",
    });
  }
  const taxAccount =
    taxLineTotal > 0n
      ? standardAccount(
          direction === "out" ? INPUT_TAX_ACCOUNT_CODE : OUTPUT_TAX_ACCOUNT_CODE,
          context,
          problems,
        )
      : null;
  problems.throwIfAny();
  if (!wallet || taxAccount === undefined) {
    throw new Error("buildStatementEntry: unreachable after the problems check");
  }

  const walletLine = plainLine(
    direction === "out" ? "credit" : "debit",
    {
      accountId: wallet.accountId,
      subAccountId: wallet.subAccountId,
      segmentId: wallet.defaultSegmentId,
    },
    size,
    tags,
  );
  const taxLines = taxAccount
    ? [
        plainLine(
          side,
          { accountId: taxAccount.id, subAccountId: null, segmentId: null },
          taxLineTotal,
          tags,
        ),
      ]
    : [];
  return {
    entryDate: input.txnDate,
    description: input.description,
    kind: "normal",
    sourceKind: "wallet_txn",
    sourceId: input.sourceId,
    lines:
      direction === "out"
        ? [...accountLines, ...taxLines, walletLine]
        : [walletLine, ...accountLines, ...taxLines],
  };
}

/** Index of an account line of `buildStatementEntry`'s entry → the input line it came from. */
export function statementEntryInputLine(
  entryLineIndex: number,
  amount: Money,
  lineCount: number,
): number | null {
  const index = amount < 0n ? entryLineIndex : entryLineIndex - 1;
  return index >= 0 && index < lineCount ? index : null;
}

export interface StatementTransferInput {
  walletId: string;
  /** The statement line: the entry's `sourceId`. */
  sourceId: string;
  txnDate: CalendarDate;
  /** Signed, ≠ 0. */
  amount: Money;
  /** The other wallet of the transfer. */
  otherWalletId: string;
  /** 手数料 (tax-inclusive), paid by the paying wallet (11 §4.3). */
  fee: Money | null;
  description: string;
  memoTagIds?: readonly string[];
}

/**
 * 振替 of a statement line to another wallet (15 §8), built with `buildSimpleEntry`'s transfer and
 * marked `sourceKind = wallet_txn`. 出金 (−a, fee f): this wallet pays a, the other receives a − f.
 * 入金 (+a, fee f): this wallet receives a, the other pays a + f. Errors about the other wallet are on
 * `counterpart`, about this one on `walletId`, about the fee on `fee`.
 */
export function buildStatementTransfer(
  input: StatementTransferInput,
  context: SimpleEntryContext,
): JournalEntryInput {
  if (input.amount === 0n) {
    throw new LedgerValidationError([
      { code: "INVALID_AMOUNT", message: "金額が 0 円の明細は無視だけできます" },
    ]);
  }
  const out = input.amount < 0n;
  const size = abs(input.amount);
  const fee = input.fee !== null && input.fee > 0n ? input.fee : null;
  const moved = out ? size - (fee ?? 0n) : size;
  if (moved <= 0n) {
    throw new LedgerValidationError([
      {
        code: "INVALID_AMOUNT",
        message: `手数料は明細の金額 ${formatYen(size)} 円より少なくしてください`,
        field: "fee",
      },
    ]);
  }
  const fromWalletId = out ? input.walletId : input.otherWalletId;
  const toWalletId = out ? input.otherWalletId : input.walletId;
  const fieldOf = (error: LedgerError): string | undefined => {
    if (error.code === "SAME_WALLET") return "counterpart";
    if (error.field === "fromWalletId") return out ? "walletId" : "counterpart";
    if (error.field === "toWalletId") return out ? "counterpart" : "walletId";
    return error.field;
  };
  try {
    const entry = buildSimpleEntry(
      {
        type: "transfer",
        entryDate: input.txnDate,
        description: input.description,
        fromWalletId,
        toWalletId,
        amount: moved,
        fee,
        ...(input.memoTagIds ? { memoTagIds: input.memoTagIds } : {}),
      },
      context,
    );
    return { ...entry, sourceKind: "wallet_txn", sourceId: input.sourceId };
  } catch (error) {
    if (!(error instanceof LedgerValidationError)) throw error;
    throw new LedgerValidationError(
      error.errors.map((item) => {
        const field = fieldOf(item);
        const { field: _field, ...rest } = item;
        return field ? { ...rest, field } : rest;
      }),
    );
  }
}
