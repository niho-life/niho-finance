"use server";

import {
  getPrismaClient,
  saveStatementFields,
  setPartnerIndividual,
  type YearEndStatementSaveInput,
} from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";
import { attemptPayroll } from "../_lib/errors";

/*
 * Server Actions of 給与 › 法定調書 (22-payroll §12.2). The repository validates every input and
 * writes the audit log; a マイナンバー never comes here (it is typed on the CSV form only).
 */

const valuesSchema = z.record(z.string(), z.unknown());
const yearSchema = z.number().int().min(2000).max(2100);

/** 法定調書の欄を保存: フリガナ・住所・市町村コード・受給者番号 and the relatives' names. */
export async function saveStatementFieldsAction(
  year: number,
  employeeId: string,
  values: unknown,
): Promise<ActionResult<null>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await attemptPayroll(async () =>
    saveStatementFields(
      getPrismaClient(),
      {
        ...(valuesSchema.parse(values) as Omit<YearEndStatementSaveInput, "year" | "employeeId">),
        year: yearSchema.parse(year),
        employeeId: parseId(employeeId),
      },
      { actor: await actor() },
    ),
  );
  if (!result.ok) return result;
  revalidatePath("/payroll", "layout");
  return { ok: true, data: null };
}

/** 個人 / 法人 / 未確認 of a partner (only individuals get a 報酬の支払調書). */
export async function setPartnerIndividualAction(
  partnerId: string,
  choice: string,
): Promise<ActionResult<{ name: string }>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await attemptPayroll(async () =>
    setPartnerIndividual(
      getPrismaClient(),
      { id: parseId(partnerId), choice },
      { actor: await actor() },
    ),
  );
  if (!result.ok) return result;
  revalidatePath("/payroll", "layout");
  return { ok: true, data: { name: result.data.name } };
}
