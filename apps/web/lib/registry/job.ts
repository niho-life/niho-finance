import { checkPartnerRegistrations, type RegistryCheckResult } from "@niho-finance/db";
import type { NtaLookup } from "@niho-finance/importers";
import { JOB_ACTOR, type JobContext, type JobSummary } from "@/lib/jobs/run";

/*
 * registry-check (monthly; 20-reader §11, 06 の invoice-registry-verify): looks up every active
 * partner's registration number at the National Tax Agency's publication and stores the result on
 * the partners. Run through `runJob` like the other jobs (docs/ops/deploy.md §6): a lookup that is
 * not set, or numbers that could not be looked up, fail the job (500 and `job.finished` with
 * `ok=false`, which alerts); the partners that were looked up keep their result. Errors carry no
 * URL and no application ID (`NtaApiError`).
 */

export interface RegistryCheckJobDependencies {
  /** The process's lookup (`getNtaLookup`), `null` without the application ID. */
  lookup: () => NtaLookup | null;
  check?: typeof checkPartnerRegistrations;
}

export const REGISTRY_NOT_CONFIGURED = "国税庁の照合が設定されていません";

export function createRegistryCheckJob(dependencies: RegistryCheckJobDependencies) {
  const check = dependencies.check ?? checkPartnerRegistrations;
  return async ({ prisma, startedAt }: JobContext): Promise<JobSummary> => {
    const lookup = dependencies.lookup();
    if (!lookup) throw new Error(REGISTRY_NOT_CONFIGURED);
    const result: RegistryCheckResult = await check(prisma, lookup, {
      actor: JOB_ACTOR,
      now: startedAt,
    });
    if (result.failed > 0) {
      throw new Error(
        `照合できなかった番号があります（${result.failed} 件。${result.errors[0] ?? "理由は不明"}）`,
      );
    }
    const { checked, registered, notRegistered, ended } = result;
    return { checked, registered, notRegistered, ended };
  };
}
