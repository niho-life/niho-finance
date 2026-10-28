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
}

export type ActionResult<T = null> = { ok: true; data: T } | ActionError;

/** The edited fields of a row after a save, as the inputs show them. */
export type RowValues = Record<string, string | boolean>;
