/**
 * Reads for the reports, the home and the exports (14-reports §13). Everything the reports show
 * is derived by `@niho-finance/reports` from what is loaded here; nothing is stored. Exports are
 * recorded in the audit log (`export.download`, 01-domain-model §8).
 */
import { addDays, type CalendarDate } from "@niho-finance/ledger";
import type {
  ArchiveDocument,
  BackupDocument,
  BackupSource,
  BackupWalletTransaction,
  ReportEntry,
  ReportSource,
  WalletStatus,
} from "@niho-finance/reports";
import type { Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, toDbDate } from "./dates";
import { countInboxDocuments } from "./documents";
import { recurringDueTodo } from "./recurring-post";
import { requireCompanyRow } from "./settings";
import { countPendingWalletTransactions } from "./statements";

const entrySelect = {
  id: true,
  fiscalYearId: true,
  no: true,
  entryDate: true,
  description: true,
  kind: true,
  sourceKind: true,
  status: true,
  reversalOfId: true,
  replacedById: true,
  voidReason: true,
  lines: {
    orderBy: { lineNo: "asc" as const },
    select: {
      lineNo: true,
      side: true,
      accountId: true,
      subAccountId: true,
      amount: true,
      taxCategoryCode: true,
      taxAmount: true,
      segmentId: true,
      partnerId: true,
      description: true,
      memoTags: { select: { memoTagId: true } },
    },
  },
} satisfies Prisma.JournalEntrySelect;

type EntryRow = Prisma.JournalEntryGetPayload<{ select: typeof entrySelect }>;

function toReportEntry(row: EntryRow): ReportEntry {
  return {
    id: row.id,
    fiscalYearId: row.fiscalYearId,
    no: row.no,
    entryDate: fromDbDate(row.entryDate),
    description: row.description,
    kind: row.kind,
    sourceKind: row.sourceKind,
    status: row.status,
    reversalOfId: row.reversalOfId,
    replacedById: row.replacedById,
    voidReason: row.voidReason,
    lines: row.lines.map((line) => ({
      lineNo: line.lineNo,
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId,
      amount: line.amount,
      taxCategoryCode: line.taxCategoryCode,
      taxAmount: line.taxAmount,
      segmentId: line.segmentId,
      partnerId: line.partnerId,
      description: line.description,
      memoTagIds: line.memoTags.map((tag) => tag.memoTagId),
    })),
  };
}

/**
 * The whole book for the reports: master data and every entry with its lines. v1 reads it all on
 * every request (a few thousand entries at most); narrow it by year when that gets slow.
 */
export async function loadReportSource(db: Db): Promise<ReportSource> {
  const company = await requireCompanyRow(db);
  const fiscalYears = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const accounts = await db.account.findMany({ orderBy: { code: "asc" } });
  const subAccounts = await db.subAccount.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const segments = await db.segment.findMany({ orderBy: { sortOrder: "asc" } });
  const partners = await db.partner.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const taxCategories = await db.taxCategory.findMany({ select: { code: true, name: true } });
  const memoTags = await db.memoTag.findMany({ select: { id: true, name: true } });
  const wallets = await db.wallet.findMany({ orderBy: { createdAt: "asc" } });
  const entries = await db.journalEntry.findMany({
    select: entrySelect,
    orderBy: [{ entryDate: "asc" }, { no: "asc" }],
  });
  return {
    company: { name: company.name, foundedOn: fromDbDate(company.foundedOn) },
    fiscalYears: fiscalYears.map((year) => ({
      id: year.id,
      no: year.no,
      startDate: fromDbDate(year.startDate),
      endDate: fromDbDate(year.endDate),
      lockedThrough: fromDbDateOrNull(year.lockedThrough),
      status: year.status,
      consumptionTax: year.consumptionTax,
      accountingMethod: year.accountingMethod,
    })),
    accounts: accounts.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      kind: account.kind,
      group: account.group,
      isCashLike: account.isCashLike,
      isActive: account.isActive,
      sortOrder: account.sortOrder,
    })),
    subAccounts: subAccounts.map((sub) => ({
      id: sub.id,
      accountId: sub.accountId,
      name: sub.name,
      isActive: sub.isActive,
      sortOrder: sub.sortOrder,
    })),
    segments: segments.map((segment) => ({
      id: segment.id,
      code: segment.code,
      name: segment.name,
      isActive: segment.isActive,
      sortOrder: segment.sortOrder,
    })),
    partners,
    taxCategories,
    memoTags,
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
      kind: wallet.kind,
      accountId: wallet.accountId,
      subAccountId: wallet.subAccountId,
      isActive: wallet.isActive,
    })),
    entries: entries.map(toReportEntry),
  };
}

function bankApiStatusOf(value: string | null): WalletStatus["bankApiStatus"] {
  return value === "authorized" || value === "connected" || value === "reauth_required"
    ? value
    : null;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * What the statements know about each active wallet (14-reports §6): pending lines, syncs,
 * balances. A bank API balance dated on or before `through` and not before the last line stands
 * for the statement balance (19-bank-api §4): the bank's own answer, whatever the order of the
 * day's lines.
 */
export async function loadWalletStatus(
  db: Db,
  options: { through: CalendarDate },
): Promise<WalletStatus[]> {
  const wallets = await db.wallet.findMany({
    where: { isActive: true },
    select: {
      id: true,
      stripeAccount: { select: { lastSyncedAt: true } },
      bankApiStatus: true,
      bankApiLastSyncedAt: true,
      bankApiBalance: true,
      bankApiBalanceDate: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const pending = await db.walletTransaction.groupBy({
    by: ["walletId"],
    where: { status: "pending" },
    _count: { _all: true },
  });
  const pendingByWallet = new Map(pending.map((row) => [row.walletId, row._count._all]));
  const through = toDbDate(options.through);
  const rows: WalletStatus[] = [];
  for (const wallet of wallets) {
    const lastStatement = await db.walletTransaction.findFirst({
      where: { walletId: wallet.id, balanceAfter: { not: null }, txnDate: { lte: through } },
      orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }],
      select: { txnDate: true, balanceAfter: true },
    });
    // A batch with an error is a sync that failed (429, a network error, …): it imported nothing,
    // so it is not the last import (the card would show the failure as the last sync).
    const lastImport = await db.importBatch.findFirst({
      where: { walletId: wallet.id, error: null },
      orderBy: { executedAt: "desc" },
      select: { executedAt: true },
    });
    let statement =
      lastStatement && lastStatement.balanceAfter !== null
        ? { date: fromDbDate(lastStatement.txnDate), balanceAfter: lastStatement.balanceAfter }
        : null;
    if (wallet.bankApiBalance !== null && wallet.bankApiBalanceDate !== null) {
      const date = fromDbDate(wallet.bankApiBalanceDate);
      if (date <= options.through && (statement === null || date >= statement.date)) {
        statement = { date, balanceAfter: wallet.bankApiBalance };
      }
    }
    rows.push({
      walletId: wallet.id,
      pendingCount: pendingByWallet.get(wallet.id) ?? 0,
      lastSyncedAt: laterOf(wallet.stripeAccount?.lastSyncedAt ?? null, wallet.bankApiLastSyncedAt),
      lastImportedAt: lastImport?.executedAt ?? null,
      lastStatement: statement,
      bankApiStatus: bankApiStatusOf(wallet.bankApiStatus),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Home: やること (14-reports §9)
// ---------------------------------------------------------------------------

export interface HomeTodo {
  /** Stable key (React). */
  key: string;
  /** The badge: a count (`"23"`) or a date (`"1/12"`). */
  badge: string;
  tone: "count" | "warn" | "date";
  /** 「未処理の明細」, 「法人設立届出書」… */
  label: string;
  /** The screen to go to; `null` while that screen does not exist yet. */
  href: string | null;
  /** For deadlines: the due date (sorting, 「期限切れ」). */
  dueDate?: CalendarDate;
}

/** A source of rows for 「やること」. S5 / S6 / S8 add theirs to `HOME_TODO_SOURCES`. */
export type HomeTodoSource = (db: Db, today: CalendarDate) => Promise<HomeTodo[]>;

/** 未処理の明細 n 件 → 明細 (15-statements §2; the count is `countPendingWalletTransactions`). */
export const pendingStatementsTodo: HomeTodoSource = async (db) => {
  const count = await countPendingWalletTransactions(db);
  if (count === 0) return [];
  return [
    {
      key: "pending-statements",
      badge: String(count),
      tone: "count",
      label: "未処理の明細",
      href: "/statements",
    },
  ];
};

/**
 * 受信箱の証憑 n 件 (S6, 13-documents §3.2): documents not linked yet, or linked but without a
 * date, an amount or a partner (未整理). The month is closed with the inbox empty (07 §2).
 */
export const inboxDocumentsTodo: HomeTodoSource = async (db) => {
  const count = await countInboxDocuments(db);
  if (count === 0) return [];
  return [
    {
      key: "inbox-documents",
      badge: String(count),
      tone: "warn",
      label: "受信箱の証憑",
      href: "/documents",
    },
  ];
};

export const DEADLINE_WINDOW_DAYS = 7;

/** Deadlines due within 7 days (overdue ones first); each row opens the calendar screen (24). */
export const upcomingDeadlinesTodo: HomeTodoSource = async (db, today) => {
  const items = await db.calendarItem.findMany({
    where: { completedAt: null, dueDate: { lte: toDbDate(addDays(today, DEADLINE_WINDOW_DAYS)) } },
    orderBy: [{ dueDate: "asc" }, { title: "asc" }],
    select: { id: true, title: true, dueDate: true },
  });
  return items.map((item) => {
    const dueDate = fromDbDate(item.dueDate);
    const [, month, day] = dueDate.split("-");
    return {
      key: `deadline:${item.id}`,
      badge: `${Number(month)}/${Number(day)}`,
      tone: "date",
      label: dueDate < today ? `${item.title}（期限切れ）` : item.title,
      href: "/calendar",
      dueDate,
    };
  });
};

/**
 * 銀行 API の再接続 n 件 (19-bank-api §1.2): active bank wallets whose authorization lapsed. One
 * wallet goes to its connection page, several to 設定 › 口座.
 */
export const bankReconnectTodo: HomeTodoSource = async (db) => {
  const wallets = await db.wallet.findMany({
    where: { isActive: true, kind: "bank", bankApiStatus: "reauth_required" },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const [only] = wallets;
  if (only === undefined) return [];
  return [
    {
      key: "bank-reconnect",
      badge: String(wallets.length),
      tone: "warn",
      label: "銀行 API の再接続",
      href: wallets.length === 1 ? `/settings/wallets/${only.id}/bank` : "/settings/wallets",
    },
  ];
};

export const HOME_TODO_SOURCES: readonly HomeTodoSource[] = [
  pendingStatementsTodo,
  inboxDocumentsTodo,
  bankReconnectTodo,
  upcomingDeadlinesTodo,
  // 定期取引を登録する n 件 (21-cashflow §10.3)
  recurringDueTodo,
];

/** The rows of 「やること」 in the order of the sources (rows with nothing to do are left out). */
export async function loadHomeTodos(
  db: Db,
  today: CalendarDate,
  sources: readonly HomeTodoSource[] = HOME_TODO_SOURCES,
): Promise<HomeTodo[]> {
  const rows: HomeTodo[] = [];
  for (const source of sources) rows.push(...(await source(db, today)));
  return rows;
}

// ---------------------------------------------------------------------------
// Exports: audit log (14-reports §10)
// ---------------------------------------------------------------------------

export const EXPORT_AUDIT_ACTION = "export.download";

export interface ExportLogInput {
  /** `trial-balance` … `freee` / `yayoi` / `beancount` / `documents` / `backup`. */
  kind: string;
  /** `csv` / `pdf` / `zip` / `beancount`. */
  format: string;
  fiscalYearNo?: number | null;
  from?: CalendarDate | null;
  to?: CalendarDate | null;
  segment?: string | null;
  encoding?: string | null;
}

export interface ExportLogRow extends ExportLogInput {
  id: string;
  at: Date;
  actor: string;
}

export async function recordExport(
  db: Db,
  input: ExportLogInput,
  options: { actor: string },
): Promise<void> {
  await appendAuditLog(db, {
    actor: options.actor,
    action: EXPORT_AUDIT_ACTION,
    entity: "export",
    after: {
      kind: input.kind,
      format: input.format,
      fiscalYearNo: input.fiscalYearNo ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      segment: input.segment ?? null,
      encoding: input.encoding ?? null,
    },
  });
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The latest exports (the settings page's 「最近の書き出し」). */
export async function listRecentExports(db: Db, limit = 20): Promise<ExportLogRow[]> {
  const rows = await db.auditLog.findMany({
    where: { action: EXPORT_AUDIT_ACTION },
    orderBy: { at: "desc" },
    take: limit,
  });
  return rows.map((row) => {
    const after = (row.after ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      at: row.at,
      actor: row.actor,
      kind: text(after.kind) ?? "",
      format: text(after.format) ?? "",
      fiscalYearNo: typeof after.fiscalYearNo === "number" ? after.fiscalYearNo : null,
      from: text(after.from) as CalendarDate | null,
      to: text(after.to) as CalendarDate | null,
      segment: text(after.segment),
      encoding: text(after.encoding),
    };
  });
}

// ---------------------------------------------------------------------------
// Documents archive and backup (14-reports §10, §11.5)
// ---------------------------------------------------------------------------

const DOCUMENT_KIND_LABELS: Readonly<Record<string, string>> = {
  receipt: "領収書",
  invoice_in: "請求書（受取）",
  invoice_out: "請求書（発行）",
  contract: "契約書",
  statement: "明細書",
  other: "その他",
};

const DOCUMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  inbox: "未紐づけ",
  linked: "紐づけ済み",
  voided: "無効",
};

const documentSelect = {
  id: true,
  kind: true,
  storageKey: true,
  sha256: true,
  mime: true,
  byteSize: true,
  originalName: true,
  uploadedAt: true,
  txnDate: true,
  amount: true,
  partnerId: true,
  partnerName: true,
  invoiceRegistrationNumber: true,
  status: true,
  partner: { select: { name: true } },
  links: {
    select: {
      walletTransactionId: true,
      journalEntry: { select: { id: true, no: true } },
    },
  },
} satisfies Prisma.DocumentSelect;

type DocumentRow = Prisma.DocumentGetPayload<{ select: typeof documentSelect }>;

/** Documents dated (or, without a date, uploaded) within `from`..`to`, with their entry numbers. */
export async function loadDocumentsForArchive(
  db: Db,
  range: { from: CalendarDate; to: CalendarDate },
): Promise<ArchiveDocument[]> {
  const from = toDbDate(range.from);
  const to = toDbDate(range.to);
  const uploadedTo = new Date(toDbDate(addDays(range.to, 1)).getTime() - 1);
  const rows = await db.document.findMany({
    where: {
      OR: [
        { txnDate: { gte: from, lte: to } },
        { txnDate: null, uploadedAt: { gte: from, lte: uploadedTo } },
      ],
    },
    select: documentSelect,
    orderBy: [{ txnDate: "asc" }, { uploadedAt: "asc" }],
  });
  return rows.map((row: DocumentRow) => ({
    id: row.id,
    kind: row.kind,
    kindLabel: DOCUMENT_KIND_LABELS[row.kind] ?? row.kind,
    txnDate: fromDbDateOrNull(row.txnDate),
    amount: row.amount,
    partnerName: row.partner?.name ?? row.partnerName,
    invoiceRegistrationNumber: row.invoiceRegistrationNumber,
    originalName: row.originalName,
    storageKey: row.storageKey,
    sha256: row.sha256,
    mime: row.mime,
    status: row.status,
    statusLabel: DOCUMENT_STATUS_LABELS[row.status] ?? row.status,
    entryNos: row.links
      .map((link) => link.journalEntry?.no)
      .filter((no): no is number => typeof no === "number")
      .sort((a, b) => a - b),
    walletTransactionIds: row.links
      .map((link) => link.walletTransactionId)
      .filter((id): id is string => typeof id === "string"),
  }));
}

/** The reports' source plus the settings, statements and documents the daily backup writes. */
export async function loadBackupSource(db: Db): Promise<BackupSource> {
  const source = await loadReportSource(db);
  const company = await requireCompanyRow(db);
  const taxRateRules = await db.taxRateRule.findMany({
    orderBy: [{ taxCategoryCode: "asc" }, { effectiveFrom: "asc" }],
  });
  const partners = await db.partner.findMany({ orderBy: { name: "asc" } });
  const wallets = await db.wallet.findMany({ orderBy: { createdAt: "asc" } });
  const transactions = await db.walletTransaction.findMany({
    orderBy: [{ walletId: "asc" }, { txnDate: "asc" }, { createdAt: "asc" }],
  });
  const documents = await db.document.findMany({
    select: documentSelect,
    orderBy: { uploadedAt: "asc" },
  });
  const dateFields = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date && /On$|Date$/.test(key) ? fromDbDate(value) : value,
      ]),
    );
  const { setupWalletsSkippedAt: _w, setupOpeningSkippedAt: _o, ...companyFields } = company;
  return {
    ...source,
    settings: {
      company: dateFields(companyFields),
      taxRateRules: taxRateRules.map((rule) => ({
        taxCategoryCode: rule.taxCategoryCode,
        effectiveFrom: fromDbDate(rule.effectiveFrom),
        effectiveTo: fromDbDateOrNull(rule.effectiveTo),
        ratePercent: rule.ratePercent,
        deductiblePercent: rule.deductiblePercent,
        enabled: rule.enabled,
      })),
      partners: partners.map((partner) => dateFields(partner)),
      // Stripe account ids and secret names are not part of the backup (06-architecture §5), nor
      // the bank API's tokens and account ID (19-bank-api §2.3).
      wallets: wallets.map(
        ({ bankApiTokens: _tokens, bankApiAccountId: _accountId, ...wallet }) => ({
          ...dateFields(wallet),
          bankApiSyncedThrough: fromDbDateOrNull(wallet.bankApiSyncedThrough),
        }),
      ),
    },
    walletTransactions: transactions.map((row): BackupWalletTransaction => ({
      id: row.id,
      walletId: row.walletId,
      txnDate: fromDbDate(row.txnDate),
      amount: row.amount,
      descriptionRaw: row.descriptionRaw,
      counterpartyRaw: row.counterpartyRaw,
      balanceAfter: row.balanceAfter,
      externalId: row.externalId,
      status: row.status,
      journalEntryId: row.journalEntryId,
      ignoredReason: row.ignoredReason,
    })),
    documents: documents.map((row: DocumentRow): BackupDocument => ({
      id: row.id,
      kind: row.kind,
      storageKey: row.storageKey,
      sha256: row.sha256,
      mime: row.mime,
      byteSize: row.byteSize,
      originalName: row.originalName,
      uploadedAt: row.uploadedAt,
      txnDate: fromDbDateOrNull(row.txnDate),
      amount: row.amount,
      partnerId: row.partnerId,
      partnerName: row.partner?.name ?? row.partnerName,
      invoiceRegistrationNumber: row.invoiceRegistrationNumber,
      status: row.status,
      journalEntryIds: row.links
        .map((link) => link.journalEntry?.id)
        .filter((id): id is string => typeof id === "string"),
      walletTransactionIds: row.links
        .map((link) => link.walletTransactionId)
        .filter((id): id is string => typeof id === "string"),
    })),
  };
}
