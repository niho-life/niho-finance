/**
 * Results of Server Actions (shared with client components: types only, no server imports).
 * Expected failures (validation, rules) come back as `{ ok: false }`; they are never thrown.
 */
export type FieldErrors = Record<string, string>;

export interface ActionError {
  ok: false;
  /** Owner-facing: what is wrong and how to get back. */
  error: string;
  /** By field name (dot path for rows, e.g. `formationCosts.1.amount`). */
  fieldErrors: FieldErrors;
  /** What belongs to no field (shown above the form); `null` when every problem has a field. */
  formError?: string | null;
}

export type ActionResult<T = null> = { ok: true; data: T } | ActionError;

/**
 * The messages a form shows above its fields (11 §4: 項目に結べないものはフォームの上に): the
 * form-level error, plus field errors of fields the form does not show.
 */
export function formLevelErrors(
  error: ActionError | null | undefined,
  shows: (field: string) => boolean,
): string[] {
  if (!error) return [];
  const messages: string[] = [];
  const hasFields = Object.keys(error.fieldErrors).length > 0;
  const formError =
    error.formError === undefined ? (hasFields ? null : error.error) : error.formError;
  if (formError) messages.push(formError);
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    if (!shows(field)) messages.push(message);
  }
  return [...new Set(messages)];
}

/** The edited fields of a row after a save, as the inputs show them. */
export type RowValues = Record<string, string | boolean>;
