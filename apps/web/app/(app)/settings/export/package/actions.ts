"use server";

import {
  getPrismaClient,
  recordHandoverFailed,
  recordHandoverRequest,
  todayInJapan,
} from "@niho-finance/db";
import { redirect } from "next/navigation";
import type { ActionError } from "@/lib/action-types";
import { actor, ActorError } from "@/lib/actor";
import { authorizeAction } from "@/lib/authz";
import { enqueueJob, taskQueueConfig } from "@/lib/jobs/enqueue";
import { HANDOVER_JOB_PATH, makeHandoverPackageInline } from "@/lib/jobs/handover-package";
import { JOB_ACTOR } from "@/lib/jobs/run";
import { logEvent } from "@/lib/log";
import { loadPackageBasis, packageEstimate } from "./_lib/collect";
import { PACKAGE_ERRORS } from "./_lib/labels";
import { conditionsOfForm, largePackageMode, packagePageHref } from "./_lib/query";

/**
 * 「作成を依頼」 (14-reports §15.4): records `requested` and hands the package to the jobs service
 * through Cloud Tasks — or, locally without a queue, makes it in place. Back to the page with the
 * outcome; the request appears under 「作成した受け渡しパッケージ」.
 */
export async function requestHandoverPackage(formData: FormData): Promise<ActionError | undefined> {
  // 閲覧 (the tax accountant) may take the package too (#55; docs/decisions/2026-10-29-handover-package-viewer.md).
  const denied = await authorizeAction("viewer");
  if (denied) return denied;
  const conditions = conditionsOfForm(formData);
  const back: (extra: Record<string, string>) => never = (extra) =>
    redirect(`${packagePageHref(conditions, extra)}#packages`);

  let requestedBy: string;
  try {
    requestedBy = await actor();
  } catch (error) {
    if (error instanceof ActorError) back({ error: "actor" });
    throw error;
  }
  const prisma = getPrismaClient();
  const basis = await loadPackageBasis(prisma, {
    fiscalYearNo: conditions.fiscalYearNo,
    today: todayInJapan(),
  });
  if (!basis) back({ error: "year" });
  const mode = largePackageMode();
  if (mode === "none") back({ error: "no-queue" });

  const { year } = basis;
  const requestId = await recordHandoverRequest(
    prisma,
    {
      fiscalYearId: year.id,
      fiscalYearNo: year.no,
      from: year.startDate,
      to: year.endDate,
      includeDocuments: conditions.includeDocuments,
      estimateBytes: packageEstimate(basis, conditions.includeDocuments),
    },
    { actor: requestedBy },
  );
  const body = {
    requestId,
    fiscalYearId: year.id,
    includeDocuments: conditions.includeDocuments,
    requestedBy,
  };

  const queue = mode === "queue" ? taskQueueConfig() : null;
  if (queue) {
    try {
      await enqueueJob(queue, { path: HANDOVER_JOB_PATH, body, taskId: `handover-${requestId}` });
    } catch (error) {
      logEvent("ERROR", "handover.enqueue_failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      await recordHandoverFailed(
        prisma,
        { requestId, reason: PACKAGE_ERRORS.enqueue ?? "" },
        { actor: JOB_ACTOR },
      );
      back({ error: "enqueue" });
    }
    back({ done: "requested" });
  }
  const made = await makeHandoverPackageInline(prisma, body);
  back({ done: made ? "made" : "failed" });
}
