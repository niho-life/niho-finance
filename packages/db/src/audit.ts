import type { Prisma, PrismaClient } from "@prisma/client";
import { newId } from "./ids";

export type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  /** Email of the authenticated user, or `system` / `seed`. */
  actor: string;
  /** `<entity>.<verb>`, e.g. `journal_entry.post`. */
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** JSON-safe snapshot: bigint → decimal string, Date → ISO string. */
export function toAuditJson(value: unknown): Prisma.InputJsonValue {
  const text = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  return JSON.parse(text) as Prisma.InputJsonValue;
}

/**
 * Appends to the audit log. There is deliberately no update or delete:
 * the table is append-only (DB triggers reject UPDATE / DELETE / TRUNCATE).
 */
export async function appendAuditLog(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      id: newId(),
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      ...(entry.before === undefined ? {} : { before: toAuditJson(entry.before) }),
      ...(entry.after === undefined ? {} : { after: toAuditJson(entry.after) }),
      reason: entry.reason ?? null,
    },
  });
}
