import {
  findHandoverRequest,
  getPrismaClient,
  getSetupProgress,
  recordHandoverDirectDownload,
  recordHandoverStoredDownload,
  todayInJapan,
} from "@niho-finance/db";
import { handoverDelivery, handoverPackageBytes, handoverZipName } from "@niho-finance/reports";
import { redirect } from "next/navigation";
import { actor } from "@/lib/actor";
import { packageStoreFromEnv } from "@/lib/jobs/package-store";
import { zipResponse } from "@/lib/pdf/download";
import { buildPackagePlan, loadPackageBasis, packageEstimate } from "../_lib/collect";
import { FILES_LEFT_OUT_NOTE } from "../_lib/labels";
import {
  conditionsOfSearch,
  isRequestId,
  largePackageMode,
  packagePageHref,
  type PackageConditions,
} from "../_lib/query";
import { authorizeRoute } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /settings/export/package/download` (14-reports §15.1, §15.4):
 * - `?request=<id>`: a package the job made — a 302 to a 10-minute signed URL (GCS) or the bytes
 *   (local), recorded as `downloaded` (`delivery: "signed-url"`).
 * - `?fy=<n>&documents=1`: made here and returned when the estimate is within 20 MB, recorded as
 *   `downloaded` (`delivery: "direct"`). Over it the page's 「作成を依頼」 is the way, except in
 *   production without a queue, where the files are left out.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeRoute("viewer");
  if (denied) return denied;
  const prisma = getPrismaClient();
  if (!(await getSetupProgress(prisma)).ready) redirect("/setup");
  const params = new URL(request.url).searchParams;
  const requestId = params.get("request");
  if (requestId !== null) return stored(requestId);
  return direct(conditionsOfSearch(params));
}

async function stored(requestId: string): Promise<Response> {
  const prisma = getPrismaClient();
  const back: (error: string) => never = (error) =>
    redirect(packagePageHref({ fiscalYearNo: null, includeDocuments: false }, { error }));
  if (!isRequestId(requestId)) back("not-found");
  const found = await findHandoverRequest(prisma, requestId);
  if (!found) back("not-found");
  if (found.state !== "ready" || !found.key) back("not-ready");
  const who = await actor();
  const fileName = handoverZipName({
    no: found.fiscalYearNo,
    startDate: found.from,
    endDate: found.to,
  });
  const response = await packageStoreFromEnv().downloadResponse(found.key, fileName);
  await recordHandoverStoredDownload(prisma, { requestId }, { actor: who });
  return response;
}

async function direct(conditions: PackageConditions): Promise<Response> {
  const prisma = getPrismaClient();
  const basis = await loadPackageBasis(prisma, {
    fiscalYearNo: conditions.fiscalYearNo,
    today: todayInJapan(),
  });
  if (!basis) redirect(packagePageHref(conditions, { error: "year" }));
  let includeDocuments = conditions.includeDocuments;
  const notes: string[] = [];
  if (handoverDelivery(packageEstimate(basis, includeDocuments)) === "job") {
    if (largePackageMode() !== "none") {
      redirect(`${packagePageHref(conditions, { error: "too-large" })}#make`);
    }
    includeDocuments = false;
    notes.push(FILES_LEFT_OUT_NOTE);
  }
  const who = await actor();
  const createdAt = new Date();
  const plan = await buildPackagePlan(prisma, basis, {
    includeDocuments,
    createdBy: who,
    createdAt,
    notes,
  });
  const { zip, result } = await handoverPackageBytes(plan);
  await recordHandoverDirectDownload(
    prisma,
    {
      fiscalYearNo: basis.year.no,
      from: basis.year.startDate,
      to: basis.year.endDate,
      includeDocuments,
      fileCount: result.fileCount,
      documentCount: result.documentCount,
      missingDocumentCount: result.missingDocumentIds.length,
      bytes: result.bytes,
    },
    { actor: who },
  );
  return zipResponse(zip, handoverZipName(basis.year));
}
