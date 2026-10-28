import { getPrismaClient, todayInJapan, type PrismaClient } from "@niho-finance/db";
import type { CalendarDate } from "@niho-finance/ledger";
import { appEnv } from "../env";
import { logEvent } from "../log";
import { verifyJobRequest } from "./auth";

/*
 * The entry of every job route (`/api/jobs/<name>`, called by Cloud Scheduler; docs/ops/deploy.md
 * §6). Jobs exist only on the jobs service (`NIHO_FINANCE_SERVICE=jobs`): the web service answers
 * 404. Who may call is checked twice: Cloud Run IAM (`roles/run.invoker` for the scheduler's service
 * account only), then the scheduler's OIDC token (`verifyJobRequest`, 12-imports §5; locally the
 * `NIHO_FINANCE_JOB_TOKEN` bearer).
 *
 * A job never throws: success and failure are one `job.finished` log line each (the alert filters
 * on `ok=false`) and the response is 200, 401 / 403 / 503 (authentication) or 500. Cloud Scheduler
 * does not retry.
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

/** Whether this is the jobs service (`NIHO_FINANCE_SERVICE=jobs`); the screens have no jobs. */
export function isJobsService(): boolean {
  return appEnv().NIHO_FINANCE_SERVICE === "jobs";
}

/** The 404 of a job route on the web service. */
export function notOnThisService(): Response {
  return new Response(null, { status: 404, headers: NO_STORE });
}

/** The one log line of a finished job (`job.finished`; the alert filters on `ok=false`). */
export function logJobFinished(
  job: string,
  ok: boolean,
  startedAt: Date,
  fields: Record<string, unknown> = {},
): void {
  logEvent(ok ? "INFO" : "ERROR", "job.finished", {
    job,
    ok,
    durationMs: Date.now() - startedAt.getTime(),
    ...fields,
  });
}

export async function runJob(
  request: Request,
  name: string,
  handler: (context: JobContext) => Promise<JobSummary>,
): Promise<Response> {
  const startedAt = new Date();
  try {
    if (!isJobsService()) return notOnThisService();
    const auth = await verifyJobRequest(request);
    if (!auth.ok) {
      logJobFinished(name, false, startedAt, { status: auth.status, error: auth.reason });
      return Response.json(
        { ok: false, job: name, error: auth.reason },
        { status: auth.status, headers: NO_STORE },
      );
    }
    const summary = await handler({
      prisma: getPrismaClient(),
      today: todayInJapan(startedAt),
      startedAt,
    });
    logJobFinished(name, true, startedAt, summary);
    return Response.json({ ok: true, job: name, ...summary }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logJobFinished(name, false, startedAt, { error: message });
    return Response.json(
      { ok: false, job: name, error: message },
      { status: 500, headers: NO_STORE },
    );
  }
}
