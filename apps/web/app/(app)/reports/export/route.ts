import { exportReport } from "../_lib/export";
import { authorizeRoute } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 報告の CSV / PDF (14-reports §2). */
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoute("viewer");
  if (denied) return denied;
  return exportReport(request);
}
