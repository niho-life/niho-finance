import type { RegistryCheckResult } from "@niho-finance/db";
import type { JobAuthResult } from "@/lib/jobs/auth";

/**
 * The monthly registry check (`POST /api/jobs/registry-check`, 20-reader §11): authenticated by
 * `verifyJobRequest`, it looks up every active partner's registration number at the National Tax
 * Agency's publication and answers 200 with the counts. Authentication failures are 401 / 403 /
 * 503; a lookup without the application ID and a failing check are 200 `ok: false`, so Cloud
 * Scheduler does not retry into a storm (06 §4). The dependencies are injected for the tests.
 */
export interface RegistryCheckJobDependencies {
  verify: (request: Request) => Promise<JobAuthResult>;
  /** Whether the lookup is set (the application ID, or the fixture outside production). */
  configured: () => boolean;
  /** Checks every partner as `actor` (the job's principal). */
  check: (actor: string) => Promise<RegistryCheckResult>;
}

export type RegistryCheckJobBody =
  ({ ok: true } & RegistryCheckResult) | { ok: false; error: string };

const NO_STORE = { "cache-control": "no-store" } as const;
const NOT_CONFIGURED = "国税庁の照合が設定されていません";
const CHECK_FAILED = "照合できませんでした";

/**
 * Strips what could carry the application ID from a log line: URLs (its query has `id=`), an
 * `id=` parameter on its own and runs of 13 digits.
 */
function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[redacted-url]")
    .replace(/\bid=[^&\s]*/gi, "id=[redacted]")
    .replace(/(?<!\d)\d{13}(?!\d)/g, "[redacted-number]");
}

function describe(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return "non-Error thrown";
}

function json(body: RegistryCheckJobBody, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function handleRegistryCheckJob(
  request: Request,
  dependencies: RegistryCheckJobDependencies,
): Promise<Response> {
  const auth = await dependencies.verify(request);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, auth.status);
  if (!dependencies.configured()) return json({ ok: false, error: NOT_CONFIGURED }, 200);
  let body: RegistryCheckJobBody;
  try {
    const { checked, registered, notRegistered, ended, failed, errors } = await dependencies.check(
      auth.principal,
    );
    body = { ok: true, checked, registered, notRegistered, ended, failed, errors };
  } catch (error) {
    console.error(`[niho-finance] registry-check job failed: ${describe(error)}`);
    body = { ok: false, error: CHECK_FAILED };
  }
  return json(body, 200);
}
