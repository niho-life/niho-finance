import { afterEach, describe, expect, it, vi } from "vitest";
import { firstRequestTiming } from "../lib/startup";

describe("firstRequestTiming (#82)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("times the first three requests of a process only, one log line each", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const timings = [1, 2, 3, 4].map(() => firstRequestTiming("/"));
    expect(timings.slice(0, 3).every((timing) => timing !== null)).toBe(true);
    expect(timings[3]).toBeNull();

    timings[0]?.mark("iap");
    timings[0]?.mark("access");
    timings[0]?.log();
    expect(log).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({ severity: "INFO", event: "startup.request", n: 1, path: "/" });
    for (const field of ["arrivedMs", "iapMs", "accessMs", "proxyMs"]) {
      expect(typeof entry[field]).toBe("number");
    }
  });
});
