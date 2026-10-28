/**
 * The registry lookup of partners (20-reader §6・§7.3): the invoice registration numbers of the
 * partner master are looked up at the National Tax Agency's publication, and the result is stored on
 * the partner (status, published name, registration and end dates, when it was checked). The lookup
 * runs outside the transaction; the partners, the audit log and the usage row are written in one.
 */
import {
  addDays,
  displayDate,
  isValidInvoiceRegistrationNumber,
  type CalendarDate,
} from "@niho-finance/ledger";
import {
  NtaApiError,
  registrationStatusAt,
  type NtaLookup,
  type NtaLookupResult,
} from "@niho-finance/importers";
import type { InvoiceRegistrationStatus, Partner, Prisma } from "@prisma/client";
import { recordApiUsage } from "./api-usage";
import { appendAuditLog, type Db } from "./audit";
import { fromDbDateOrNull, toDbDate, todayInJapan } from "./dates";
import { partnerRegistryCheckSchema } from "./schemas";
import type { WriteOptions } from "./settings";
import { runInTransaction } from "./transaction";

/** A lookup that failed without a reason of its own. */
export const REGISTRY_LOOKUP_FAILED = "国税庁の公表サイトに接続できませんでした";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A partner's registration on a date (20-reader §6); `unknown` when not looked up. */
export type PartnerRegistrationStatus = "registered" | "not_registered" | "unknown";

/** What the partner list shows in 照合 (20-reader §10.3). */
export interface PartnerRegistrationView {
  status: InvoiceRegistrationStatus;
  /** The published name; `null` while `unknown`. */
  name: string | null;
  registeredOn: CalendarDate | null;
  /** Expiry or revocation: not registered from this day. */
  endedOn: CalendarDate | null;
  checkedAt: Date | null;
}

export interface RegistryCheckResult {
  /** Partners whose number was answered (registered, not registered or ended). */
  checked: number;
  registered: number;
  notRegistered: number;
  ended: number;
  /** Partners whose number could not be looked up (left as they were). */
  failed: number;
  /** The owner-facing reasons of the failures, without duplicates. */
  errors: string[];
}

export interface RegistryCheckOptions extends WriteOptions {
  /** Only these partners (still only the active ones with a valid number). */
  partnerIds?: readonly string[];
  /** The time of the check (`invoice_registration_checked_at`); its JST day decides `revoked`. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The provider recorded on the usage row: a lookup may name itself, else the real API. */
export function lookupProvider(lookup: NtaLookup): string {
  const provider = (lookup as { provider?: unknown }).provider;
  return typeof provider === "string" && provider !== "" ? provider : "nta";
}

/**
 * `lookup.lookup(numbers)`, never throwing: the client already turns failed batches into
 * `failures`, and anything else it throws fails every number the same way.
 */
export async function lookupRegistrations(
  lookup: NtaLookup,
  numbers: readonly string[],
): Promise<NtaLookupResult> {
  try {
    return await lookup.lookup(numbers);
  } catch (error) {
    return {
      registrations: new Map(),
      requestCount: 0,
      failures: [
        {
          numbers: [...numbers],
          message: error instanceof NtaApiError ? error.message : REGISTRY_LOOKUP_FAILED,
        },
      ],
    };
  }
}

/** The failure messages of a lookup, without duplicates. */
export function lookupErrors(result: NtaLookupResult): string[] {
  return [...new Set(result.failures.map((failure) => failure.message))];
}

type RegistrationColumns = Pick<
  Partner,
  | "invoiceRegistrationStatus"
  | "invoiceRegistrationName"
  | "invoiceRegisteredOn"
  | "invoiceRegistrationEndedOn"
  | "invoiceRegistrationCheckedAt"
>;

function registrationColumns(row: RegistrationColumns): RegistrationColumns {
  return {
    invoiceRegistrationStatus: row.invoiceRegistrationStatus,
    invoiceRegistrationName: row.invoiceRegistrationName,
    invoiceRegisteredOn: row.invoiceRegisteredOn,
    invoiceRegistrationEndedOn: row.invoiceRegistrationEndedOn,
    invoiceRegistrationCheckedAt: row.invoiceRegistrationCheckedAt,
  };
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

/** Whether the status, the name or a date changes (the time of the check aside). */
function registrationChanges(row: RegistrationColumns, next: RegistrationColumns): boolean {
  return (
    row.invoiceRegistrationStatus !== next.invoiceRegistrationStatus ||
    row.invoiceRegistrationName !== next.invoiceRegistrationName ||
    !sameTime(row.invoiceRegisteredOn, next.invoiceRegisteredOn) ||
    !sameTime(row.invoiceRegistrationEndedOn, next.invoiceRegistrationEndedOn)
  );
}

const checkableWhere = {
  isActive: true,
  invoiceRegistrationNumber: { not: null },
} satisfies Prisma.PartnerWhereInput;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The registration of a partner on `date` (20-reader §6): `unknown` while not looked up (a changed
 * number resets the status), `not_registered` when the number is not published, else by the dates.
 */
export function partnerRegistrationAt(
  partner: Pick<
    Partner,
    "invoiceRegistrationStatus" | "invoiceRegisteredOn" | "invoiceRegistrationEndedOn"
  >,
  date: CalendarDate,
): PartnerRegistrationStatus {
  if (partner.invoiceRegistrationStatus === "unknown") return "unknown";
  if (partner.invoiceRegistrationStatus === "not_found") return "not_registered";
  return registrationStatusAt(
    {
      registeredOn: fromDbDateOrNull(partner.invoiceRegisteredOn),
      endedOn: fromDbDateOrNull(partner.invoiceRegistrationEndedOn),
    },
    date,
  );
}

/** The registration of every partner by ID (inactive ones too). */
export async function listPartnerRegistrations(
  db: Db,
): Promise<Map<string, PartnerRegistrationView>> {
  const rows = await db.partner.findMany({
    select: {
      id: true,
      invoiceRegistrationStatus: true,
      invoiceRegistrationName: true,
      invoiceRegisteredOn: true,
      invoiceRegistrationEndedOn: true,
      invoiceRegistrationCheckedAt: true,
    },
  });
  return new Map(
    rows.map((row) => {
      // A changed number resets the status to `unknown`; the old published values are not read.
      const known = row.invoiceRegistrationStatus !== "unknown";
      return [
        row.id,
        {
          status: row.invoiceRegistrationStatus,
          name: known ? row.invoiceRegistrationName : null,
          registeredOn: known ? fromDbDateOrNull(row.invoiceRegisteredOn) : null,
          endedOn: known ? fromDbDateOrNull(row.invoiceRegistrationEndedOn) : null,
          checkedAt: row.invoiceRegistrationCheckedAt,
        },
      ];
    }),
  );
}

/**
 * 照合 in the partner list: 「登録あり（2023/10/01〜）」「未登録」「登録終了（2025/03/31）」「未照合」.
 * The end's reason (失効・取消) is not stored on the partner, so both read 登録終了.
 */
export function registrationStatusLabel(
  view: Pick<PartnerRegistrationView, "status" | "registeredOn" | "endedOn">,
): string {
  switch (view.status) {
    case "unknown":
      return "未照合";
    case "not_found":
      return "未登録";
    case "revoked":
      return view.endedOn === null ? "登録終了" : `登録終了（${displayDate(view.endedOn)}）`;
    case "verified": {
      if (view.registeredOn === null) return "登録あり";
      const until = view.endedOn === null ? "" : displayDate(addDays(view.endedOn, -1));
      return `登録あり（${displayDate(view.registeredOn)}〜${until}）`;
    }
  }
}

/** Active partners with a valid registration number (what 照合する looks up). */
export async function countCheckablePartners(db: Db): Promise<number> {
  const rows = await db.partner.findMany({
    where: checkableWhere,
    select: { invoiceRegistrationNumber: true },
  });
  return rows.filter(
    (row) =>
      row.invoiceRegistrationNumber !== null &&
      isValidInvoiceRegistrationNumber(row.invoiceRegistrationNumber),
  ).length;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Looks up the registration numbers of the active partners (or of `partnerIds`) and stores the
 * result (20-reader §7.3). Malformed numbers are never sent. Found → `verified`, or `revoked` when
 * ended by today; not published → `not_found`; failed numbers are left as they were. A partner
 * whose status, name or dates change gets its own `partner.registry_check`; those where only the
 * time of the check moves share one row (entityId `null`). One `external_api_usage` row per lookup.
 * Nothing is written when there is nothing to look up.
 */
export async function checkPartnerRegistrations(
  db: Db,
  lookup: NtaLookup,
  options: RegistryCheckOptions,
): Promise<RegistryCheckResult> {
  const { partnerIds } = partnerRegistryCheckSchema.parse({ partnerIds: options.partnerIds });
  const now = options.now ?? new Date();
  const today = todayInJapan(now);
  const result: RegistryCheckResult = {
    checked: 0,
    registered: 0,
    notRegistered: 0,
    ended: 0,
    failed: 0,
    errors: [],
  };

  const targets = (
    await db.partner.findMany({
      where: { ...checkableWhere, ...(partnerIds ? { id: { in: partnerIds } } : {}) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, invoiceRegistrationNumber: true },
    })
  ).filter(
    (row): row is { id: string; invoiceRegistrationNumber: string } =>
      row.invoiceRegistrationNumber !== null &&
      isValidInvoiceRegistrationNumber(row.invoiceRegistrationNumber),
  );
  if (targets.length === 0) return result;

  const numbers = [...new Set(targets.map((row) => row.invoiceRegistrationNumber))];
  // No transaction is open while the publication answers.
  const lookedUp = await lookupRegistrations(lookup, numbers);
  const failedNumbers = new Set(lookedUp.failures.flatMap((failure) => failure.numbers));
  result.errors = lookupErrors(lookedUp);

  return runInTransaction(db, async (tx) => {
    const ids = targets.map((row) => row.id);
    await tx.$queryRaw`SELECT "id" FROM "partner" WHERE "id" = ANY(${ids}) FOR UPDATE`;
    const rows = await tx.partner.findMany({
      where: { id: { in: ids } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const lookedUpNumbers = new Map(targets.map((row) => [row.id, row.invoiceRegistrationNumber]));
    const unchanged: string[] = [];

    for (const row of rows) {
      const number = lookedUpNumbers.get(row.id);
      // Changed or deactivated while the publication answered: its result is not this partner's.
      if (!row.isActive || row.invoiceRegistrationNumber !== number) continue;
      const registration = lookedUp.registrations.get(number);
      if (failedNumbers.has(number) || registration === undefined) {
        result.failed += 1;
        continue;
      }

      let next: RegistrationColumns;
      if (registration === null) {
        next = {
          invoiceRegistrationStatus: "not_found",
          invoiceRegistrationName: null,
          invoiceRegisteredOn: null,
          invoiceRegistrationEndedOn: null,
          invoiceRegistrationCheckedAt: now,
        };
        result.notRegistered += 1;
      } else {
        const ended = registration.endedOn !== null && registration.endedOn <= today;
        next = {
          invoiceRegistrationStatus: ended ? "revoked" : "verified",
          invoiceRegistrationName: registration.name,
          invoiceRegisteredOn:
            registration.registeredOn === null ? null : toDbDate(registration.registeredOn),
          invoiceRegistrationEndedOn:
            registration.endedOn === null ? null : toDbDate(registration.endedOn),
          invoiceRegistrationCheckedAt: now,
        };
        if (ended) result.ended += 1;
        else result.registered += 1;
      }
      result.checked += 1;

      await tx.partner.update({ where: { id: row.id }, data: next });
      if (registrationChanges(row, next)) {
        await appendAuditLog(tx, {
          actor: options.actor,
          action: "partner.registry_check",
          entity: "partner",
          entityId: row.id,
          before: registrationColumns(row),
          after: next,
        });
      } else {
        unchanged.push(row.id);
      }
    }

    if (unchanged.length > 0) {
      await appendAuditLog(tx, {
        actor: options.actor,
        action: "partner.registry_check",
        entity: "partner",
        entityId: null,
        after: { checkedAt: now, unchangedCount: unchanged.length, partnerIds: unchanged },
      });
    }
    await recordApiUsage(tx, {
      service: "registry",
      provider: lookupProvider(lookup),
      outcome: lookedUp.failures.length > 0 ? "failed" : "ok",
      error: result.errors.length > 0 ? result.errors.join(" / ") : null,
      requestCount: lookedUp.requestCount,
      itemCount: numbers.length,
      actor: options.actor,
    });
    return result;
  });
}
