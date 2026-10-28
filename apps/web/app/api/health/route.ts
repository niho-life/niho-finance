import { getPrismaClient } from "@niho-finance/db";

export const dynamic = "force-dynamic";

/** Liveness of the app and reachability of the database (`SELECT 1`). */
export async function GET(): Promise<Response> {
  return Response.json(
    { ok: true, db: await databaseReachable() },
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
