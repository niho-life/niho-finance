import { getPrismaClient, resolveBankApiConfig, saveBankAuthorization } from "@niho-finance/db";
import { exchangeAuthorizationCode } from "@niho-finance/importers";
import { handleBankCallback } from "@/lib/bank/oauth-routes";
import { actor } from "@/lib/actor";
import { appEnvironment } from "@/lib/env";
import { authorizeRoute } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * The bank's redirect after the authorization (19-bank-api §2.2 steps 2–5): one URL for every
 * wallet, registered with GMO as `NIHO_FINANCE_GMO_AOZORA_REDIRECT_URI`.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoute("owner");
  if (denied) return denied;
  return handleBankCallback(request, {
    config: () => resolveBankApiConfig(),
    exchange: (auth, code, nonce) => exchangeAuthorizationCode(auth, code, { nonce }),
    save: async (input) =>
      saveBankAuthorization(getPrismaClient(), input, { actor: await actor() }),
    secure: () => appEnvironment() === "prod",
  });
}
