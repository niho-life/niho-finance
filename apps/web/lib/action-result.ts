import { isUniqueViolation, SettingsError } from "@niho-finance/db";
import { LedgerValidationError } from "@niho-finance/ledger";
import { z, ZodError } from "zod";
import type { ActionError, ActionResult } from "./action-types";
import { ActorError } from "./actor";

/** A ZodError issue that is not one of our messages (a malformed request, not a typing mistake). */
const SHAPE_ERROR =
  "入力の形式が正しくありません。画面を読み込み直してから、もう一度試してください";
const UNKNOWN_ERROR =
  "保存できませんでした。もう一度試してください。続くときは画面を読み込み直してください";

/** Our schema messages are Japanese; Zod's own (English) ones mean a malformed request. */
const OWNER_FACING = /[^\x20-\x7e\s]/;

function zodFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".");
    fieldErrors[key] ??= OWNER_FACING.test(issue.message) ? issue.message : SHAPE_ERROR;
  }
  return fieldErrors;
}

/** Turns an exception from the repository into an owner-facing result. */
export function toActionError(error: unknown): ActionError {
  if (error instanceof ZodError) {
    const fieldErrors = zodFieldErrors(error);
    return {
      ok: false,
      error: Object.values(fieldErrors)[0] ?? SHAPE_ERROR,
      fieldErrors,
      formError: null,
    };
  }
  if (error instanceof ActorError) {
    return { ok: false, error: error.message, fieldErrors: {} };
  }
  if (error instanceof SettingsError) {
    return {
      ok: false,
      error: error.message,
      fieldErrors: error.field ? { [error.field]: error.message } : {},
      formError: error.field ? null : error.message,
    };
  }
  if (error instanceof LedgerValidationError) {
    // The repository names the form field of each ledger error it can (`field`, 11 §4).
    const fieldErrors: Record<string, string> = {};
    const formLevel: string[] = [];
    for (const item of error.errors) {
      if (item.field) fieldErrors[item.field] ??= item.message;
      else formLevel.push(item.message);
    }
    const unique = (messages: string[]) => [...new Set(messages)].join(" / ");
    return {
      ok: false,
      error: unique(error.errors.map((item) => item.message)),
      fieldErrors,
      formError: formLevel.length > 0 ? unique(formLevel) : null,
    };
  }
  if (isUniqueViolation(error)) {
    return {
      ok: false,
      error: "同じ内容がすでにあります。画面を読み込み直して確かめてください",
      fieldErrors: {},
    };
  }
  console.error("[niho-finance] action failed", error);
  return { ok: false, error: UNKNOWN_ERROR, fieldErrors: {} };
}

/** Runs a repository call; expected failures become `{ ok: false }`. */
export async function attempt<T>(run: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return toActionError(error);
  }
}

/** Form fields as a plain object (Next adds `$ACTION_*` keys; the schemas drop unknown keys). */
export function formValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION")) values[key] = value;
  }
  return values;
}

/** Form fields handed to a repository write as its input type (the repository validates them). */
export function formInput<T = Record<string, string>>(formData: FormData): T {
  return formValues(formData) as T;
}

const idSchema = z.string().min(1).max(64);
const patchSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));

/**
 * Checks the arguments of an inline edit: an id and only the editable fields of the row.
 * Throws ZodError (→ the shape error) for anything else.
 */
export function inlinePatch<const K extends string>(
  id: unknown,
  patch: unknown,
  fields: readonly K[],
): { id: string } & Partial<Record<K, string | boolean>> {
  const parsedId = idSchema.parse(id);
  const parsed = patchSchema.parse(patch);
  const result: Partial<Record<K, string | boolean>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(fields as readonly string[]).includes(key)) {
      throw new ZodError([{ code: "custom", path: [key], message: SHAPE_ERROR, input: value }]);
    }
    result[key as K] = value;
  }
  return { id: parsedId, ...result };
}

export function parseId(id: unknown): string {
  return idSchema.parse(id);
}

export function parseBoolean(value: unknown): boolean {
  return z.boolean().parse(value);
}
