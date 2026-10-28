import { checkPartnerRegistrations, getPrismaClient } from "@niho-finance/db";
import { verifyJobRequest } from "@/lib/jobs/auth";
import { methodNotAllowed } from "@/lib/jobs/stripe-sync";
import { getNtaLookup } from "@/lib/reader/config";
import { handleRegistryCheckJob } from "@/lib/registry/job";

export const dynamic = "force-dynamic";

/**
 * Cloud Scheduler's monthly registry check (20-reader §11, 06 の invoice-registry-verify):
 * OIDC-authenticated, always 200 once in.
 */
export async function POST(request: Request): Promise<Response> {
  return handleRegistryCheckJob(request, {
    verify: (incoming) => verifyJobRequest(incoming),
    configured: () => getNtaLookup() !== null,
    check: async (actor) => {
      const lookup = getNtaLookup();
      if (!lookup) throw new Error("the registry lookup is not configured");
      return checkPartnerRegistrations(getPrismaClient(), lookup, { actor });
    },
  });
}

export function GET(): Response {
  return methodNotAllowed();
}
