/**
 * Restores a daily export into an empty, migrated database and checks it against the export:
 *
 *   DATABASE_URL=<niho_finance_* database> npm run db:restore -- <export folder>
 *
 * The folder holds `snapshot.json` and `trial-balance.json` (and `manifest.json`, whose SHA-256
 * sums are checked first). Prints `restore: OK` and exits 0 when the trial balance of every
 * fiscal year recomputed from the restored book equals the exported one; otherwise exits 1.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  latestAppliedMigration,
  restoreBackupSnapshot,
  trialBalancesForBackup,
  type BackupSnapshot,
  type BackupTrialBalance,
} from "../src/backup";
import { createPrismaClient } from "../src/client";
import { describeDatabaseUrl, requireDatabaseUrl } from "../src/env";

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** Problems with the files listed in `manifest.json` (none when it matches or is absent). */
async function checkManifest(dir: string): Promise<string[]> {
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.warn("restore: no manifest.json; the SHA-256 sums are not checked");
    return [];
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { files?: ManifestFile[] };
  const problems: string[] = [];
  for (const file of manifest.files ?? []) {
    const body = await readFile(path.join(dir, file.path)).catch(() => null);
    if (!body) {
      problems.push(`${file.path}: missing`);
      continue;
    }
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== file.sha256 || body.length !== file.bytes) {
      problems.push(`${file.path}: SHA-256 or size differs from manifest.json`);
    }
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where two JSON values differ (`path: expected …, got …`); trial balance rows keyed by code. */
function collectDifferences(want: unknown, got: unknown, at: string, out: string[]): void {
  if (out.length >= 30 || isDeepStrictEqual(want, got)) return;
  if (isRecord(want) && isRecord(got)) {
    for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
      collectDifferences(want[key], got[key], `${at}.${key}`, out);
    }
    return;
  }
  if (Array.isArray(want) && Array.isArray(got)) {
    const keyOf = (item: unknown, index: number) =>
      isRecord(item) && typeof item.code === "string" ? item.code : String(index);
    const remaining = new Map(got.map((item, index) => [keyOf(item, index), item]));
    want.forEach((item, index) => {
      const key = keyOf(item, index);
      collectDifferences(item, remaining.get(key), `${at}[${key}]`, out);
      remaining.delete(key);
    });
    for (const [key, item] of remaining) collectDifferences(undefined, item, `${at}[${key}]`, out);
    return;
  }
  out.push(`${at}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function describeMismatch(expected: BackupTrialBalance[], actual: BackupTrialBalance[]): string[] {
  const lines: string[] = [];
  const restored = new Map(actual.map((item) => [item.fiscalYearNo, item]));
  for (const want of expected) {
    const got = restored.get(want.fiscalYearNo);
    restored.delete(want.fiscalYearNo);
    if (!got) {
      lines.push(`fiscal year ${want.fiscalYearNo}: missing after the restore`);
    } else if (!isDeepStrictEqual(want, got)) {
      lines.push(`fiscal year ${want.fiscalYearNo} (${want.startDate}..${want.endDate}): differs`);
      const differences: string[] = [];
      collectDifferences(want, got, "  ", differences);
      lines.push(...differences);
    }
  }
  for (const extra of restored.values()) {
    lines.push(`fiscal year ${extra.fiscalYearNo}: not in trial-balance.json`);
  }
  return lines;
}

async function main(): Promise<number> {
  const folder = process.argv[2];
  if (!folder) {
    console.error(
      "usage: npm run db:restore -- <export folder with snapshot.json and trial-balance.json>",
    );
    return 2;
  }
  // `npm run` changes into packages/db: a relative folder is relative to where npm was started.
  const dir = path.resolve(process.env.INIT_CWD ?? process.cwd(), folder);
  const problems = await checkManifest(dir);
  if (problems.length > 0) {
    console.error(`restore: FAILED: ${dir} does not match its manifest.json`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  const snapshot = JSON.parse(
    await readFile(path.join(dir, "snapshot.json"), "utf8"),
  ) as BackupSnapshot;
  const expected = JSON.parse(
    await readFile(path.join(dir, "trial-balance.json"), "utf8"),
  ) as BackupTrialBalance[];

  const databaseUrl = requireDatabaseUrl();
  const { host, port, database } = describeDatabaseUrl(databaseUrl);
  const prisma = createPrismaClient({ databaseUrl });
  try {
    const migration = await latestAppliedMigration(prisma);
    if (migration !== snapshot.migration) {
      console.warn(
        `restore: ${database} is migrated to ${migration ?? "(nothing)"}; the export was taken at ${snapshot.migration ?? "(unknown)"}`,
      );
    }
    const result = await restoreBackupSnapshot(prisma, snapshot);
    const rows = Object.values(result.tables).reduce((sum, count) => sum + count, 0);
    const actual = await trialBalancesForBackup(prisma);
    if (!isDeepStrictEqual(actual, expected)) {
      console.error(
        `restore: FAILED: ${database} at ${host}:${port} was restored, but its trial balances differ from trial-balance.json`,
      );
      for (const line of describeMismatch(expected, actual)) console.error(line);
      return 1;
    }
    console.log(
      `restore: OK ${database} at ${host}:${port}: ${rows} rows in ${Object.keys(result.tables).length} tables from ${snapshot.exportedAt}; ` +
        `the trial balances of ${actual.length} fiscal year(s) match`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`restore: FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
