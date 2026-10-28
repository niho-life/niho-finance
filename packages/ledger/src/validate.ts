import { displayDate, isCalendarDate } from "./date";
import { LedgerValidationError, type LedgerError } from "./errors";
import { formatYen, type Money } from "./money";
import { isLocked, isWithinFiscalYear } from "./period";
import { getTaxCategory } from "./tax-categories";
import {
  ENTRY_KINDS,
  SIDES,
  SOURCE_KINDS,
  type AccountRef,
  type FiscalYearContext,
  type JournalEntryInput,
} from "./types";

export interface ValidationContext {
  fiscalYear: FiscalYearContext;
  /** Accounts referenced by the lines, keyed by account id. */
  accounts: ReadonlyMap<string, AccountRef>;
  /** When given, tax category codes outside this set are rejected. */
  taxCategoryCodes?: ReadonlySet<string>;
  /** When given, each line's sub-account must exist and belong to the line's account. */
  subAccounts?: ReadonlyMap<string, { accountId: string }>;
}

export type ValidationResult = { ok: true } | { ok: false; errors: LedgerError[] };

const KINDS_ALLOWED_WHILE_CLOSING = new Set(["adjusting", "closing"]);
const SEGMENT_REQUIRED_KINDS = new Set(["revenue", "expense", "internal"]);

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/**
 * Checks an entry against the ledger rules (02-accounting-rules §1, 01-domain-model §3).
 * Never throws for bad input: every violation is returned with a code.
 */
export function validateEntry(input: JournalEntryInput, ctx: ValidationContext): ValidationResult {
  const errors: LedgerError[] = [];
  const fiscalYear = ctx.fiscalYear;

  if (!isCalendarDate(input.entryDate)) {
    errors.push({
      code: "INVALID_DATE",
      message: `日付「${String(input.entryDate)}」が正しくありません`,
    });
  } else {
    if (!isWithinFiscalYear(input.entryDate, fiscalYear)) {
      errors.push({
        code: "OUT_OF_FISCAL_YEAR",
        message: `日付 ${input.entryDate} が会計期間（${fiscalYear.startDate}〜${fiscalYear.endDate}）の外です`,
      });
    }
    if (isLocked(input.entryDate, fiscalYear) && fiscalYear.lockedThrough !== null) {
      errors.push({
        code: "PERIOD_LOCKED",
        message: `${displayDate(fiscalYear.lockedThrough)} までは締めています。登録するには 設定 › 会計期間 で締めを戻してください`,
      });
    }
  }

  if (fiscalYear.status === "closed") {
    errors.push({ code: "FISCAL_YEAR_CLOSED", message: "締め済みの会計期間には登録できません" });
  } else if (fiscalYear.status === "closing" && !KINDS_ALLOWED_WHILE_CLOSING.has(input.kind)) {
    errors.push({
      code: "FISCAL_YEAR_CLOSING",
      message: "決算整理中の会計期間には決算整理仕訳と決算振替仕訳だけを登録できます",
    });
  }

  if (!(ENTRY_KINDS as readonly string[]).includes(input.kind)) {
    errors.push({
      code: "INVALID_KIND",
      message: `仕訳の種類「${String(input.kind)}」が正しくありません`,
    });
  }
  if (!(SOURCE_KINDS as readonly string[]).includes(input.sourceKind)) {
    errors.push({
      code: "INVALID_SOURCE_KIND",
      message: `生成元「${String(input.sourceKind)}」が正しくありません`,
    });
  }
  if (isBlank(input.description)) {
    errors.push({ code: "DESCRIPTION_REQUIRED", message: "摘要を入力してください" });
  }
  const isReversal = input.kind === "reversal";
  if (isReversal !== !isBlank(input.reversalOfId)) {
    errors.push({
      code: "INVALID_REVERSAL_LINK",
      message: isReversal
        ? "反対仕訳には取消す仕訳が必要です"
        : "反対仕訳以外は取消す仕訳を持てません",
    });
  }

  if (input.lines.length < 2) {
    errors.push({ code: "TOO_FEW_LINES", message: "仕訳には 2 行以上が必要です" });
  }

  let debit: Money = 0n;
  let credit: Money = 0n;
  let internalDebit: Money = 0n;
  let internalCredit: Money = 0n;
  /** False when a side or an amount is invalid: the totals are then unknown. */
  let totalsKnown = true;

  input.lines.forEach((line, lineIndex) => {
    const lineNo = lineIndex + 1;
    const sideValid = (SIDES as readonly string[]).includes(line.side);
    if (!sideValid) {
      totalsKnown = false;
      errors.push({
        code: "INVALID_SIDE",
        message: `${lineNo} 行目の貸借が正しくありません`,
        lineIndex,
      });
    }

    const amountValid = typeof line.amount === "bigint";
    if (!amountValid) {
      totalsKnown = false;
      errors.push({
        code: "INVALID_AMOUNT",
        message: `${lineNo} 行目の金額が整数（円）ではありません`,
        lineIndex,
      });
    } else if (line.amount <= 0n) {
      totalsKnown = false;
      errors.push({
        code: "NON_POSITIVE_AMOUNT",
        message: `${lineNo} 行目の金額は 1 円以上にしてください`,
        lineIndex,
      });
    }

    if (
      typeof line.taxAmount !== "bigint" ||
      line.taxAmount < 0n ||
      (amountValid && line.taxAmount > line.amount)
    ) {
      errors.push({
        code: "INVALID_TAX_AMOUNT",
        message: `${lineNo} 行目の消費税額は 0 円以上、金額以下にしてください`,
        lineIndex,
      });
    }

    if (isBlank(line.taxCategoryCode)) {
      errors.push({
        code: "TAX_CATEGORY_REQUIRED",
        message: `${lineNo} 行目の税区分を選んでください`,
        lineIndex,
      });
    } else {
      if (ctx.taxCategoryCodes && !ctx.taxCategoryCodes.has(line.taxCategoryCode)) {
        errors.push({
          code: "UNKNOWN_TAX_CATEGORY",
          message: `${lineNo} 行目の税区分「${line.taxCategoryCode}」はありません`,
          lineIndex,
        });
      }
      const category = getTaxCategory(line.taxCategoryCode);
      if (
        category &&
        category.kind !== "taxable" &&
        typeof line.taxAmount === "bigint" &&
        line.taxAmount !== 0n
      ) {
        errors.push({
          code: "TAX_AMOUNT_NOT_ALLOWED",
          message: `${lineNo} 行目の税区分（${category.name}）には消費税額を付けられません`,
          lineIndex,
        });
      }
    }

    const account = ctx.accounts.get(line.accountId);
    if (!account) {
      errors.push({
        code: "UNKNOWN_ACCOUNT",
        message: `${lineNo} 行目の勘定科目がありません`,
        lineIndex,
      });
    } else {
      if (account.isActive === false && !isReversal) {
        errors.push({
          code: "ACCOUNT_INACTIVE",
          message: `${lineNo} 行目の勘定科目（${account.code}）は無効です`,
          lineIndex,
        });
      }
      if (ctx.subAccounts && !isBlank(line.subAccountId)) {
        const subAccount = ctx.subAccounts.get(line.subAccountId ?? "");
        if (!subAccount) {
          errors.push({
            code: "UNKNOWN_SUB_ACCOUNT",
            message: `${lineNo} 行目の補助科目がありません`,
            lineIndex,
          });
        } else if (subAccount.accountId !== account.id) {
          errors.push({
            code: "SUB_ACCOUNT_MISMATCH",
            message: `${lineNo} 行目の補助科目は勘定科目（${account.code}）のものではありません`,
            lineIndex,
          });
        }
      }
      if (SEGMENT_REQUIRED_KINDS.has(account.kind) && isBlank(line.segmentId)) {
        errors.push({
          code: "SEGMENT_REQUIRED",
          message: `${lineNo} 行目（${account.code}）のセグメントを選んでください`,
          lineIndex,
        });
      }
    }

    if (!sideValid || !amountValid) return;
    if (line.side === "debit") debit += line.amount;
    else credit += line.amount;
    if (account?.kind === "internal") {
      if (line.side === "debit") internalDebit += line.amount;
      else internalCredit += line.amount;
    }
  });

  if (totalsKnown && debit !== credit) {
    errors.push({
      code: "UNBALANCED",
      message: `借方合計と貸方合計が一致しません（借方 ${formatYen(debit)} 円 / 貸方 ${formatYen(credit)} 円）`,
    });
  }
  if (totalsKnown && internalDebit !== internalCredit) {
    errors.push({
      code: "INTERNAL_UNBALANCED",
      message: `内部取引の借方と貸方が一致しません（借方 ${formatYen(internalDebit)} 円 / 貸方 ${formatYen(internalCredit)} 円）`,
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Same as `validateEntry`, but throws `LedgerValidationError` on any violation. */
export function assertValidEntry(input: JournalEntryInput, ctx: ValidationContext): void {
  const result = validateEntry(input, ctx);
  if (!result.ok) throw new LedgerValidationError(result.errors);
}
