import { getPrismaClient, settleAfterImport, syncAllBankWallets } from "@niho-finance/db";
import { verifyJobRequest } from "@/lib/jobs/auth";
import {
  bankSyncFinished,
  handleBankSyncJob,
  methodNotAllowed,
  type BankSyncJobBody,
} from "@/lib/jobs/bank-sync";
import { isJobsService, logJobFinished, notOnThisService } from "@/lib/jobs/run";

export const dynamic = "force-dynamic";

/**
 * Cloud Scheduler's daily bank API sync (19-bank-api §3.5): OIDC-authenticated, always 200 once
 * in. Jobs service only (docs/ops/deploy.md §6); the outcome is one `job.finished` log line.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isJobsService()) return notOnThisService();
  const startedAt = new Date();
  const response = await handleBankSyncJob(request, {
    verify: (incoming) => verifyJobRequest(incoming),
    // 取込時の自動登録 (15 §11) runs in each wallet's import.
    sync: (actor) =>
      syncAllBankWallets(getPrismaClient(), { actor, afterImport: settleAfterImport }),
  });
  const body = (await response.clone().json()) as BankSyncJobBody;
  const finished = bankSyncFinished(response.status, body);
  logJobFinished("bank-sync", finished.ok, startedAt, finished.fields);
  return response;
}

export function GET(): Response {
  return methodNotAllowed();
}
