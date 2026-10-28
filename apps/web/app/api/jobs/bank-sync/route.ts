import { getPrismaClient, settleAfterImport, syncAllBankWallets } from "@niho-finance/db";
import { verifyJobRequest } from "@/lib/jobs/auth";
import { handleBankSyncJob, methodNotAllowed } from "@/lib/jobs/bank-sync";

export const dynamic = "force-dynamic";

/** Cloud Scheduler's daily bank API sync (19-bank-api §3.5): OIDC-authenticated, always 200 once in. */
export async function POST(request: Request): Promise<Response> {
  return handleBankSyncJob(request, {
    verify: (incoming) => verifyJobRequest(incoming),
    // 取込時の自動登録 (15 §11) runs in each wallet's import.
    sync: (actor) =>
      syncAllBankWallets(getPrismaClient(), { actor, afterImport: settleAfterImport }),
  });
}

export function GET(): Response {
  return methodNotAllowed();
}
