import { PayrollInputError, PayrollTableMissingError } from "@niho-finance/payroll";
import { toActionError } from "@/lib/action-result";
import type { ActionError, ActionResult } from "@/lib/action-types";
import { TABLE_MISSING_HINT } from "./labels";

const unique = (messages: readonly string[]) => [...new Set(messages)];

/**
 * The two errors of `@niho-finance/payroll` that `toActionError` does not know: an input that
 * breaks a payroll rule (fields `items.<n>.<field>`, owner-facing messages) and a missing yearly
 * table (form-level, with the way to import it). Everything else goes to `toActionError`.
 */
export function toPayrollActionError(error: unknown): ActionError {
  if (error instanceof PayrollInputError) {
    const fieldErrors: Record<string, string> = {};
    const formLevel: string[] = [];
    for (const issue of error.issues) {
      if (issue.field) fieldErrors[issue.field] ??= issue.message;
      else formLevel.push(issue.message);
    }
    return {
      ok: false,
      error: unique(error.issues.map((issue) => issue.message)).join(" / "),
      fieldErrors,
      formError: formLevel.length > 0 ? unique(formLevel).join(" / ") : null,
    };
  }
  if (error instanceof PayrollTableMissingError) {
    const message = `${error.message}。${TABLE_MISSING_HINT}`;
    return { ok: false, error: message, fieldErrors: {}, formError: message };
  }
  return toActionError(error);
}

/** `attempt` of `@/lib/action-result` that also knows the payroll errors. */
export async function attemptPayroll<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return toPayrollActionError(error);
  }
}
