import { calendarNotifyJob } from "@/lib/jobs/calendar-notify";
import { runJob } from "@/lib/jobs/run";

export const dynamic = "force-dynamic";

/** Deadline reminders by mail (Cloud Scheduler, jobs service only). */
export async function POST(request: Request): Promise<Response> {
  return runJob(request, "calendar-notify", calendarNotifyJob);
}
