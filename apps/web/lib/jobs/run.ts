import { getPrismaClient, todayInJapan, type PrismaClient } from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import { appEnv } from "../env";
import { logEvent } from "../log";

/*
 * The entry of every job route (`/api/jobs/<name>`, called by Cloud Scheduler; docs/ops/deploy.md
 * §6). Jobs exist only on the jobs service (`NIHO_FINANCE_SERVICE=jobs`): the web service answers
 * 404. Who may call is enforced by Cloud Run IAM (`roles/run.invoker` for the scheduler's service
 * account only). When S4 (#5) adds `requireJobInvoker(request)` (`apps/web/lib/jobs/auth.ts`, the
 * OIDC check), call it right after the 404 check below so the check is made twice.
 *
 * A job never throws: success and failure are one `job.finished` log line each (the alert filters
 * on `ok=false`) and the response is 200 or 500. Cloud Scheduler does not retry.
 */

/** The audit log actor of job writes. */
export const JOB_ACTOR = "system";

export interface JobContext {
  prisma: PrismaClient;
  /** Today in Japan (JST) when the job started. */
  today: CalendarDate;
  startedAt: Date;
}

/** What a job reports: logged with `job.finished` and returned as the response body. */
export type JobSummary = Record<string, unknown>;

const NO_STORE = { "cache-control": "no-store" } as const;

export async function runJob(
  request: Request,
  name: string,
  handler: (context: JobContext) => Promise<JobSummary>,
): Promise<Response> {
  const startedAt = new Date();
  try {
    if (appEnv().NIHO_FINANCE_SERVICE !== "jobs") {
      return new Response(null, { status: 404, headers: NO_STORE });
    }
    // S4 (#5): requireJobInvoker(request) goes here.
    const summary = await handler({
      prisma: getPrismaClient(),
      today: todayInJapan(startedAt),
      startedAt,
    });
    const durationMs = Date.now() - startedAt.getTime();
    logEvent("INFO", "job.finished", { job: name, ok: true, durationMs, ...summary });
    return Response.json({ ok: true, job: name, ...summary }, { headers: NO_STORE });
  } catch (error) {
    const durationMs = Date.now() - startedAt.getTime();
    const message = error instanceof Error ? error.message : String(error);
    logEvent("ERROR", "job.finished", { job: name, ok: false, durationMs, error: message });
    return Response.json(
      { ok: false, job: name, error: message },
      { status: 500, headers: NO_STORE },
    );
  }
}
