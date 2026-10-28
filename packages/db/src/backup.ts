import type { CalendarDate } from "@niho-finance/ledger";
import { Prisma, type PrismaClient } from "@prisma/client";
import { toAuditJson, type Db } from "./audit";
import { fromDbDate } from "./dates";
import { loadTrialBalance } from "./queries";

/*
 * Daily export (06-architecture §6, docs/ops/deploy.md §7): every table as JSON (keyed by the
 * table name, rows keyed by the column names, in primary key order) and the trial balance of every
 * fiscal year. `restoreBackupSnapshot` loads a snapshot into an empty, migrated database through
 * the ledger guards, so a restored book obeys the same rules as the original. Column names and
 * types come from the Prisma schema (`Prisma.dmmf`); only the table order is written down here.
 */

/** A JSON value as written to the export files. */
export type BackupJson =
  null | boolean | number | string | BackupJson[] | { [key: string]: BackupJson };

export type BackupRow = Record<string, BackupJson>;

export const BACKUP_SNAPSHOT_FORMAT = "niho-finance-snapshot";
export const BACKUP_SNAPSHOT_VERSION = 1;

export interface BackupSnapshot {
  format: typeof BACKUP_SNAPSHOT_FORMAT;
  version: typeof BACKUP_SNAPSHOT_VERSION;
  exportedAt: string;
  /** The last migration applied to the exported database (`_prisma_migrations`). */
  migration: string | null;
  /** Rows by table name: column → value (bigint as a decimal string, dates as ISO strings). */
  tables: Record<string, BackupRow[]>;
}

export interface BackupTrialBalance {
  fiscalYearNo: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** `ledger.trialBalance` of the year through its end, JSON-safe (amounts as decimal strings). */
  trialBalance: BackupJson;
}

/**
 * Every model, in foreign-key order: a table only references tables above it (or itself).
 * Restore inserts in this order. A model missing here fails the export (see `backupTableSpecs`).
 */
export const BACKUP_TABLES = [
  { table: "company", model: "Company" },
  { table: "fiscal_year", model: "FiscalYear" },
  { table: "tax_category", model: "TaxCategory" },
  { table: "tax_rate_rule", model: "TaxRateRule" },
  { table: "segment", model: "Segment" },
  { table: "account", model: "Account" },
  { table: "partner", model: "Partner" },
  { table: "employee", model: "Employee" },
  { table: "sub_account", model: "SubAccount" },
  { table: "memo_tag", model: "MemoTag" },
  { table: "wallet", model: "Wallet" },
  { table: "stripe_account_link", model: "StripeAccountLink" },
  { table: "document", model: "Document" },
  { table: "import_batch", model: "ImportBatch" },
  { table: "rule", model: "Rule" },
  { table: "journal_entry", model: "JournalEntry" },
  { table: "journal_line", model: "JournalLine" },
  { table: "journal_line_memo_tag", model: "JournalLineMemoTag" },
  { table: "payroll_run", model: "PayrollRun" },
  { table: "payroll_bonus_run", model: "PayrollBonusRun" },
  { table: "payroll_year_end_declaration", model: "PayrollYearEndDeclaration" },
  { table: "payroll_year_end", model: "PayrollYearEnd" },
  { table: "wallet_transaction", model: "WalletTransaction" },
  { table: "invoice", model: "Invoice" },
  { table: "document_link", model: "DocumentLink" },
  { table: "fixed_asset", model: "FixedAsset" },
  { table: "recurring_item", model: "RecurringItem" },
  { table: "calendar_item", model: "CalendarItem" },
  { table: "audit_log", model: "AuditLog" },
  { table: "external_api_usage", model: "ExternalApiUsage" },
  { table: "app_user", model: "User" },
  { table: "expense_payment", model: "ExpensePayment" },
  { table: "expense_claim", model: "ExpenseClaim" },
] as const satisfies readonly { table: string; model: Prisma.ModelName }[];

export interface BackupColumn {
  /** Prisma field name. */
  field: string;
  /** Database column name (`@map`). */
  column: string;
  /** Prisma scalar type (`BigInt`, `DateTime`, `Json`, ...) or the enum name. */
  type: string;
}

export interface BackupTableSpec {
  table: string;
  model: Prisma.ModelName;
  columns: BackupColumn[];
  byColumn: Map<string, BackupColumn>;
  /** Primary key fields (the export order). */
  primaryKey: string[];
  /** Foreign key fields that reference the same table. */
  selfReferences: string[];
}

/** Scalar types the JSON conversion does not round-trip (Bytes is written as base64). */
const UNSUPPORTED_TYPES = new Set<string>();

/** A column value before the JSON conversion: bytes (e.g. an imported file) become base64 text. */
function columnValue(column: BackupColumn, value: unknown): unknown {
  if (column.type === "Bytes" && value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  return value;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

let tableSpecs: BackupTableSpec[] | undefined;

/** The tables of `BACKUP_TABLES` with their columns, checked against the Prisma schema. */
export function backupTableSpecs(): BackupTableSpec[] {
  if (tableSpecs) return tableSpecs;
  const models = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));
  const listed = new Set<string>(BACKUP_TABLES.map((entry) => entry.model));
  const unlisted = [...models.keys()].filter((name) => !listed.has(name));
  if (unlisted.length > 0) {
    throw new Error(`backup: add the models ${unlisted.join(", ")} to BACKUP_TABLES`);
  }
  tableSpecs = BACKUP_TABLES.map(({ table, model }) => {
    const definition = models.get(model);
    if (!definition) throw new Error(`backup: ${model} is not a Prisma model`);
    if ((definition.dbName ?? definition.name) !== table) {
      throw new Error(`backup: ${model} is stored in ${definition.dbName ?? model}, not ${table}`);
    }
    const columns: BackupColumn[] = [];
    for (const field of definition.fields) {
      if (field.kind === "object") continue;
      if (field.kind === "unsupported" || UNSUPPORTED_TYPES.has(field.type)) {
        throw new Error(
          `backup: ${table}.${field.name} (${field.type}) cannot be exported as JSON`,
        );
      }
      columns.push({ field: field.name, column: field.dbName ?? field.name, type: field.type });
    }
    const primaryKey = definition.primaryKey
      ? [...definition.primaryKey.fields]
      : definition.fields.filter((field) => field.isId).map((field) => field.name);
    const selfReferences = definition.fields
      .filter((field) => field.kind === "object" && field.type === model)
      .flatMap((field) => [...(field.relationFromFields ?? [])]);
    return {
      table,
      model,
      columns,
      byColumn: new Map(columns.map((column) => [column.column, column])),
      primaryKey,
      selfReferences,
    };
  });
  return tableSpecs;
}

type Row = Record<string, unknown>;

/** The model delegate (`db.journalEntry`, ...) with untyped rows: the columns come from the schema. */
interface ModelDelegate {
  findMany(args: { orderBy: Record<string, "asc">[] }): Promise<Row[]>;
  createMany(args: { data: Row[] }): Promise<{ count: number }>;
  update(args: { where: Row; data: Row }): Promise<unknown>;
  count(): Promise<number>;
}

function delegateOf(db: Db, model: Prisma.ModelName): ModelDelegate {
  const key = `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
  const delegate = (db as unknown as Record<string, ModelDelegate | undefined>)[key];
  if (!delegate) throw new Error(`backup: the Prisma client has no ${key}`);
  return delegate;
}

/** JSON-safe copy (bigint → decimal string, Date → ISO string): the audit log's conversion. */
function toBackupJson(value: unknown): BackupJson {
  return toAuditJson(value) as BackupJson;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last migration applied to the database (`_prisma_migrations`), or `null` without any. */
export async function latestAppliedMigration(db: Db): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ migration_name: string }[]>`
      SELECT "migration_name" FROM "_prisma_migrations"
       WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
       ORDER BY "migration_name" DESC
       LIMIT 1`;
    return rows[0]?.migration_name ?? null;
  } catch (error) {
    throw new Error(
      `_prisma_migrations を読めません（接続するロールに SELECT の権限が要ります）: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/** Every table of the database as JSON, in primary key order. */
export async function exportBackupSnapshot(
  db: Db,
  options: { now?: Date } = {},
): Promise<BackupSnapshot> {
  const exportedAt = (options.now ?? new Date()).toISOString();
  const migration = await latestAppliedMigration(db);
  const tables: Record<string, BackupRow[]> = {};
  for (const spec of backupTableSpecs()) {
    const rows = await delegateOf(db, spec.model).findMany({
      orderBy: spec.primaryKey.map((field) => ({ [field]: "asc" as const })),
    });
    const byColumn = rows.map((row) =>
      Object.fromEntries(
        spec.columns.map((column) => [column.column, columnValue(column, row[column.field])]),
      ),
    );
    tables[spec.table] = toBackupJson(byColumn) as BackupRow[];
  }
  return {
    format: BACKUP_SNAPSHOT_FORMAT,
    version: BACKUP_SNAPSHOT_VERSION,
    exportedAt,
    migration,
    tables,
  };
}

/** The trial balance of every fiscal year (by 第 n 期), JSON-safe: what a restore must reproduce. */
export async function trialBalancesForBackup(db: Db): Promise<BackupTrialBalance[]> {
  const fiscalYears = await db.fiscalYear.findMany({ orderBy: { no: "asc" } });
  const result: BackupTrialBalance[] = [];
  for (const fiscalYear of fiscalYears) {
    result.push({
      fiscalYearNo: fiscalYear.no,
      startDate: fromDbDate(fiscalYear.startDate),
      endDate: fromDbDate(fiscalYear.endDate),
      trialBalance: toBackupJson(await loadTrialBalance(db, fiscalYear.id)),
    });
  }
  return result;
}

export interface BackupExport<Extra = undefined> {
  snapshot: BackupSnapshot;
  trialBalances: BackupTrialBalance[];
  /** What `options.extra` read in the same view of the database. */
  extra: Extra | undefined;
}

const BACKUP_TRANSACTION = { maxWait: 60_000, timeout: 10 * 60_000 } as const;

/**
 * The snapshot and the trial balances from one view of the database (REPEATABLE READ), so the
 * trial balances are exactly those of the snapshot even when something is posted meanwhile.
 * `extra` reads more in the same view (the job adds the reports' CSV / beancount source, S7).
 */
export async function exportBackup<Extra = undefined>(
  prisma: PrismaClient,
  options: { now?: Date; extra?: (tx: Db) => Promise<Extra> } = {},
): Promise<BackupExport<Extra>> {
  return prisma.$transaction(
    async (tx) => ({
      snapshot: await exportBackupSnapshot(tx, options),
      trialBalances: await trialBalancesForBackup(tx),
      extra: options.extra ? await options.extra(tx) : undefined,
    }),
    { ...BACKUP_TRANSACTION, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreBackupResult {
  /** Rows inserted, by table name. */
  tables: Record<string, number>;
}

/** Rows per createMany (well below the bind parameter limit). */
const INSERT_CHUNK = 500;

function fromBackupValue(table: string, column: BackupColumn, value: BackupJson): unknown {
  if (column.type === "Json") return value === null ? Prisma.DbNull : value;
  if (value === null) return null;
  switch (column.type) {
    case "BigInt":
      if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
      if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
      break;
    case "DateTime":
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value);
      break;
    case "Bytes":
      if (typeof value === "string" && value.length % 4 === 0 && BASE64.test(value)) {
        return Buffer.from(value, "base64");
      }
      break;
    default:
      return value;
  }
  throw new Error(
    `スナップショットの ${table}.${column.column} の値 ${JSON.stringify(value)} を ${column.type} として読めません`,
  );
}

/** Snapshot rows as Prisma create data (field names, bigint and Date restored). */
function readSnapshotTables(
  snapshot: BackupSnapshot,
  specs: BackupTableSpec[],
): Map<string, Row[]> {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    snapshot.format !== BACKUP_SNAPSHOT_FORMAT ||
    snapshot.version !== BACKUP_SNAPSHOT_VERSION ||
    typeof snapshot.tables !== "object" ||
    snapshot.tables === null
  ) {
    throw new Error(
      `${BACKUP_SNAPSHOT_FORMAT} の version ${BACKUP_SNAPSHOT_VERSION} のスナップショットではありません`,
    );
  }
  const known = new Set(specs.map((spec) => spec.table));
  const unknown = Object.keys(snapshot.tables).filter((table) => !known.has(table));
  if (unknown.length > 0) {
    throw new Error(
      `スナップショットに今のスキーマにない表があります（${unknown.join("、")}）。manifest.json の gitSha のコードで復元してください`,
    );
  }
  const result = new Map<string, Row[]>();
  for (const spec of specs) {
    const rows = snapshot.tables[spec.table] ?? [];
    result.set(
      spec.table,
      rows.map((row) => {
        const data: Row = {};
        for (const [columnName, value] of Object.entries(row)) {
          const column = spec.byColumn.get(columnName);
          if (!column) {
            throw new Error(
              `スナップショットの列 ${spec.table}.${columnName} は今のスキーマにありません。manifest.json の gitSha のコードで復元してください`,
            );
          }
          data[column.field] = fromBackupValue(spec.table, column, value);
        }
        return data;
      }),
    );
  }
  return result;
}

async function assertEmptyDatabase(db: Db, specs: BackupTableSpec[]): Promise<void> {
  const filled: string[] = [];
  for (const spec of specs) {
    if ((await delegateOf(db, spec.model).count()) > 0) filled.push(spec.table);
  }
  if (filled.length > 0) {
    throw new Error(
      `復元先のデータベースが空ではありません（${filled.join("、")}）。migration だけを流した空のデータベースに復元してください`,
    );
  }
}

/** A text key of a row (IDs are ULID strings); `null` when the value is empty. */
function key(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`スナップショットの ID ${JSON.stringify(value)} が文字列ではありません`);
  }
  return value;
}

/** Rows ordered so that a row referencing its own table comes after the row it references. */
function orderBySelfReferences(spec: BackupTableSpec, rows: Row[]): Row[] {
  if (spec.selfReferences.length === 0) return rows;
  const ids = new Set(rows.map((row) => key(row.id)));
  const placed = new Set<string | null>();
  const ordered: Row[] = [];
  let pending = rows;
  while (pending.length > 0) {
    const waiting: Row[] = [];
    for (const row of pending) {
      const ready = spec.selfReferences.every((field) => {
        const target = key(row[field]);
        return target === null || !ids.has(target) || placed.has(target);
      });
      if (ready) {
        ordered.push(row);
        placed.add(key(row.id));
      } else {
        waiting.push(row);
      }
    }
    if (waiting.length === pending.length) {
      throw new Error(`スナップショットの ${spec.table} の参照が循環しています`);
    }
    pending = waiting;
  }
  return ordered;
}

async function insertRows(db: Db, model: Prisma.ModelName, rows: Row[]): Promise<void> {
  const delegate = delegateOf(db, model);
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    await delegate.createMany({ data: rows.slice(start, start + INSERT_CHUNK) });
  }
}

/**
 * Journal entries through the ledger guards: each entry is inserted as posted and followed by its
 * lines in the same transaction (lines can only join the entry inserted last). Voids are applied
 * afterwards (posted → voided with voided_at and void_reason), then the replacement links.
 */
async function restoreJournal(
  db: Db,
  spec: BackupTableSpec,
  entries: Row[],
  lines: Row[],
): Promise<void> {
  const linesByEntry = new Map<string, Row[]>();
  for (const line of lines) {
    const entryId = key(line.journalEntryId) ?? "";
    const entryLines = linesByEntry.get(entryId);
    if (entryLines) entryLines.push(line);
    else linesByEntry.set(entryId, [line]);
  }
  const entryIds = new Set(entries.map((entry) => key(entry.id) ?? ""));
  const orphans = [...linesByEntry.keys()].filter((id) => !entryIds.has(id));
  if (orphans.length > 0) {
    throw new Error(`スナップショットの仕訳行が、ない仕訳を指しています（${orphans.join("、")}）`);
  }

  const journalEntries = delegateOf(db, "JournalEntry");
  const journalLines = delegateOf(db, "JournalLine");
  const asPosted = entries.map((entry) => ({
    ...entry,
    status: "posted",
    voidedAt: null,
    voidReason: null,
    replacedById: null,
  }));
  for (const entry of orderBySelfReferences(spec, asPosted)) {
    await journalEntries.createMany({ data: [entry] });
    const entryLines = linesByEntry.get(key(entry.id) ?? "") ?? [];
    if (entryLines.length > 0) await journalLines.createMany({ data: entryLines });
  }
  for (const entry of entries) {
    if (entry.status !== "voided") continue;
    await journalEntries.update({
      where: { id: entry.id },
      data: { status: "voided", voidedAt: entry.voidedAt, voidReason: entry.voidReason },
    });
  }
  for (const entry of entries) {
    if (entry.replacedById === null || entry.replacedById === undefined) continue;
    await journalEntries.update({
      where: { id: entry.id },
      data: { replacedById: entry.replacedById },
    });
  }
}

/**
 * Loads a snapshot into an empty, migrated database in one transaction (all or nothing), keeping
 * every ID, timestamp and audit log row. The ledger guards stay in force: entries go in as posted
 * with their lines and are voided afterwards, so the restored book passes the same checks.
 */
export async function restoreBackupSnapshot(
  db: PrismaClient,
  snapshot: BackupSnapshot,
): Promise<RestoreBackupResult> {
  const specs = backupTableSpecs();
  const rows = readSnapshotTables(snapshot, specs);
  return db.$transaction(async (tx) => {
    await assertEmptyDatabase(tx, specs);
    const tables: Record<string, number> = {};
    for (const spec of specs) {
      const tableRows = rows.get(spec.table) ?? [];
      tables[spec.table] = tableRows.length;
      if (spec.table === "journal_line") continue; // inserted with their entries
      if (spec.table === "journal_entry") {
        await restoreJournal(tx, spec, tableRows, rows.get("journal_line") ?? []);
        continue;
      }
      await insertRows(tx, spec.model, orderBySelfReferences(spec, tableRows));
    }
    return { tables };
  }, BACKUP_TRANSACTION);
}
