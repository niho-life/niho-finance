import { isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import { NtaApiError } from "./errors";
import type { NtaRegistration, NtaRegistrationStatus } from "./types";

/**
 * The JSON of the registration number API (`/1/num`, `type=21`, resource definition 1.5). Every
 * value is a string and an empty value is `""`; numbers not found are absent from `announcement`;
 * with `history=1` a number has one row per event (`process`: 01 new, 02 change, 03 expiry,
 * 04 revocation) and `latest = "1"` marks the current one.
 */

interface AnnouncementRow {
  sequenceNumber: number;
  number: string;
  kind: string;
  latest: boolean;
  registrationDate: CalendarDate | null;
  updateDate: CalendarDate | null;
  disposalDate: CalendarDate | null;
  expireDate: CalendarDate | null;
  name: string | null;
}

function malformed(): NtaApiError {
  return new NtaApiError("国税庁の公表サイトの応答の形式が正しくありません");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw malformed();
  return value.trim();
}

/** `YYYY-MM-DD` (also `YYYY/MM/DD` and `YYYYMMDD`); `""` → `null`. */
function date(row: Record<string, unknown>, key: string): CalendarDate | null {
  const value = text(row, key);
  if (value === "") return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value.replaceAll("/", "-");
  if (!isCalendarDate(iso)) throw malformed();
  return iso;
}

function toRow(value: unknown): AnnouncementRow {
  if (!isRecord(value)) throw malformed();
  const number = text(value, "registratedNumber");
  if (!/^T\d{13}$/.test(number)) throw malformed();
  const sequence = Number(text(value, "sequenceNumber"));
  return {
    sequenceNumber: Number.isSafeInteger(sequence) ? sequence : 0,
    number,
    kind: text(value, "kind"),
    latest: text(value, "latest") === "1",
    registrationDate: date(value, "registrationDate"),
    updateDate: date(value, "updateDate"),
    disposalDate: date(value, "disposalDate"),
    expireDate: date(value, "expireDate"),
    name: text(value, "name") || text(value, "tradeName") || null,
  };
}

/** The row marked latest; otherwise the most recently updated one. */
function latestRow(rows: readonly AnnouncementRow[]): AnnouncementRow {
  const marked = rows.find((row) => row.latest);
  if (marked) return marked;
  return [...rows].sort((a, b) => {
    const byDate = (b.updateDate ?? "").localeCompare(a.updateDate ?? "");
    return byDate !== 0 ? byDate : b.sequenceNumber - a.sequenceNumber;
  })[0] as AnnouncementRow;
}

function toRegistration(
  rows: readonly AnnouncementRow[],
  lastUpdateDate: CalendarDate | null,
): NtaRegistration {
  const latest = latestRow(rows);
  let endedOn: CalendarDate | null = null;
  let endReason: NtaRegistration["endReason"] = null;
  for (const row of rows) {
    const ends: [CalendarDate | null, "expired" | "revoked"][] = [
      [row.expireDate, "expired"],
      [row.disposalDate, "revoked"],
    ];
    for (const [on, reason] of ends) {
      if (on !== null && (endedOn === null || on > endedOn)) {
        endedOn = on;
        endReason = reason;
      }
    }
  }
  const registeredOn = latest.registrationDate;
  // Registered again after an earlier end: the earlier end is history, not the current state.
  if (registeredOn !== null && endedOn !== null && endedOn < registeredOn) {
    endedOn = null;
    endReason = null;
  }
  return {
    number: latest.number,
    name: latest.name,
    kind: latest.kind === "2" ? "corporation" : latest.kind === "1" ? "individual" : null,
    registeredOn,
    endedOn,
    endReason,
    lastUpdateDate,
  };
}

/** Number → registration for every number in the response. Throws `NtaApiError` on another shape. */
export function parseNtaResponse(json: unknown): Map<string, NtaRegistration> {
  if (!isRecord(json)) throw malformed();
  const announcement = json.announcement ?? [];
  if (!Array.isArray(announcement)) throw malformed();
  const lastUpdateDate = date(json, "lastUpdateDate");
  const byNumber = new Map<string, AnnouncementRow[]>();
  for (const value of announcement) {
    const row = toRow(value);
    const rows = byNumber.get(row.number);
    if (rows) rows.push(row);
    else byNumber.set(row.number, [row]);
  }
  const registrations = new Map<string, NtaRegistration>();
  for (const [number, rows] of byNumber) {
    registrations.set(number, toRegistration(rows, lastUpdateDate));
  }
  return registrations;
}

/**
 * The registration on `date` (20-reader §6): registered when `registeredOn ≤ date < endedOn`. On
 * the registration date it is registered; on the expiry or revocation date it is not.
 */
export function registrationStatusAt(
  registration: Pick<NtaRegistration, "registeredOn" | "endedOn"> | null,
  date: CalendarDate,
): NtaRegistrationStatus {
  if (registration === null || registration.registeredOn === null) return "not_registered";
  if (date < registration.registeredOn) return "not_registered";
  if (registration.endedOn !== null && date >= registration.endedOn) return "not_registered";
  return "registered";
}
