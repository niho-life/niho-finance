import { handoverPackageJob } from "@/lib/jobs/handover-package";
import { runJob } from "@/lib/jobs/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 受け渡しパッケージ (14-reports §16.4): a Cloud Tasks task from the screens with
 * `{ requestId, fiscalYearId, includeDocuments, requestedBy }`; jobs service only.
 */
export async function POST(request: Request): Promise<Response> {
  return runJob(request, "handover-package", handoverPackageJob(request));
}
