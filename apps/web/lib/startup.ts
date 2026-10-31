import { getPrismaClient } from "@niho-finance/db";
import { prefetchIapKeys } from "./actor";
import { appEnv } from "./env";
import { logEvent } from "./log";

/*
 * The start of a server process (#82). On Cloud Run an instance starts for the request that waits
 * for it (min-instances 0), so that request pays for everything opened lazily. Two of those are
 * opened here at the start, in parallel with the loading of the routes, instead of one after the
 * other inside the request: the database connection and IAP's public keys. The first requests of a
 * process log how long their steps took (`startup.*` in Cloud Logging). Nothing here can fail a start
 * or a request; `NIHO_FINANCE_STARTUP_WARMUP=off` turns the warm-up off (to compare).
 */

/** How many requests after a start log their timing. */
const FIRST_REQUESTS = 3;

let requestsSeen = 0;

/** Milliseconds since the process started (the instance's start on Cloud Run). */
function uptimeMs(): number {
  return Math.round(process.uptime() * 1000);
}

/** How long `work` took in ms, or why it failed. */
async function timed(work: () => Promise<unknown>): Promise<number | string> {
  const start = performance.now();
  try {
    await work();
    return Math.round(performance.now() - start);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Opens the database connection and fetches IAP's keys without waiting for them (`register`). */
export function warmUpOnStart(): void {
  try {
    const env = appEnv();
    const warmUp = process.env.NIHO_FINANCE_STARTUP_WARMUP !== "off";
    logEvent("INFO", "startup.register", { uptimeMs: uptimeMs(), warmUp });
    if (!warmUp) return;
    const iap =
      env.NIHO_FINANCE_SERVICE === "web" && env.NIHO_FINANCE_IAP_AUDIENCE
        ? timed(prefetchIapKeys)
        : Promise.resolve(null);
    const database = timed(() => getPrismaClient().$connect());
    void Promise.all([iap, database]).then(([iapKeysMs, databaseMs]) => {
      logEvent("INFO", "startup.warmup", { uptimeMs: uptimeMs(), iapKeysMs, databaseMs });
    });
  } catch (error) {
    logEvent("WARNING", "startup.warmup_skipped", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface RequestTiming {
  /** The step that just ended (`iap`, `access`): its time since the previous mark. */
  mark(step: string): void;
  /** One `startup.request` line with the steps and the whole proxy. */
  log(): void;
}

/** The timing of one of the first requests of a process, or `null` once they have passed. */
export function firstRequestTiming(path: string): RequestTiming | null {
  if (requestsSeen >= FIRST_REQUESTS) return null;
  requestsSeen += 1;
  const n = requestsSeen;
  const arrivedMs = uptimeMs();
  const start = performance.now();
  let last = start;
  const steps: Record<string, number> = {};
  return {
    mark(step) {
      const now = performance.now();
      steps[`${step}Ms`] = Math.round(now - last);
      last = now;
    },
    log() {
      logEvent("INFO", "startup.request", {
        n,
        path,
        arrivedMs,
        ...steps,
        proxyMs: Math.round(performance.now() - start),
      });
    },
  };
}
