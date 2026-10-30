/**
 * 監査ログ (11-transactions §8): the append-only audit log, newest first, narrowed by target and by
 * period (JST calendar days), with each row's target named as the owner knows it (「仕訳 No. 12」).
 * Reading never writes: the audit log does not grow by being looked at.
 */
import {
  addDays,
  AUDIT_ENTITY_LABELS,
  displayDate,
  DOCUMENT_KIND_LABELS,
  isAuditEntity,
  type AuditEntity,
  type CalendarDate,
} from "@niho-finance/ledger";
import type { Prisma } from "@prisma/client";
import type { Db } from "./audit";
import { fromDbDate } from "./dates";
import { ruleDisplayName } from "./rule-json";
import { invoiceAuditName } from "./invoices";
import { payableAuditName } from "./payables";
import type { AuditLogFilter } from "./schemas";
import { formatStatementAmount } from "./statements";

export const AUDIT_PAGE_SIZE = 50;

/** The filters of the list; left out = not narrowed. */
export type AuditLogFilters = Partial<Omit<AuditLogFilter, "page">>;

export interface AuditLogRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  /** 「仕訳 No. 12」「勘定科目 1100 普通預金」, or `null` when the target cannot be named. */
  target: string | null;
  /** Set for journal entries: the detail can be opened. */
  journalEntryId: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** The start of a JST calendar day as an instant (`at` is a UTC timestamp). */
function startOfJapanDay(date: CalendarDate): Date {
  return new Date(`${date}T00:00:00+09:00`);
}

function auditWhere(filters: AuditLogFilters): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (filters.entity === "setup") {
    // The setup's choices are recorded on the company row with `setup.*` actions.
    and.push({ action: { startsWith: "setup." } });
  } else if (filters.entity) {
    and.push({ entity: filters.entity });
  }
  if (filters.from) and.push({ at: { gte: startOfJapanDay(filters.from) } });
  if (filters.to) and.push({ at: { lt: startOfJapanDay(addDays(filters.to, 1)) } });
  return { AND: and };
}

const key = (entity: string, id: string) => `${entity}:${id}`;

/**
 * Names the targets of audit rows, one query per kind of target: journal entries by their number,
 * fiscal years as 第 n 期, documents by their number (「見積書（下書き）」 before the issue), the other
 * rows by their name. Keys are `<entity>:<id>`.
 */
export async function describeAuditTargets(
  db: Db,
  rows: readonly { entity: string; entityId: string | null }[],
): Promise<Map<string, string>> {
  const ids = new Map<AuditEntity, string[]>();
  for (const row of rows) {
    if (!row.entityId || !isAuditEntity(row.entity)) continue;
    const list = ids.get(row.entity) ?? [];
    list.push(row.entityId);
    ids.set(row.entity, list);
  }
  const names = new Map<string, string>();
  const label = (entity: AuditEntity, id: string, name: string) =>
    names.set(key(entity, id), `${AUDIT_ENTITY_LABELS[entity]} ${name}`);
  const of = (entity: AuditEntity) => ({ in: [...new Set(ids.get(entity) ?? [])] });

  if (ids.has("journal_entry")) {
    const entries = await db.journalEntry.findMany({
      where: { id: of("journal_entry") },
      select: { id: true, no: true },
    });
    for (const entry of entries) label("journal_entry", entry.id, `No. ${entry.no}`);
  }
  if (ids.has("fiscal_year")) {
    const years = await db.fiscalYear.findMany({
      where: { id: of("fiscal_year") },
      select: { id: true, no: true },
    });
    for (const year of years) label("fiscal_year", year.id, `第 ${year.no} 期`);
  }
  if (ids.has("company")) {
    const companies = await db.company.findMany({
      where: { id: of("company") },
      select: { id: true, name: true },
    });
    for (const company of companies) label("company", company.id, company.name);
  }
  if (ids.has("account")) {
    const accounts = await db.account.findMany({
      where: { id: of("account") },
      select: { id: true, code: true, name: true },
    });
    for (const account of accounts) label("account", account.id, `${account.code} ${account.name}`);
  }
  if (ids.has("sub_account")) {
    const subAccounts = await db.subAccount.findMany({
      where: { id: of("sub_account") },
      select: { id: true, name: true, account: { select: { name: true } } },
    });
    for (const sub of subAccounts)
      label("sub_account", sub.id, `${sub.account.name} / ${sub.name}`);
  }
  if (ids.has("tax_rate_rule")) {
    const rules = await db.taxRateRule.findMany({
      where: { id: of("tax_rate_rule") },
      select: {
        id: true,
        ratePercent: true,
        effectiveFrom: true,
        taxCategory: { select: { name: true } },
      },
    });
    for (const rule of rules) {
      const from = displayDate(fromDbDate(rule.effectiveFrom));
      label("tax_rate_rule", rule.id, `${rule.taxCategory.name} ${rule.ratePercent}%（${from}〜）`);
    }
  }
  const select = { id: true, name: true } as const;
  if (ids.has("wallet")) {
    for (const row of await db.wallet.findMany({ where: { id: of("wallet") }, select }))
      label("wallet", row.id, row.name);
  }
  if (ids.has("partner")) {
    for (const row of await db.partner.findMany({ where: { id: of("partner") }, select }))
      label("partner", row.id, row.name);
  }
  if (ids.has("document")) {
    const documents = await db.document.findMany({
      where: { id: of("document") },
      select: { id: true, kind: true, originalName: true },
    });
    for (const row of documents)
      label("document", row.id, row.originalName ?? DOCUMENT_KIND_LABELS[row.kind]);
  }
  if (ids.has("segment")) {
    for (const row of await db.segment.findMany({ where: { id: of("segment") }, select }))
      label("segment", row.id, row.name);
  }
  if (ids.has("memo_tag")) {
    for (const row of await db.memoTag.findMany({ where: { id: of("memo_tag") }, select }))
      label("memo_tag", row.id, row.name);
  }
  if (ids.has("wallet_transaction")) {
    const lines = await db.walletTransaction.findMany({
      where: { id: of("wallet_transaction") },
      select: { id: true, txnDate: true, amount: true },
    });
    for (const line of lines) {
      const date = displayDate(fromDbDate(line.txnDate));
      label("wallet_transaction", line.id, `${date} ${formatStatementAmount(line.amount)}`);
    }
  }
  if (ids.has("rule")) {
    const rules = await db.rule.findMany({
      where: { id: of("rule") },
      select: { id: true, name: true, match: true },
    });
    for (const rule of rules) label("rule", rule.id, ruleDisplayName(rule));
  }
  if (ids.has("payable")) {
    const documents = await db.document.findMany({
      where: { id: of("payable") },
      select: {
        id: true,
        note: true,
        originalName: true,
        partnerName: true,
        partner: { select: { name: true } },
      },
    });
    for (const row of documents) {
      const partnerName = row.partner?.name ?? row.partnerName;
      label("payable", row.id, payableAuditName({ ...row, partnerName }));
    }
  }
  if (ids.has("invoice")) {
    const invoices = await db.invoice.findMany({
      where: { id: of("invoice") },
      select: { id: true, docType: true, number: true },
    });
    for (const invoice of invoices) label("invoice", invoice.id, invoiceAuditName(invoice));
  }
  // 「定期請求 顧問料 架空デザイン」「領収書 RC-2026-0001」 (18 §14.6, §15.5).
  if (ids.has("recurring_invoice")) {
    const where = { id: of("recurring_invoice") };
    for (const row of await db.recurringInvoice.findMany({ where, select }))
      label("recurring_invoice", row.id, row.name);
  }
  if (ids.has("receipt")) {
    const receipts = await db.receipt.findMany({
      where: { id: of("receipt") },
      select: { id: true, number: true },
    });
    for (const receipt of receipts) label("receipt", receipt.id, receipt.number);
  }
  if (ids.has("calendar_item")) {
    const items = await db.calendarItem.findMany({
      where: { id: of("calendar_item") },
      select: { id: true, title: true, fiscalYear: { select: { no: true } } },
    });
    // 「第 1 期 法人税…の申告と納付」; a payroll payment has no fiscal year (22 §7.1).
    for (const item of items) {
      const year = item.fiscalYear ? `第 ${item.fiscalYear.no} 期 ` : "";
      label("calendar_item", item.id, `${year}${item.title}`);
    }
  }
  if (ids.has("fixed_asset")) {
    for (const row of await db.fixedAsset.findMany({ where: { id: of("fixed_asset") }, select }))
      label("fixed_asset", row.id, row.name);
  }
  // 「利用者 架空 太郎」, the email without a name (23 §4).
  if (ids.has("user")) {
    const users = await db.user.findMany({
      where: { id: of("user") },
      select: { id: true, email: true, name: true },
    });
    for (const user of users) label("user", user.id, user.name ?? user.email);
  }
  // 「立替精算 2026/11/05 タクシー代」 (23 §5.2).
  if (ids.has("expense_claim")) {
    const claims = await db.expenseClaim.findMany({
      where: { id: of("expense_claim") },
      select: { id: true, spentOn: true, description: true },
    });
    for (const claim of claims) {
      const date = displayDate(fromDbDate(claim.spentOn));
      label("expense_claim", claim.id, `${date} ${claim.description}`);
    }
  }
  if (ids.has("recurring_item")) {
    const where = { id: of("recurring_item") };
    for (const row of await db.recurringItem.findMany({ where, select }))
      label("recurring_item", row.id, row.name);
  }
  return names;
}

/** The audit log, newest first, `pageSize` (50) per page (11 §8). Read only. */
export async function listAuditLog(
  db: Db,
  filters: AuditLogFilters,
  page = 1,
  options: { pageSize?: number } = {},
): Promise<AuditLogPage> {
  const pageSize = options.pageSize ?? AUDIT_PAGE_SIZE;
  const where = auditWhere(filters);
  const total = await db.auditLog.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const rows = await db.auditLog.findMany({
    where,
    orderBy: [{ at: "desc" }, { id: "desc" }],
    skip: (current - 1) * pageSize,
    take: pageSize,
  });
  const targets = await describeAuditTargets(db, rows);
  return {
    rows: rows.map((row) => {
      const target = row.entityId ? (targets.get(key(row.entity, row.entityId)) ?? null) : null;
      // Rows about a kind of target as a whole: 標準データ, and 索引簿の書き出し (証憑, no id).
      const standard =
        row.entity === "standard_data"
          ? AUDIT_ENTITY_LABELS.standard_data
          : row.entity === "document" && row.entityId === null
            ? AUDIT_ENTITY_LABELS.document
            : null;
      return {
        id: row.id,
        at: row.at,
        actor: row.actor,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        target: target ?? standard,
        journalEntryId: row.entity === "journal_entry" ? row.entityId : null,
        before: row.before,
        after: row.after,
        reason: row.reason,
      };
    }),
    total,
    page: current,
    pageSize,
    pageCount,
  };
}

/** Rows of the audit log (the settings index shows it). */
export async function countAuditLog(db: Db): Promise<number> {
  return db.auditLog.count();
}
