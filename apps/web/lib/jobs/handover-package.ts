import {
  findHandoverRequest,
  recordHandoverFailed,
  recordHandoverReady,
  todayInJapan,
  type PrismaClient,
} from "@niho-finance/db";
import { writeHandoverPackage } from "@niho-finance/reports";
import { z } from "zod";
import {
  buildPackagePlan,
  loadPackageBasis,
} from "@/app/(app)/settings/export/package/_lib/collect";
import { logEvent } from "../log";
import {
  packageKey,
  packageStoreFromEnv,
  type PackageStore,
  type PackageWriter,
} from "./package-store";
import { JOB_ACTOR, type JobContext, type JobSummary } from "./run";

/*
 * handover-package (14-reports §16.4): makes the 受け渡しパッケージ of one request with the screens'
 * functions, streams the zip to the backup bucket (`packages/<作成日時>_fy<n>_<requestId>.zip`) and
 * records `ready` — or `failed` with a reason for the owner. Once per request: a request that is
 * already made is left alone. The screen calls the same function itself when there is no queue
 * (local development).
 */

export const HANDOVER_JOB_PATH = "/api/jobs/handover-package";

export const handoverJobBodySchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  fiscalYearId: z.string().min(1).max(64),
  includeDocuments: z.boolean(),
  requestedBy: z.string().min(1).max(320),
});
export type HandoverJobBody = z.infer<typeof handoverJobBodySchema>;

const GENERIC_REASON = "受け渡しパッケージを作れませんでした。時間をおいてもう一度依頼してください";

/** An owner-facing reason: the error's own message when it is written for people (Japanese). */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /[぀-ヿ一-鿿]/.test(message) ? message.slice(0, 300) : GENERIC_REASON;
}

export interface HandoverJobResult extends JobSummary {
  requestId: string;
  outcome: "ready" | "already-ready" | "failed";
}

/**
 * Makes and stores the package of `body.requestId`. Throws after recording `failed`, so that the
 * job's log says `ok=false` (the alert); returns quietly when the request is already made.
 */
export async function makeStoredHandoverPackage(
  prisma: PrismaClient,
  body: HandoverJobBody,
  options: { now?: Date; store?: PackageStore } = {},
): Promise<HandoverJobResult> {
  const now = options.now ?? new Date();
  const request = await findHandoverRequest(prisma, body.requestId, { now });
  if (!request) throw new Error(`no handover request ${body.requestId}`);
  if (request.state === "ready") {
    return { requestId: body.requestId, outcome: "already-ready", key: request.key };
  }
  if (
    request.fiscalYearId !== body.fiscalYearId ||
    request.includeDocuments !== body.includeDocuments
  ) {
    throw new Error(`handover request ${body.requestId} does not match the task's body`);
  }

  let writer: PackageWriter | null = null;
  try {
    const basis = await loadPackageBasis(prisma, {
      fiscalYearId: request.fiscalYearId,
      today: todayInJapan(now),
    });
    if (!basis || basis.year.id !== request.fiscalYearId) {
      throw new Error("会計期間が見つかりません。期を確かめてもう一度依頼してください");
    }
    const plan = await buildPackagePlan(prisma, basis, {
      includeDocuments: request.includeDocuments,
      createdBy: request.requestedBy,
      createdAt: now,
    });
    const store = options.store ?? packageStoreFromEnv();
    const key = packageKey(now, basis.year.no, body.requestId);
    const opened = await store.openWriter(key);
    writer = opened;
    const result = await writeHandoverPackage(plan, (chunk) => opened.write(chunk));
    await opened.close();
    writer = null;
    await recordHandoverReady(
      prisma,
      { requestId: body.requestId, key, fileCount: result.fileCount, bytes: result.bytes },
      { actor: JOB_ACTOR },
    );
    return {
      requestId: body.requestId,
      outcome: "ready",
      location: `${store.describe()}/${key}`,
      files: result.fileCount,
      bytes: result.bytes,
      documents: result.documentCount,
      missingDocuments: result.missingDocumentIds.length,
    };
  } catch (error) {
    if (writer) await writer.abort(error);
    await recordHandoverFailed(
      prisma,
      { requestId: body.requestId, reason: reasonOf(error) },
      { actor: JOB_ACTOR },
    );
    throw error;
  }
}

/** The handler of `POST /api/jobs/handover-package` (the task's body names the request). */
export function handoverPackageJob(request: Request) {
  return async ({ prisma, startedAt }: JobContext): Promise<JobSummary> => {
    const parsed = handoverJobBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new Error("the task's body is not a handover request");
    return makeStoredHandoverPackage(prisma, parsed.data, { now: startedAt });
  };
}

/** The screen without a queue (local): runs the job in place. `false` when it failed (recorded). */
export async function makeHandoverPackageInline(
  prisma: PrismaClient,
  body: HandoverJobBody,
): Promise<boolean> {
  try {
    await makeStoredHandoverPackage(prisma, body);
    return true;
  } catch (error) {
    logEvent("ERROR", "handover.inline_failed", {
      requestId: body.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
