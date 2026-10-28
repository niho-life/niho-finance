import { backupExportJob } from "@/lib/jobs/backup-export";
import { runJob } from "@/lib/jobs/run";

export const dynamic = "force-dynamic";

/** Daily export to the backup bucket (Cloud Scheduler, jobs service only). */
export async function POST(request: Request): Promise<Response> {
  return runJob(request, "backup-export", backupExportJob);
}
