import type { ImportOutcome } from "@niho-finance/db";
import type { JobAuthResult } from "./auth";

/**
 * The Stripe sync job (`POST /api/jobs/stripe-sync`, 12-imports §4.4): authenticated by
 * `verifyJobRequest`, it syncs every connected Stripe wallet and answers 200 with each wallet's
 * outcome. Authentication failures are 401 / 403 / 503; a failing sync is never a 5xx, so Cloud
 * Scheduler does not retry into a storm (06 §4). The dependencies are injected for the tests.
 */
export interface StripeSyncJobDependencies {
  verify: (request: Request) => Promise<JobAuthResult>;
  /** Syncs all connected Stripe wallets as `actor` (the job's principal). */
  sync: (actor: string) => Promise<readonly ImportOutcome[]>;
}

export interface StripeSyncJobWallet {
  walletId: string;
  ok: boolean;
  batchId: string | null;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  error: string | null;
}

export type StripeSyncJobBody =
  { ok: true; wallets: StripeSyncJobWallet[] } | { ok: false; error: string };

const NO_STORE = { "cache-control": "no-store" } as const;
const SYNC_FAILED = "同期できませんでした";

/** Strips anything shaped like a Stripe key or a database URL from a log line. */
function redact(text: string): string {
  return text
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*@[^\s]*/gi, "[redacted-url]");
}

function describe(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return "non-Error thrown";
}

export async function handleStripeSyncJob(
  request: Request,
  dependencies: StripeSyncJobDependencies,
): Promise<Response> {
  const auth = await dependencies.verify(request);
  if (!auth.ok) {
    return Response.json({ ok: false, error: auth.reason } satisfies StripeSyncJobBody, {
      status: auth.status,
      headers: NO_STORE,
    });
  }
  let body: StripeSyncJobBody;
  try {
    const outcomes = await dependencies.sync(auth.principal);
    body = {
      ok: true,
      wallets: outcomes.map(
        ({ walletId, batchId, importedCount, duplicateCount, failedCount, error }) => ({
          walletId,
          ok: error === null,
          batchId,
          importedCount,
          duplicateCount,
          failedCount,
          error,
        }),
      ),
    };
  } catch (error) {
    console.error(`[niho-finance] stripe-sync job failed: ${describe(error)}`);
    body = { ok: false, error: SYNC_FAILED };
  }
  return Response.json(body, { status: 200, headers: NO_STORE });
}

/** `GET` and the other methods: only `POST` runs the job. */
export function methodNotAllowed(): Response {
  return Response.json(
    { ok: false, error: "POST で呼び出してください" } satisfies StripeSyncJobBody,
    {
      status: 405,
      headers: { allow: "POST", ...NO_STORE },
    },
  );
}
