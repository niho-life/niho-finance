import type { ImportOutcome } from "@niho-finance/db";
import type { JobAuthResult } from "./auth";

/**
 * The bank API sync job (`POST /api/jobs/bank-sync`, 19-bank-api §3.5): authenticated by
 * `verifyJobRequest`, it syncs every active bank wallet that is connected or needs reconnecting
 * and answers 200 with each wallet's outcome. Authentication failures are 401 / 403 / 503; a
 * failing sync is never a 5xx, so Cloud Scheduler does not retry into a storm (06 §4). The
 * dependencies are injected for the tests.
 */
export interface BankSyncJobDependencies {
  verify: (request: Request) => Promise<JobAuthResult>;
  /** Syncs all connected bank wallets as `actor` (the job's principal). */
  sync: (actor: string) => Promise<readonly ImportOutcome[]>;
}

export interface BankSyncJobWallet {
  walletId: string;
  ok: boolean;
  batchId: string | null;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  error: string | null;
}

export type BankSyncJobBody =
  { ok: true; wallets: BankSyncJobWallet[] } | { ok: false; error: string };

const NO_STORE = { "cache-control": "no-store" } as const;
const SYNC_FAILED = "同期できませんでした";

/**
 * Strips anything shaped like a token, a bank account ID or a database URL from a log line: the
 * bank's access / refresh tokens and ID Tokens, Authorization headers, long digit runs.
 */
function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*@[^\s]*/gi, "[redacted-url]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted]")
    .replace(/[A-Za-z0-9_\-~+/]{32,}={0,2}/g, "[redacted]")
    .replace(/\d{10,}/g, "***");
}

function describe(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return "non-Error thrown";
}

export async function handleBankSyncJob(
  request: Request,
  dependencies: BankSyncJobDependencies,
): Promise<Response> {
  const auth = await dependencies.verify(request);
  if (!auth.ok) {
    return Response.json({ ok: false, error: auth.reason } satisfies BankSyncJobBody, {
      status: auth.status,
      headers: NO_STORE,
    });
  }
  let body: BankSyncJobBody;
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
    console.error(`[niho-finance] bank-sync job failed: ${describe(error)}`);
    body = { ok: false, error: SYNC_FAILED };
  }
  return Response.json(body, { status: 200, headers: NO_STORE });
}

/** `GET` and the other methods: only `POST` runs the job. */
export function methodNotAllowed(): Response {
  return Response.json(
    { ok: false, error: "POST で呼び出してください" } satisfies BankSyncJobBody,
    {
      status: 405,
      headers: { allow: "POST", ...NO_STORE },
    },
  );
}

/**
 * What the job reports in its `job.finished` log line (docs/ops/deploy.md §6): the response is
 * 200 even when a wallet fails, so a failed or lapsed wallet reaches the "job failed" alert, and
 * its mail, through `ok: false` here (as `stripeSyncFinished` does for Stripe).
 */
export function bankSyncFinished(
  status: number,
  body: BankSyncJobBody,
): { ok: boolean; fields: Record<string, unknown> } {
  if (status !== 200 || !body.ok) {
    return { ok: false, fields: { status, error: body.ok ? "unexpected status" : body.error } };
  }
  const failed = body.wallets.filter((wallet) => !wallet.ok);
  const sum = (key: "importedCount" | "duplicateCount" | "failedCount") =>
    body.wallets.reduce((total, wallet) => total + wallet[key], 0);
  return {
    ok: failed.length === 0,
    fields: {
      wallets: body.wallets.length,
      imported: sum("importedCount"),
      duplicates: sum("duplicateCount"),
      failedRows: sum("failedCount"),
      ...(failed.length > 0
        ? { error: `同期できなかった口座があります（${failed.length} 件）`, failedWallets: failed }
        : {}),
    },
  };
}
