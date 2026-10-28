/**
 * Opening entries of the setup (10-settings-and-setup §3 Step 5, 02-accounting-rules §4.1):
 * the capital paid in, the incorporation costs (創立費) and the costs until the opening (開業費),
 * each paid by the officer (役員借入金) or from a wallet. Posted once, in one transaction, through
 * `postJournalEntryInTransaction` (kind `opening`, source `system`, segment 共通).
 */
import {
  CORPORATE_SEGMENT_CODE,
  getTaxCategory,
  inclusiveTaxAmount,
  resolveTaxRule,
  type AccountingMethod,
  type CalendarDate,
  type JournalEntryInput,
  type JournalLineInput,
  type Money,
  type Side,
  type TaxRateRule,
} from "@niho-finance/ledger";
import type { Db } from "./audit";
import { fromDbDate, fromDbDateOrNull } from "./dates";
import { SettingsError } from "./errors";
import { postJournalEntryInTransaction, type StoredJournalEntry } from "./journal";
import { openingInputSchema, type OpeningInput, type ParsedOpeningInput } from "./schemas";
import { runInTransaction } from "./transaction";

/** Accounts of the opening entries in the standard chart (02 §2). */
export const OPENING_ACCOUNT_CODES = {
  capital: "3000",
  formationCosts: "1700",
  startupCosts: "1710",
  ownerLoan: "2400",
} as const;

type OpeningAccountRole = keyof typeof OPENING_ACCOUNT_CODES;

export interface OpeningAccountRef {
  id: string;
  code: string;
  name: string;
}

export interface OpeningWalletRef {
  id: string;
  name: string;
  accountId: string;
  subAccountId: string | null;
  isActive: boolean;
}

/** Everything `buildOpeningEntries` needs, loaded once (`loadOpeningContext`). */
export interface OpeningContext {
  fiscalYear: {
    id: string;
    startDate: CalendarDate;
    endDate: CalendarDate;
    accountingMethod: AccountingMethod;
  };
  accounts: Readonly<Record<OpeningAccountRole, OpeningAccountRef>>;
  wallets: ReadonlyMap<string, OpeningWalletRef>;
  corporateSegmentId: string;
  taxRules: readonly TaxRateRule[];
  /** Names for the preview. */
  accountLabels: ReadonlyMap<string, { code: string; name: string }>;
  subAccountLabels: ReadonlyMap<string, string>;
}

function line(
  side: Side,
  accountId: string,
  subAccountId: string | null,
  amount: Money,
  segmentId: string,
  tax: { code: string; amount: Money } = { code: "na", amount: 0n },
  description: string | null = null,
): JournalLineInput {
  return {
    side,
    accountId,
    subAccountId,
    amount,
    taxCategoryCode: tax.code,
    taxAmount: tax.amount,
    segmentId,
    description,
  };
}

function assertInFirstYear(date: CalendarDate, field: string, context: OpeningContext): void {
  const { startDate, endDate } = context.fiscalYear;
  if (date < startDate || date > endDate) {
    const period = `${startDate.replaceAll("-", "/")}〜${endDate.replaceAll("-", "/")}`;
    throw new SettingsError(`日付は第 1 期（${period}）の中にしてください`, { field });
  }
}

function requireWallet(walletId: string, field: string, context: OpeningContext): OpeningWalletRef {
  const wallet = context.wallets.get(walletId);
  if (!wallet) throw new SettingsError("口座が見つかりません。一覧から選んでください", { field });
  if (!wallet.isActive) {
    throw new SettingsError(`口座「${wallet.name}」は無効です。別の口座を選んでください`, {
      field,
    });
  }
  return wallet;
}

/**
 * Consumption tax contained in a cost (kept on the line for the reports, 01 §3). Tax-exclusive
 * years would need 仮払消費税 lines, which belong to the transaction screen: such costs are refused.
 */
function containedTax(
  cost: ParsedOpeningInput["formationCosts"][number],
  field: string,
  context: OpeningContext,
): { code: string; amount: Money } {
  const category = getTaxCategory(cost.taxCategoryCode);
  if (!category || category.kind !== "taxable") return { code: cost.taxCategoryCode, amount: 0n };
  if (context.fiscalYear.accountingMethod === "tax_exclusive") {
    throw new SettingsError(
      "第 1 期が税抜経理のため、課税仕入の行は開始仕訳にできません。不課税・非課税の行だけを登録し、課税仕入は取引から登録してください",
      { field },
    );
  }
  const rule = resolveTaxRule(cost.taxCategoryCode, cost.date, context.taxRules);
  return {
    code: cost.taxCategoryCode,
    amount: rule ? inclusiveTaxAmount(cost.amount, rule.ratePercent) : 0n,
  };
}

/**
 * Input of Step 5 → the journal entries to post (pure). One entry for the capital
 * (普通預金 / 資本金), one per cost row (創立費 or 開業費 / 役員借入金 or the paying wallet).
 * Throws `SettingsError` naming the field (`formationCosts.1.date`, …).
 */
export function buildOpeningEntries(
  input: ParsedOpeningInput,
  context: OpeningContext,
): JournalEntryInput[] {
  const segment = context.corporateSegmentId;
  const entries: JournalEntryInput[] = [];

  const { capital } = input;
  assertInFirstYear(capital.date, "capital.date", context);
  const deposit = requireWallet(capital.walletId, "capital.walletId", context);
  entries.push({
    entryDate: capital.date,
    description: "資本金の払込",
    kind: "opening",
    sourceKind: "system",
    lines: [
      line("debit", deposit.accountId, deposit.subAccountId, capital.amount, segment),
      line("credit", context.accounts.capital.id, null, capital.amount, segment),
    ],
  });

  const groups = [
    ["formationCosts", input.formationCosts, context.accounts.formationCosts],
    ["startupCosts", input.startupCosts, context.accounts.startupCosts],
  ] as const;
  for (const [group, costs, account] of groups) {
    costs.forEach((cost, index) => {
      const at = `${group}.${index}`;
      assertInFirstYear(cost.date, `${at}.date`, context);
      const payer = cost.paidFromWalletId
        ? requireWallet(cost.paidFromWalletId, `${at}.paidFromWalletId`, context)
        : { accountId: context.accounts.ownerLoan.id, subAccountId: null };
      const tax = containedTax(cost, `${at}.taxCategoryCode`, context);
      entries.push({
        entryDate: cost.date,
        description: cost.description,
        kind: "opening",
        sourceKind: "system",
        lines: [
          line("debit", account.id, null, cost.amount, segment, tax, cost.description),
          line("credit", payer.accountId, payer.subAccountId, cost.amount, segment),
        ],
      });
    });
  }
  return entries;
}

/** Loads the accounts, wallets, segment and tax rules the opening entries use. */
export async function loadOpeningContext(db: Db): Promise<OpeningContext> {
  const fiscalYear = await db.fiscalYear.findFirst({ where: { no: 1 } });
  if (!fiscalYear)
    throw new SettingsError("第 1 期がまだありません。初期設定の 2 会計期間から作ってください");

  const codes = Object.values(OPENING_ACCOUNT_CODES);
  const accountRows = await db.account.findMany({ where: { code: { in: codes } } });
  const byCode = new Map(accountRows.map((account) => [account.code, account]));
  const accountFor = (role: OpeningAccountRole): OpeningAccountRef => {
    const code = OPENING_ACCOUNT_CODES[role];
    const account = byCode.get(code);
    if (!account) {
      throw new SettingsError(
        `勘定科目 ${code} がありません。初期設定の 3 勘定科目で作るか、設定 › 勘定科目 で足してください`,
      );
    }
    return { id: account.id, code: account.code, name: account.name };
  };
  const accounts = {
    capital: accountFor("capital"),
    formationCosts: accountFor("formationCosts"),
    startupCosts: accountFor("startupCosts"),
    ownerLoan: accountFor("ownerLoan"),
  };

  const segment = await db.segment.findUnique({ where: { code: CORPORATE_SEGMENT_CODE } });
  if (!segment) {
    throw new SettingsError(
      "セグメント「共通」がありません。初期設定の 3 勘定科目で作ってください",
    );
  }

  const walletRows = await db.wallet.findMany({
    orderBy: { id: "asc" },
    include: {
      account: { select: { id: true, code: true, name: true } },
      subAccount: { select: { id: true, name: true } },
    },
  });
  const accountLabels = new Map<string, { code: string; name: string }>();
  for (const account of Object.values(accounts)) accountLabels.set(account.id, account);
  const subAccountLabels = new Map<string, string>();
  for (const wallet of walletRows) {
    accountLabels.set(wallet.account.id, { code: wallet.account.code, name: wallet.account.name });
    if (wallet.subAccount) subAccountLabels.set(wallet.subAccount.id, wallet.subAccount.name);
  }

  const rules = await db.taxRateRule.findMany();
  return {
    fiscalYear: {
      id: fiscalYear.id,
      startDate: fromDbDate(fiscalYear.startDate),
      endDate: fromDbDate(fiscalYear.endDate),
      accountingMethod: fiscalYear.accountingMethod,
    },
    accounts,
    wallets: new Map(
      walletRows.map((wallet) => [
        wallet.id,
        {
          id: wallet.id,
          name: wallet.name,
          accountId: wallet.accountId,
          subAccountId: wallet.subAccountId,
          isActive: wallet.isActive,
        },
      ]),
    ),
    corporateSegmentId: segment.id,
    taxRules: rules.map((rule) => ({
      taxCategoryCode: rule.taxCategoryCode,
      effectiveFrom: fromDbDate(rule.effectiveFrom),
      effectiveTo: fromDbDateOrNull(rule.effectiveTo),
      ratePercent: rule.ratePercent,
      deductiblePercent: rule.deductiblePercent,
      enabled: rule.enabled,
    })),
    accountLabels,
    subAccountLabels,
  };
}

export interface OpeningPreviewLine {
  side: Side;
  accountCode: string;
  accountName: string;
  subAccountName: string | null;
  amount: Money;
  taxCategoryCode: string;
  description: string | null;
}

export interface OpeningPreviewEntry {
  /** Set once posted. */
  no: number | null;
  entryDate: CalendarDate;
  description: string;
  lines: OpeningPreviewLine[];
}

export interface OpeningPreview {
  entries: OpeningPreviewEntry[];
  debitTotal: Money;
  creditTotal: Money;
}

function summarize(entries: OpeningPreviewEntry[]): OpeningPreview {
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const entry of entries) {
    for (const item of entry.lines) {
      if (item.side === "debit") debitTotal += item.amount;
      else creditTotal += item.amount;
    }
  }
  return { entries, debitTotal, creditTotal };
}

/** The entries Step 5 would post, with account names, without writing anything. */
export async function previewOpeningEntries(db: Db, input: OpeningInput): Promise<OpeningPreview> {
  const data = openingInputSchema.parse(input);
  const context = await loadOpeningContext(db);
  const entries = buildOpeningEntries(data, context);
  return summarize(
    entries.map((entry) => ({
      no: null,
      entryDate: entry.entryDate,
      description: entry.description,
      lines: entry.lines.map((item) => {
        const account = context.accountLabels.get(item.accountId);
        return {
          side: item.side,
          accountCode: account?.code ?? "",
          accountName: account?.name ?? "",
          subAccountName: item.subAccountId
            ? (context.subAccountLabels.get(item.subAccountId) ?? null)
            : null,
          amount: item.amount,
          taxCategoryCode: item.taxCategoryCode,
          description: item.description ?? null,
        };
      }),
    })),
  );
}

/** Opening entries of fiscal year 1 as posted (Step 5 shows them read-only once registered). */
export async function loadOpeningEntries(db: Db): Promise<OpeningPreview> {
  const rows = await db.journalEntry.findMany({
    where: { kind: "opening", fiscalYear: { no: 1 } },
    orderBy: { no: "asc" },
    include: {
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          account: { select: { code: true, name: true } },
          subAccount: { select: { name: true } },
        },
      },
    },
  });
  return summarize(
    rows.map((row) => ({
      no: row.no,
      entryDate: fromDbDate(row.entryDate),
      description: row.description,
      lines: row.lines.map((item) => ({
        side: item.side,
        accountCode: item.account.code,
        accountName: item.account.name,
        subAccountName: item.subAccount?.name ?? null,
        amount: item.amount,
        taxCategoryCode: item.taxCategoryCode,
        description: item.description,
      })),
    })),
  );
}

/**
 * Posts the opening entries in one transaction. Refused when fiscal year 1 already has opening
 * entries: a posted entry is never rewritten (corrections are reversals, S3).
 */
export async function postOpeningEntries(
  db: Db,
  input: OpeningInput,
  options: { actor: string },
): Promise<StoredJournalEntry[]> {
  const data = openingInputSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const fiscalYear = await tx.fiscalYear.findFirst({ where: { no: 1 }, select: { id: true } });
    if (!fiscalYear) {
      throw new SettingsError("第 1 期がまだありません。初期設定の 2 会計期間から作ってください");
    }
    // Same lock as the posting: a second submit waits here, then sees the first one's entries.
    await tx.$queryRaw`SELECT "id" FROM "fiscal_year" WHERE "id" = ${fiscalYear.id} FOR UPDATE`;
    const existing = await tx.journalEntry.count({
      where: { fiscalYearId: fiscalYear.id, kind: "opening" },
    });
    if (existing > 0) {
      throw new SettingsError(
        "開始仕訳はすでに登録しています。直しは取引の画面の訂正（反対仕訳）で行います",
      );
    }
    const entries = buildOpeningEntries(data, await loadOpeningContext(tx));
    const posted: StoredJournalEntry[] = [];
    for (const entry of entries) {
      posted.push(
        await postJournalEntryInTransaction(tx, { ...entry, fiscalYearId: fiscalYear.id }, options),
      );
    }
    return posted;
  });
}
