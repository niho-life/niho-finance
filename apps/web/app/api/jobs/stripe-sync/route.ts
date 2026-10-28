import { getPrismaClient, settleAfterImport, syncAllStripeWallets } from "@niho-finance/db";
import { verifyJobRequest } from "@/lib/jobs/auth";
import { isJobsService, logJobFinished, notOnThisService } from "@/lib/jobs/run";
import {
  handleStripeSyncJob,
  methodNotAllowed,
  type StripeSyncJobBody,
} from "@/lib/jobs/stripe-sync";
import { stripeSyncFinished } from "@/lib/jobs/stripe-sync-result";

export const dynamic = "force-dynamic";

/**
 * Cloud Scheduler's daily Stripe sync (12-imports §4.4): OIDC-authenticated, always 200 once in.
 * Jobs service only (docs/ops/deploy.md §6); the outcome is one `job.finished` log line.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isJobsService()) return notOnThisService();
  const startedAt = new Date();
  const response = await handleStripeSyncJob(request, {
    verify: (incoming) => verifyJobRequest(incoming),
    // 取込時の自動登録 (15 §11) runs in each wallet's import.
    sync: (actor) =>
      syncAllStripeWallets(getPrismaClient(), { actor, afterImport: settleAfterImport }),
  });
  const body = (await response.clone().json()) as StripeSyncJobBody;
  const finished = stripeSyncFinished(response.status, body);
  logJobFinished("stripe-sync", finished.ok, startedAt, finished.fields);
  return response;
}

export function GET(): Response {
  return methodNotAllowed();
}
