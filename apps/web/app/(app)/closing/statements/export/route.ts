import { exportStatements } from "../_lib/export";
import { authorizeRoute } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 決算書と申告用データの書き出し (17-financial-statements §2). */
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoute("accountant");
  if (denied) return denied;
  return exportStatements(request);
}
