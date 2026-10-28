import type { CalendarDate } from "@niho-finance/ledger";

/**
 * A qualified invoice issuer as the National Tax Agency publishes it (20-reader §8): the latest
 * record of the number, with the end of the registration taken from its whole history.
 */
export interface NtaRegistration {
  /** `T` + 13 digits. */
  number: string;
  /** The published name (or trade name), `null` when not published. */
  name: string | null;
  kind: "corporation" | "individual" | null;
  registeredOn: CalendarDate | null;
  /** The latest expiry or revocation date; the registration is not in force from this day. */
  endedOn: CalendarDate | null;
  endReason: "expired" | "revoked" | null;
  /** The publication's last update (the response header). */
  lastUpdateDate: CalendarDate | null;
}

/** The registration on a given date: registered on or after `registeredOn` and before `endedOn`. */
export type NtaRegistrationStatus = "registered" | "not_registered";

export interface NtaLookupResult {
  /** Every looked-up number: its registration, or `null` when the publication has no such number. */
  registrations: Map<string, NtaRegistration | null>;
  /** Requests actually sent (cached numbers send none). */
  requestCount: number;
  /** Batches that failed; their numbers are not in `registrations`. */
  failures: { numbers: string[]; message: string }[];
}

export interface NtaLookup {
  /** Malformed numbers (format or check digit) are skipped, never sent. */
  lookup(numbers: readonly string[]): Promise<NtaLookupResult>;
}
