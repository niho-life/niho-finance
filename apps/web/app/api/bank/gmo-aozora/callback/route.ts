import { getPrismaClient, resolveBankApiConfig, saveBankAuthorization } from "@niho-finance/db";
import { exchangeAuthorizationCode } from "@niho-finance/importers";
import { handleBankCallback } from "@/lib/bank/oauth-routes";
import { actor, appEnvironment } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * The bank's redirect after the authorization (19-bank-api §2.2 steps 2–5): one URL for every
 * wallet, registered with GMO as `NIHO_FINANCE_GMO_AOZORA_REDIRECT_URI`.
 */
export async function GET(request: Request): Promise<Response> {
  return handleBankCallback(request, {
    config: () => resolveBankApiConfig(),
    exchange: (auth, code, nonce) => exchangeAuthorizationCode(auth, code, { nonce }),
    save: (input) => saveBankAuthorization(getPrismaClient(), input, { actor: actor() }),
    secure: () => appEnvironment() === "prod",
  });
}
