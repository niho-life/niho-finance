import { getPrismaClient } from "@niho-finance/db";
import { appEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Liveness of the app, reachability of the database (`SELECT 1`), the service and the commit. */
export async function GET(): Promise<Response> {
  const env = appEnv();
  return Response.json(
    {
      ok: true,
      db: await databaseReachable(),
      service: env.NIHO_FINANCE_SERVICE,
      ...(env.NIHO_FINANCE_GIT_SHA ? { gitSha: env.NIHO_FINANCE_GIT_SHA } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function databaseReachable(): Promise<boolean> {
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
