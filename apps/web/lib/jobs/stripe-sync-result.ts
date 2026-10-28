import type { StripeSyncJobBody } from "./stripe-sync";

/*
 * What the Stripe sync job reports in its `job.finished` log line (docs/ops/deploy.md §6). The
 * job itself answers 200 even when a wallet fails (12-imports §4.4: no retry storm), so the
 * failure reaches the "job failed" alert, and its mail, through this line.
 */

export interface StripeSyncFinished {
  ok: boolean;
  fields: Record<string, unknown>;
}

export function stripeSyncFinished(status: number, body: StripeSyncJobBody): StripeSyncFinished {
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
