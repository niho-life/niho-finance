import { runJob } from "@/lib/jobs/run";
import { getNtaLookup } from "@/lib/reader/config";
import { createRegistryCheckJob } from "@/lib/registry/job";

export const dynamic = "force-dynamic";

const registryCheckJob = createRegistryCheckJob({ lookup: getNtaLookup });

/** The monthly registry check (20-reader §11; Cloud Scheduler, jobs service only). */
export async function POST(request: Request): Promise<Response> {
  return runJob(request, "registry-check", registryCheckJob);
}
