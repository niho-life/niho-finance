/**
 * 賞与 (22-payroll §10) and 年末調整 (§11): the bonus run (計算 → 確定), its payslips and what it adds
 * to the payment schedule; the year-end declarations, the year-end adjustment (計算 → 確定 with the
 * settlement entry) and 源泉徴収簿. The statutory reports (§12) follow in this module.
 *
 * - The calculation, the entries, the deadlines and the snapshot are pure functions of
 *   `@niho-finance/payroll` (`bonus.ts`, `year-end.ts`); this layer reads the master data and the
 *   confirmed runs, and posts through the path of the monthly run (`payroll.ts`): the payroll lock,
 *   the fiscal-year lock, `buildVoucherEntry`, `postJournalEntryInTransaction` with
 *   `sourceKind = payroll`.
 * - A confirmed bonus run and a confirmed 年末調整 are append-only (DB triggers). Their 源泉所得税 (and
 *   a bonus's 社会保険料) are derived into the same deadlines as the monthly runs
 *   (`listPayrollSchedule` adds them; a refund larger than its deadline carries over, §11.4).
 */
import {
  dateParts,
  formatYen,
  lastDayOfMonth,
  LedgerValidationError,
  type CalendarDate,
  type Money,
} from "@niho-finance/ledger";
import {
  BONUS_WITHHOLDING_METHOD_LABELS,
  bonusReportSlot,
  bonusTableIdsOf,
  buildBonusEntries,
  buildYearEndSettlementEntry,
  calculateBonus,
  calculateYearEnd,
  emptyYearEndDeclaration,
  findTableById,
  findYearEndTable,
  insuranceYearOf,
  isTableEffective,
  parseBonusRunItems,
  parseBonusTableIds,
  PAYROLL_BONUS_SUB_ACCOUNTS,
  PAYROLL_PAYMENT_CATEGORY_LABELS,
  PAYROLL_SUB_ACCOUNTS,
  PayrollInputError,
  PayrollTableMissingError,
  pinnedBonusTables,
  predeterminedFilingWarnings,
  runPaymentSlots,
  scheduleAmount,
  serializeBonusRunItems,
  serializeBonusTableIds,
  shiftYearMonth,
  summarizeBonusRun,
  summarizeYearEndSettlement,
  tableRef,
  withholdingSlot,
  yearMonthLabel,
  yearMonthOf,
  yearMonthParts,
  type BonusTables,
  type BonusWarning,
  type BonusWarningCode,
  type PayrollBonusItem,
  type PayrollBonusItemInput,
  type PayrollBonusTableIds,
  type PayrollCoverage,
  type PayrollEntryPlan,
  type PayrollFilingSlot,
  type PayrollInputIssue,
  type PayrollRunSummary,
  type SocialInsuranceAggregate,
  type TableRef,
  type TaxColumn,
  type WorkerKind,
  type YearEndDeclaration,
  type YearEndInput,
  type YearEndResult,
  type YearEndTable,
  type YearMonth,
} from "@niho-finance/payroll";
import type {
  Employee,
  PayrollBonusRun,
  PayrollYearEnd,
  PayrollYearEndDeclaration,
  Prisma,
} from "@prisma/client";
import { z } from "zod";
import { appendAuditLog, toAuditJson, type Db } from "./audit";
import { fromDbDate, toDbDate } from "./dates";
import type { EntryRef } from "./entries";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import {
  assertPaidPaymentsUnchanged,
  assertPostable,
  dateOf,
  employeeCoverage,
  employeeOrder,
  ensurePayrollSubAccounts,
  entryRefs,
  listPayrollSchedule,
  loadLedgerRefs,
  loadRuns,
  taxColumnOf,
  toEmployeeRecord,
  toJournalEntry,
  totalsOf,
  withDateField,
  type EmployeeRecord,
  type PayrollEntryPreview,
  type PayrollRunTotals,
  type PayrollScheduleRow,
  type PayrollSchedulePreviewRow,
  type StoredRun,
} from "./payroll";
import {
  payrollBonusRunSchema,
  yearEndConfirmSchema,
  yearEndDeclarationSaveSchema,
  yearEndDeclarationSchema,
  yearEndSnapshotInputSchema,
  type ParsedPayrollBonusRun,
  type PayrollBonusRunInput,
  type YearEndConfirmInput,
  type YearEndDeclarationFormInput,
  type YearEndDeclarationSaveInput,
} from "./schemas";
import { lockSettings, runInTransaction } from "./transaction";

// ---------------------------------------------------------------------------------------------
// Stored bonus runs
// ---------------------------------------------------------------------------------------------

interface StoredBonusRun {
  row: PayrollBonusRun;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  items: PayrollBonusItem[];
  tableIds: PayrollBonusTableIds;
  summary: PayrollRunSummary;
}

function toStoredBonusRun(row: PayrollBonusRun): StoredBonusRun {
  const payMonth = row.payMonth as YearMonth;
  const items = parseBonusRunItems(row.items);
  return {
    row,
    payMonth,
    paymentDate: fromDbDate(row.paymentDate),
    items,
    tableIds: parseBonusTableIds(row.tableIds),
    summary: summarizeBonusRun({
      payMonth,
      withholdingSpecialDue: row.withholdingSpecialDue,
      items,
    }),
  };
}

async function loadBonusRuns(db: Db): Promise<StoredBonusRun[]> {
  const rows = await db.payrollBonusRun.findMany({ orderBy: { payMonth: "asc" } });
  return rows.map(toStoredBonusRun);
}

/** The tables a bonus run used, for the screens. */
export interface BonusTableRefs {
  bonusWithholding: TableRef;
  withholding: TableRef;
  kenpo: TableRef;
  pension: TableRef;
  employment: TableRef | null;
}

function bonusTableRefsOf(ids: PayrollBonusTableIds): BonusTableRefs {
  const ref = (id: string): TableRef => {
    const table = findTableById(id);
    if (!table) throw new Error(`payroll table ${id} is not registered`);
    return tableRef(table);
  };
  return {
    bonusWithholding: ref(ids.bonusWithholding),
    withholding: ref(ids.withholding),
    kenpo: ref(ids.kenpo),
    pension: ref(ids.pension),
    employment: ids.employment === null ? null : ref(ids.employment),
  };
}

/** A warning about one person of a bonus run (保存は止めない, §10.3). */
export interface BonusRunWarning {
  employeeId: string;
  name: string;
  code: BonusWarningCode;
  /** Owner-facing, with the person's name. */
  message: string;
}

function personWarnings(
  employee: { id: string; name: string },
  warnings: readonly BonusWarning[],
): BonusRunWarning[] {
  return warnings.map((warning) => ({
    employeeId: employee.id,
    name: employee.name,
    code: warning.code,
    message: `${employee.name}: ${warning.message}`,
  }));
}

// ---------------------------------------------------------------------------------------------
// 賞与の計算 (§10.5): shared by the preview and the confirmation
// ---------------------------------------------------------------------------------------------

/** Input fields of `calculateBonus` → the fields of the screen (`items.<n>.…`). */
const ITEM_FIELDS: Readonly<Record<string, string>> = {
  bonus: "bonus",
  "previousMonth.pay": "previousMonthPay",
  "previousMonth.incomeTax": "previousMonthTax",
};

function itemInputError(error: PayrollInputError, index: number, name: string): PayrollInputError {
  return new PayrollInputError(
    error.issues.map((issue): PayrollInputIssue => {
      if (issue.field === "paymentDate" || issue.field === "calcPeriodOver6Months") return issue;
      const field = ITEM_FIELDS[issue.field];
      return field
        ? { ...issue, field: `items.${index}.${field}`, message: `${name}: ${issue.message}` }
        : {
            ...issue,
            field: `items.${index}`,
            message: `${name}: ${issue.message}（従業員 › ${name} で直してください）`,
          };
    }),
  );
}

interface BonusPlan {
  data: ParsedPayrollBonusRun;
  items: PayrollBonusItem[];
  warnings: BonusRunWarning[];
  tableIds: PayrollBonusTableIds;
  summary: PayrollRunSummary;
  /** Every other confirmed run's summary, monthly and bonus (the schedule adds them). */
  others: PayrollRunSummary[];
  pay: PayrollEntryPlan;
  employer: PayrollEntryPlan | null;
  socialInsurance: SocialInsuranceAggregate;
  filing: PayrollFilingSlot | null;
}

/**
 * Client-sent table ids (the versions the preview used) must be registered versions of their kind
 * in force for the payment date and its month; otherwise the preview is stale.
 */
function requestedBonusTables(
  ids: PayrollBonusTableIds | null,
  paymentDate: CalendarDate,
): Partial<BonusTables> | undefined {
  if (!ids) return undefined;
  const kinds = {
    bonusWithholding: "withholding-bonus",
    withholding: "withholding-monthly",
    kenpo: "kyokai-kenpo",
    pension: "pension",
    employment: "employment-insurance",
  } as const;
  for (const key of Object.keys(kinds) as (keyof typeof kinds)[]) {
    const id = ids[key];
    if (id === null) continue;
    const table = findTableById(id);
    if (table?.kind !== kinds[key]) {
      throw new SettingsError(
        `計算に使う表の版（${id}）が見つかりません。画面を読み込み直してから、もう一度計算してください`,
      );
    }
    const when =
      key === "bonusWithholding" || key === "withholding" ? paymentDate : yearMonthOf(paymentDate);
    if (!isTableEffective(table, when)) {
      throw new SettingsError(
        `支払日が変わったので、計算に使う表の版（${table.title}）が変わります。もう一度計算してから確定してください`,
      );
    }
  }
  return pinnedBonusTables(ids);
}

/** 標準賞与額（健保）of the earlier bonuses of the same 年度, per employee (§10.2). */
function priorHealthStandardBonuses(
  runs: readonly StoredBonusRun[],
  payMonth: YearMonth,
  paymentDate: CalendarDate,
): Map<string, Money> {
  const year = insuranceYearOf(paymentDate);
  const prior = new Map<string, Money>();
  for (const run of runs) {
    // Every other confirmed bonus of the 年度 counts (one entered late still sees them all).
    if (run.payMonth === payMonth || insuranceYearOf(run.paymentDate) !== year) continue;
    for (const item of run.items) {
      prior.set(
        item.employeeId,
        (prior.get(item.employeeId) ?? 0n) + item.result.standardBonus.health,
      );
    }
  }
  return prior;
}

async function planBonus(db: Db, data: ParsedPayrollBonusRun): Promise<BonusPlan> {
  if (yearMonthOf(data.paymentDate) !== data.payMonth) {
    throw new SettingsError(
      `支払日は ${yearMonthLabel(data.payMonth)}の日付にしてください（支給月は支払日の月です）`,
      { field: "paymentDate" },
    );
  }
  const [bonusRuns, monthlyRuns] = await Promise.all([loadBonusRuns(db), loadRuns(db)]);
  if (bonusRuns.some((run) => run.payMonth === data.payMonth)) {
    throw new SettingsError(
      `${yearMonthLabel(data.payMonth)}の賞与は確定済みです。賞与は 1 か月に 1 回です。確定した賞与は変えられないので、直すときは取引で仕訳を訂正してください`,
      { field: "payMonth" },
    );
  }

  const employees = (await db.employee.findMany({ where: { isActive: true } }))
    .sort(employeeOrder)
    .map(toEmployeeRecord);
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const rows = new Map<string, { row: ParsedPayrollBonusRun["items"][number]; index: number }>();
  data.items.forEach((row, index) => {
    if (!byId.has(row.employeeId)) {
      throw new SettingsError(
        "賞与の計算にない従業員か、無効にした従業員が入っています。画面を読み込み直してください",
        { field: `items.${index}.employeeId` },
      );
    }
    if (rows.has(row.employeeId)) {
      throw new SettingsError("同じ従業員が 2 回入っています。画面を読み込み直してください", {
        field: `items.${index}.employeeId`,
      });
    }
    rows.set(row.employeeId, { row, index });
  });
  const missing = employees.find((employee) => !rows.has(employee.id));
  if (missing) {
    throw new SettingsError(
      `従業員「${missing.name}」の入力がありません。従業員が増えたときは画面を読み込み直してください`,
    );
  }

  const tables = requestedBonusTables(data.tableIds, data.paymentDate);
  const prior = priorHealthStandardBonuses(bonusRuns, data.payMonth, data.paymentDate);
  const run = { paymentDate: data.paymentDate, calcPeriodOver6Months: data.calcPeriodOver6Months };
  const items: PayrollBonusItem[] = [];
  const warnings: BonusRunWarning[] = [];
  for (const employee of employees) {
    const entry = rows.get(employee.id);
    if (!entry) throw new Error("unreachable: every employee has a row");
    const { row, index } = entry;
    const filing =
      employee.kind === "officer" ? { date: row.filingDate, amount: row.filingAmount } : null;
    warnings.push(
      ...personWarnings(
        employee,
        predeterminedFilingWarnings(
          { kind: employee.kind, bonus: row.bonus, filing },
          data.paymentDate,
        ),
      ),
    );
    // No bonus: the person is not in this run.
    if (row.bonus === 0n) continue;
    const input: PayrollBonusItemInput = {
      bonus: row.bonus,
      coverage: employeeCoverage(employee, data.payMonth),
      taxColumn: taxColumnOf(employee),
      previousMonth:
        row.previousMonthPay === null
          ? null
          : { pay: row.previousMonthPay, incomeTax: row.previousMonthTax },
      priorHealthStandardBonus: prior.get(employee.id) ?? 0n,
      filing,
    };
    try {
      items.push({
        employeeId: employee.id,
        name: employee.name,
        kind: employee.kind,
        input,
        result: calculateBonus({
          paymentDate: run.paymentDate,
          calcPeriodOver6Months: run.calcPeriodOver6Months,
          worker: employee.kind,
          bonus: input.bonus,
          coverage: input.coverage,
          taxColumn: input.taxColumn,
          previousMonth: input.previousMonth,
          priorHealthStandardBonus: input.priorHealthStandardBonus,
          ...(tables ? { tables } : {}),
        }),
      });
    } catch (error) {
      if (error instanceof PayrollInputError) throw itemInputError(error, index, employee.name);
      throw error;
    }
  }
  if (items.length === 0) {
    throw new SettingsError("賞与の額がすべて 0 円です。支給する人の賞与の額を入れてください", {
      field: "items.0.bonus",
    });
  }

  const tableIds = bonusTableIdsOf(items.map((item) => item.result));
  const summary = summarizeBonusRun({
    payMonth: data.payMonth,
    withholdingSpecialDue: data.withholdingSpecialDue,
    items,
  });
  const entries = buildBonusEntries({
    payMonth: data.payMonth,
    title: data.title,
    items,
    payFrom: data.payFromWalletId ? "wallet" : "accrued",
  });

  if (data.expected) {
    const differences = [
      ["総支給", data.expected.grossPay, summary.grossPay],
      ["差引支給", data.expected.netPay, summary.netPay],
      ["会社負担", data.expected.employerTotal, summary.socialInsuranceEmployer],
    ] as const;
    const changed = differences.filter(([, expected, actual]) => expected !== actual);
    if (changed.length > 0) {
      throw new SettingsError(
        `計算の結果が確認した内容と変わりました（${changed
          .map(
            ([label, expected, actual]) =>
              `${label}の合計 ${formatYen(expected)} 円 → ${formatYen(actual)} 円`,
          )
          .join("、")}）。画面を読み込み直して、もう一度確かめてください`,
      );
    }
  }

  const insured = items.some((item) => item.input.coverage.health || item.input.coverage.pension);
  return {
    data,
    items,
    warnings,
    tableIds,
    summary,
    others: [
      ...monthlyRuns.map((stored) => stored.summary),
      ...bonusRuns.map((stored) => stored.summary),
    ],
    pay: entries.pay,
    employer: entries.employer,
    socialInsurance: entries.socialInsurance,
    filing: insured ? bonusReportSlot(data.payMonth, data.paymentDate) : null,
  };
}

function schedulePreview(plan: BonusPlan): PayrollSchedulePreviewRow[] {
  const all = [...plan.others, plan.summary];
  return runPaymentSlots(plan.summary).map(({ slot, amount }) => ({
    category: slot.category,
    categoryLabel: PAYROLL_PAYMENT_CATEGORY_LABELS[slot.category],
    ruleKey: slot.ruleKey,
    title: slot.title,
    dueDate: slot.dueDate,
    amount: amount.total,
    scheduledTotal: scheduleAmount(slot.ruleKey, all).total,
  }));
}

export interface BonusPreview {
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  title: string;
  calcPeriodOver6Months: boolean;
  payFromWalletId: string | null;
  withholdingSpecialDue: boolean;
  /** The people with a bonus (an amount of 0 leaves the person out), in the employee order. */
  items: PayrollBonusItem[];
  /** 事前確定届出給与 (§10.3): shown, never blocking. */
  warnings: BonusRunWarning[];
  tableIds: PayrollBonusTableIds;
  tables: BonusTableRefs;
  socialInsurance: SocialInsuranceAggregate;
  totals: PayrollRunTotals;
  entries: { pay: PayrollEntryPreview; employer: PayrollEntryPreview | null };
  schedule: PayrollSchedulePreviewRow[];
  /** 被保険者賞与支払届 (none when nobody is insured). */
  filing: PayrollFilingSlot | null;
  /** Send back as `expected` (with `tableIds`) when confirming what this preview showed. */
  expected: { grossPay: Money; netPay: Money; employerTotal: Money };
}

function previewOf(
  plan: BonusPlan,
  entries: { pay: PayrollEntryPreview; employer: PayrollEntryPreview | null },
): BonusPreview {
  return {
    payMonth: plan.data.payMonth,
    paymentDate: plan.data.paymentDate,
    title: plan.data.title,
    calcPeriodOver6Months: plan.data.calcPeriodOver6Months,
    payFromWalletId: plan.data.payFromWalletId,
    withholdingSpecialDue: plan.data.withholdingSpecialDue,
    items: plan.items,
    warnings: plan.warnings,
    tableIds: plan.tableIds,
    tables: bonusTableRefsOf(plan.tableIds),
    socialInsurance: plan.socialInsurance,
    totals: totalsOf(plan.summary),
    entries,
    schedule: schedulePreview(plan),
    filing: plan.filing,
    expected: {
      grossPay: plan.summary.grossPay,
      netPay: plan.summary.netPay,
      employerTotal: plan.summary.socialInsuranceEmployer,
    },
  };
}

/**
 * The results, the 2 entries and the deadlines of a bonus run, without writing anything. It runs
 * the confirmation's checks, so what it shows is what `confirmBonusRun` posts.
 */
export async function previewBonusRun(db: Db, input: PayrollBonusRunInput): Promise<BonusPreview> {
  const data = payrollBonusRunSchema.parse(input);
  const plan = await planBonus(db, data);
  try {
    const refs = await loadLedgerRefs(db, {
      date: data.paymentDate,
      walletId: data.payFromWalletId,
      lock: false,
      dateField: "paymentDate",
      walletField: "payFromWalletId",
    });
    const context = { date: data.paymentDate, sourceId: "preview", pendingSubAccounts: true };
    const pay = toJournalEntry(plan.pay, refs, context);
    const employer = plan.employer ? toJournalEntry(plan.employer, refs, context) : null;
    assertPostable(pay.entry, refs);
    if (employer) assertPostable(employer.entry, refs);
    return previewOf(plan, { pay: pay.preview, employer: employer?.preview ?? null });
  } catch (error) {
    if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
    throw error;
  }
}

/** A confirmed bonus run (読み取りだけ). */
export interface BonusRunDetail {
  id: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  title: string;
  calcPeriodOver6Months: boolean;
  /** `null`: 未払金〔給与〕. */
  payFromWallet: { id: string; name: string } | null;
  withholdingSpecialDue: boolean;
  items: PayrollBonusItem[];
  /** 事前確定届出給与 of the officers paid, as at confirmation. */
  warnings: BonusRunWarning[];
  tableIds: PayrollBonusTableIds;
  tables: BonusTableRefs;
  totals: PayrollRunTotals;
  payEntry: EntryRef | null;
  employerEntry: EntryRef | null;
  /** The payment deadlines this run pays into, with their derived amounts and state. */
  schedule: PayrollScheduleRow[];
  /** 被保険者賞与支払届, when one was added. */
  filing: { id: string; title: string; dueDate: CalendarDate; completedAt: Date | null } | null;
  confirmedAt: Date;
  confirmedBy: string;
}

/**
 * 確定: in one transaction — the payroll lock → the checks and the calculation (as the preview) →
 * the deadlines must still be open → the sub-accounts (§5.2 and 「賞与」) → the 2 entries → the
 * `PayrollBonusRun` row → the payment deadlines and 被保険者賞与支払届 → the audit log
 * `payroll_bonus_run.confirm`.
 */
export async function confirmBonusRun(
  db: Db,
  input: PayrollBonusRunInput,
  options: ActorOptions,
): Promise<BonusRunDetail> {
  const data = payrollBonusRunSchema.parse(input);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "payroll");
    const plan = await planBonus(tx, data);
    const slots = runPaymentSlots(plan.summary);
    for (const { slot } of slots) {
      const existing = await tx.calendarItem.findFirst({
        where: { fiscalYearId: null, ruleKey: slot.ruleKey },
      });
      if (existing?.completedAt) {
        throw new SettingsError(
          `「${existing.title}」は納付済みにしています。この賞与の分を同じ納付に足せないので、納期の特例の設定か支払日を確かめてください`,
          { field: slot.category === "withholding" ? "withholdingSpecialDue" : "paymentDate" },
        );
      }
    }
    await assertPaidPaymentsUnchanged(tx, [plan.summary], "paymentDate");

    const runId = newId();
    let payEntryId: string;
    let employerEntryId: string | null = null;
    try {
      const refs = await loadLedgerRefs(tx, {
        date: data.paymentDate,
        walletId: data.payFromWalletId,
        lock: true,
        dateField: "paymentDate",
        walletField: "payFromWalletId",
      });
      await ensurePayrollSubAccounts(tx, refs, options, [
        ...Object.values(PAYROLL_SUB_ACCOUNTS),
        ...Object.values(PAYROLL_BONUS_SUB_ACCOUNTS),
      ]);
      const context = { date: data.paymentDate, sourceId: runId, pendingSubAccounts: false };
      const pay = toJournalEntry(plan.pay, refs, context);
      payEntryId = (
        await postJournalEntryInTransaction(
          tx,
          { ...pay.entry, fiscalYearId: refs.fiscalYear.id },
          options,
        )
      ).id;
      if (plan.employer) {
        const employer = toJournalEntry(plan.employer, refs, context);
        employerEntryId = (
          await postJournalEntryInTransaction(
            tx,
            { ...employer.entry, fiscalYearId: refs.fiscalYear.id },
            options,
          )
        ).id;
      }
    } catch (error) {
      if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
      throw error;
    }

    await tx.payrollBonusRun
      .create({
        data: {
          id: runId,
          payMonth: data.payMonth,
          paymentDate: toDbDate(data.paymentDate),
          title: data.title,
          calcPeriodOver6Months: data.calcPeriodOver6Months,
          payFromWalletId: data.payFromWalletId,
          withholdingSpecialDue: data.withholdingSpecialDue,
          tableIds: serializeBonusTableIds(plan.tableIds) as Prisma.InputJsonValue,
          items: serializeBonusRunItems(plan.items) as Prisma.InputJsonValue,
          payEntryId,
          employerEntryId,
          confirmedBy: options.actor,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new SettingsError(
            `${yearMonthLabel(data.payMonth)}の賞与は確定済みです。画面を読み込み直してください`,
            { field: "payMonth" },
          );
        }
        throw error;
      });

    for (const { slot } of slots) {
      const existing = await tx.calendarItem.findFirst({
        where: { fiscalYearId: null, ruleKey: slot.ruleKey },
      });
      if (!existing) {
        await tx.calendarItem.create({
          data: {
            id: newId(),
            fiscalYearId: null,
            kind: "payment",
            title: slot.title,
            dueDate: toDbDate(slot.dueDate),
            ruleKey: slot.ruleKey,
          },
        });
      }
    }
    if (plan.filing) {
      const existing = await tx.calendarItem.findFirst({
        where: { fiscalYearId: null, ruleKey: plan.filing.ruleKey },
      });
      if (!existing) {
        await tx.calendarItem.create({
          data: {
            id: newId(),
            fiscalYearId: null,
            kind: "filing",
            title: plan.filing.title,
            dueDate: toDbDate(plan.filing.dueDate),
            ruleKey: plan.filing.ruleKey,
            note: "健康保険・厚生年金保険 被保険者賞与支払届を日本年金機構へ（支払日から 5 日以内）",
          },
        });
      }
    }

    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payroll_bonus_run.confirm",
      entity: "payroll_bonus_run",
      entityId: runId,
      after: {
        payMonth: data.payMonth,
        paymentDate: data.paymentDate,
        title: data.title,
        calcPeriodOver6Months: data.calcPeriodOver6Months,
        payFromWalletId: data.payFromWalletId,
        withholdingSpecialDue: data.withholdingSpecialDue,
        tableIds: plan.tableIds,
        payEntryId,
        employerEntryId,
        employeeIds: plan.items.map((item) => item.employeeId),
        totals: totalsOf(plan.summary),
        warnings: plan.warnings.map(({ employeeId, code }) => ({ employeeId, code })),
      },
    });

    const detail = await getBonusRun(tx, runId);
    if (!detail) throw new Error(`payroll bonus run ${runId} disappeared`);
    return detail;
  });
}

// ---------------------------------------------------------------------------------------------
// 賞与の計算の初期値 (§10.5)
// ---------------------------------------------------------------------------------------------

export interface BonusRunItemValues {
  employeeId: string;
  bonus: Money;
  /** `null`: 前月の給与なし. */
  previousMonthPay: Money | null;
  previousMonthTax: Money;
  filingDate: CalendarDate | null;
  filingAmount: Money | null;
}

/** A complete input of `previewBonusRun` / `confirmBonusRun`, typed. */
export interface BonusRunValues {
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  title: string;
  calcPeriodOver6Months: boolean;
  payFromWalletId: string | null;
  withholdingSpecialDue: boolean;
  items: BonusRunItemValues[];
  tableIds?: PayrollBonusTableIds | null;
  expected?: { grossPay: Money; netPay: Money; employerTotal: Money } | null;
}

export interface BonusDraftEmployee {
  employee: EmployeeRecord;
  /** Coverage in the pay month (介護・厚年・健保 by age, from 資格取得日). */
  coverage: PayrollCoverage;
  taxColumn: TaxColumn;
  /** From the confirmed run of the month before, when the person was in it. */
  previousMonth: { pay: Money; incomeTax: Money } | null;
}

export interface BonusDraft {
  payMonth: YearMonth;
  /** Set when the month's bonus is confirmed already (the screen then opens it). */
  confirmedRunId: string | null;
  /** The month before (前月の給与). */
  previousPayMonth: YearMonth;
  /** The confirmed monthly run of the month before, if any. */
  previousRunId: string | null;
  input: BonusRunValues;
  employees: BonusDraftEmployee[];
  /** The active wallets that can pay (支払元). */
  wallets: { id: string; name: string }[];
}

/** 夏季賞与 (6〜8 月), 冬季賞与 (11〜1 月), otherwise 賞与. */
function defaultTitle(payMonth: YearMonth): string {
  const { month } = yearMonthParts(payMonth);
  if (month >= 6 && month <= 8) return "夏季賞与";
  if (month >= 11 || month === 1) return "冬季賞与";
  return "賞与";
}

/**
 * The defaults of 賞与の計算 for `payMonth` (§10.5): the active employees, 前月の給与 and its tax from
 * the confirmed run of the month before (課税支給 − 社会保険料等 and the table's tax), the latest
 * monthly run's 支払元 and 源泉の納期の特例, the officers' filing left empty.
 */
export async function loadBonusDraft(db: Db, payMonth: string): Promise<BonusDraft> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payMonth)) {
    throw new SettingsError("支給月は 2026-12 の形にしてください", { field: "payMonth" });
  }
  const month = payMonth as YearMonth;
  const previousPayMonth = shiftYearMonth(month, -1);
  const [runs, bonus] = await Promise.all([
    loadRuns(db),
    db.payrollBonusRun.findUnique({ where: { payMonth: month }, select: { id: true } }),
  ]);
  const previous = runs.find((run) => run.payMonth === previousPayMonth) ?? null;
  const sameMonth = runs.find((run) => run.payMonth === month) ?? null;
  const latest = [...runs].reverse().find((run) => run.payMonth <= month) ?? runs.at(-1) ?? null;

  // 支払日: the monthly run's of the same month, else the latest run's day of the month (25 first).
  const { year, month: monthNumber } = yearMonthParts(month);
  const lastDay = dateParts(lastDayOfMonth(year, monthNumber)).day;
  const latestDay = latest ? dateParts(latest.paymentDate).day : 25;
  const paymentDate =
    sameMonth?.paymentDate ?? dateOf(year, monthNumber, latestDay > lastDay ? lastDay : latestDay);

  const wallets = await db.wallet.findMany({
    where: { isActive: true },
    orderBy: [{ createdAt: "asc" }],
    select: { id: true, name: true },
  });
  const payFromWalletId =
    latest?.row.payFromWalletId &&
    wallets.some((wallet) => wallet.id === latest.row.payFromWalletId)
      ? latest.row.payFromWalletId
      : null;
  const employees = (await db.employee.findMany({ where: { isActive: true } }))
    .sort(employeeOrder)
    .map(toEmployeeRecord);
  const draftEmployees = employees.map((employee): BonusDraftEmployee => {
    const item = previous?.items.find((candidate) => candidate.employeeId === employee.id);
    return {
      employee,
      coverage: employeeCoverage(employee, month),
      taxColumn: taxColumnOf(employee),
      previousMonth: item
        ? { pay: item.result.withholdingBase, incomeTax: item.result.incomeTax }
        : null,
    };
  });
  return {
    payMonth: month,
    confirmedRunId: bonus?.id ?? null,
    previousPayMonth,
    previousRunId: previous?.row.id ?? null,
    input: {
      payMonth: month,
      paymentDate,
      title: defaultTitle(month),
      calcPeriodOver6Months: false,
      payFromWalletId,
      withholdingSpecialDue: latest?.row.withholdingSpecialDue ?? false,
      items: draftEmployees.map(({ employee, previousMonth }) => ({
        employeeId: employee.id,
        bonus: 0n,
        previousMonthPay: previousMonth?.pay ?? null,
        previousMonthTax: previousMonth?.incomeTax ?? 0n,
        filingDate: null,
        filingAmount: null,
      })),
    },
    employees: draftEmployees,
    wallets,
  };
}

// ---------------------------------------------------------------------------------------------
// History, detail and payslip
// ---------------------------------------------------------------------------------------------

export interface BonusRunListRow {
  id: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  title: string;
  totals: PayrollRunTotals;
  payEntry: EntryRef | null;
  employerEntry: EntryRef | null;
  confirmedAt: Date;
}

/** 賞与の履歴, newest first. */
export async function listBonusRuns(db: Db): Promise<BonusRunListRow[]> {
  const runs = (await loadBonusRuns(db)).reverse();
  const refs = await entryRefs(
    db,
    runs.flatMap((run) => [run.row.payEntryId, run.row.employerEntryId]),
  );
  return runs.map((run) => ({
    id: run.row.id,
    payMonth: run.payMonth,
    paymentDate: run.paymentDate,
    title: run.row.title,
    totals: totalsOf(run.summary),
    payEntry: refs.get(run.row.payEntryId) ?? null,
    employerEntry: run.row.employerEntryId ? (refs.get(run.row.employerEntryId) ?? null) : null,
    confirmedAt: run.row.confirmedAt,
  }));
}

function storedWarnings(run: StoredBonusRun): BonusRunWarning[] {
  return run.items.flatMap((item) =>
    personWarnings(
      { id: item.employeeId, name: item.name },
      predeterminedFilingWarnings(
        { kind: item.kind, bonus: item.input.bonus, filing: item.input.filing },
        run.paymentDate,
      ),
    ),
  );
}

/** A confirmed bonus run, or `null` when there is none with this id. */
export async function getBonusRun(db: Db, id: string): Promise<BonusRunDetail | null> {
  const row = await db.payrollBonusRun.findUnique({ where: { id } });
  if (!row) return null;
  const run = toStoredBonusRun(row);
  const filingKey = bonusReportSlot(run.payMonth, run.paymentDate).ruleKey;
  const [refs, wallet, schedule, filing] = await Promise.all([
    entryRefs(db, [row.payEntryId, row.employerEntryId]),
    row.payFromWalletId
      ? db.wallet.findUnique({
          where: { id: row.payFromWalletId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    listPayrollSchedule(db),
    db.calendarItem.findFirst({ where: { fiscalYearId: null, ruleKey: filingKey } }),
  ]);
  const ruleKeys = new Set(runPaymentSlots(run.summary).map(({ slot }) => slot.ruleKey));
  return {
    id: row.id,
    payMonth: run.payMonth,
    paymentDate: run.paymentDate,
    title: row.title,
    calcPeriodOver6Months: row.calcPeriodOver6Months,
    payFromWallet: wallet,
    withholdingSpecialDue: row.withholdingSpecialDue,
    items: run.items,
    warnings: storedWarnings(run),
    tableIds: run.tableIds,
    tables: bonusTableRefsOf(run.tableIds),
    totals: totalsOf(run.summary),
    payEntry: refs.get(row.payEntryId) ?? null,
    employerEntry: row.employerEntryId ? (refs.get(row.employerEntryId) ?? null) : null,
    schedule: schedule.filter((item) => ruleKeys.has(item.ruleKey)),
    filing: filing
      ? {
          id: filing.id,
          title: filing.title,
          dueDate: fromDbDate(filing.dueDate),
          completedAt: filing.completedAt,
        }
      : null,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
  };
}

/** 賞与明細: A4 一枚の項目. */
export interface BonusPayslip {
  runId: string;
  companyName: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  /** 題名 (夏季賞与 など). */
  title: string;
  employee: { id: string; name: string; kind: WorkerKind };
  bonus: Money;
  deductions: {
    /** 健康保険（介護・子ども・子育て支援金を含む）の本人負担 */
    health: Money;
    pension: Money;
    employmentInsurance: Money;
    incomeTax: Money;
    total: Money;
  };
  netPay: Money;
  reference: {
    /** 標準賞与額 (1,000 円未満切り捨て). */
    standardBonus: Money;
    /** The capped amounts charged; `null` when not covered. */
    healthStandardBonus: Money | null;
    pensionStandardBonus: Money | null;
    taxColumn: TaxColumn;
    withholdingBase: Money;
    withholding: PayrollBonusItem["result"]["withholding"];
    previousMonthPay: Money | null;
    coverage: PayrollCoverage;
  };
}

/** The bonus payslip of one person of a confirmed bonus run, or `null`. */
export async function loadBonusPayslip(
  db: Db,
  runId: string,
  employeeId: string,
): Promise<BonusPayslip | null> {
  const row = await db.payrollBonusRun.findUnique({ where: { id: runId } });
  if (!row) return null;
  const run = toStoredBonusRun(row);
  const item = run.items.find((candidate) => candidate.employeeId === employeeId);
  if (!item) return null;
  const company = await db.company.findFirst({ select: { name: true } });
  const { input, result } = item;
  return {
    runId: row.id,
    companyName: company?.name ?? "",
    payMonth: run.payMonth,
    paymentDate: run.paymentDate,
    title: row.title,
    employee: { id: item.employeeId, name: item.name, kind: item.kind },
    bonus: result.bonus,
    deductions: {
      health: result.socialInsurance.health.employee,
      pension: result.socialInsurance.pension.employee,
      employmentInsurance: result.employmentInsurance?.employee ?? 0n,
      incomeTax: result.incomeTax,
      total: result.totalDeductions,
    },
    netPay: result.netPay,
    reference: {
      standardBonus: result.standardBonus.amount,
      healthStandardBonus: input.coverage.health ? result.standardBonus.health : null,
      pensionStandardBonus: input.coverage.pension ? result.standardBonus.pension : null,
      taxColumn: input.taxColumn,
      withholdingBase: result.withholdingBase,
      withholding: result.withholding,
      previousMonthPay: input.previousMonth?.pay ?? null,
      coverage: input.coverage,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 年末調整 (§11): 申告
// ---------------------------------------------------------------------------------------------

/** A saved 年末調整の申告 (one person and year). */
export interface YearEndDeclarationRecord {
  id: string;
  year: number;
  employeeId: string;
  declaration: YearEndDeclaration;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

/** A stored declaration read back through the same schema as the form (a mismatch is a data bug). */
function readStoredDeclaration(json: unknown, id: string): YearEndDeclaration {
  const parsed = yearEndDeclarationSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`payroll year-end declaration ${id}: the stored declarations are malformed`);
  }
  return parsed.data;
}

function toDeclarationRecord(row: PayrollYearEndDeclaration): YearEndDeclarationRecord {
  return {
    id: row.id,
    year: row.year,
    employeeId: row.employeeId,
    declaration: readStoredDeclaration(row.declarations, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** The saved declaration of `employeeId` for `year`, or `null`. */
export async function getYearEndDeclaration(
  db: Db,
  year: number,
  employeeId: string,
): Promise<YearEndDeclarationRecord | null> {
  if (!Number.isSafeInteger(year) || typeof employeeId !== "string" || employeeId === "") {
    return null;
  }
  const row = await db.payrollYearEndDeclaration.findUnique({
    where: { year_employeeId: { year, employeeId } },
  });
  return row ? toDeclarationRecord(row) : null;
}

/**
 * 申告を保存 (§11.4): creates or replaces the declaration, with the audit log
 * `payroll_year_end_declaration.save` (before and after). Refused once the person's 年末調整 of the
 * year is confirmed (the confirmed snapshot is the record) and for a year without data.
 */
export async function saveYearEndDeclaration(
  db: Db,
  input: YearEndDeclarationSaveInput,
  options: ActorOptions,
): Promise<YearEndDeclarationRecord> {
  const data = yearEndDeclarationSaveSchema.parse(input);
  findYearEndTable(data.year);
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "payroll");
    const employee = await tx.employee.findUnique({ where: { id: data.employeeId } });
    if (!employee) {
      throw new SettingsError("従業員が見つかりません。画面を読み込み直してください", {
        field: "employeeId",
      });
    }
    const key = { year_employeeId: { year: data.year, employeeId: data.employeeId } };
    if (await tx.payrollYearEnd.findUnique({ where: key, select: { id: true } })) {
      throw new SettingsError(
        `${employee.name}さんの ${data.year} 年分の年末調整は確定済みです。確定した後は申告を変えられません`,
      );
    }
    const existing = await tx.payrollYearEndDeclaration.findUnique({ where: key });
    const declarations = toAuditJson(data.declaration);
    const row = existing
      ? await tx.payrollYearEndDeclaration.update({
          where: { id: existing.id },
          data: { declarations, updatedBy: options.actor },
        })
      : await tx.payrollYearEndDeclaration.create({
          data: {
            id: newId(),
            year: data.year,
            employeeId: data.employeeId,
            declarations,
            updatedBy: options.actor,
          },
        });
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payroll_year_end_declaration.save",
      entity: "payroll_year_end_declaration",
      entityId: row.id,
      ...(existing
        ? {
            before: {
              year: existing.year,
              employeeId: existing.employeeId,
              declarations: existing.declarations,
            },
          }
        : {}),
      after: { year: data.year, employeeId: data.employeeId, declarations: data.declaration },
    });
    return toDeclarationRecord(row);
  });
}

// ---------------------------------------------------------------------------------------------
// 年末調整 (§11): その年の集計と計算
// ---------------------------------------------------------------------------------------------

/** One confirmed run's share of a person's year (支払日がその年). */
export interface YearEndRunLine {
  kind: "monthly" | "bonus";
  runId: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  /** 「2026 年 12 月の給与」 / 「冬季賞与（2026 年 12 月）」 */
  label: string;
  /** 課税支給額 (monthly) or 賞与の額. */
  pay: Money;
  /** 社会保険料等: 健保・介護・支援金・厚年（調整後）と雇用保険の本人分. */
  socialInsurance: Money;
  /** 源泉所得税（調整後）. */
  withheld: Money;
}

/** This employer's totals of a person's year, from the confirmed monthly and bonus runs. */
export interface YearEndTotals {
  pay: Money;
  bonus: Money;
  socialInsurance: Money;
  withheld: Money;
  runs: YearEndRunLine[];
}

const inYear = (date: CalendarDate, year: number) => dateParts(date).year === year;

/** The totals of `employeeId` over the runs paid in `year` (by payment date). */
function yearTotalsOf(
  employeeId: string,
  year: number,
  runs: readonly StoredRun[],
  bonuses: readonly StoredBonusRun[],
): YearEndTotals {
  const lines: YearEndRunLine[] = [];
  for (const run of runs) {
    if (!inYear(run.paymentDate, year)) continue;
    const item = run.items.find((candidate) => candidate.employeeId === employeeId);
    if (!item) continue;
    lines.push({
      kind: "monthly",
      runId: run.row.id,
      payMonth: run.payMonth,
      paymentDate: run.paymentDate,
      label: `${yearMonthLabel(run.payMonth)}の給与`,
      pay: item.input.taxablePay,
      socialInsurance:
        item.result.socialInsuranceEmployeeTotal +
        (item.result.employmentInsurance?.employee ?? 0n),
      withheld: item.result.incomeTaxTotal,
    });
  }
  for (const run of bonuses) {
    if (!inYear(run.paymentDate, year)) continue;
    const item = run.items.find((candidate) => candidate.employeeId === employeeId);
    if (!item || item.result.bonus === 0n) continue;
    lines.push({
      kind: "bonus",
      runId: run.row.id,
      payMonth: run.payMonth,
      paymentDate: run.paymentDate,
      label: `${run.row.title}（${yearMonthLabel(run.payMonth)}）`,
      pay: item.result.bonus,
      socialInsurance:
        item.result.socialInsurance.employeeTotal +
        (item.result.employmentInsurance?.employee ?? 0n),
      withheld: item.result.incomeTax,
    });
  }
  lines.sort(
    (a, b) =>
      (a.paymentDate < b.paymentDate ? -1 : a.paymentDate > b.paymentDate ? 1 : 0) ||
      (a.kind === b.kind ? 0 : a.kind === "monthly" ? -1 : 1),
  );
  const totals: YearEndTotals = {
    pay: 0n,
    bonus: 0n,
    socialInsurance: 0n,
    withheld: 0n,
    runs: lines,
  };
  for (const line of lines) {
    if (line.kind === "monthly") totals.pay += line.pay;
    else totals.bonus += line.pay;
    totals.socialInsurance += line.socialInsurance;
    totals.withheld += line.withheld;
  }
  return totals;
}

/** What every person's 年末調整 of one year reads. */
interface YearEndContext {
  year: number;
  table: YearEndTable;
  runs: StoredRun[];
  bonuses: StoredBonusRun[];
  /** The year's December monthly run (最後の給与), when confirmed. */
  decemberRun: StoredRun | null;
}

async function loadYearEndContext(db: Db, year: number): Promise<YearEndContext> {
  const table = findYearEndTable(year);
  const [runs, bonuses] = await Promise.all([loadRuns(db), loadBonusRuns(db)]);
  const december = `${String(year).padStart(4, "0")}-12`;
  return {
    year,
    table,
    runs,
    bonuses,
    decemberRun: runs.find((run) => run.payMonth === december) ?? null,
  };
}

interface YearEndPlan {
  employee: EmployeeRecord;
  declaration: YearEndDeclarationRecord | null;
  totals: YearEndTotals;
  input: YearEndInput;
  result: YearEndResult;
  inDecemberRun: boolean;
  /** Why 確定 is not possible (empty: it is). */
  blockers: string[];
}

function planFor(
  context: YearEndContext,
  employee: EmployeeRecord,
  declaration: YearEndDeclarationRecord | null,
  override: YearEndDeclaration | null,
): YearEndPlan {
  const totals = yearTotalsOf(employee.id, context.year, context.runs, context.bonuses);
  const decemberItem =
    context.decemberRun?.items.find((item) => item.employeeId === employee.id) ?? null;
  const input: YearEndInput = {
    year: context.year,
    // 最後の給与の支払時の区分 (the December run's), else the master data.
    taxColumn: decemberItem ? decemberItem.input.taxColumn.column : employee.taxColumn,
    salary: {
      pay: totals.pay,
      bonus: totals.bonus,
      socialInsurance: totals.socialInsurance,
      withheld: totals.withheld,
    },
    declaration: override ?? declaration?.declaration ?? emptyYearEndDeclaration(),
    table: context.table,
  };
  const result = calculateYearEnd(input);
  const blockers: string[] = [];
  const december = `${context.year} 年 12 月の支給`;
  if (!context.decemberRun) {
    blockers.push(
      `${december}がまだ確定していません。年末調整は 12 月の支給を確定した後に行います`,
    );
  } else if (!decemberItem) {
    blockers.push(
      `${december}に${employee.name}さんが入っていません。年末調整は最後の給与の支払時に在職している人が対象です`,
    );
  }
  if (!declaration) blockers.push("申告をまだ保存していません。申告を保存してから確定します");
  for (const reason of result.ineligible) blockers.push(reason.message);
  return {
    employee,
    declaration,
    totals,
    input,
    result,
    inDecemberRun: decemberItem !== null,
    blockers,
  };
}

// ---------------------------------------------------------------------------------------------
// 年末調整 (§11): 確定した記録
// ---------------------------------------------------------------------------------------------

/** A confirmed 年末調整 (read back from its snapshot and recalculated with its table). */
export interface YearEndRecord {
  id: string;
  year: number;
  employeeId: string;
  settledRun: { id: string; payMonth: YearMonth; paymentDate: CalendarDate };
  /** What was calculated (the table pinned to the version used). */
  input: Omit<YearEndInput, "table">;
  /** The runs the totals came from, as at confirmation. */
  runs: YearEndRunLine[];
  result: YearEndResult;
  /** 精算の仕訳; `null` when 過不足 was 0. */
  settlementEntry: EntryRef | null;
  confirmedAt: Date;
  confirmedBy: string;
}

const snapshotRunSchema = z.object({
  kind: z.enum(["monthly", "bonus"]),
  runId: z.string().min(1),
  payMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  label: z.string().min(1),
  pay: z.string().regex(/^\d+$/),
  socialInsurance: z.string().regex(/^\d+$/),
  withheld: z.string().regex(/^\d+$/),
});

const yearEndSnapshotSchema = z.object({
  input: yearEndSnapshotInputSchema,
  runs: z.array(snapshotRunSchema),
  result: z.record(z.string(), z.unknown()),
});

/**
 * The snapshot read back: the inputs through the declaration's schema, the result recalculated with
 * the pinned table and checked against the stored 年調年税額 and 過不足 (a mismatch is a data bug).
 */
function readYearEnd(
  row: PayrollYearEnd,
  run: StoredRun | undefined,
  entry: EntryRef | null,
): YearEndRecord {
  const parsed = yearEndSnapshotSchema.safeParse(row.snapshot);
  if (!parsed.success) throw new Error(`payroll year-end ${row.id}: the snapshot is malformed`);
  const table = findTableById(row.tableId);
  if (table?.kind !== "year-end") {
    throw new Error(
      `payroll year-end ${row.id}: ${row.tableId} is not a registered year-end table`,
    );
  }
  if (!run) throw new Error(`payroll year-end ${row.id}: run ${row.settledRunId} is missing`);
  const input = parsed.data.input;
  const result = calculateYearEnd({ ...input, table });
  if (result.annualTax !== row.annualTax || result.difference !== row.difference) {
    throw new Error(`payroll year-end ${row.id}: the recalculation differs from the stored result`);
  }
  return {
    id: row.id,
    year: row.year,
    employeeId: row.employeeId,
    settledRun: { id: run.row.id, payMonth: run.payMonth, paymentDate: run.paymentDate },
    input,
    runs: parsed.data.runs.map((line) => ({
      kind: line.kind,
      runId: line.runId,
      payMonth: line.payMonth as YearMonth,
      paymentDate: line.paymentDate as CalendarDate,
      label: line.label,
      pay: BigInt(line.pay),
      socialInsurance: BigInt(line.socialInsurance),
      withheld: BigInt(line.withheld),
    })),
    result,
    settlementEntry: entry,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy,
  };
}

async function readYearEnds(
  db: Db,
  rows: readonly PayrollYearEnd[],
  runs: readonly StoredRun[],
): Promise<Map<string, YearEndRecord>> {
  const refs = await entryRefs(
    db,
    rows.map((row) => row.settlementEntryId),
  );
  const byId = new Map(runs.map((run) => [run.row.id, run]));
  return new Map(
    rows.map((row) => [
      row.employeeId,
      readYearEnd(
        row,
        byId.get(row.settledRunId),
        row.settlementEntryId ? (refs.get(row.settlementEntryId) ?? null) : null,
      ),
    ]),
  );
}

/** The confirmed 年末調整 of `employeeId` for `year`, or `null`. */
export async function getYearEndRecord(
  db: Db,
  year: number,
  employeeId: string,
): Promise<YearEndRecord | null> {
  if (!Number.isSafeInteger(year) || typeof employeeId !== "string" || employeeId === "") {
    return null;
  }
  const row = await db.payrollYearEnd.findUnique({
    where: { year_employeeId: { year, employeeId } },
  });
  if (!row) return null;
  const records = await readYearEnds(db, [row], await loadRuns(db));
  return records.get(employeeId) ?? null;
}

// ---------------------------------------------------------------------------------------------
// 年末調整 (§11.5): 一覧・プレビュー・確定
// ---------------------------------------------------------------------------------------------

/** The December run a settlement goes with, as the screens show it. */
export interface YearEndDecemberRun {
  id: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  /** `null`: 未払金〔給与〕. */
  payFromWallet: { id: string; name: string } | null;
}

async function decemberRunView(db: Db, run: StoredRun | null): Promise<YearEndDecemberRun | null> {
  if (!run) return null;
  const wallet = run.row.payFromWalletId
    ? await db.wallet.findUnique({
        where: { id: run.row.payFromWalletId },
        select: { id: true, name: true },
      })
    : null;
  return {
    id: run.row.id,
    payMonth: run.payMonth,
    paymentDate: run.paymentDate,
    payFromWallet: wallet,
  };
}

/** One person of 年末調整の一覧. */
export interface YearEndListRow {
  employee: Pick<EmployeeRecord, "id" | "name" | "kind" | "isActive" | "taxColumn">;
  /** The saved declaration's time, `null` = 未入力. */
  declaration: { updatedAt: Date; updatedBy: string } | null;
  inDecemberRun: boolean;
  /** The confirmed result, or the preview's (概算) when not confirmed. */
  result: YearEndResult;
  /** Why 確定 is not possible yet (empty when confirmed or ready). */
  blockers: string[];
  confirmed: {
    id: string;
    confirmedAt: Date;
    confirmedBy: string;
    settlementEntry: EntryRef | null;
  } | null;
}

export interface YearEndOverview {
  year: number;
  table: TableRef;
  decemberRun: YearEndDecemberRun | null;
  rows: YearEndListRow[];
}

/**
 * 年末調整の一覧 (§11.5) of `year`: everyone paid in the year (monthly or bonus), every active
 * employee and everyone with a declaration or a confirmed 年末調整 of the year; the declaration's
 * state, the estimated (or confirmed) 過不足, and what still blocks 確定. Throws
 * `PayrollTableMissingError` for a year without data.
 */
export async function loadYearEnd(db: Db, year: number): Promise<YearEndOverview> {
  const context = await loadYearEndContext(db, year);
  const [employees, declarations, confirmedRows] = await Promise.all([
    db.employee.findMany(),
    db.payrollYearEndDeclaration.findMany({ where: { year } }),
    db.payrollYearEnd.findMany({ where: { year } }),
  ]);
  const confirmed = await readYearEnds(db, confirmedRows, context.runs);
  const declared = new Map(declarations.map((row) => [row.employeeId, toDeclarationRecord(row)]));
  const paid = new Set<string>();
  for (const run of context.runs) {
    if (inYear(run.paymentDate, year)) for (const item of run.items) paid.add(item.employeeId);
  }
  for (const run of context.bonuses) {
    if (inYear(run.paymentDate, year)) for (const item of run.items) paid.add(item.employeeId);
  }
  const listed = employees
    .filter(
      (row: Employee) =>
        row.isActive || paid.has(row.id) || declared.has(row.id) || confirmed.has(row.id),
    )
    .sort(employeeOrder)
    .map(toEmployeeRecord);
  const rows = listed.map((employee): YearEndListRow => {
    const declaration = declared.get(employee.id) ?? null;
    const record = confirmed.get(employee.id) ?? null;
    const plan = planFor(context, employee, declaration, null);
    return {
      employee: {
        id: employee.id,
        name: employee.name,
        kind: employee.kind,
        isActive: employee.isActive,
        taxColumn: plan.input.taxColumn,
      },
      declaration: declaration
        ? { updatedAt: declaration.updatedAt, updatedBy: declaration.updatedBy }
        : null,
      inDecemberRun: plan.inDecemberRun,
      result: record?.result ?? plan.result,
      blockers: record ? [] : plan.blockers,
      confirmed: record
        ? {
            id: record.id,
            confirmedAt: record.confirmedAt,
            confirmedBy: record.confirmedBy,
            settlementEntry: record.settlementEntry,
          }
        : null,
    };
  });
  return {
    year,
    table: tableRef(context.table),
    decemberRun: await decemberRunView(db, context.decemberRun),
    rows,
  };
}

/** The 源泉所得税 deadline the settlement goes into and the entry it posts. */
export interface YearEndSettlementPreview {
  slot: { ruleKey: string; title: string; dueDate: CalendarDate };
  /** `null` when 過不足 is 0 (nothing is posted) or the ledger refuses it (see `blockers`). */
  entry: PayrollEntryPreview | null;
}

/** 年末調整の画面 (§11.5): the declaration, the year's totals, every step and what 確定 does. */
export interface YearEndPreview {
  year: number;
  table: TableRef;
  /** The year's birth-date ranges (特定扶養・老人・16 歳以上・23 歳未満), for the form's help. */
  birthDates: YearEndTable["birthDates"];
  employee: EmployeeRecord;
  /** The saved declaration, `null` = 未入力. */
  declaration: YearEndDeclarationRecord | null;
  /** What the result was computed with: the form's values, else the saved declaration, else empty. */
  usedDeclaration: YearEndDeclaration;
  totals: YearEndTotals;
  /** 甲欄 / 乙欄 at the last pay (the December run's), else the master data's. */
  taxColumn: "kou" | "otsu";
  result: YearEndResult;
  decemberRun: YearEndDecemberRun | null;
  inDecemberRun: boolean;
  /** Why 確定 is not possible now; empty when it is. */
  blockers: string[];
  /** `null` until the December run is confirmed. */
  settlement: YearEndSettlementPreview | null;
  /** Set once confirmed (the screen then shows this record instead of the preview). */
  confirmed: YearEndRecord | null;
}

/**
 * The 年末調整 of one person (§11.5), without writing anything: the totals of the confirmed runs paid
 * in the year, the saved declaration (or `options.declaration`, the form's unsaved values) and every
 * step, the December run, the settlement entry it would post (the ledger's checks included) and the
 * blockers of 確定.
 */
export async function previewYearEnd(
  db: Db,
  year: number,
  employeeId: string,
  options: { declaration?: YearEndDeclarationFormInput } = {},
): Promise<YearEndPreview> {
  const override = options.declaration ? yearEndDeclarationSchema.parse(options.declaration) : null;
  const context = await loadYearEndContext(db, year);
  const row =
    typeof employeeId === "string" && employeeId !== ""
      ? await db.employee.findUnique({ where: { id: employeeId } })
      : null;
  if (!row) {
    throw new SettingsError("従業員が見つかりません。画面を読み込み直してください", {
      field: "employeeId",
    });
  }
  const employee = toEmployeeRecord(row);
  const [declarationRow, confirmedRow] = await Promise.all([
    db.payrollYearEndDeclaration.findUnique({
      where: { year_employeeId: { year, employeeId } },
    }),
    db.payrollYearEnd.findUnique({ where: { year_employeeId: { year, employeeId } } }),
  ]);
  const declaration = declarationRow ? toDeclarationRecord(declarationRow) : null;
  const confirmed = confirmedRow
    ? ((await readYearEnds(db, [confirmedRow], context.runs)).get(employeeId) ?? null)
    : null;
  const plan = planFor(context, employee, declaration, override);
  const blockers = confirmed ? [] : [...plan.blockers];
  const run = context.decemberRun;
  let settlement: YearEndSettlementPreview | null = null;
  if (run) {
    const slot = withholdingSlot(run.payMonth, run.row.withholdingSpecialDue);
    const difference = confirmed?.result.difference ?? plan.result.difference;
    let entry: PayrollEntryPreview | null = null;
    const entryPlan = buildYearEndSettlementEntry({
      year,
      name: employee.name,
      difference,
      payFrom: run.row.payFromWalletId ? "wallet" : "accrued",
    });
    if (entryPlan) {
      try {
        const refs = await loadLedgerRefs(db, {
          date: run.paymentDate,
          walletId: run.row.payFromWalletId,
          lock: false,
          dateField: "paymentDate",
          walletField: "payFromWalletId",
        });
        const built = toJournalEntry(entryPlan, refs, {
          date: run.paymentDate,
          sourceId: "preview",
          pendingSubAccounts: true,
        });
        if (!confirmed) assertPostable(built.entry, refs);
        entry = built.preview;
      } catch (error) {
        if (!(error instanceof LedgerValidationError || error instanceof SettingsError))
          throw error;
        if (!confirmed) blockers.push(error.message);
      }
    }
    if (!confirmed && difference !== 0n) {
      const item = await db.calendarItem.findFirst({
        where: { fiscalYearId: null, ruleKey: slot.ruleKey },
      });
      if (item?.completedAt) {
        blockers.push(
          `「${item.title}」は納付済みにしています。精算はこの納付に足すので、納付済みを戻してから確定します`,
        );
      }
    }
    settlement = {
      slot: { ruleKey: slot.ruleKey, title: slot.title, dueDate: slot.dueDate },
      entry,
    };
  }
  return {
    year,
    table: tableRef(context.table),
    birthDates: context.table.birthDates,
    employee,
    declaration,
    usedDeclaration: plan.input.declaration,
    totals: plan.totals,
    taxColumn: plan.input.taxColumn,
    result: confirmed?.result ?? plan.result,
    decemberRun: await decemberRunView(db, run),
    inDecemberRun: plan.inDecemberRun,
    blockers,
    settlement,
    confirmed,
  };
}

/**
 * 年末調整を確定 (§11.4): in one transaction — the payroll lock → the plan (as the preview, with the
 * saved declaration) → the checks (the December run includes the person, a saved declaration, 対象,
 * not confirmed yet, what the dialog showed, the deadline still open, no paid deadline moves) → the
 * settlement entry on the December run's payment date (過納 2300 預り金〔源泉所得税〕 / 2100 未払金
 * 〔給与〕 or the run's wallet, 不足 the reverse, none for 0) → the `PayrollYearEnd` row → the 源泉所得税
 * deadline when there was none → the audit log `payroll_year_end.confirm`.
 */
export async function confirmYearEnd(
  db: Db,
  year: number,
  employeeId: string,
  options: ActorOptions & {
    /** 年調年税額 and 過不足 the confirmation dialog showed (whole yen, as bigint or digits). */
    expected?: YearEndConfirmInput["expected"];
  },
): Promise<YearEndRecord> {
  const data = yearEndConfirmSchema.parse({ year, employeeId, expected: options.expected ?? null });
  return runInTransaction(db, async (tx) => {
    await lockSettings(tx, "payroll");
    const context = await loadYearEndContext(tx, data.year);
    const row = await tx.employee.findUnique({ where: { id: data.employeeId } });
    if (!row) {
      throw new SettingsError("従業員が見つかりません。画面を読み込み直してください", {
        field: "employeeId",
      });
    }
    const employee = toEmployeeRecord(row);
    const key = { year_employeeId: { year: data.year, employeeId: data.employeeId } };
    if (await tx.payrollYearEnd.findUnique({ where: key, select: { id: true } })) {
      throw new SettingsError(
        `${employee.name}さんの ${data.year} 年分の年末調整は確定済みです。画面を読み込み直してください`,
      );
    }
    const declarationRow = await tx.payrollYearEndDeclaration.findUnique({ where: key });
    const declaration = declarationRow ? toDeclarationRecord(declarationRow) : null;
    const plan = planFor(context, employee, declaration, null);
    const [blocker] = plan.blockers;
    if (blocker !== undefined) throw new SettingsError(blocker);
    const run = context.decemberRun;
    if (!run) throw new Error("unreachable: a plan without blockers has the December run");
    const { result } = plan;
    if (
      data.expected &&
      (data.expected.annualTax !== result.annualTax ||
        data.expected.difference !== result.difference)
    ) {
      throw new SettingsError(
        `計算の結果が確認した内容と変わりました（年調年税額 ${formatYen(data.expected.annualTax)} 円 → ${formatYen(result.annualTax)} 円、過不足 ${formatYen(data.expected.difference)} 円 → ${formatYen(result.difference)} 円）。画面を読み込み直して、もう一度確かめてください`,
      );
    }

    const slot = withholdingSlot(run.payMonth, run.row.withholdingSpecialDue);
    const existingSlot =
      result.difference === 0n
        ? null
        : await tx.calendarItem.findFirst({ where: { fiscalYearId: null, ruleKey: slot.ruleKey } });
    if (existingSlot?.completedAt) {
      throw new SettingsError(
        `「${existingSlot.title}」は納付済みにしています。年末調整の精算はこの納付に足すので、納付済みを戻してから確定してください`,
      );
    }
    const summary = summarizeYearEndSettlement({
      payMonth: run.payMonth,
      withholdingSpecialDue: run.row.withholdingSpecialDue,
      difference: result.difference,
    });
    if (result.difference !== 0n) await assertPaidPaymentsUnchanged(tx, [summary]);

    const id = newId();
    let settlementEntryId: string | null = null;
    const entryPlan = buildYearEndSettlementEntry({
      year: data.year,
      name: employee.name,
      difference: result.difference,
      payFrom: run.row.payFromWalletId ? "wallet" : "accrued",
    });
    if (entryPlan) {
      try {
        const refs = await loadLedgerRefs(tx, {
          date: run.paymentDate,
          walletId: run.row.payFromWalletId,
          lock: true,
          dateField: "paymentDate",
          walletField: "payFromWalletId",
        });
        await ensurePayrollSubAccounts(tx, refs, options);
        const { entry } = toJournalEntry(entryPlan, refs, {
          date: run.paymentDate,
          sourceId: id,
          pendingSubAccounts: false,
        });
        settlementEntryId = (
          await postJournalEntryInTransaction(
            tx,
            { ...entry, fiscalYearId: refs.fiscalYear.id },
            options,
          )
        ).id;
      } catch (error) {
        if (error instanceof LedgerValidationError) throw withDateField(error, "paymentDate");
        throw error;
      }
    }

    const { table: _table, ...input } = plan.input;
    const snapshot = toAuditJson({ input, runs: plan.totals.runs, result });
    await tx.payrollYearEnd
      .create({
        data: {
          id,
          year: data.year,
          employeeId: data.employeeId,
          settledRunId: run.row.id,
          tableId: context.table.id,
          snapshot,
          annualTax: result.annualTax,
          difference: result.difference,
          settlementEntryId,
          confirmedBy: options.actor,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new SettingsError(
            `${employee.name}さんの ${data.year} 年分の年末調整は確定済みです。画面を読み込み直してください`,
          );
        }
        throw error;
      });
    if (result.difference !== 0n && !existingSlot) {
      await tx.calendarItem.create({
        data: {
          id: newId(),
          fiscalYearId: null,
          kind: "payment",
          title: slot.title,
          dueDate: toDbDate(slot.dueDate),
          ruleKey: slot.ruleKey,
        },
      });
    }
    await appendAuditLog(tx, {
      actor: options.actor,
      action: "payroll_year_end.confirm",
      entity: "payroll_year_end",
      entityId: id,
      after: {
        year: data.year,
        employeeId: data.employeeId,
        settledRunId: run.row.id,
        tableId: context.table.id,
        declarationId: declaration?.id ?? null,
        totalPay: result.totalPay,
        annualTax: result.annualTax,
        withheld: result.withheld,
        difference: result.difference,
        settlementEntryId,
        ruleKey: result.difference === 0n ? null : slot.ruleKey,
      },
    });
    const record = await getYearEndRecord(tx, data.year, data.employeeId);
    if (!record) throw new Error(`payroll year-end ${id} disappeared`);
    return record;
  });
}

// ---------------------------------------------------------------------------------------------
// 源泉徴収簿 (§11.4)
// ---------------------------------------------------------------------------------------------

/** One monthly pay of 源泉徴収簿. */
export interface WithholdingLedgerMonth {
  runId: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  /** 総支給金額 (課税). */
  taxablePay: Money;
  /** 非課税 (通勤手当). */
  nonTaxablePay: Money;
  /** 社会保険料 (健保・介護・支援金・厚年、調整後). */
  socialInsurance: Money;
  employmentInsurance: Money;
  /** 社会保険料等控除後の給与等の金額. */
  withholdingBase: Money;
  /** 甲欄の扶養親族等の数, `null` for 乙欄. */
  dependents: number | null;
  /** 算出税額 (税額表) and the adjustment. */
  tableTax: Money;
  adjustment: Money;
  /** 差引徴収税額. */
  withheld: Money;
}

/** One bonus of 源泉徴収簿. */
export interface WithholdingLedgerBonus {
  runId: string;
  payMonth: YearMonth;
  paymentDate: CalendarDate;
  title: string;
  bonus: Money;
  socialInsurance: Money;
  employmentInsurance: Money;
  withholdingBase: Money;
  /** 「4.084%」 or how the monthly table was used. */
  rate: string;
  withheld: Money;
}

/** 源泉徴収簿 of one person and year (§11.4), derived from the confirmed records. */
export interface WithholdingLedger {
  year: number;
  companyName: string;
  employee: { id: string; name: string; kind: WorkerKind };
  months: WithholdingLedgerMonth[];
  bonuses: WithholdingLedgerBonus[];
  totals: {
    taxablePay: Money;
    socialInsurance: Money;
    employmentInsurance: Money;
    withheld: Money;
    bonus: Money;
    bonusSocialInsurance: Money;
    bonusEmploymentInsurance: Money;
    bonusWithheld: Money;
  };
  /** 年末調整の欄: the confirmed one, or the estimate (概算) while not confirmed. */
  yearEnd:
    | {
        state: "confirmed" | "estimate";
        result: YearEndResult;
        confirmedAt: Date | null;
        settlementEntry: EntryRef | null;
      }
    | { state: "unavailable"; message: string };
}

/**
 * 源泉徴収簿 (§11.4): the person's monthly pays and bonuses paid in `year` (by payment date) from the
 * confirmed runs, and the 年末調整 columns (confirmed, or the estimate with the saved declaration).
 * `null` when there is no such employee.
 */
export async function loadWithholdingLedger(
  db: Db,
  year: number,
  employeeId: string,
): Promise<WithholdingLedger | null> {
  if (!Number.isSafeInteger(year) || typeof employeeId !== "string" || employeeId === "") {
    return null;
  }
  const row = await db.employee.findUnique({ where: { id: employeeId } });
  if (!row) return null;
  const [runs, bonusRuns, company] = await Promise.all([
    loadRuns(db),
    loadBonusRuns(db),
    db.company.findFirst({ select: { name: true } }),
  ]);
  const months: WithholdingLedgerMonth[] = [];
  for (const run of runs) {
    if (!inYear(run.paymentDate, year)) continue;
    const item = run.items.find((candidate) => candidate.employeeId === employeeId);
    if (!item) continue;
    const { input, result } = item;
    months.push({
      runId: run.row.id,
      payMonth: run.payMonth,
      paymentDate: run.paymentDate,
      taxablePay: input.taxablePay,
      nonTaxablePay: input.nonTaxablePay,
      socialInsurance: result.socialInsuranceEmployeeTotal,
      employmentInsurance: result.employmentInsurance?.employee ?? 0n,
      withholdingBase: result.withholdingBase,
      dependents: input.taxColumn.column === "kou" ? input.taxColumn.dependents : null,
      tableTax: result.incomeTax,
      adjustment: result.adjustments.incomeTax,
      withheld: result.incomeTaxTotal,
    });
  }
  const bonuses: WithholdingLedgerBonus[] = [];
  for (const run of bonusRuns) {
    if (!inYear(run.paymentDate, year)) continue;
    const item = run.items.find((candidate) => candidate.employeeId === employeeId);
    if (!item || item.result.bonus === 0n) continue;
    const { result } = item;
    bonuses.push({
      runId: run.row.id,
      payMonth: run.payMonth,
      paymentDate: run.paymentDate,
      title: run.row.title,
      bonus: result.bonus,
      socialInsurance: result.socialInsurance.employeeTotal,
      employmentInsurance: result.employmentInsurance?.employee ?? 0n,
      withholdingBase: result.withholdingBase,
      rate:
        result.withholding.method === "rate" && result.withholding.ratePercent !== null
          ? `${result.withholding.ratePercent}%`
          : BONUS_WITHHOLDING_METHOD_LABELS[result.withholding.method],
      withheld: result.incomeTax,
    });
  }
  const byDate = <T extends { paymentDate: CalendarDate }>(a: T, b: T) =>
    a.paymentDate < b.paymentDate ? -1 : a.paymentDate > b.paymentDate ? 1 : 0;
  months.sort(byDate);
  bonuses.sort(byDate);
  const sum = <T>(rows: readonly T[], pick: (row: T) => Money) =>
    rows.reduce((total, item) => total + pick(item), 0n);

  let yearEnd: WithholdingLedger["yearEnd"];
  try {
    const preview = await previewYearEnd(db, year, employeeId);
    yearEnd = preview.confirmed
      ? {
          state: "confirmed",
          result: preview.confirmed.result,
          confirmedAt: preview.confirmed.confirmedAt,
          settlementEntry: preview.confirmed.settlementEntry,
        }
      : { state: "estimate", result: preview.result, confirmedAt: null, settlementEntry: null };
  } catch (error) {
    if (!(error instanceof PayrollTableMissingError)) throw error;
    yearEnd = { state: "unavailable", message: error.message };
  }

  return {
    year,
    companyName: company?.name ?? "",
    employee: { id: row.id, name: row.name, kind: row.kind },
    months,
    bonuses,
    totals: {
      taxablePay: sum(months, (month) => month.taxablePay),
      socialInsurance: sum(months, (month) => month.socialInsurance),
      employmentInsurance: sum(months, (month) => month.employmentInsurance),
      withheld: sum(months, (month) => month.withheld),
      bonus: sum(bonuses, (bonus) => bonus.bonus),
      bonusSocialInsurance: sum(bonuses, (bonus) => bonus.socialInsurance),
      bonusEmploymentInsurance: sum(bonuses, (bonus) => bonus.employmentInsurance),
      bonusWithheld: sum(bonuses, (bonus) => bonus.withheld),
    },
    yearEnd,
  };
}
