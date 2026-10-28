import { corporateNumberCheckDigit } from "@niho-finance/ledger";
import { describe, expect, it, vi } from "vitest";
import { createNtaClient, NTA_BATCH_SIZE } from "../src/nta/client";
import { createNtaLookupFromEnv, ntaConfig } from "../src/nta/config";
import { NtaApiError } from "../src/nta/errors";
import { createFixtureNtaLookup, FIXTURE_NTA_REGISTRATIONS } from "../src/nta/fixture";
import { parseNtaResponse, registrationStatusAt } from "../src/nta/parse";
import { fixtureJson } from "./support/fixtures";

/** A fictional application ID: it must never appear in a message. */
const APPLICATION_ID = "9999999999999";

/** `T` + check digit + a 12-digit base of 9s ending in `n` (fictional numbers). */
function fictionalNumber(n: number): string {
  const base = `9999999999${String(n).padStart(2, "0")}`;
  return `T${corporateNumberCheckDigit(base)}${base}`;
}

const registeredJson = fixtureJson("nta/registered.json");
const historyJson = fixtureJson("nta/history.json");
const notFoundJson = fixtureJson("nta/not-found.json");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers from `respond` and records the requested URLs. */
function fakeFetch(
  respond: (url: URL) => Response | Promise<Response> = () => jsonResponse(notFoundJson),
) {
  const urls: URL[] = [];
  const fetch = vi.fn((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    urls.push(url);
    return Promise.resolve(respond(url));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls, calls: fetch };
}

function client(
  fetch: typeof globalThis.fetch,
  overrides: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    cacheTtlMs?: number;
  } = {},
) {
  return createNtaClient({
    applicationId: APPLICATION_ID,
    fetch,
    now: overrides.now ?? (() => 0),
    sleep: overrides.sleep ?? (() => Promise.resolve()),
    ...(overrides.cacheTtlMs === undefined ? {} : { cacheTtlMs: overrides.cacheTtlMs }),
  });
}

describe("parseNtaResponse (20-reader §8.1)", () => {
  it("reads a new registration of a corporation and of an individual (trade name)", () => {
    const registrations = parseNtaResponse(registeredJson);
    expect(registrations.get("T8999999999901")).toEqual({
      number: "T8999999999901",
      name: "架空食堂株式会社",
      kind: "corporation",
      registeredOn: "2023-10-01",
      endedOn: null,
      endReason: null,
      lastUpdateDate: "2026-10-27",
    });
    expect(registrations.get("T7999999999910")).toMatchObject({
      name: "架空商店",
      kind: "individual",
      registeredOn: "2024-04-01",
      endedOn: null,
    });
  });

  it("takes the latest row of a history and the end from the expiry or revocation row", () => {
    const registrations = parseNtaResponse(historyJson);
    expect(registrations.get("T7999999999902")).toMatchObject({
      name: "架空マート株式会社",
      registeredOn: "2023-10-01",
      endedOn: null,
      endReason: null,
    });
    expect(registrations.get("T6999999999911")).toMatchObject({
      registeredOn: "2023-10-01",
      endedOn: "2025-03-31",
      endReason: "expired",
    });
    expect(registrations.get("T5999999999912")).toMatchObject({
      registeredOn: "2023-10-01",
      endedOn: "2026-06-30",
      endReason: "revoked",
    });
  });

  it("uses the most recent end when a number ended more than once", () => {
    const json = structuredClone(historyJson) as { announcement: Record<string, string>[] };
    json.announcement.push({
      ...json.announcement[5],
      sequenceNumber: "7",
      latest: "0",
      process: "03",
      expireDate: "2024-12-31",
      disposalDate: "",
    });
    expect(parseNtaResponse(json).get("T5999999999912")).toMatchObject({
      endedOn: "2026-06-30",
      endReason: "revoked",
    });
  });

  it("leaves a number that was not found out of the map", () => {
    expect(parseNtaResponse(notFoundJson).size).toBe(0);
    expect(parseNtaResponse(registeredJson).has("T9999999999909")).toBe(false);
  });

  it("throws NtaApiError on another shape", () => {
    expect(() => parseNtaResponse("<html>")).toThrow(NtaApiError);
    expect(() => parseNtaResponse({ announcement: {} })).toThrow(NtaApiError);
    expect(() =>
      parseNtaResponse({ announcement: [{ registratedNumber: 8999999999901 }] }),
    ).toThrow(NtaApiError);
    expect(() =>
      parseNtaResponse({
        announcement: [{ registratedNumber: "T8999999999901", registrationDate: "2023-13-01" }],
      }),
    ).toThrow(NtaApiError);
  });
});

describe("registrationStatusAt (20-reader §6)", () => {
  const expired = { registeredOn: "2023-10-01", endedOn: "2025-03-31" } as const;

  it("is registered from the registration date, and not on the expiry or revocation date", () => {
    expect(registrationStatusAt(expired, "2023-09-30")).toBe("not_registered");
    expect(registrationStatusAt(expired, "2023-10-01")).toBe("registered");
    expect(registrationStatusAt(expired, "2025-03-30")).toBe("registered");
    expect(registrationStatusAt(expired, "2025-03-31")).toBe("not_registered");
    expect(registrationStatusAt(expired, "2026-01-01")).toBe("not_registered");
  });

  it("is registered with no end, and not registered when not found or never registered", () => {
    expect(registrationStatusAt({ registeredOn: "2023-10-01", endedOn: null }, "2030-01-01")).toBe(
      "registered",
    );
    expect(registrationStatusAt(null, "2026-10-01")).toBe("not_registered");
    expect(registrationStatusAt({ registeredOn: null, endedOn: null }, "2026-10-01")).toBe(
      "not_registered",
    );
  });
});

describe("createNtaClient (20-reader §8.1)", () => {
  it("asks /1/num with type=21, history=1 and the numbers comma-separated", async () => {
    const { fetch, urls } = fakeFetch(() => jsonResponse(registeredJson));
    const result = await client(fetch).lookup(["T8999999999901", "T7999999999910"]);

    expect(urls).toHaveLength(1);
    const url = urls[0] as URL;
    expect(`${url.origin}${url.pathname}`).toBe("https://web-api.invoice-kohyo.nta.go.jp/1/num");
    expect(url.searchParams.get("id")).toBe(APPLICATION_ID);
    expect(url.searchParams.get("number")).toBe("T8999999999901,T7999999999910");
    expect(url.searchParams.get("type")).toBe("21");
    expect(url.searchParams.get("history")).toBe("1");
    expect(result.requestCount).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.registrations.get("T8999999999901")?.name).toBe("架空食堂株式会社");
  });

  it("sends only valid numbers, normalized and once each; a number not found is null", async () => {
    const { fetch, urls } = fakeFetch(() => jsonResponse(registeredJson));
    const result = await client(fetch).lookup([
      "t8999999999901",
      "T８９９９９９９９９９９０１",
      "T8999999999902", // wrong check digit
      "T123",
      fictionalNumber(9),
    ]);
    expect(urls[0]?.searchParams.get("number")).toBe(`T8999999999901,${fictionalNumber(9)}`);
    expect([...result.registrations.keys()]).toEqual(["T8999999999901", fictionalNumber(9)]);
    expect(result.registrations.get(fictionalNumber(9))).toBeNull();
  });

  it("splits 11 numbers into 10 + 1, one request each, in order", async () => {
    const numbers = Array.from({ length: 11 }, (_, index) => fictionalNumber(index + 1));
    const { fetch, urls } = fakeFetch();
    const result = await client(fetch).lookup(numbers);

    expect(NTA_BATCH_SIZE).toBe(10);
    expect(urls.map((url) => url.searchParams.get("number")?.split(","))).toEqual([
      numbers.slice(0, 10),
      numbers.slice(10),
    ]);
    expect(result.requestCount).toBe(2);
    expect(result.registrations.size).toBe(11);
  });

  it("waits minIntervalMs between requests, also across lookups", async () => {
    let clock = 10_000;
    const sleeps: number[] = [];
    const sleep = vi.fn((ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    });
    const { fetch, calls } = fakeFetch(() => {
      clock += 200; // each request takes 200 ms
      return jsonResponse(notFoundJson);
    });
    const lookup = client(fetch, { now: () => clock, sleep });
    const numbers = Array.from({ length: 21 }, (_, index) => fictionalNumber(index + 1));

    await lookup.lookup(numbers);
    expect(calls).toHaveBeenCalledTimes(3);
    // Requests start at 10_000, 11_000 and 12_000: the first does not wait.
    expect(sleeps).toEqual([800, 800]);

    clock += 5_000;
    await lookup.lookup([fictionalNumber(30)]);
    expect(sleeps).toEqual([800, 800]);
    await lookup.lookup([fictionalNumber(31)]);
    expect(sleeps).toEqual([800, 800, 800]);
  });

  it("spaces the requests of lookups that run at the same time", async () => {
    let clock = 10_000;
    const starts: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      await Promise.resolve();
      clock += ms;
    });
    const { fetch } = fakeFetch(() => {
      starts.push(clock);
      return jsonResponse(notFoundJson);
    });
    const lookup = client(fetch, { now: () => clock, sleep });

    await lookup.lookup([fictionalNumber(1)]);
    // A bulk check and a document reading at once: one at a time, 1 second apart.
    await Promise.all([lookup.lookup([fictionalNumber(2)]), lookup.lookup([fictionalNumber(3)])]);
    expect(starts).toEqual([10_000, 11_000, 12_000]);
  });

  it("caches every answer per number until the TTL passes", async () => {
    let clock = 0;
    const { fetch, urls } = fakeFetch(() => jsonResponse(registeredJson));
    const lookup = client(fetch, { now: () => clock, cacheTtlMs: 60_000 });

    await lookup.lookup(["T8999999999901", fictionalNumber(9)]);
    const cached = await lookup.lookup(["T8999999999901", fictionalNumber(9), "T7999999999910"]);
    expect(cached.requestCount).toBe(1);
    expect(urls[1]?.searchParams.get("number")).toBe("T7999999999910");
    expect(cached.registrations.get("T8999999999901")?.name).toBe("架空食堂株式会社");
    expect(cached.registrations.get(fictionalNumber(9))).toBeNull();

    clock = 60_000;
    const expired = await lookup.lookup(["T8999999999901"]);
    expect(expired.requestCount).toBe(1);
    expect(urls).toHaveLength(3);
  });

  it("reports a failed batch without the URL or the ID, and goes on with the next", async () => {
    const numbers = Array.from({ length: 12 }, (_, index) => fictionalNumber(index + 1));
    let call = 0;
    const { fetch } = fakeFetch(() => {
      call += 1;
      return call === 1 ? jsonResponse({ message: "busy" }, 503) : jsonResponse(notFoundJson);
    });
    const result = await client(fetch).lookup(numbers);

    expect(result.requestCount).toBe(2);
    expect(result.failures).toEqual([
      {
        numbers: numbers.slice(0, 10),
        message: "国税庁の公表サイトに接続できませんでした（HTTP 503）",
      },
    ]);
    expect([...result.registrations.keys()]).toEqual(numbers.slice(10));
  });

  it("does not cache a failure", async () => {
    let call = 0;
    const { fetch } = fakeFetch(() => {
      call += 1;
      return call === 1 ? jsonResponse({}, 500) : jsonResponse(registeredJson);
    });
    const lookup = client(fetch);
    expect((await lookup.lookup(["T8999999999901"])).failures).toHaveLength(1);
    const retried = await lookup.lookup(["T8999999999901"]);
    expect(retried.requestCount).toBe(1);
    expect(retried.registrations.get("T8999999999901")?.name).toBe("架空食堂株式会社");
  });

  it("hides the URL of a network error and reports a body that is not JSON", async () => {
    const failing = vi.fn((input: string | URL | Request) =>
      Promise.reject(
        new TypeError(`fetch failed: ${input instanceof Request ? input.url : input.toString()}`),
      ),
    );
    const network = await client(failing).lookup(["T8999999999901"]);
    const html = await client(
      fakeFetch(() => new Response("<html>maintenance</html>", { status: 200 })).fetch,
    ).lookup(["T8999999999901"]);
    const shape = await client(
      fakeFetch(() => jsonResponse({ announcement: "none" })).fetch,
    ).lookup(["T8999999999901"]);

    expect(network.failures[0]?.message).toBe("国税庁の公表サイトに接続できませんでした");
    expect(html.failures[0]?.message).toBe("国税庁の公表サイトの応答を読めませんでした");
    expect(shape.failures[0]?.message).toBe("国税庁の公表サイトの応答の形式が正しくありません");
    for (const result of [network, html, shape]) {
      expect(result.requestCount).toBe(1);
      const message = result.failures[0]?.message ?? "";
      expect(message).not.toContain(APPLICATION_ID);
      expect(message).not.toContain("http");
    }
  });

  it("sends nothing for no valid numbers", async () => {
    const { fetch, calls } = fakeFetch();
    const result = await client(fetch).lookup(["T123", ""]);
    expect(calls).not.toHaveBeenCalled();
    expect(result).toEqual({ registrations: new Map(), requestCount: 0, failures: [] });
  });
});

describe("createFixtureNtaLookup", () => {
  it("answers from the fixture and counts requests 10 numbers each", async () => {
    const lookup = createFixtureNtaLookup(FIXTURE_NTA_REGISTRATIONS);
    const numbers = Array.from({ length: 13 }, (_, index) => fictionalNumber(index + 1));
    const result = await lookup.lookup([...numbers, "T123"]);

    expect(result.requestCount).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.registrations.size).toBe(13);
    expect(result.registrations.get(fictionalNumber(1))?.name).toBe("架空食堂株式会社");
    expect(result.registrations.get(fictionalNumber(9))).toBeNull();
  });

  it("covers registered, expired, revoked and not yet registered on a date", () => {
    const on = "2026-10-15";
    const statuses = new Map(
      FIXTURE_NTA_REGISTRATIONS.map((registration) => [
        registration.endReason ??
          ((registration.registeredOn ?? "") > on ? "future" : "registered"),
        registrationStatusAt(registration, on),
      ]),
    );
    expect(Object.fromEntries(statuses)).toEqual({
      registered: "registered",
      expired: "not_registered",
      revoked: "not_registered",
      future: "not_registered",
    });
    for (const registration of FIXTURE_NTA_REGISTRATIONS) {
      expect(registration.name?.startsWith("架空")).toBe(true);
    }
  });
});

describe("ntaConfig (20-reader §8.2)", () => {
  it("is off without an application ID", () => {
    expect(ntaConfig({})).toEqual({ status: "off" });
    expect(ntaConfig({ NIHO_FINANCE_NTA_APPLICATION_ID: "  " })).toEqual({ status: "off" });
    expect(createNtaLookupFromEnv({})).toBeNull();
  });

  it("is off with an application ID that is not 13 digits", () => {
    for (const id of ["999999999999", "99999999999999", "9999999999999x", "T999999999999"]) {
      const env = { NIHO_FINANCE_NTA_APPLICATION_ID: id };
      expect(ntaConfig(env)).toEqual({ status: "off" });
      expect(createNtaLookupFromEnv(env)).toBeNull();
    }
    // Surrounding blanks of a pasted secret are not an error.
    expect(ntaConfig({ NIHO_FINANCE_NTA_APPLICATION_ID: ` ${APPLICATION_ID}\n` })).toEqual({
      status: "on",
      mode: "api",
    });
  });

  it("uses the API with an application ID and never returns the ID", () => {
    const env = { NIHO_FINANCE_NTA_APPLICATION_ID: APPLICATION_ID };
    expect(ntaConfig(env)).toEqual({ status: "on", mode: "api" });
    expect(JSON.stringify(ntaConfig(env))).not.toContain(APPLICATION_ID);
    expect(createNtaLookupFromEnv(env)).not.toBeNull();
  });

  it("uses the fixture outside production only", async () => {
    expect(ntaConfig({ NIHO_FINANCE_NTA_MODE: "fixture" })).toEqual({
      status: "on",
      mode: "fixture",
    });
    expect(
      ntaConfig({
        NIHO_FINANCE_NTA_MODE: "fixture",
        NIHO_FINANCE_NTA_APPLICATION_ID: APPLICATION_ID,
      }),
    ).toEqual({ status: "on", mode: "fixture" });
    expect(ntaConfig({ NIHO_FINANCE_NTA_MODE: "fixture", NIHO_FINANCE_ENV: "prod" })).toEqual({
      status: "off",
    });
    expect(
      ntaConfig({
        NIHO_FINANCE_NTA_MODE: "fixture",
        NIHO_FINANCE_ENV: "prod",
        NIHO_FINANCE_NTA_APPLICATION_ID: APPLICATION_ID,
      }),
    ).toEqual({ status: "on", mode: "api" });

    const lookup = createNtaLookupFromEnv({ NIHO_FINANCE_NTA_MODE: "fixture" });
    const result = await lookup?.lookup([fictionalNumber(1)]);
    expect(result?.registrations.get(fictionalNumber(1))?.name).toBe("架空食堂株式会社");
  });
});
