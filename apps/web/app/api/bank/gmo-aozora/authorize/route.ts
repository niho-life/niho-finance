import {
  getPrismaClient,
  listWallets,
  resolveBankApiConfig,
  resolveBankTokenKey,
} from "@niho-finance/db";
import { handleBankAuthorize } from "@/lib/bank/oauth-routes";
import { appEnvironment } from "@/lib/env";
import { authorizeRoute } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** 「接続する」/「再接続する」 of the authorization code flow (19-bank-api §2.2 step 1). */
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoute("owner");
  if (denied) return denied;
  return handleBankAuthorize(request, {
    walletState: async (walletId) => {
      const wallet = (await listWallets(getPrismaClient())).find((item) => item.id === walletId);
      if (!wallet || wallet.kind !== "bank") return null;
      return wallet.isActive ? "active" : "inactive";
    },
    config: () => resolveBankApiConfig(),
    hasTokenKey: () => resolveBankTokenKey() !== null,
    secure: () => appEnvironment() === "prod",
  });
}
