import { createHash } from "node:crypto";
import { appendAuditLog, exportBackup } from "@niho-finance/db";
import { backupSinkFromEnv } from "../backup/sink";
import { appEnv } from "../env";
import { JOB_ACTOR, type JobContext, type JobSummary } from "./run";

/*
 * backup-export (daily, 03:00 JST; docs/ops/deploy.md §6–§7): `snapshot.json` (every table),
 * `trial-balance.json` (every fiscal year) and, last, `manifest.json` (SHA-256 of each file) in
 * `exports/<YYYY-MM-DD>/<HHmmss>Z/` (UTC). A folder without a manifest is an incomplete export.
 */

export const BACKUP_MANIFEST_FORMAT = "niho-finance-backup";

const JSON_TYPE = "application/json";

interface ExportFile {
  /** Relative to the export folder. */
  path: string;
  body: Buffer;
  contentType: string;
}

/** `exports/2026-11-20/180000Z` for 2026-11-20T18:00:00Z. */
export function backupFolder(at: Date): string {
  const iso = at.toISOString();
  return `exports/${iso.slice(0, 10)}/${iso.slice(11, 19).replaceAll(":", "")}Z`;
}

function jsonFile(filePath: string, value: unknown): ExportFile {
  return {
    path: filePath,
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: JSON_TYPE,
  };
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export async function backupExportJob({ prisma, startedAt }: JobContext): Promise<JobSummary> {
  const sink = backupSinkFromEnv();
  const { snapshot, trialBalances } = await exportBackup(prisma, { now: startedAt });
  const folder = backupFolder(startedAt);
  const files: ExportFile[] = [
    jsonFile("snapshot.json", snapshot),
    jsonFile("trial-balance.json", trialBalances),
    // S7 (#8): the CSV / beancount exports (`(db) => Promise<{ path, body, contentType }[]>`)
    // join here, in the same folder and the manifest.
  ];

  const written: { path: string; bytes: number; sha256: string }[] = [];
  for (const file of files) {
    await sink.write(`${folder}/${file.path}`, file.body, file.contentType);
    written.push({ path: file.path, bytes: file.body.length, sha256: sha256(file.body) });
  }
  const manifest = {
    format: BACKUP_MANIFEST_FORMAT,
    exportedAt: snapshot.exportedAt,
    gitSha: appEnv().NIHO_FINANCE_GIT_SHA ?? null,
    migration: snapshot.migration,
    files: written,
  };
  const manifestFile = jsonFile("manifest.json", manifest);
  await sink.write(`${folder}/${manifestFile.path}`, manifestFile.body, manifestFile.contentType);

  const location = `${sink.describe()}/${folder}`;
  await appendAuditLog(prisma, {
    actor: JOB_ACTOR,
    action: "backup.export",
    entity: "backup",
    entityId: folder,
    after: { manifest, location },
  });
  return {
    location,
    files: written.length + 1,
    bytes: written.reduce((sum, file) => sum + file.bytes, manifestFile.body.length),
    entries: snapshot.tables.journal_entry?.length ?? 0,
  };
}
