import { exportReport } from "../_lib/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 報告の CSV / PDF (14-reports §2). */
export async function GET(request: Request): Promise<Response> {
  return exportReport(request);
}
