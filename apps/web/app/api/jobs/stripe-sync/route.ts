import { getPrismaClient, settleAfterImport, syncAllStripeWallets } from "@niho-finance/db";
import { verifyJobRequest } from "@/lib/jobs/auth";
import { handleStripeSyncJob, methodNotAllowed } from "@/lib/jobs/stripe-sync";

export const dynamic = "force-dynamic";

/** Cloud Scheduler's daily Stripe sync (12-imports §4.4): OIDC-authenticated, always 200 once in. */
export async function POST(request: Request): Promise<Response> {
  return handleStripeSyncJob(request, {
    verify: (incoming) => verifyJobRequest(incoming),
    // 取込時の自動登録 (15 §11) runs in each wallet's import.
    sync: (actor) =>
      syncAllStripeWallets(getPrismaClient(), { actor, afterImport: settleAfterImport }),
  });
}

export function GET(): Response {
  return methodNotAllowed();
}
