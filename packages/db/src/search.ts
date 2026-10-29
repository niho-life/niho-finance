import {
  normalizeInvoiceRegistrationNumber,
  normalizeText,
  type CalendarDate,
  type DocumentKind,
  type DocumentStatus,
  type EntryStatus,
  type InvoiceDocType,
  type InvoiceStatus,
  type Money,
  type PartnerKind,
  type WalletTransactionStatus,
} from "@niho-finance/ledger";
import { Prisma } from "@prisma/client";
import type { Db } from "./audit";
import { fromDbDate, fromDbDateOrNull } from "./dates";

/*
 * 全体検索 (10 §7): one query across 取引・明細・証憑・取引先・請求. Reads only: nothing is written,
 * the audit log included. The text is compared as `lower(normalize(<column>, NFKC))`, the expression
 * of the trigram indexes (migration `*_search`); each condition of a kind is one arm of a UNION, so
 * every arm can use its own index.
 */

export const SEARCH_KINDS = ["entry", "statement", "document", "partner", "invoice"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_KIND_LABELS: Readonly<Record<SearchKind, string>> = {
  entry: "取引",
  statement: "明細",
  document: "証憑",
  partner: "取引先",
  invoice: "請求",
};

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === "string" && (SEARCH_KINDS as readonly string[]).includes(value);
}

/** Hits of a kind in the palette and on `/search` (10 §7.2). */
export const SEARCH_PER_KIND = 5;
/** Hits per page of one kind on `/search?kind=` (10 §7.2). */
export const SEARCH_PAGE_SIZE = 50;

export interface ParsedSearchQuery {
  /** The input without the surrounding whitespace. */
  raw: string;
  /** `normalizeText(raw)` when it is 2 characters or more (1 character finds nothing), else `null`. */
  text: string | null;
  /** 「1,650」「1650」「¥1,650」「￥1650」「1,650円」 → 1650 (compared with |金額|). */
  amount: Money | null;
  /** 「No.12」「No 12」「no12」 → 12; digits only are also the No. (all fiscal years). */
  entryNo: number | null;
  /** 「T」+ 13 digits: the partners' 登録番号, prefix match. */
  registrationNumber: string | null;
}

const MAX_AMOUNT_DIGITS = 15;
/** `journal_entry.no` is an int4. */
const MAX_ENTRY_NO_DIGITS = 9;

/** After NFKC (￥ → ¥, full-width digits and commas → half-width): sign, yen sign, digits, 円. */
const AMOUNT_PATTERN = /^[+\-−]?\s*[¥\\]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?$/u;
const ENTRY_NO_PATTERN = /^no\.?\s*(\d+)$/u;
const DIGITS_PATTERN = /^\d+$/u;
const REGISTRATION_PATTERN = /^T\d{13}$/u;

function parseAmount(normalized: string): Money | null {
  const match = AMOUNT_PATTERN.exec(normalized);
  const digits = match?.[1]?.replaceAll(",", "");
  if (!digits || digits.length > MAX_AMOUNT_DIGITS) return null;
  return BigInt(digits);
}

function parseEntryNo(normalized: string): number | null {
  const digits = DIGITS_PATTERN.test(normalized)
    ? normalized
    : ENTRY_NO_PATTERN.exec(normalized)?.[1];
  if (!digits) return null;
  const significant = digits.replace(/^0+(?=\d)/u, "");
  if (significant.length > MAX_ENTRY_NO_DIGITS) return null;
  const no = Number(significant);
  return no >= 1 ? no : null;
}

function parseRegistrationNumber(normalized: string): string | null {
  if (!/^t[\d\s-]+$/u.test(normalized)) return null;
  const number = normalizeInvoiceRegistrationNumber(normalized);
  return REGISTRATION_PATTERN.test(number) ? number : null;
}

/** How `input` is looked up (10 §7.2). Pure. */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  const raw = input.trim();
  const normalized = normalizeText(raw);
  return {
    raw,
    text: [...normalized].length >= 2 ? normalized : null,
    amount: parseAmount(normalized),
    entryNo: parseEntryNo(normalized),
    registrationNumber: parseRegistrationNumber(normalized),
  };
}

/** True when the query can find anything (one character of text alone cannot). */
export function isSearchable(query: ParsedSearchQuery): boolean {
  return (
    query.text !== null ||
    query.amount !== null ||
    query.entryNo !== null ||
    query.registrationNumber !== null
  );
}

export type SearchHit =
  | {
      kind: "entry";
      id: string;
      no: number;
      fiscalYearNo: number;
      entryDate: CalendarDate;
      description: string;
      /** The debit total. */
      amount: Money;
      status: EntryStatus;
    }
  | {
      kind: "statement";
      id: string;
      walletId: string;
      walletName: string;
      txnDate: CalendarDate;
      descriptionRaw: string;
      /** Signed: deposits are positive. */
      amount: Money;
      status: WalletTransactionStatus;
    }
  | {
      kind: "document";
      id: string;
      documentKind: DocumentKind;
      originalName: string | null;
      txnDate: CalendarDate | null;
      amount: Money | null;
      /** The master partner's name, or the free-text one. */
      partnerName: string | null;
      status: DocumentStatus;
    }
  | {
      kind: "partner";
      id: string;
      name: string;
      partnerKind: PartnerKind;
      invoiceRegistrationNumber: string | null;
      isActive: boolean;
    }
  | {
      kind: "invoice";
      id: string;
      docType: InvoiceDocType;
      /** As stored: a draft holds a placeholder (`invoiceNumberLabel` shows 「下書き」). */
      number: string;
      title: string | null;
      partnerName: string;
      total: Money;
      issueDate: CalendarDate;
      status: InvoiceStatus;
    };

export interface SearchGroup {
  kind: SearchKind;
  /** Every match of the kind (the hits are the first of them). */
  total: number;
  hits: SearchHit[];
  /**
   * Entries only: the dates of the first and the last match, so that 「すべて見る」 can open the
   * journal over them (without dates the journal shows 今期 only). `null` for the other kinds.
   */
  period: { from: CalendarDate; to: CalendarDate } | null;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

/** `lower(normalize(<column>, NFKC)) LIKE <pattern> ESCAPE '\'`: the indexes' expression. */
function like(column: string, pattern: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(`lower(normalize(${column}, NFKC))`)} LIKE ${pattern} ${Prisma.raw("ESCAPE '\\'")}`;
}

interface KindSql {
  /** Each selects one column `id`; the matches of the kind are their union. */
  arms: Prisma.Sql[];
  /** `count(*)` of the matches as `total` (entries also `from` and `to`). */
  count: Prisma.Sql;
  /** The hits, newest first (partners by name). */
  rows: (limit: number, offset: number) => Prisma.Sql;
}

function withMatches(arms: Prisma.Sql[], select: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`WITH "m" AS (${Prisma.join(arms, " UNION ")}) ${select}`;
}

function entrySql(query: ParsedSearchQuery, pattern: string | null): KindSql {
  const arms: Prisma.Sql[] = [];
  if (pattern !== null) {
    arms.push(Prisma.sql`SELECT "id" FROM "journal_entry" WHERE ${like(`"description"`, pattern)}`);
    arms.push(
      Prisma.sql`SELECT "journal_entry_id" AS "id" FROM "journal_line" WHERE ${like(`"description"`, pattern)}`,
    );
  }
  if (query.amount !== null) {
    arms.push(Prisma.sql`SELECT "journal_entry_id" AS "id" FROM "journal_line"
      WHERE "side" = 'debit' GROUP BY "journal_entry_id" HAVING sum("amount") = ${query.amount}`);
  }
  if (query.entryNo !== null) {
    arms.push(Prisma.sql`SELECT "id" FROM "journal_entry" WHERE "no" = ${query.entryNo}`);
  }
  // Reversals are never hits; the voided entries they cancel are (10 §7.2).
  const from = Prisma.sql`FROM "journal_entry" e JOIN "m" ON "m"."id" = e."id"
    WHERE e."kind" <> 'reversal'`;
  return {
    arms,
    count: withMatches(
      arms,
      Prisma.sql`SELECT count(*)::int AS "total", min(e."entry_date") AS "from",
        max(e."entry_date") AS "to" ${from}`,
    ),
    rows: (limit, offset) =>
      withMatches(
        arms,
        Prisma.sql`SELECT e."id", e."no", fy."no" AS "fiscalYearNo", e."entry_date" AS "entryDate",
          e."description", e."status"::text AS "status",
          (SELECT coalesce(sum(l."amount"), 0) FROM "journal_line" l
            WHERE l."journal_entry_id" = e."id" AND l."side" = 'debit')::bigint AS "amount"
          FROM "journal_entry" e JOIN "m" ON "m"."id" = e."id"
          JOIN "fiscal_year" fy ON fy."id" = e."fiscal_year_id"
          WHERE e."kind" <> 'reversal'
          ORDER BY e."entry_date" DESC, e."id" DESC LIMIT ${limit} OFFSET ${offset}`,
      ),
  };
}

function statementSql(query: ParsedSearchQuery, pattern: string | null): KindSql {
  const arms: Prisma.Sql[] = [];
  if (pattern !== null) {
    arms.push(
      Prisma.sql`SELECT "id" FROM "wallet_transaction" WHERE ${like(`"description_raw"`, pattern)}`,
    );
    arms.push(
      Prisma.sql`SELECT "id" FROM "wallet_transaction" WHERE ${like(`"counterparty_raw"`, pattern)}`,
    );
  }
  if (query.amount !== null) {
    arms.push(Prisma.sql`SELECT "id" FROM "wallet_transaction"
      WHERE "amount" IN (${query.amount}, ${-query.amount})`);
  }
  return {
    arms,
    count: withMatches(arms, Prisma.sql`SELECT count(*)::int AS "total" FROM "m"`),
    rows: (limit, offset) =>
      withMatches(
        arms,
        Prisma.sql`SELECT t."id", t."wallet_id" AS "walletId", w."name" AS "walletName",
          t."txn_date" AS "txnDate", t."description_raw" AS "descriptionRaw", t."amount",
          t."status"::text AS "status"
          FROM "wallet_transaction" t JOIN "m" ON "m"."id" = t."id"
          JOIN "wallet" w ON w."id" = t."wallet_id"
          ORDER BY t."txn_date" DESC, t."id" DESC LIMIT ${limit} OFFSET ${offset}`,
      ),
  };
}

function documentSql(query: ParsedSearchQuery, pattern: string | null): KindSql {
  const arms: Prisma.Sql[] = [];
  if (pattern !== null) {
    for (const column of [`"partner_name"`, `"original_name"`, `"note"`]) {
      arms.push(Prisma.sql`SELECT "id" FROM "document" WHERE ${like(column, pattern)}`);
    }
    // The partner of the master (the list shows its name when one is set).
    arms.push(Prisma.sql`SELECT d."id" FROM "document" d JOIN "partner" p ON p."id" = d."partner_id"
      WHERE ${like(`p."name"`, pattern)}`);
  }
  if (query.amount !== null) {
    arms.push(Prisma.sql`SELECT "id" FROM "document" WHERE "amount" = ${query.amount}`);
  }
  return {
    arms,
    count: withMatches(arms, Prisma.sql`SELECT count(*)::int AS "total" FROM "m"`),
    rows: (limit, offset) =>
      withMatches(
        arms,
        Prisma.sql`SELECT d."id", d."kind"::text AS "documentKind", d."original_name" AS "originalName",
          d."txn_date" AS "txnDate", d."amount", coalesce(p."name", d."partner_name") AS "partnerName",
          d."status"::text AS "status"
          FROM "document" d JOIN "m" ON "m"."id" = d."id"
          LEFT JOIN "partner" p ON p."id" = d."partner_id"
          ORDER BY coalesce(d."txn_date", (d."uploaded_at" AT TIME ZONE 'Asia/Tokyo')::date) DESC,
            d."id" DESC LIMIT ${limit} OFFSET ${offset}`,
      ),
  };
}

function partnerSql(query: ParsedSearchQuery, pattern: string | null): KindSql {
  const arms: Prisma.Sql[] = [];
  if (pattern !== null) {
    arms.push(Prisma.sql`SELECT "id" FROM "partner" WHERE ${like(`"name"`, pattern)}`);
    arms.push(Prisma.sql`SELECT "id" FROM "partner" WHERE ${like(`"name_kana"`, pattern)}`);
  }
  if (query.registrationNumber !== null) {
    const prefix = `${escapeLike(query.registrationNumber)}%`;
    arms.push(Prisma.sql`SELECT "id" FROM "partner"
      WHERE "invoice_registration_number" LIKE ${prefix} ${Prisma.raw("ESCAPE '\\'")}`);
  }
  return {
    arms,
    count: withMatches(arms, Prisma.sql`SELECT count(*)::int AS "total" FROM "m"`),
    rows: (limit, offset) =>
      withMatches(
        arms,
        Prisma.sql`SELECT p."id", p."name", p."kind"::text AS "partnerKind",
          p."invoice_registration_number" AS "invoiceRegistrationNumber", p."is_active" AS "isActive"
          FROM "partner" p JOIN "m" ON "m"."id" = p."id"
          ORDER BY p."name", p."id" LIMIT ${limit} OFFSET ${offset}`,
      ),
  };
}

function invoiceSql(query: ParsedSearchQuery, pattern: string | null): KindSql {
  const arms: Prisma.Sql[] = [];
  if (pattern !== null) {
    // A draft's placeholder number is not a number (it holds an id): only issued ones are searched.
    arms.push(Prisma.sql`SELECT "id" FROM "invoice"
      WHERE "issued_at" IS NOT NULL AND ${like(`"number"`, pattern)}`);
    arms.push(Prisma.sql`SELECT "id" FROM "invoice" WHERE ${like(`"title"`, pattern)}`);
    arms.push(Prisma.sql`SELECT i."id" FROM "invoice" i JOIN "partner" p ON p."id" = i."partner_id"
      WHERE ${like(`p."name"`, pattern)}`);
  }
  if (query.amount !== null) {
    arms.push(Prisma.sql`SELECT "id" FROM "invoice" WHERE "total" = ${query.amount}`);
  }
  return {
    arms,
    count: withMatches(arms, Prisma.sql`SELECT count(*)::int AS "total" FROM "m"`),
    rows: (limit, offset) =>
      withMatches(
        arms,
        Prisma.sql`SELECT i."id", i."doc_type"::text AS "docType", i."number", i."title",
          p."name" AS "partnerName", i."total", i."issue_date" AS "issueDate",
          i."status"::text AS "status"
          FROM "invoice" i JOIN "m" ON "m"."id" = i."id"
          JOIN "partner" p ON p."id" = i."partner_id"
          ORDER BY i."issue_date" DESC, i."id" DESC LIMIT ${limit} OFFSET ${offset}`,
      ),
  };
}

const KIND_SQL: Record<SearchKind, (query: ParsedSearchQuery, pattern: string | null) => KindSql> =
  {
    entry: entrySql,
    statement: statementSql,
    document: documentSql,
    partner: partnerSql,
    invoice: invoiceSql,
  };

interface CountRow {
  total: number;
  from?: Date | null;
  to?: Date | null;
}

interface EntryRow {
  id: string;
  no: number;
  fiscalYearNo: number;
  entryDate: Date;
  description: string;
  amount: bigint;
  status: EntryStatus;
}

interface StatementRow {
  id: string;
  walletId: string;
  walletName: string;
  txnDate: Date;
  descriptionRaw: string;
  amount: bigint;
  status: WalletTransactionStatus;
}

interface DocumentRow {
  id: string;
  documentKind: DocumentKind;
  originalName: string | null;
  txnDate: Date | null;
  amount: bigint | null;
  partnerName: string | null;
  status: DocumentStatus;
}

interface PartnerRow {
  id: string;
  name: string;
  partnerKind: PartnerKind;
  invoiceRegistrationNumber: string | null;
  isActive: boolean;
}

interface InvoiceRow {
  id: string;
  docType: InvoiceDocType;
  number: string;
  title: string | null;
  partnerName: string;
  total: bigint;
  issueDate: Date;
  status: InvoiceStatus;
}

function toHits(kind: SearchKind, rows: unknown[]): SearchHit[] {
  switch (kind) {
    case "entry":
      return (rows as EntryRow[]).map((row) => ({
        kind,
        id: row.id,
        no: row.no,
        fiscalYearNo: row.fiscalYearNo,
        entryDate: fromDbDate(row.entryDate),
        description: row.description,
        amount: row.amount,
        status: row.status,
      }));
    case "statement":
      return (rows as StatementRow[]).map((row) => ({
        kind,
        id: row.id,
        walletId: row.walletId,
        walletName: row.walletName,
        txnDate: fromDbDate(row.txnDate),
        descriptionRaw: row.descriptionRaw,
        amount: row.amount,
        status: row.status,
      }));
    case "document":
      return (rows as DocumentRow[]).map((row) => ({
        kind,
        id: row.id,
        documentKind: row.documentKind,
        originalName: row.originalName,
        txnDate: fromDbDateOrNull(row.txnDate),
        amount: row.amount,
        partnerName: row.partnerName,
        status: row.status,
      }));
    case "partner":
      return (rows as PartnerRow[]).map((row) => ({
        kind,
        id: row.id,
        name: row.name,
        partnerKind: row.partnerKind,
        invoiceRegistrationNumber: row.invoiceRegistrationNumber,
        isActive: row.isActive,
      }));
    case "invoice":
      return (rows as InvoiceRow[]).map((row) => ({
        kind,
        id: row.id,
        docType: row.docType,
        number: row.number,
        title: row.title,
        partnerName: row.partnerName,
        total: row.total,
        issueDate: fromDbDate(row.issueDate),
        status: row.status,
      }));
  }
}

function prepare(query: ParsedSearchQuery): string | null {
  return query.text === null ? null : `%${escapeLike(query.text)}%`;
}

async function countKind(db: Db, sql: KindSql): Promise<CountRow> {
  if (sql.arms.length === 0) return { total: 0 };
  const [row] = await db.$queryRaw<CountRow[]>(sql.count);
  return row ?? { total: 0 };
}

async function hitsOfKind(
  db: Db,
  kind: SearchKind,
  sql: KindSql,
  limit: number,
  offset: number,
): Promise<SearchHit[]> {
  if (sql.arms.length === 0) return [];
  return toHits(kind, await db.$queryRaw<unknown[]>(sql.rows(limit, offset)));
}

function periodOf(count: CountRow): SearchGroup["period"] {
  return count.from && count.to ? { from: fromDbDate(count.from), to: fromDbDate(count.to) } : null;
}

/**
 * The palette and `/search` (10 §7.2): per kind, in the fixed order, the first `perKind` hits and the
 * count of every match. Kinds without a match are left out; a query that can find nothing (empty,
 * one character of text) has no groups. Reads only.
 */
export async function searchAll(
  db: Db,
  input: string,
  options: { perKind?: number } = {},
): Promise<{ query: ParsedSearchQuery; groups: SearchGroup[] }> {
  const query = parseSearchQuery(input);
  if (!isSearchable(query)) return { query, groups: [] };
  const perKind = options.perKind ?? SEARCH_PER_KIND;
  const pattern = prepare(query);
  const groups = await Promise.all(
    SEARCH_KINDS.map(async (kind): Promise<SearchGroup> => {
      const sql = KIND_SQL[kind](query, pattern);
      const [count, hits] = await Promise.all([
        countKind(db, sql),
        hitsOfKind(db, kind, sql, perKind, 0),
      ]);
      return { kind, total: count.total, hits, period: periodOf(count) };
    }),
  );
  return { query, groups: groups.filter((group) => group.total > 0) };
}

/** `/search?kind=`: one kind, `pageSize` (50) per page; a page past the end shows the last. Reads only. */
export async function searchKind(
  db: Db,
  input: string,
  kind: SearchKind,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ query: ParsedSearchQuery; group: SearchGroup; page: number; pageCount: number }> {
  const query = parseSearchQuery(input);
  const pageSize = options.pageSize ?? SEARCH_PAGE_SIZE;
  const empty = { kind, total: 0, hits: [], period: null };
  if (!isSearchable(query)) return { query, group: empty, page: 1, pageCount: 1 };
  const sql = KIND_SQL[kind](query, prepare(query));
  const count = await countKind(db, sql);
  const pageCount = Math.max(1, Math.ceil(count.total / pageSize));
  const requested = Number.isFinite(options.page) ? Math.trunc(options.page ?? 1) : 1;
  const page = Math.min(Math.max(1, requested), pageCount);
  const hits =
    count.total === 0 ? [] : await hitsOfKind(db, kind, sql, pageSize, (page - 1) * pageSize);
  return {
    query,
    group: { kind, total: count.total, hits, period: periodOf(count) },
    page,
    pageCount,
  };
}
