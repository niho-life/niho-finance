import { logEvent } from "./log";

/*
 * The first requests of a server process (#82). On Cloud Run an instance starts for the request that
 * waits for it (min-instances 0), so that request pays for everything a new process opens lazily.
 * The first few requests log how long their steps took (`startup.request` in Cloud Logging): with the
 * request log's latency they show where the wait goes. A warm-up at the start (`instrumentation.ts`)
 * was measured and made the first request slower (docs/decisions/2026-10-31-no-startup-warmup.md).
 */

/** How many requests after a start log their timing. */
const FIRST_REQUESTS = 3;

let requestsSeen = 0;

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
  // Since the process started (the instance's start on Cloud Run).
  const arrivedMs = Math.round(process.uptime() * 1000);
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
