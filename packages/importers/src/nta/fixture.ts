import { chunk, lookupableNumbers, NTA_BATCH_SIZE } from "./client";
import type { NtaLookup, NtaRegistration } from "./types";

/**
 * A lookup that answers from fictional publication data (tests and development:
 * `NIHO_FINANCE_NTA_MODE=fixture`, never in production). It counts requests as the real client
 * would send them, 10 numbers each.
 */
export function createFixtureNtaLookup(registrations: readonly NtaRegistration[]): NtaLookup {
  const byNumber = new Map(
    registrations.map((registration) => [registration.number, registration]),
  );
  return {
    lookup(input) {
      const numbers = lookupableNumbers(input);
      return Promise.resolve({
        registrations: new Map(numbers.map((number) => [number, byNumber.get(number) ?? null])),
        requestCount: chunk(numbers, NTA_BATCH_SIZE).length,
        failures: [],
      });
    },
  };
}

function registered(number: string, name: string): NtaRegistration {
  return {
    number,
    name,
    kind: "corporation",
    registeredOn: "2023-10-01",
    endedOn: null,
    endReason: null,
    lastUpdateDate: "2026-10-27",
  };
}

/**
 * Fictional publication data. The numbers are bases of 9s with their check digits (no real
 * company has them); most of the reader's gold set is registered, `T9999999999909` is not
 * published at all, and four more show expiry, revocation and a registration still to come.
 */
export const FIXTURE_NTA_REGISTRATIONS: readonly NtaRegistration[] = [
  registered("T8999999999901", "架空食堂株式会社"),
  registered("T7999999999902", "架空マート株式会社"),
  registered("T6999999999903", "架空タクシー株式会社"),
  registered("T5999999999904", "架空書店株式会社"),
  registered("T4999999999905", "架空文具店株式会社"),
  registered("T3999999999906", "架空スーパー株式会社"),
  registered("T2999999999907", "架空クラウドサービス株式会社"),
  registered("T1999999999908", "架空印刷株式会社"),
  {
    number: "T7999999999910",
    name: "架空商店",
    kind: "individual",
    registeredOn: "2024-04-01",
    endedOn: null,
    endReason: null,
    lastUpdateDate: "2026-10-27",
  },
  {
    number: "T6999999999911",
    name: "架空失効株式会社",
    kind: "corporation",
    registeredOn: "2023-10-01",
    endedOn: "2025-03-31",
    endReason: "expired",
    lastUpdateDate: "2026-10-27",
  },
  {
    number: "T5999999999912",
    name: "架空取消株式会社",
    kind: "corporation",
    registeredOn: "2023-10-01",
    endedOn: "2026-06-30",
    endReason: "revoked",
    lastUpdateDate: "2026-10-27",
  },
  {
    number: "T4999999999913",
    name: "架空新設株式会社",
    kind: "corporation",
    registeredOn: "2027-04-01",
    endedOn: null,
    endReason: null,
    lastUpdateDate: "2026-10-27",
  },
];
