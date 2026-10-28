import {
  isValidInvoiceRegistrationNumber,
  normalizeInvoiceRegistrationNumber,
} from "@niho-finance/ledger";
import { NtaApiError } from "./errors";
import { parseNtaResponse } from "./parse";
import type { NtaLookup, NtaLookupResult, NtaRegistration } from "./types";

/**
 * The National Tax Agency's qualified invoice issuer publication API (20-reader §8.1): numbers are
 * looked up 10 per request, in order, at least `minIntervalMs` apart (no rate limit is published,
 * so the client stays slow), and every answer is cached per number for `cacheTtlMs`. Only the
 * registration numbers are sent. Failures are not retried; the monthly job runs again.
 */

export const NTA_API_BASE = "https://web-api.invoice-kohyo.nta.go.jp";
export const NTA_BATCH_SIZE = 10;
const NTA_NUMBER_PATH = "/1/num";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Valid numbers (format and check digit), normalized, without duplicates, in input order. */
export function lookupableNumbers(numbers: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of numbers) {
    const number = normalizeInvoiceRegistrationNumber(value.trim());
    if (isValidInvoiceRegistrationNumber(number)) seen.add(number);
  }
  return [...seen];
}

export function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

function failureMessage(error: unknown): string {
  return error instanceof NtaApiError ? error.message : "国税庁の公表サイトに接続できませんでした";
}

export function createNtaClient(options: {
  applicationId: string;
  fetch?: typeof fetch;
  minIntervalMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): NtaLookup {
  const fetchImpl = options.fetch ?? fetch;
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const cacheTtlMs = options.cacheTtlMs ?? DAY_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<string, { value: NtaRegistration | null; expiresAt: number }>();
  let lastRequestAt: number | null = null;
  /** The previous request's turn: each request waits for it, so turns never overlap. */
  let previousTurn: Promise<void> = Promise.resolve();

  /**
   * Waits until this request may start: one at a time and `minIntervalMs` apart, also when several
   * lookups run at once in the process (a bulk check while a document is read, 20-reader §8.1).
   */
  function takeTurn(): Promise<void> {
    const turn = previousTurn.then(async () => {
      if (lastRequestAt !== null) {
        const wait = lastRequestAt + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastRequestAt = now();
    });
    previousTurn = turn.catch(() => undefined);
    return turn;
  }

  async function request(numbers: readonly string[]): Promise<Map<string, NtaRegistration>> {
    await takeTurn();
    const url = new URL(NTA_NUMBER_PATH, NTA_API_BASE);
    url.search = new URLSearchParams({
      id: options.applicationId,
      number: numbers.join(","),
      type: "21",
      history: "1",
    }).toString();
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { accept: "application/json" } });
    } catch {
      // The network error may quote the URL, which carries the application ID.
      throw new NtaApiError("国税庁の公表サイトに接続できませんでした");
    }
    if (!response.ok) {
      throw new NtaApiError(
        `国税庁の公表サイトに接続できませんでした（HTTP ${response.status}）`,
        response.status,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new NtaApiError("国税庁の公表サイトの応答を読めませんでした", response.status);
    }
    return parseNtaResponse(json);
  }

  return {
    async lookup(input) {
      const result: NtaLookupResult = { registrations: new Map(), requestCount: 0, failures: [] };
      const misses: string[] = [];
      for (const number of lookupableNumbers(input)) {
        const cached = cache.get(number);
        if (cached && cached.expiresAt > now()) result.registrations.set(number, cached.value);
        else misses.push(number);
      }
      for (const numbers of chunk(misses, NTA_BATCH_SIZE)) {
        result.requestCount += 1;
        try {
          const found = await request(numbers);
          const expiresAt = now() + cacheTtlMs;
          for (const number of numbers) {
            const value = found.get(number) ?? null;
            cache.set(number, { value, expiresAt });
            result.registrations.set(number, value);
          }
        } catch (error) {
          result.failures.push({ numbers: [...numbers], message: failureMessage(error) });
        }
      }
      return result;
    },
  };
}
