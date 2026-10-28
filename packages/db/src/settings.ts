/**
 * Settings repository (10-settings-and-setup §4, §5): 事業所・会計期間・勘定科目・補助科目・税区分・
 * 口座・取引先・セグメント・タグ. Every write is validated with the schemas in `schemas.ts`, runs in
 * one transaction and appends to the audit log. Nothing is deleted: rows are deactivated instead.
 */
import {
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_KIND_LABELS,
  checkFiscalYearPeriod,
  dateParts,
  deriveFirstFiscalYear,
  deriveNextFiscalYear,
  fiscalYearEndMonthFromStartMonth,
  fiscalYearStartMonthFromEndMonth,
  isAccountGroupOf,
  isStandardSegmentCode,
  normalizeInvoiceRegistrationNumber,
  resolveTaxRule,
  WALLET_DEFAULT_ACCOUNT_CODES,
  WALLET_KIND_LABELS,
  type AccountGroup,
  type AccountingMethod,
  type AccountKind,
  type CalendarDate,
  type ConsumptionTaxMethod,
  type FiscalYearPeriod,
  type FiscalYearStatus,
  type Money,
  type PartnerKind,
  type TaxDirection,
  type TaxKind,
  type TaxRateRule,
  type WalletKind,
} from "@niho-finance/ledger";
import {
  ETAX_EDITIONS,
  editionForFiscalYear,
  normalizeEtaxCodeInput,
  validateEtaxCodeOverride,
  type EtaxEdition,
} from "@niho-finance/reports";
import type {
  Account,
  Company,
  MemoTag,
  Partner,
  Prisma,
  Segment,
  TaxRateRule as TaxRateRuleRow,
} from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, fromDbDateOrNull, todayInJapan, toDbDate } from "./dates";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import { loadCurrentFiscalYear } from "./queries";
import {
  accountCreateSchema,
  accountUpdateSchema,
  activeToggleSchema,
  companyInputSchema,
  firstFiscalYearSchema,
  fiscalYearUpdateSchema,
  memoTagCreateSchema,
  memoTagUpdateSchema,
  nextFiscalYearSchema,
  partnerCreateSchema,
  partnerUpdateSchema,
  segmentCreateSchema,
  segmentUpdateSchema,
  subAccountCreateSchema,
  subAccountUpdateSchema,
  taxRateRuleCreateSchema,
  taxRateRuleToggleSchema,
  walletCreateSchema,
  walletUpdateSchema,
  type AccountCreateInput,
  type AccountUpdateInput,
  type ActiveToggleInput,
  type CompanyInput,
  type FirstFiscalYearInput,
  type FiscalYearUpdateInput,
  type MemoTagCreateInput,
  type MemoTagUpdateInput,
  type NextFiscalYearInput,
  type PartnerCreateInput,
  type PartnerUpdateInput,
  type SegmentCreateInput,
  type SegmentUpdateInput,
  type SubAccountCreateInput,
  type SubAccountUpdateInput,
  type TaxRateRuleCreateInput,
  type TaxRateRuleToggleInput,
  type WalletCreateInput,
  type WalletUpdateInput,
} from "./schemas";
import { lockSettings, runInTransaction, type Tx } from "./transaction";

export interface WriteOptions {
  /** Recorded in the audit log (the signed-in user's email; `owner` until S8). */
  actor: string;
}

function hasChanges(row: object, patch: object): boolean {
  const current = row as Record<string, unknown>;
  return Object.entries(patch).some(([key, value]) => {
    const before = current[key];
    if (before instanceof Date && value instanceof Date)
      return before.getTime() !== value.getTime();
    return before !== value;
  });
}

async function audit(
  tx: Tx,
  options: WriteOptions,
  entry: { action: string; entity: string; entityId: string; before?: unknown; after?: unknown },
): Promise<void> {
  await appendAuditLog(tx, { actor: options.actor, ...entry });
}

/** Re-throws a unique violation (a concurrent duplicate) as an owner-facing error. */
function rethrowUnique(error: unknown, message: string, field: string): never {
  if (isUniqueViolation(error)) throw new SettingsError(message, { field });
  throw error;
}

// ---------------------------------------------------------------------------
// Company (事業所)
// ---------------------------------------------------------------------------

export interface CompanySettings {
  id: string;
  name: string;
  nameKana: string | null;
  representative: string | null;
  address: string | null;
  foundedOn: CalendarDate;
  /** 決算月 (stored as the first month of the fiscal year). */
  fiscalYearEndMonth: number;
  corporateNumber: string | null;
  invoiceRegistrationNumber: string | null;
  invoiceRegisteredOn: CalendarDate | null;
}

function toCompanySettings(row: Company): CompanySettings {
  return {
    id: row.id,
    name: row.name,
    nameKana: row.nameKana,
    representative: row.representative,
    address: row.address,
    foundedOn: fromDbDate(row.foundedOn),
    fiscalYearEndMonth: fiscalYearEndMonthFromStartMonth(row.fiscalYearStartMonth),
    corporateNumber: row.corporateNumber,
    invoiceRegistrationNumber: row.invoiceRegistrationNumber,
    invoiceRegisteredOn: fromDbDateOrNull(row.invoiceRegisteredOn),
  };
}

function companyData(input: CompanyInput) {
  const data = companyInputSchema.parse(input);
  return {
    name: data.name,
    nameKana: data.nameKana,
    representative: data.representative,
    address: data.address,
    foundedOn: toDbDate(data.foundedOn),
    fiscalYearStartMonth: fiscalYearStartMonthFromEndMonth(data.fiscalYearEndMonth),
    corporateNumber: data.corporateNumber,
    invoiceRegistrationNumber: data.invoiceRegistrationNumber,
    invoiceRegisteredOn: data.invoiceRegisteredOn ? toDbDate(data.invoiceRegisteredOn) : null,
  };
}

const NO_COMPANY = "事業所がまだ登録されていません。初期設定から登録してください";

export async function requireCompanyRow(db: Db): Promise<Company> {
  const company = await db.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (!company) throw new SettingsError(NO_COMPANY);
  return company;
}

export async function getCompany(db: Db): Promise<CompanySettings | null> {
  const company = await db.company.findFirst({ orderBy: { createdAt: "asc" } });
  return company ? toCompanySettings(company) : null;
}

/** Registers the company (Step 1 of the setup). There is only ever one. */
export async function createCompany(
  db: Db,
  input: CompanyInput,
  options: WriteOptions,
): Promise<CompanySettings> {
  const data = companyData(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    if ((await tx.company.count()) > 0) {
      throw new SettingsError("事業所はすでに登録しています。直すときは 設定 › 事業所 から");
    }
    const row = await tx.company.create({ data: { id: newId(), ...data } });
    await audit(tx, options, {
      action: "company.create",
      entity: "company",
      entityId: row.id,
      after: row,
    });
    return toCompanySettings(row);
  });
}

/**
 * Updates the company. The founding date and 決算月 are fixed once a fiscal year exists:
 * the periods were derived from them.
 */
export async function updateCompany(
  db: Db,
  input: CompanyInput,
  options: WriteOptions,
): Promise<CompanySettings> {
  const data = companyData(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "company");
    const current = await requireCompanyRow(tx);
    if ((await tx.fiscalYear.count()) > 0) {
      if (data.fiscalYearStartMonth !== current.fiscalYearStartMonth) {
        throw new SettingsError("決算月は会計期間を作った後は変えられません", {
          field: "fiscalYearEndMonth",
        });
      }
      if (data.foundedOn.getTime() !== current.foundedOn.getTime()) {
        throw new SettingsError("設立日は会計期間を作った後は変えられません", {
          field: "foundedOn",
        });
      }
    }
    if (!hasChanges(current, data)) return toCompanySettings(current);
    const row = await tx.company.update({ where: { id: current.id }, data });
    await audit(tx, options, {
      action: "company.update",
      entity: "company",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toCompanySettings(row);
  });
}

// ---------------------------------------------------------------------------
// Fiscal years (会計期間)
// ---------------------------------------------------------------------------

export interface FiscalYearSettings {
  id: string;
  no: number;
  startDate: CalendarDate;
  endDate: CalendarDate;
  status: FiscalYearStatus;
  consumptionTax: ConsumptionTaxMethod;
  accountingMethod: AccountingMethod;
  lockedThrough: CalendarDate | null;
  /** Journal entries in the year (changing the tax method of a year with entries is confirmed). */
  entryCount: number;
}

const fiscalYearInclude = { _count: { select: { journalEntries: true } } } as const;

type FiscalYearRow = Prisma.FiscalYearGetPayload<{ include: typeof fiscalYearInclude }>;

function toFiscalYearSettings(row: FiscalYearRow): FiscalYearSettings {
  return {
    id: row.id,
    no: row.no,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    status: row.status,
    consumptionTax: row.consumptionTax,
    accountingMethod: row.accountingMethod,
    lockedThrough: fromDbDateOrNull(row.lockedThrough),
    entryCount: row._count.journalEntries,
  };
}

export async function listFiscalYears(db: Db): Promise<FiscalYearSettings[]> {
  const rows = await db.fiscalYear.findMany({
    orderBy: { no: "asc" },
    include: fiscalYearInclude,
  });
  return rows.map(toFiscalYearSettings);
}

/** A fiscal year is at most a year and ends in the 決算月. */
function assertFiscalYearPeriod(period: FiscalYearPeriod, fiscalYearEndMonth: number): void {
  const check = checkFiscalYearPeriod(period);
  if (!check.ok) throw new SettingsError(check.message, { field: "endDate" });
  if (dateParts(period.endDate).month !== fiscalYearEndMonth) {
    throw new SettingsError(
      `終了日は決算月（${fiscalYearEndMonth} 月）の日付にしてください。決算月は 設定 › 事業所 で変えます`,
      { field: "endDate" },
    );
  }
}

/** The proposal of Step 2: from the founding date to the end of the next 決算月. */
export function proposeFirstFiscalYear(company: CompanySettings): FiscalYearPeriod {
  return deriveFirstFiscalYear(company.foundedOn, company.fiscalYearEndMonth);
}

/** Creates 第 1 期 from the founding date (Step 2 of the setup). Only the end date is chosen. */
export async function createFirstFiscalYear(
  db: Db,
  input: FirstFiscalYearInput,
  options: WriteOptions,
): Promise<FiscalYearSettings> {
  const data = firstFiscalYearSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "fiscalYears");
    const company = toCompanySettings(await requireCompanyRow(tx));
    if ((await tx.fiscalYear.count()) > 0) {
      throw new SettingsError("第 1 期はすでに作っています。設定 › 会計期間 で確かめてください");
    }
    const period = { startDate: company.foundedOn, endDate: data.endDate };
    assertFiscalYearPeriod(period, company.fiscalYearEndMonth);
    const row = await tx.fiscalYear.create({
      data: {
        id: newId(),
        companyId: company.id,
        no: 1,
        startDate: toDbDate(period.startDate),
        endDate: toDbDate(period.endDate),
        status: "open",
        consumptionTax: data.consumptionTax,
        accountingMethod: data.accountingMethod,
      },
      include: fiscalYearInclude,
    });
    await audit(tx, options, {
      action: "fiscal_year.create",
      entity: "fiscal_year",
      entityId: row.id,
      after: row,
    });
    return toFiscalYearSettings(row);
  });
}

/** The default of 「次の期を作る」: the day after the last year, 12 months long. */
export async function proposeNextFiscalYear(db: Db): Promise<FiscalYearPeriod | null> {
  const last = await db.fiscalYear.findFirst({ orderBy: { no: "desc" } });
  return last ? deriveNextFiscalYear(fromDbDate(last.endDate)) : null;
}

/** 「次の期を作る」: starts the day after the last fiscal year. Years are never deleted. */
export async function createNextFiscalYear(
  db: Db,
  input: NextFiscalYearInput,
  options: WriteOptions,
): Promise<FiscalYearSettings> {
  const data = nextFiscalYearSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "fiscalYears");
    const company = toCompanySettings(await requireCompanyRow(tx));
    const last = await tx.fiscalYear.findFirst({ orderBy: { no: "desc" } });
    if (!last) {
      throw new SettingsError("第 1 期がまだありません。初期設定から作ってください");
    }
    const derived = deriveNextFiscalYear(fromDbDate(last.endDate));
    const period = { startDate: derived.startDate, endDate: data.endDate ?? derived.endDate };
    assertFiscalYearPeriod(period, company.fiscalYearEndMonth);
    const row = await tx.fiscalYear.create({
      data: {
        id: newId(),
        companyId: company.id,
        no: last.no + 1,
        startDate: toDbDate(period.startDate),
        endDate: toDbDate(period.endDate),
        status: "open",
        consumptionTax: data.consumptionTax,
        accountingMethod: data.accountingMethod,
      },
      include: fiscalYearInclude,
    });
    await audit(tx, options, {
      action: "fiscal_year.create",
      entity: "fiscal_year",
      entityId: row.id,
      after: row,
    });
    return toFiscalYearSettings(row);
  });
}

/** Changes the consumption tax method and the accounting method of a year (not of a closed one). */
export async function updateFiscalYear(
  db: Db,
  input: FiscalYearUpdateInput,
  options: WriteOptions,
): Promise<FiscalYearSettings> {
  const data = fiscalYearUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.fiscalYear.findUnique({
      where: { id: data.id },
      include: fiscalYearInclude,
    });
    if (!current) throw new SettingsError("会計期間が見つかりません。画面を読み込み直してください");
    if (current.status === "closed") {
      throw new SettingsError(`第 ${current.no} 期は締め済みのため変えられません`);
    }
    const patch = { consumptionTax: data.consumptionTax, accountingMethod: data.accountingMethod };
    if (!hasChanges(current, patch)) return toFiscalYearSettings(current);
    const row = await tx.fiscalYear.update({
      where: { id: current.id },
      data: patch,
      include: fiscalYearInclude,
    });
    await audit(tx, options, {
      action: "fiscal_year.update",
      entity: "fiscal_year",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toFiscalYearSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Accounts and sub-accounts (勘定科目・補助科目)
// ---------------------------------------------------------------------------

export interface AccountSettings {
  id: string;
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
  defaultTaxCategoryCode: string | null;
  defaultSegmentId: string | null;
  isCashLike: boolean;
  isActive: boolean;
  note: string | null;
  subAccountCount: number;
  /** Names of the active wallets that post to the account. */
  walletNames: string[];
  /** 勘定科目コードの上書き (17-financial-statements §6.4); `null` = the standard code. */
  eTaxCode: string | null;
}

const accountInclude = {
  _count: { select: { subAccounts: true } },
  wallets: { select: { name: true, isActive: true }, orderBy: { name: "asc" } },
} as const;

type AccountRow = Prisma.AccountGetPayload<{ include: typeof accountInclude }>;

function toAccountSettings(row: AccountRow): AccountSettings {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    group: row.group,
    defaultTaxCategoryCode: row.defaultTaxCategoryCode,
    defaultSegmentId: row.defaultSegmentId,
    isCashLike: row.isCashLike,
    isActive: row.isActive,
    note: row.note,
    subAccountCount: row._count.subAccounts,
    walletNames: row.wallets.filter((wallet) => wallet.isActive).map((wallet) => wallet.name),
    eTaxCode: row.eTaxCode,
  };
}

export async function listAccounts(db: Db): Promise<AccountSettings[]> {
  const rows = await db.account.findMany({ orderBy: { code: "asc" }, include: accountInclude });
  return rows.map(toAccountSettings);
}

/** The account row itself for the audit log (without the counts and wallets read along). */
function accountSnapshot(row: AccountRow): Account {
  const { _count: _counts, wallets: _wallets, ...account } = row;
  return account;
}

/** Initial 既定の税区分 of a new account, in line with the chart template. */
function defaultTaxCategoryFor(kind: AccountKind): string {
  if (kind === "revenue") return "sales_10";
  if (kind === "expense") return "purchase_10";
  return "na";
}

async function assertTaxCategoryExists(tx: Tx, code: string, field: string): Promise<void> {
  const category = await tx.taxCategory.findUnique({ where: { code }, select: { id: true } });
  if (!category) {
    throw new SettingsError("税区分が見つかりません。税区分の一覧から選んでください", { field });
  }
}

export async function createAccount(
  db: Db,
  input: AccountCreateInput,
  options: WriteOptions,
): Promise<AccountSettings> {
  const data = accountCreateSchema.parse(input);
  const taken = `コード ${data.code} はすでに使っています。別のコードにしてください`;
  return runInTransaction(db, async (tx) => {
    const existing = await tx.account.findUnique({ where: { code: data.code } });
    if (existing) {
      throw new SettingsError(
        `コード ${data.code} は「${existing.name}」で使っています。別のコードにしてください`,
        { field: "code" },
      );
    }
    const taxCategoryCode = defaultTaxCategoryFor(data.kind);
    const hasTaxCategory = await tx.taxCategory.findUnique({
      where: { code: taxCategoryCode },
      select: { id: true },
    });
    const row = await tx.account
      .create({
        data: {
          id: newId(),
          code: data.code,
          name: data.name,
          kind: data.kind,
          group: data.group,
          defaultTaxCategoryCode: hasTaxCategory ? taxCategoryCode : null,
          sortOrder: Number(data.code),
        },
        include: accountInclude,
      })
      .catch((error: unknown) => rethrowUnique(error, taken, "code"));
    await audit(tx, options, {
      action: "account.create",
      entity: "account",
      entityId: row.id,
      after: accountSnapshot(row),
    });
    return toAccountSettings(row);
  });
}

/**
 * The e-Tax code table edition of today's fiscal year (17-financial-statements §6.1, §6.4): the year
 * containing today, the first before the books start, the latest after they end. Without any year,
 * the newest edition.
 */
export async function loadCurrentEtaxEdition(
  db: Db,
  today: CalendarDate = todayInJapan(),
): Promise<EtaxEdition> {
  const fiscalYear = await loadCurrentFiscalYear(db, today);
  if (fiscalYear) return editionForFiscalYear({ endDate: fiscalYear.endDate });
  const newest = ETAX_EDITIONS[ETAX_EDITIONS.length - 1];
  if (!newest) throw new Error("db: no e-Tax code table edition");
  return newest;
}

/**
 * Edits 名前・決算書の区分・既定の税区分・現預金・勘定科目コード (the code and the kind stay). A 勘定科目コード
 * is checked against the code table of today's fiscal year (17 §6.3, §6.4) and stored normalized
 * (half-width, upper case); empty puts the standard code back.
 */
export async function updateAccount(
  db: Db,
  input: AccountUpdateInput,
  options: WriteOptions,
): Promise<AccountSettings> {
  const data = accountUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.account.findUnique({
      where: { id: data.id },
      include: accountInclude,
    });
    if (!current) throw new SettingsError("勘定科目が見つかりません。画面を読み込み直してください");
    if (data.group !== undefined && !isAccountGroupOf(current.kind, data.group)) {
      throw new SettingsError(
        `${ACCOUNT_KIND_LABELS[current.kind]}の科目に「${ACCOUNT_GROUP_LABELS[data.group]}」は選べません`,
        { field: "group" },
      );
    }
    if (data.isCashLike === true && current.kind !== "asset") {
      throw new SettingsError("現預金にできるのは資産の科目だけです", { field: "isCashLike" });
    }
    if (data.defaultTaxCategoryCode) {
      await assertTaxCategoryExists(tx, data.defaultTaxCategoryCode, "defaultTaxCategoryCode");
    }
    const patch: Prisma.AccountUncheckedUpdateInput = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.group !== undefined) patch.group = data.group;
    if (data.defaultTaxCategoryCode !== undefined) {
      patch.defaultTaxCategoryCode = data.defaultTaxCategoryCode;
    }
    if (data.isCashLike !== undefined) patch.isCashLike = data.isCashLike;
    if (data.eTaxCode !== undefined) {
      const code = data.eTaxCode === null ? "" : normalizeEtaxCodeInput(data.eTaxCode);
      if (code !== "") {
        const edition = await loadCurrentEtaxEdition(tx);
        const reason = validateEtaxCodeOverride(
          { group: data.group ?? current.group },
          code,
          edition,
        );
        if (reason) throw new SettingsError(reason, { field: "eTaxCode" });
      }
      patch.eTaxCode = code === "" ? null : code;
    }
    if (!hasChanges(current, patch)) return toAccountSettings(current);
    const row = await tx.account.update({
      where: { id: current.id },
      data: patch,
      include: accountInclude,
    });
    await audit(tx, options, {
      action: "account.update",
      entity: "account",
      entityId: row.id,
      before: accountSnapshot(current),
      after: accountSnapshot(row),
    });
    return toAccountSettings(row);
  });
}

/** 無効にする / 有効にする. An account used by an active wallet stays active. */
export async function setAccountActive(
  db: Db,
  input: ActiveToggleInput,
  options: WriteOptions,
): Promise<AccountSettings> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.account.findUnique({
      where: { id: data.id },
      include: accountInclude,
    });
    if (!current) throw new SettingsError("勘定科目が見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toAccountSettings(current);
    const activeWallets = current.wallets.filter((wallet) => wallet.isActive);
    if (!data.isActive && activeWallets.length > 0) {
      const names = activeWallets.map((wallet) => `「${wallet.name}」`).join("");
      throw new SettingsError(
        `口座${names}がこの科目に紐づいています。先に 設定 › 口座 で口座を無効にしてください`,
      );
    }
    const row = await tx.account.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
      include: accountInclude,
    });
    await audit(tx, options, {
      action: data.isActive ? "account.activate" : "account.deactivate",
      entity: "account",
      entityId: row.id,
      before: accountSnapshot(current),
      after: accountSnapshot(row),
    });
    return toAccountSettings(row);
  });
}

export interface SubAccountSettings {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  /** The wallet the sub-account belongs to (named after it), when there is one. */
  walletName: string | null;
}

const subAccountInclude = {
  wallets: { select: { name: true, isActive: true }, take: 1 },
} as const;

type SubAccountRow = Prisma.SubAccountGetPayload<{ include: typeof subAccountInclude }>;

function toSubAccountSettings(row: SubAccountRow): SubAccountSettings {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    isActive: row.isActive,
    walletName: row.wallets[0]?.name ?? null,
  };
}

/** Sub-accounts of one account, or of all accounts when `accountId` is left out. */
export async function listSubAccounts(db: Db, accountId?: string): Promise<SubAccountSettings[]> {
  const rows = await db.subAccount.findMany({
    where: accountId ? { accountId } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: subAccountInclude,
  });
  return rows.map(toSubAccountSettings);
}

function sameNameMessage(accountName: string, name: string): string {
  return `「${accountName}」には同じ名前の補助科目「${name}」があります。別の名前にしてください`;
}

export async function createSubAccount(
  db: Db,
  input: SubAccountCreateInput,
  options: WriteOptions,
): Promise<SubAccountSettings> {
  const data = subAccountCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const account = await tx.account.findUnique({ where: { id: data.accountId } });
    if (!account) throw new SettingsError("勘定科目が見つかりません。画面を読み込み直してください");
    const duplicate = await tx.subAccount.findUnique({
      where: { accountId_name: { accountId: account.id, name: data.name } },
    });
    if (duplicate)
      throw new SettingsError(sameNameMessage(account.name, data.name), { field: "name" });
    const row = await tx.subAccount
      .create({
        data: { id: newId(), accountId: account.id, name: data.name },
        include: subAccountInclude,
      })
      .catch((error: unknown) =>
        rethrowUnique(error, sameNameMessage(account.name, data.name), "name"),
      );
    await audit(tx, options, {
      action: "sub_account.create",
      entity: "sub_account",
      entityId: row.id,
      after: row,
    });
    return toSubAccountSettings(row);
  });
}

/** Renames a sub-account. A wallet's sub-account follows the wallet's name instead. */
export async function updateSubAccount(
  db: Db,
  input: SubAccountUpdateInput,
  options: WriteOptions,
): Promise<SubAccountSettings> {
  const data = subAccountUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.subAccount.findUnique({
      where: { id: data.id },
      include: { ...subAccountInclude, account: true },
    });
    if (!current) throw new SettingsError("補助科目が見つかりません。画面を読み込み直してください");
    const wallet = current.wallets[0];
    if (wallet) {
      throw new SettingsError(
        `口座「${wallet.name}」の補助科目です。名前は 設定 › 口座 で口座の名前を変えると変わります`,
        { field: "name" },
      );
    }
    if (current.name === data.name) return toSubAccountSettings(current);
    const duplicate = await tx.subAccount.findUnique({
      where: { accountId_name: { accountId: current.accountId, name: data.name } },
    });
    if (duplicate) {
      throw new SettingsError(sameNameMessage(current.account.name, data.name), { field: "name" });
    }
    const row = await tx.subAccount.update({
      where: { id: current.id },
      data: { name: data.name },
      include: subAccountInclude,
    });
    await audit(tx, options, {
      action: "sub_account.update",
      entity: "sub_account",
      entityId: row.id,
      before: { id: current.id, accountId: current.accountId, name: current.name },
      after: { id: row.id, accountId: row.accountId, name: row.name },
    });
    return toSubAccountSettings(row);
  });
}

export async function setSubAccountActive(
  db: Db,
  input: ActiveToggleInput,
  options: WriteOptions,
): Promise<SubAccountSettings> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.subAccount.findUnique({
      where: { id: data.id },
      include: subAccountInclude,
    });
    if (!current) throw new SettingsError("補助科目が見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toSubAccountSettings(current);
    const wallet = current.wallets[0];
    if (wallet?.isActive) {
      throw new SettingsError(
        `口座「${wallet.name}」の補助科目です。口座を無効にすると一緒に無効になります（設定 › 口座）`,
      );
    }
    const row = await tx.subAccount.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
      include: subAccountInclude,
    });
    await audit(tx, options, {
      action: data.isActive ? "sub_account.activate" : "sub_account.deactivate",
      entity: "sub_account",
      entityId: row.id,
      before: { isActive: current.isActive },
      after: { isActive: row.isActive },
    });
    return toSubAccountSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Tax categories and rate rules (税区分・税率規則)
// ---------------------------------------------------------------------------

export interface TaxRateRuleSettings {
  id: string;
  taxCategoryCode: string;
  effectiveFrom: CalendarDate;
  effectiveTo: CalendarDate | null;
  ratePercent: number;
  deductiblePercent: number | null;
  enabled: boolean;
  note: string | null;
}

export interface TaxCategorySettings {
  id: string;
  code: string;
  name: string;
  direction: TaxDirection;
  kind: TaxKind;
  isActive: boolean;
  rules: TaxRateRuleSettings[];
  /** The rule in force on the day asked for (`null` when none is). */
  current: TaxRateRuleSettings | null;
}

function toTaxRateRuleSettings(row: TaxRateRuleRow): TaxRateRuleSettings {
  return {
    id: row.id,
    taxCategoryCode: row.taxCategoryCode,
    effectiveFrom: fromDbDate(row.effectiveFrom),
    effectiveTo: fromDbDateOrNull(row.effectiveTo),
    ratePercent: row.ratePercent,
    deductiblePercent: row.deductiblePercent,
    enabled: row.enabled,
    note: row.note,
  };
}

function toLedgerRule(rule: TaxRateRuleSettings): TaxRateRule {
  return {
    taxCategoryCode: rule.taxCategoryCode,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    ratePercent: rule.ratePercent,
    deductiblePercent: rule.deductiblePercent,
    enabled: rule.enabled,
  };
}

/** Tax categories with their rules; `current` is resolved on `on` (e.g. today in JST). */
export async function listTaxCategories(
  db: Db,
  options: { on: CalendarDate },
): Promise<TaxCategorySettings[]> {
  const rows = await db.taxCategory.findMany({
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: { rules: { orderBy: [{ effectiveFrom: "asc" }, { ratePercent: "desc" }] } },
  });
  return rows.map((row) => {
    const rules = row.rules.map(toTaxRateRuleSettings);
    const ledgerRules = rules.map(toLedgerRule);
    let current: TaxRateRuleSettings | null = null;
    try {
      const resolved = resolveTaxRule(row.code, options.on, ledgerRules);
      current = resolved ? (rules[ledgerRules.indexOf(resolved)] ?? null) : null;
    } catch {
      // Two enabled rules for the same period: shown as no current rate until one is disabled.
      current = null;
    }
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      direction: row.direction,
      kind: row.kind,
      isActive: row.isActive,
      rules,
      current,
    };
  });
}

/** Another enabled rule with the same period makes the rate ambiguous (`resolveTaxRule`). */
async function findSamePeriodRule(
  tx: Tx,
  rule: { id?: string; taxCategoryCode: string; effectiveFrom: Date; effectiveTo: Date | null },
) {
  return tx.taxRateRule.findFirst({
    where: {
      taxCategoryCode: rule.taxCategoryCode,
      enabled: true,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      ...(rule.id ? { id: { not: rule.id } } : {}),
    },
  });
}

const SAME_PERIOD =
  "同じ適用期間の有効な規則があります。先にその規則を無効にしてから追加・有効にしてください";

/**
 * Adds a rate rule. Existing rules are never edited: a mistake is corrected by a new rule
 * (a later start wins) and disabling the old one.
 */
export async function createTaxRateRule(
  db: Db,
  input: TaxRateRuleCreateInput,
  options: WriteOptions,
): Promise<TaxRateRuleSettings> {
  const data = taxRateRuleCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const category = await tx.taxCategory.findUnique({ where: { code: data.taxCategoryCode } });
    if (!category) throw new SettingsError("税区分が見つかりません。画面を読み込み直してください");
    const isTaxablePurchase = category.direction === "purchase" && category.kind === "taxable";
    if (isTaxablePurchase && data.deductiblePercent === null) {
      throw new SettingsError("課税仕入の税区分には控除割合を入力してください", {
        field: "deductiblePercent",
      });
    }
    if (!isTaxablePurchase && data.deductiblePercent !== null) {
      throw new SettingsError("控除割合は課税仕入の税区分にだけ入力します", {
        field: "deductiblePercent",
      });
    }
    if (category.kind !== "taxable" && data.ratePercent !== 0) {
      throw new SettingsError("課税以外の税区分の税率は 0% です", { field: "ratePercent" });
    }
    const effectiveFrom = toDbDate(data.effectiveFrom);
    const effectiveTo = data.effectiveTo === null ? null : toDbDate(data.effectiveTo);
    const duplicate = await tx.taxRateRule.findUnique({
      where: {
        taxCategoryCode_effectiveFrom_ratePercent: {
          taxCategoryCode: category.code,
          effectiveFrom,
          ratePercent: data.ratePercent,
        },
      },
    });
    const sameStart =
      "同じ開始日・税率の規則がすでにあります（無効の規則も含みます）。一覧で確かめてください";
    if (duplicate) throw new SettingsError(sameStart, { field: "effectiveFrom" });
    if (
      await findSamePeriodRule(tx, { taxCategoryCode: category.code, effectiveFrom, effectiveTo })
    ) {
      throw new SettingsError(SAME_PERIOD, { field: "effectiveFrom" });
    }
    const row = await tx.taxRateRule
      .create({
        data: {
          id: newId(),
          taxCategoryCode: category.code,
          effectiveFrom,
          effectiveTo,
          ratePercent: data.ratePercent,
          deductiblePercent: data.deductiblePercent,
          enabled: true,
          note: data.note,
        },
      })
      .catch((error: unknown) => rethrowUnique(error, sameStart, "effectiveFrom"));
    await audit(tx, options, {
      action: "tax_rate_rule.create",
      entity: "tax_rate_rule",
      entityId: row.id,
      after: row,
    });
    return toTaxRateRuleSettings(row);
  });
}

/** Enables or disables a rule (the only change allowed on an existing rule). */
export async function setTaxRateRuleEnabled(
  db: Db,
  input: TaxRateRuleToggleInput,
  options: WriteOptions,
): Promise<TaxRateRuleSettings> {
  const data = taxRateRuleToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.taxRateRule.findUnique({ where: { id: data.id } });
    if (!current) throw new SettingsError("税率規則が見つかりません。画面を読み込み直してください");
    if (current.enabled === data.enabled) return toTaxRateRuleSettings(current);
    if (data.enabled && (await findSamePeriodRule(tx, current))) {
      throw new SettingsError(SAME_PERIOD);
    }
    const row = await tx.taxRateRule.update({
      where: { id: current.id },
      data: { enabled: data.enabled },
    });
    await audit(tx, options, {
      action: data.enabled ? "tax_rate_rule.enable" : "tax_rate_rule.disable",
      entity: "tax_rate_rule",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toTaxRateRuleSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Wallets (口座)
// ---------------------------------------------------------------------------

export interface WalletSettings {
  id: string;
  name: string;
  kind: WalletKind;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountIsCashLike: boolean;
  subAccountId: string | null;
  subAccountName: string | null;
  defaultSegmentId: string | null;
  defaultSegmentName: string | null;
  importer: string | null;
  openingBalanceDate: CalendarDate | null;
  openingBalance: Money | null;
  note: string | null;
  isActive: boolean;
}

const walletInclude = {
  account: { select: { code: true, name: true, isCashLike: true } },
  subAccount: { select: { name: true } },
  defaultSegment: { select: { name: true } },
} as const;

type WalletRow = Prisma.WalletGetPayload<{ include: typeof walletInclude }>;

function toWalletSettings(row: WalletRow): WalletSettings {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    accountId: row.accountId,
    accountCode: row.account.code,
    accountName: row.account.name,
    accountIsCashLike: row.account.isCashLike,
    subAccountId: row.subAccountId,
    subAccountName: row.subAccount?.name ?? null,
    defaultSegmentId: row.defaultSegmentId,
    defaultSegmentName: row.defaultSegment?.name ?? null,
    importer: row.importer,
    openingBalanceDate: fromDbDateOrNull(row.openingBalanceDate),
    openingBalance: row.openingBalance,
    note: row.note,
    isActive: row.isActive,
  };
}

/** The wallet as audited: never the bank API's tokens or account ID (19-bank-api §2.3). */
function walletSnapshot(row: WalletRow) {
  const {
    account: _account,
    subAccount: _subAccount,
    defaultSegment: _segment,
    bankApiTokens: _tokens,
    bankApiAccountId: _bankAccountId,
    ...wallet
  } = row;
  return wallet;
}

export async function listWallets(db: Db): Promise<WalletSettings[]> {
  const rows = await db.wallet.findMany({ orderBy: { id: "asc" }, include: walletInclude });
  return rows.map(toWalletSettings);
}

/** The account a wallet posts to: the one chosen, or the default of its kind (bank → 1100, …). */
async function resolveWalletAccount(
  tx: Tx,
  kind: WalletKind,
  accountId: string | null | undefined,
): Promise<Account> {
  let account: Account | null;
  if (accountId) {
    account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new SettingsError("紐づく科目が見つかりません。一覧から選んでください", {
        field: "accountId",
      });
    }
  } else {
    const code = WALLET_DEFAULT_ACCOUNT_CODES[kind];
    if (!code) {
      throw new SettingsError(
        `種類が「${WALLET_KIND_LABELS[kind]}」の口座は紐づく科目を選んでください`,
        {
          field: "accountId",
        },
      );
    }
    account = await tx.account.findUnique({ where: { code } });
    if (!account) {
      throw new SettingsError(
        `勘定科目 ${code} がありません。先に勘定科目を作ってください（初期設定の 3 勘定科目）`,
        { field: "accountId" },
      );
    }
  }
  if (account.kind !== "asset" && account.kind !== "liability") {
    throw new SettingsError("口座に紐づけられるのは資産か負債の科目です", { field: "accountId" });
  }
  if (!account.isActive) {
    throw new SettingsError(`勘定科目「${account.name}」は無効です。有効な科目を選んでください`, {
      field: "accountId",
    });
  }
  return account;
}

async function assertSegmentExists(tx: Tx, segmentId: string, field: string): Promise<void> {
  const segment = await tx.segment.findUnique({ where: { id: segmentId }, select: { id: true } });
  if (!segment) {
    throw new SettingsError("セグメントが見つかりません。一覧から選んでください", { field });
  }
}

async function assertSubAccountNameFree(
  tx: Tx,
  account: Account,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const duplicate = await tx.subAccount.findUnique({
    where: { accountId_name: { accountId: account.id, name } },
  });
  if (duplicate && duplicate.id !== exceptId) {
    throw new SettingsError(
      `「${account.name}」には同じ名前の補助科目「${name}」があります。口座の名前を変えてください`,
      { field: "name" },
    );
  }
}

async function createWalletInTransaction(
  tx: Tx,
  input: WalletCreateInput,
  options: WriteOptions,
): Promise<WalletSettings> {
  const data = walletCreateSchema.parse(input);
  const account = await resolveWalletAccount(tx, data.kind, data.accountId);
  if (data.defaultSegmentId)
    await assertSegmentExists(tx, data.defaultSegmentId, "defaultSegmentId");
  await assertSubAccountNameFree(tx, account, data.name, null);
  const openingBalance = data.openingBalance ?? null;
  const openingBalanceDate =
    openingBalance === null
      ? null
      : data.openingBalanceDate
        ? toDbDate(data.openingBalanceDate)
        : (await requireCompanyRow(tx)).foundedOn;

  const subAccount = await tx.subAccount.create({
    data: { id: newId(), accountId: account.id, name: data.name },
  });
  await audit(tx, options, {
    action: "sub_account.create",
    entity: "sub_account",
    entityId: subAccount.id,
    after: subAccount,
  });
  const row = await tx.wallet.create({
    data: {
      id: newId(),
      name: data.name,
      kind: data.kind,
      accountId: account.id,
      subAccountId: subAccount.id,
      defaultSegmentId: data.defaultSegmentId ?? null,
      openingBalanceDate,
      openingBalance,
      note: data.note ?? null,
    },
    include: walletInclude,
  });
  await audit(tx, options, {
    action: "wallet.create",
    entity: "wallet",
    entityId: row.id,
    after: walletSnapshot(row),
  });
  return toWalletSettings(row);
}

/** Adds a wallet: the account comes from the kind unless chosen, the sub-account is named after it. */
export async function createWallet(
  db: Db,
  input: WalletCreateInput,
  options: WriteOptions,
): Promise<WalletSettings> {
  return runInTransaction(db, (tx) => createWalletInTransaction(tx, input, options));
}

/** Adds several wallets in one transaction (Step 4). Errors name the row: `wallets.<n>.<field>`. */
export async function createWallets(
  db: Db,
  inputs: readonly WalletCreateInput[],
  options: WriteOptions,
): Promise<WalletSettings[]> {
  return runInTransaction(db, async (tx) => {
    const created: WalletSettings[] = [];
    const names = new Set<string>();
    for (const [index, input] of inputs.entries()) {
      try {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (name && names.has(name)) {
          throw new SettingsError("同じ名前の口座が 2 つあります。名前を変えてください", {
            field: "name",
          });
        }
        names.add(name);
        created.push(await createWalletInTransaction(tx, input, options));
      } catch (error) {
        if (error instanceof SettingsError) {
          throw new SettingsError(error.message, {
            field: `wallets.${index}${error.field ? `.${error.field}` : ""}`,
          });
        }
        throw error;
      }
    }
    return created;
  });
}

/**
 * Edits a wallet. Renaming renames its sub-account; changing the account moves the sub-account,
 * which is refused once journal lines use it (the history would change account).
 */
export async function updateWallet(
  db: Db,
  input: WalletUpdateInput,
  options: WriteOptions,
): Promise<WalletSettings> {
  const data = walletUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.wallet.findUnique({ where: { id: data.id }, include: walletInclude });
    if (!current) throw new SettingsError("口座が見つかりません。画面を読み込み直してください");
    const kind = data.kind ?? current.kind;
    const name = data.name ?? current.name;
    let account = await tx.account.findUniqueOrThrow({ where: { id: current.accountId } });
    if (data.accountId !== undefined) {
      account = await resolveWalletAccount(tx, kind, data.accountId);
    }
    const accountChanged = account.id !== current.accountId;
    if (accountChanged && current.subAccountId) {
      const used = await tx.journalLine.count({ where: { subAccountId: current.subAccountId } });
      if (used > 0) {
        throw new SettingsError("この口座には仕訳があるため、紐づく科目は変えられません", {
          field: "accountId",
        });
      }
    }
    if (data.defaultSegmentId)
      await assertSegmentExists(tx, data.defaultSegmentId, "defaultSegmentId");

    let subAccountId = current.subAccountId;
    if (accountChanged || name !== current.name || !subAccountId) {
      await assertSubAccountNameFree(tx, account, name, subAccountId);
      if (subAccountId) {
        const before = await tx.subAccount.findUniqueOrThrow({ where: { id: subAccountId } });
        const after = await tx.subAccount.update({
          where: { id: subAccountId },
          data: { accountId: account.id, name },
        });
        await audit(tx, options, {
          action: "sub_account.update",
          entity: "sub_account",
          entityId: after.id,
          before,
          after,
        });
      } else {
        const created = await tx.subAccount.create({
          data: { id: newId(), accountId: account.id, name },
        });
        subAccountId = created.id;
        await audit(tx, options, {
          action: "sub_account.create",
          entity: "sub_account",
          entityId: created.id,
          after: created,
        });
      }
    }

    const openingBalance =
      data.openingBalance !== undefined ? data.openingBalance : current.openingBalance;
    let openingBalanceDate: Date | null = null;
    if (openingBalance !== null) {
      if (data.openingBalanceDate) openingBalanceDate = toDbDate(data.openingBalanceDate);
      else if (data.openingBalanceDate === undefined && current.openingBalanceDate) {
        openingBalanceDate = current.openingBalanceDate;
      } else openingBalanceDate = (await requireCompanyRow(tx)).foundedOn;
    }

    const patch: Prisma.WalletUncheckedUpdateInput = {
      name,
      kind,
      accountId: account.id,
      subAccountId,
      openingBalance,
      openingBalanceDate,
    };
    if (data.defaultSegmentId !== undefined) patch.defaultSegmentId = data.defaultSegmentId;
    if (data.note !== undefined) patch.note = data.note;
    if (!hasChanges(current, patch)) return toWalletSettings(current);
    const row = await tx.wallet.update({
      where: { id: current.id },
      data: patch,
      include: walletInclude,
    });
    await audit(tx, options, {
      action: "wallet.update",
      entity: "wallet",
      entityId: row.id,
      before: walletSnapshot(current),
      after: walletSnapshot(row),
    });
    return toWalletSettings(row);
  });
}

/** 無効にする / 有効にする. The wallet's sub-account follows. */
export async function setWalletActive(
  db: Db,
  input: ActiveToggleInput,
  options: WriteOptions,
): Promise<WalletSettings> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.wallet.findUnique({ where: { id: data.id }, include: walletInclude });
    if (!current) throw new SettingsError("口座が見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toWalletSettings(current);
    if (data.isActive) {
      const account = await tx.account.findUniqueOrThrow({ where: { id: current.accountId } });
      if (!account.isActive) {
        throw new SettingsError(
          `勘定科目「${account.name}」が無効です。先に 設定 › 勘定科目 で有効にしてください`,
        );
      }
    }
    if (current.subAccountId) {
      await tx.subAccount.update({
        where: { id: current.subAccountId },
        data: { isActive: data.isActive },
      });
    }
    const row = await tx.wallet.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
      include: walletInclude,
    });
    await audit(tx, options, {
      action: data.isActive ? "wallet.activate" : "wallet.deactivate",
      entity: "wallet",
      entityId: row.id,
      before: walletSnapshot(current),
      after: walletSnapshot(row),
    });
    return toWalletSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Partners (取引先)
// ---------------------------------------------------------------------------

export interface PartnerSettings {
  id: string;
  name: string;
  nameKana: string | null;
  kind: PartnerKind;
  invoiceRegistrationNumber: string | null;
  defaultAccountId: string | null;
  defaultSegmentId: string | null;
  defaultTaxCategoryCode: string | null;
  isActive: boolean;
}

function toPartnerSettings(row: Partner): PartnerSettings {
  return {
    id: row.id,
    name: row.name,
    nameKana: row.nameKana,
    kind: row.kind,
    invoiceRegistrationNumber: row.invoiceRegistrationNumber,
    defaultAccountId: row.defaultAccountId,
    defaultSegmentId: row.defaultSegmentId,
    defaultTaxCategoryCode: row.defaultTaxCategoryCode,
    isActive: row.isActive,
  };
}

/** Partners, optionally filtered by name, kana or registration number (case-insensitive). */
export async function listPartners(
  db: Db,
  options: { query?: string | null } = {},
): Promise<PartnerSettings[]> {
  const query = options.query?.trim() ?? "";
  const number = normalizeInvoiceRegistrationNumber(query);
  const rows = await db.partner.findMany({
    where: query
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { nameKana: { contains: query, mode: "insensitive" } },
            { invoiceRegistrationNumber: { contains: number || query, mode: "insensitive" } },
          ],
        }
      : {},
    orderBy: [{ nameKana: { sort: "asc", nulls: "last" } }, { name: "asc" }],
  });
  return rows.map(toPartnerSettings);
}

/** One partner (取引先の詳細, 14-reports §15.5); `null` for an unknown id. */
export async function getPartner(db: Db, id: string): Promise<PartnerSettings | null> {
  const row = await db.partner.findUnique({ where: { id } });
  return row ? toPartnerSettings(row) : null;
}

async function assertPartnerReferences(
  tx: Tx,
  data: {
    defaultAccountId?: string | null | undefined;
    defaultSegmentId?: string | null | undefined;
    defaultTaxCategoryCode?: string | null | undefined;
  },
): Promise<void> {
  if (data.defaultAccountId) {
    const account = await tx.account.findUnique({ where: { id: data.defaultAccountId } });
    if (!account) {
      throw new SettingsError("既定の科目が見つかりません。一覧から選んでください", {
        field: "defaultAccountId",
      });
    }
  }
  if (data.defaultSegmentId)
    await assertSegmentExists(tx, data.defaultSegmentId, "defaultSegmentId");
  if (data.defaultTaxCategoryCode) {
    await assertTaxCategoryExists(tx, data.defaultTaxCategoryCode, "defaultTaxCategoryCode");
  }
}

export async function createPartner(
  db: Db,
  input: PartnerCreateInput,
  options: WriteOptions,
): Promise<PartnerSettings> {
  const data = partnerCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await assertPartnerReferences(tx, data);
    const row = await tx.partner.create({
      data: {
        id: newId(),
        name: data.name,
        nameKana: data.nameKana ?? null,
        kind: data.kind,
        invoiceRegistrationNumber: data.invoiceRegistrationNumber ?? null,
        defaultAccountId: data.defaultAccountId ?? null,
        defaultSegmentId: data.defaultSegmentId ?? null,
        defaultTaxCategoryCode: data.defaultTaxCategoryCode ?? null,
      },
    });
    await audit(tx, options, {
      action: "partner.create",
      entity: "partner",
      entityId: row.id,
      after: row,
    });
    return toPartnerSettings(row);
  });
}

export async function updatePartner(
  db: Db,
  input: PartnerUpdateInput,
  options: WriteOptions,
): Promise<PartnerSettings> {
  const data = partnerUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.partner.findUnique({ where: { id: data.id } });
    if (!current) throw new SettingsError("取引先が見つかりません。画面を読み込み直してください");
    await assertPartnerReferences(tx, data);
    const { id: _id, ...fields } = data;
    const patch: Prisma.PartnerUncheckedUpdateInput = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
    }
    if (
      data.invoiceRegistrationNumber !== undefined &&
      data.invoiceRegistrationNumber !== current.invoiceRegistrationNumber
    ) {
      // A changed number has not been looked up at the National Tax Agency yet (v2).
      patch.invoiceRegistrationStatus = "unknown";
      patch.invoiceRegistrationCheckedAt = null;
    }
    if (!hasChanges(current, patch)) return toPartnerSettings(current);
    const row = await tx.partner.update({ where: { id: current.id }, data: patch });
    await audit(tx, options, {
      action: "partner.update",
      entity: "partner",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toPartnerSettings(row);
  });
}

export async function setPartnerActive(
  db: Db,
  input: ActiveToggleInput,
  options: WriteOptions,
): Promise<PartnerSettings> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.partner.findUnique({ where: { id: data.id } });
    if (!current) throw new SettingsError("取引先が見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toPartnerSettings(current);
    const row = await tx.partner.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
    });
    await audit(tx, options, {
      action: data.isActive ? "partner.activate" : "partner.deactivate",
      entity: "partner",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toPartnerSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Segments (セグメント)
// ---------------------------------------------------------------------------

export interface SegmentSettings {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /** One of the 4 standard segments: cannot be deactivated or recoded. */
  isStandard: boolean;
}

function toSegmentSettings(row: Segment): SegmentSettings {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    isStandard: isStandardSegmentCode(row.code),
  };
}

export async function listSegments(db: Db): Promise<SegmentSettings[]> {
  const rows = await db.segment.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
  return rows.map(toSegmentSettings);
}

function codeTaken(code: string): string {
  return `コード「${code}」はすでに使っています。別のコードにしてください`;
}

export async function createSegment(
  db: Db,
  input: SegmentCreateInput,
  options: WriteOptions,
): Promise<SegmentSettings> {
  const data = segmentCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    if (await tx.segment.findUnique({ where: { code: data.code } })) {
      throw new SettingsError(codeTaken(data.code), { field: "code" });
    }
    // New segments go before 共通 (sort order 90), after the others.
    const last = await tx.segment.findFirst({
      where: { sortOrder: { lt: 90 } },
      orderBy: { sortOrder: "desc" },
    });
    const sortOrder = Math.min(89, (last?.sortOrder ?? 0) + 10);
    const row = await tx.segment
      .create({ data: { id: newId(), code: data.code, name: data.name, sortOrder } })
      .catch((error: unknown) => rethrowUnique(error, codeTaken(data.code), "code"));
    await audit(tx, options, {
      action: "segment.create",
      entity: "segment",
      entityId: row.id,
      after: row,
    });
    return toSegmentSettings(row);
  });
}

export async function updateSegment(
  db: Db,
  input: SegmentUpdateInput,
  options: WriteOptions,
): Promise<SegmentSettings> {
  const data = segmentUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.segment.findUnique({ where: { id: data.id } });
    if (!current)
      throw new SettingsError("セグメントが見つかりません。画面を読み込み直してください");
    if (data.code !== undefined && data.code !== current.code) {
      if (isStandardSegmentCode(current.code)) {
        throw new SettingsError("標準のセグメントのコードは変えられません。名前は変えられます", {
          field: "code",
        });
      }
      if (await tx.segment.findUnique({ where: { code: data.code } })) {
        throw new SettingsError(codeTaken(data.code), { field: "code" });
      }
    }
    const patch: Prisma.SegmentUpdateInput = {};
    if (data.code !== undefined) patch.code = data.code;
    if (data.name !== undefined) patch.name = data.name;
    if (!hasChanges(current, patch)) return toSegmentSettings(current);
    const row = await tx.segment
      .update({ where: { id: current.id }, data: patch })
      .catch((error: unknown) => rethrowUnique(error, codeTaken(data.code ?? ""), "code"));
    await audit(tx, options, {
      action: "segment.update",
      entity: "segment",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toSegmentSettings(row);
  });
}

export async function setSegmentActive(
  db: Db,
  input: ActiveToggleInput,
  options: WriteOptions,
): Promise<SegmentSettings> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.segment.findUnique({ where: { id: data.id } });
    if (!current)
      throw new SettingsError("セグメントが見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toSegmentSettings(current);
    if (!data.isActive && isStandardSegmentCode(current.code)) {
      throw new SettingsError("標準のセグメントは無効にできません");
    }
    const row = await tx.segment.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
    });
    await audit(tx, options, {
      action: data.isActive ? "segment.activate" : "segment.deactivate",
      entity: "segment",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toSegmentSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Memo tags (タグ)
// ---------------------------------------------------------------------------

export interface MemoTagSettings {
  id: string;
  name: string;
  isActive: boolean;
}

function toMemoTagSettings(row: MemoTag): MemoTagSettings {
  return { id: row.id, name: row.name, isActive: row.isActive };
}

export async function listMemoTags(db: Db): Promise<MemoTagSettings[]> {
  const rows = await db.memoTag.findMany({ orderBy: { name: "asc" } });
  return rows.map(toMemoTagSettings);
}

function tagTaken(name: string): string {
  return `タグ「${name}」はすでにあります`;
}

export async function createMemoTag(
  db: Db,
  input: MemoTagCreateInput,
  options: WriteOptions,
): Promise<MemoTagSettings> {
  const data = memoTagCreateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    if (await tx.memoTag.findUnique({ where: { name: data.name } })) {
      throw new SettingsError(tagTaken(data.name), { field: "name" });
    }
    const row = await tx.memoTag
      .create({ data: { id: newId(), name: data.name } })
      .catch((error: unknown) => rethrowUnique(error, tagTaken(data.name), "name"));
    await audit(tx, options, {
      action: "memo_tag.create",
      entity: "memo_tag",
      entityId: row.id,
      after: row,
    });
    return toMemoTagSettings(row);
  });
}

export async function updateMemoTag(
  db: Db,
  input: MemoTagUpdateInput,
  options: WriteOptions,
): Promise<MemoTagSettings> {
  const data = memoTagUpdateSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.memoTag.findUnique({ where: { id: data.id } });
    if (!current) throw new SettingsError("タグが見つかりません。画面を読み込み直してください");
    if (current.name === data.name) return toMemoTagSettings(current);
    if (await tx.memoTag.findUnique({ where: { name: data.name } })) {
      throw new SettingsError(tagTaken(data.name), { field: "name" });
    }
    const row = await tx.memoTag
      .update({ where: { id: current.id }, data: { name: data.name } })
      .catch((error: unknown) => rethrowUnique(error, tagTaken(data.name), "name"));
    await audit(tx, options, {
      action: "memo_tag.update",
      entity: "memo_tag",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toMemoTagSettings(row);
  });
}

export async function setMemoTagActive(
  db: Db,
  input: ActiveToggleInput,
  options: WriteOptions,
): Promise<MemoTagSettings> {
  const data = activeToggleSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    const current = await tx.memoTag.findUnique({ where: { id: data.id } });
    if (!current) throw new SettingsError("タグが見つかりません。画面を読み込み直してください");
    if (current.isActive === data.isActive) return toMemoTagSettings(current);
    const row = await tx.memoTag.update({
      where: { id: current.id },
      data: { isActive: data.isActive },
    });
    await audit(tx, options, {
      action: data.isActive ? "memo_tag.activate" : "memo_tag.deactivate",
      entity: "memo_tag",
      entityId: row.id,
      before: current,
      after: row,
    });
    return toMemoTagSettings(row);
  });
}

// ---------------------------------------------------------------------------
// Index of the settings (設定の索引) and options for selects
// ---------------------------------------------------------------------------

export interface SettingsSummary {
  companyName: string | null;
  fiscalYear: {
    no: number;
    startDate: CalendarDate;
    endDate: CalendarDate;
    consumptionTax: ConsumptionTaxMethod;
  } | null;
  /** Active rows of each section. */
  counts: {
    accounts: number;
    taxCategories: number;
    wallets: number;
    partners: number;
    segments: number;
    memoTags: number;
  };
}

export async function getSettingsSummary(
  db: Db,
  options: { today: CalendarDate },
): Promise<SettingsSummary> {
  const company = await db.company.findFirst({ orderBy: { createdAt: "asc" } });
  const fiscalYear = await loadCurrentFiscalYear(db, options.today);
  const active = { where: { isActive: true } };
  return {
    companyName: company?.name ?? null,
    fiscalYear: fiscalYear
      ? {
          no: fiscalYear.no,
          startDate: fiscalYear.startDate,
          endDate: fiscalYear.endDate,
          consumptionTax: fiscalYear.consumptionTax,
        }
      : null,
    counts: {
      accounts: await db.account.count(active),
      taxCategories: await db.taxCategory.count(active),
      wallets: await db.wallet.count(active),
      partners: await db.partner.count(active),
      segments: await db.segment.count(active),
      memoTags: await db.memoTag.count(active),
    },
  };
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Active tax categories for selects, in the order of the return (optionally one direction). */
export async function listTaxCategoryOptions(
  db: Db,
  options: { directions?: readonly TaxDirection[] } = {},
): Promise<SelectOption[]> {
  const rows = await db.taxCategory.findMany({
    where: {
      isActive: true,
      ...(options.directions ? { direction: { in: [...options.directions] } } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { code: true, name: true },
  });
  return rows.map((row) => ({ value: row.code, label: row.name }));
}

/** Active accounts for selects (`1100 普通預金`). */
export async function listAccountOptions(
  db: Db,
  options: { kinds?: readonly AccountKind[] } = {},
): Promise<(SelectOption & { kind: AccountKind; code: string })[]> {
  const rows = await db.account.findMany({
    where: { isActive: true, ...(options.kinds ? { kind: { in: [...options.kinds] } } : {}) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, kind: true },
  });
  return rows.map((row) => ({
    value: row.id,
    label: `${row.code} ${row.name}`,
    kind: row.kind,
    code: row.code,
  }));
}

/** Active segments for selects. */
export async function listSegmentOptions(db: Db): Promise<SelectOption[]> {
  const rows = await db.segment.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { id: true, name: true },
  });
  return rows.map((row) => ({ value: row.id, label: row.name }));
}
