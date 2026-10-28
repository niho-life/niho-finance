/**
 * Reads and writes of 決算書と申告用データ (17-financial-statements §10, §11). The statements are
 * derived by `@niho-finance/reports` from the book loaded here on every request; only the 決算書の
 * 設定 of each fiscal year is stored (`FiscalYear.statementSettings`), and every download is in the
 * audit log (`export.download`).
 */
import type { TaxRateRule } from "@niho-finance/ledger";
import {
  EMPTY_STATEMENT_SETTINGS,
  normalizeStatementSettings,
  toFinancialStatementsSource,
  type FinancialStatementsSource,
  type StatementSettings,
} from "@niho-finance/reports";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull } from "./dates";
import { SettingsError } from "./errors";
import { EXPORT_AUDIT_ACTION, loadReportSource } from "./reports-query";
import { statementSettingsSchema, type StatementSettingsInput } from "./schemas";
import { requireCompanyRow, type WriteOptions } from "./settings";
import { runInTransaction } from "./transaction";

/** The audit action of a change of 決算書の設定 (entity `fiscal_year`). */
export const STATEMENTS_UPDATE_ACTION = "statements.update";

/** The export kinds of 決算書と申告用データ (17 §1), as `recordExport` stores them. */
export const STATEMENT_EXPORT_KINDS = [
  "financial-statements",
  "opening-balance-sheet",
  "business-report",
  "supplementary-schedules",
  "etax-csv",
  "account-details",
  "consumption-tax",
  "announcement",
] as const;
export type StatementExportKind = (typeof STATEMENT_EXPORT_KINDS)[number];

async function loadTaxRateRules(db: Db): Promise<TaxRateRule[]> {
  const rows = await db.taxRateRule.findMany({
    orderBy: [{ taxCategoryCode: "asc" }, { effectiveFrom: "asc" }, { ratePercent: "desc" }],
  });
  return rows.map((rule) => ({
    taxCategoryCode: rule.taxCategoryCode,
    effectiveFrom: fromDbDate(rule.effectiveFrom),
    effectiveTo: fromDbDateOrNull(rule.effectiveTo),
    ratePercent: rule.ratePercent,
    deductiblePercent: rule.deductiblePercent,
    enabled: rule.enabled,
    ...(rule.note ? { note: rule.note } : {}),
  }));
}

/**
 * The whole book for the statements: `loadReportSource` plus the columns only the statements read
 * (the company's address / representative / invoice registration date, each account's 勘定科目コード,
 * the partners' addresses, the partner of each sub-account, each year's 決算書の設定 and the tax rate
 * rules).
 */
export async function loadFinancialStatementsSource(db: Db): Promise<FinancialStatementsSource> {
  const base = await loadReportSource(db);
  const company = await requireCompanyRow(db);
  const accounts = await db.account.findMany({ select: { id: true, eTaxCode: true } });
  const partners = await db.partner.findMany({ select: { id: true, address: true } });
  const subAccounts = await db.subAccount.findMany({ select: { id: true, partnerId: true } });
  const fiscalYears = await db.fiscalYear.findMany({
    select: { id: true, statementSettings: true },
  });
  return toFinancialStatementsSource(base, {
    company: {
      address: company.address,
      representative: company.representative,
      invoiceRegisteredOn: fromDbDateOrNull(company.invoiceRegisteredOn),
    },
    accountETaxCodes: Object.fromEntries(accounts.map((row) => [row.id, row.eTaxCode])),
    partnerAddresses: Object.fromEntries(partners.map((row) => [row.id, row.address])),
    subAccountPartners: Object.fromEntries(subAccounts.map((row) => [row.id, row.partnerId])),
    statementSettings: Object.fromEntries(
      fiscalYears.map((row) => [row.id, row.statementSettings ?? null]),
    ),
    taxRules: await loadTaxRateRules(db),
  });
}

// ---------------------------------------------------------------------------
// 決算書の設定 (17 §3.1)
// ---------------------------------------------------------------------------

type SettingsGroup = "notes" | "businessReport";
type Changes = Record<string, unknown>;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only the keys that changed, nested as stored (`{ notes: { depreciation: … } }`). */
function changedKeys(
  before: StatementSettings,
  after: StatementSettings,
): { before: Changes; after: Changes } | null {
  const was: Changes = {};
  const now: Changes = {};
  const scalars = [
    "issuedShares",
    "shareholdersMeetingOn",
    "announcementPublishedOn",
    "announcementUrl",
    "simplifiedTaxClass",
  ] as const;
  for (const key of scalars) {
    if (!same(before[key], after[key])) {
      was[key] = before[key];
      now[key] = after[key];
    }
  }
  for (const group of ["notes", "businessReport"] as const satisfies readonly SettingsGroup[]) {
    const from = before[group] as unknown as Record<string, unknown>;
    const to = after[group] as unknown as Record<string, unknown>;
    for (const key of Object.keys(to)) {
      if (same(from[key], to[key])) continue;
      ((was[group] ??= {}) as Changes)[key] = from[key];
      ((now[group] ??= {}) as Changes)[key] = to[key];
    }
  }
  return Object.keys(now).length === 0 ? null : { before: was, after: now };
}

function displayDate(date: string): string {
  return date.replaceAll("-", "/");
}

/**
 * Saves 決算書の設定 of a fiscal year (17 §3.1): validated with `statementSettingsSchema` (a missing
 * key keeps the stored value), checked against the year (株主総会 after the year end, 決算公告 on or
 * after the meeting), stored as JSON and written to the audit log (`statements.update`, entity
 * `fiscal_year`, only the changed keys). A closed year can be saved too: only words and dates change.
 * Saving a text unchanged still records it (the 雛形 is then the directors' own text).
 */
export async function saveStatementSettings(
  db: Db,
  fiscalYearId: string,
  input: StatementSettingsInput,
  options: WriteOptions,
): Promise<StatementSettings> {
  const patch = statementSettingsSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const year = await tx.fiscalYear.findUnique({ where: { id: fiscalYearId } });
    if (!year) throw new SettingsError("会計期間が見つかりません。画面を読み込み直してください");
    const stored =
      year.statementSettings === null ? null : normalizeStatementSettings(year.statementSettings);
    const base = stored ?? EMPTY_STATEMENT_SETTINGS;
    const pick = <T>(value: T | undefined, current: T): T =>
      value === undefined ? current : value;
    const next: StatementSettings = {
      issuedShares: pick(patch.issuedShares, base.issuedShares),
      shareholdersMeetingOn: pick(patch.shareholdersMeetingOn, base.shareholdersMeetingOn),
      announcementPublishedOn: pick(patch.announcementPublishedOn, base.announcementPublishedOn),
      announcementUrl: pick(patch.announcementUrl, base.announcementUrl),
      notes: {
        depreciation: pick(patch.notes?.depreciation, base.notes.depreciation),
        revenueRecognition: pick(patch.notes?.revenueRecognition, base.notes.revenueRecognition),
        otherSignificant: pick(patch.notes?.otherSignificant, base.notes.otherSignificant),
        accountingPolicyChanges: pick(
          patch.notes?.accountingPolicyChanges,
          base.notes.accountingPolicyChanges,
        ),
        presentationChanges: pick(patch.notes?.presentationChanges, base.notes.presentationChanges),
        errorCorrections: pick(patch.notes?.errorCorrections, base.notes.errorCorrections),
        otherNotes: pick(patch.notes?.otherNotes, base.notes.otherNotes),
      },
      businessReport: {
        progress: pick(patch.businessReport?.progress, base.businessReport.progress),
        issues: pick(patch.businessReport?.issues, base.businessReport.issues),
        otherMatters: pick(patch.businessReport?.otherMatters, base.businessReport.otherMatters),
      },
      simplifiedTaxClass: pick(patch.simplifiedTaxClass, base.simplifiedTaxClass),
    };

    const endDate = fromDbDate(year.endDate);
    if (next.shareholdersMeetingOn !== null && next.shareholdersMeetingOn <= endDate) {
      throw new SettingsError(
        `株主総会の日は期末日（${displayDate(endDate)}）より後の日にしてください`,
        { field: "shareholdersMeetingOn" },
      );
    }
    if (
      next.announcementPublishedOn !== null &&
      next.shareholdersMeetingOn !== null &&
      next.announcementPublishedOn < next.shareholdersMeetingOn
    ) {
      throw new SettingsError("決算公告の掲載日は株主総会の日以後にしてください", {
        field: "announcementPublishedOn",
      });
    }

    const changes = changedKeys(base, next);
    if (!changes) return next;
    await tx.fiscalYear.update({
      where: { id: year.id },
      data: { statementSettings: toAuditJson(next) },
    });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: STATEMENTS_UPDATE_ACTION,
      entity: "fiscal_year",
      entityId: year.id,
      before: changes.before,
      after: changes.after,
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// 決算のチェックリストの「書き出し」 (17 §10)
// ---------------------------------------------------------------------------

export interface StatementsExportStatus {
  /** The latest download of 計算書類 (PDF) for the year, or `null`. */
  financialStatementsAt: Date | null;
  /** The latest download of 財務諸表 CSV (e-Tax, zip or one statement) for the year, or `null`. */
  etaxCsvAt: Date | null;
  /** Both were downloaded: the checklist's 「書き出し」 is done. */
  done: boolean;
}

/** From the `export.download` rows of the year's 第 n 期 (`after.fiscalYearNo`). */
export async function loadStatementsExportStatus(
  db: Db,
  fiscalYearId: string,
): Promise<StatementsExportStatus> {
  const year = await db.fiscalYear.findUnique({
    where: { id: fiscalYearId },
    select: { no: true },
  });
  if (!year) throw new SettingsError("会計期間が見つかりません。画面を読み込み直してください");
  const latest = async (kind: StatementExportKind): Promise<Date | null> => {
    const row = await db.auditLog.findFirst({
      where: {
        action: EXPORT_AUDIT_ACTION,
        AND: [
          { after: { path: ["kind"], equals: kind } },
          { after: { path: ["fiscalYearNo"], equals: year.no } },
        ],
      },
      orderBy: { at: "desc" },
      select: { at: true },
    });
    return row?.at ?? null;
  };
  const financialStatementsAt = await latest("financial-statements");
  const etaxCsvAt = await latest("etax-csv");
  return {
    financialStatementsAt,
    etaxCsvAt,
    done: financialStatementsAt !== null && etaxCsvAt !== null,
  };
}
