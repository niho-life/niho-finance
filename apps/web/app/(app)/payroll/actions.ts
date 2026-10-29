"use server";

import {
  confirmBonusRun,
  confirmPayrollRun,
  createEmployee,
  getPrismaClient,
  markPayrollPaymentDone,
  postPayrollPayment,
  setEmployeeActive,
  SettingsError,
  todayInJapan,
  updateEmployee,
  type EmployeeCreateInput,
  type EmployeeUpdateInput,
  type PayrollBonusRunInput,
  type PayrollPaymentInput,
  type PayrollRunInput,
} from "@niho-finance/db";
import { formatYenInput, parseYenInput } from "@niho-finance/ledger";
import {
  determineStandardRemuneration,
  findKenpoTable,
  findPensionTable,
  yearMonthLabel,
  yearMonthOf,
} from "@niho-finance/payroll";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseBoolean, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";
import { loadBonusPreview, type BonusPreviewView } from "./_lib/bonus-views";
import { attemptPayroll } from "./_lib/errors";
import {
  loadPaymentPreview,
  loadRunPreview,
  type PaymentPreviewView,
  type RunPreviewView,
} from "./_lib/views";

/*
 * Server Actions of /payroll (22-payroll §6). The repository validates every input with its Zod
 * schemas and writes the audit log as `NIHO_FINANCE_ACTOR`; expected failures come back as
 * `{ ok: false }` with the field of each problem (`items.<n>.<field>` for a person of a run).
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

/** Form values from the client: a plain object (the repository checks every field). */
const valuesSchema = z.record(z.string(), z.unknown());

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attemptPayroll(run);
  if (!result.ok) return result;
  // The payroll pages, the entries (new journal entries) and the home read what changed.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

// 従業員 (§6.2) ----------------------------------------------------------------

export interface SavedEmployee {
  name: string;
  /** Shown after saving (保存は止めない). */
  warnings: string[];
}

/** 追加 (`id` = null) or 保存. */
export async function saveEmployeeAction(
  id: string | null,
  values: unknown,
): Promise<ActionResult<SavedEmployee>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () => {
      const input = valuesSchema.parse(values);
      return id === null
        ? createEmployee(prisma(), input as EmployeeCreateInput, await by())
        : updateEmployee(
            prisma(),
            { ...input, id: parseId(id) } as EmployeeUpdateInput,
            await by(),
          );
    },
    ({ employee, warnings }) => ({
      name: employee.name,
      warnings: warnings.map((warning) => warning.message),
    }),
  );
}

export async function setEmployeeActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      setEmployeeActive(
        prisma(),
        { id: parseId(id), isActive: parseBoolean(isActive) },
        await by(),
      ),
    () => null,
  );
}

export interface StandardRemunerationView {
  health: { grade: number; smr: string };
  pension: { grade: number; smr: string };
  /** 「2026 年 10 月分の等級表」 */
  basis: string;
}

function standardRemunerationOf(remuneration: unknown): StandardRemunerationView {
  const amount = parseYenInput(z.string().max(30).parse(remuneration));
  if (amount === null) {
    throw new SettingsError("報酬月額は 0 円以上の円の整数で入力してください", {
      field: "remuneration",
    });
  }
  const month = yearMonthOf(todayInJapan());
  const result = determineStandardRemuneration(
    { kenpo: findKenpoTable(month), pension: findPensionTable(month) },
    amount,
  );
  return {
    health: { grade: result.health.grade, smr: formatYenInput(result.health.smr) },
    pension: { grade: result.pension.grade, smr: formatYenInput(result.pension.smr) },
    basis: `${yearMonthLabel(month)}分の等級表`,
  };
}

/** 報酬月額から求める: the grades of this month's kenpo / pension tables (nothing is written). */
export async function standardRemunerationAction(
  remuneration: string,
): Promise<ActionResult<StandardRemunerationView>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return attemptPayroll(() => Promise.resolve(standardRemunerationOf(remuneration)));
}

// 支給の計算と確定 (§6.3) --------------------------------------------------------

/** The results, the 2 entries and the deadlines of the form's values (nothing is written). */
export async function previewPayrollRunAction(
  values: unknown,
): Promise<ActionResult<RunPreviewView>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return attemptPayroll(() =>
    loadRunPreview(prisma(), valuesSchema.parse(values) as PayrollRunInput),
  );
}

export interface ConfirmedRun {
  id: string;
  /** 「2026 年 12 月」 */
  payMonthLabel: string;
}

/** 確定: the values with `tableIds` and `expected` of the preview the owner confirmed. */
export async function confirmPayrollRunAction(
  values: unknown,
): Promise<ActionResult<ConfirmedRun>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      confirmPayrollRun(prisma(), valuesSchema.parse(values) as PayrollRunInput, await by()),
    (run) => ({ id: run.id, payMonthLabel: yearMonthLabel(run.payMonth) }),
  );
}

// 納付 (§5.4・§6.6) ---------------------------------------------------------------

export async function previewPayrollPaymentAction(
  values: unknown,
): Promise<ActionResult<PaymentPreviewView>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return attemptPayroll(() =>
    loadPaymentPreview(prisma(), valuesSchema.parse(values) as PayrollPaymentInput),
  );
}

export interface PostedPayment {
  title: string;
  no: number;
}

/** 納付を登録: the entry of §5.4, and the deadline becomes 納付済み. */
export async function postPayrollPaymentAction(
  values: unknown,
): Promise<ActionResult<PostedPayment>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      postPayrollPayment(prisma(), valuesSchema.parse(values) as PayrollPaymentInput, await by()),
    ({ item, entry }) => ({ title: item.title, no: entry.no }),
  );
}

/** 納付済みにする: the payment was registered from the wallet's statement (no entry here). */
export async function markPayrollPaymentDoneAction(
  calendarItemId: string,
): Promise<ActionResult<{ title: string }>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () => markPayrollPaymentDone(prisma(), parseId(calendarItemId), await by()),
    (row) => ({ title: row.title }),
  );
}

// 賞与 (§10.5) -------------------------------------------------------------------

/** The results, the 2 entries, the deadlines and the warnings of the form's values (no write). */
export async function previewBonusRunAction(
  values: unknown,
): Promise<ActionResult<BonusPreviewView>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return attemptPayroll(() =>
    loadBonusPreview(prisma(), valuesSchema.parse(values) as PayrollBonusRunInput),
  );
}

export interface ConfirmedBonusRun {
  id: string;
  /** 「夏季賞与（2026 年 7 月支給）」 */
  label: string;
}

/** 確定: the values with `tableIds` and `expected` of the preview the owner confirmed. */
export async function confirmBonusRunAction(
  values: unknown,
): Promise<ActionResult<ConfirmedBonusRun>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  return write(
    async () =>
      confirmBonusRun(prisma(), valuesSchema.parse(values) as PayrollBonusRunInput, await by()),
    (run) => ({ id: run.id, label: `${run.title}（${yearMonthLabel(run.payMonth)}支給）` }),
  );
}
