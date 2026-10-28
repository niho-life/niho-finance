/**
 * A rejected settings or setup change. `message` is owner-facing Japanese that states what is
 * wrong and how to get back (05-ui-ux §4); `field` names the input it belongs to, when there is one
 * (dot path for rows, e.g. `formationCosts.1.amount`).
 */
export class SettingsError extends Error {
  readonly field: string | undefined;

  constructor(message: string, options: { field?: string } = {}) {
    super(message);
    this.name = "SettingsError";
    this.field = options.field;
  }
}

/** Prisma's unique-constraint violation (P2002), e.g. two requests adding the same code at once. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
