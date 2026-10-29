/**
 * 賞与 (22-payroll §10): the bonus run (計算 → 確定), its payslips and what it adds to the payment
 * schedule. The year-end adjustment and the statutory reports (§11・§12) follow in this module.
 *
 * - The calculation, the entries, the deadlines and the snapshot are pure functions of
 *   `@niho-finance/payroll` (`bonus.ts`); this layer reads the master data and the earlier runs,
 *   and posts through the path of the monthly run (`payroll.ts`): the payroll lock, the fiscal-year
 *   lock, `buildVoucherEntry`, `postJournalEntryInTransaction` with `sourceKind = payroll`.
 * - A confirmed bonus run is append-only (DB trigger). Its 源泉所得税 and 社会保険料 are derived into the
 *   same deadlines as the monthly runs (`listPayrollSchedule` adds them).
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
  bonusReportSlot,
  bonusTableIdsOf,
  buildBonusEntries,
  calculateBonus,
  findTableById,
  insuranceYearOf,
  isTableEffective,
  parseBonusRunItems,
  parseBonusTableIds,
  PAYROLL_BONUS_SUB_ACCOUNTS,
  PAYROLL_PAYMENT_CATEGORY_LABELS,
  PAYROLL_SUB_ACCOUNTS,
  PayrollInputError,
  pinnedBonusTables,
  predeterminedFilingWarnings,
  runPaymentSlots,
  scheduleAmount,
  serializeBonusRunItems,
  serializeBonusTableIds,
  shiftYearMonth,
  summarizeBonusRun,
  tableRef,
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
  type YearMonth,
} from "@niho-finance/payroll";
import type { PayrollBonusRun, Prisma } from "@prisma/client";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDate, toDbDate } from "./dates";
import type { EntryRef } from "./entries";
import { isUniqueViolation, SettingsError } from "./errors";
import { newId } from "./ids";
import { postJournalEntryInTransaction, type ActorOptions } from "./journal";
import {
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
} from "./payroll";
import {
  payrollBonusRunSchema,
  type ParsedPayrollBonusRun,
  type PayrollBonusRunInput,
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
