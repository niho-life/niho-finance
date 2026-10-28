import { mailCheckJob } from "@/lib/jobs/mail-check";
import { runJob } from "@/lib/jobs/run";

export const dynamic = "force-dynamic";

/** One confirmation mail (manual: scripts/run-job.sh mail-check; jobs service only). */
export async function POST(request: Request): Promise<Response> {
  return runJob(request, "mail-check", mailCheckJob);
}
