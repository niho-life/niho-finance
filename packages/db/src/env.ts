import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

/** Finds the repository root (the package.json that declares `workspaces`), walking up from `startDir`. */
export function findRepoRoot(startDir: string = process.cwd()): string | null {
  // The lookup is for local development only: keep it out of Next.js output file tracing.
  let dir = path.resolve(/* turbopackIgnore: true */ startDir);
  for (;;) {
    const packageJson = path.join(/* turbopackIgnore: true */ dir, "package.json");
    if (existsSync(packageJson)) {
      try {
        const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { workspaces?: unknown };
        if (manifest.workspaces !== undefined) return dir;
      } catch {
        // Not a readable manifest: keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Only databases named `niho_finance` or `niho_finance_*` are ever touched. */
const DATABASE_NAME_PATTERN = /^niho_finance(_[a-z0-9_]+)?$/;

export interface DatabaseLocation {
  host: string;
  port: string;
  database: string;
}

/** Host, port and database name of a connection URL (never the credentials). */
export function describeDatabaseUrl(url: string): DatabaseLocation {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

export function isNihoFinanceDatabaseUrl(url: string): boolean {
  try {
    return DATABASE_NAME_PATTERN.test(describeDatabaseUrl(url).database);
  } catch {
    return false;
  }
}

/** Throws unless the URL points to a niho-finance database (guards against another project's DB). */
export function assertNihoFinanceDatabase(url: string): void {
  if (isNihoFinanceDatabaseUrl(url)) return;
  let where = "an unparsable URL";
  try {
    const { host, port, database } = describeDatabaseUrl(url);
    where = `"${database}" at ${host}:${port}`;
  } catch {
    // keep the generic description
  }
  throw new Error(
    `Refusing to use database ${where}: niho-finance only uses databases named niho_finance or ` +
      `niho_finance_*. Check DATABASE_URL (the repository .env, CI, or a variable exported by your shell).`,
  );
}

/**
 * Applies an env file to `env`. Variables already set win (standard precedence), except a
 * `DATABASE_URL` that points to a database other than niho_finance*: a shell may export one for
 * another project, and the repository file is what this project means. Returns the replaced keys.
 */
export function applyEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const values = parseEnv(readFileSync(file, "utf8"));
  const replaced: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    const current = env[key];
    if (current === undefined || current === "") {
      env[key] = value;
    } else if (
      key === "DATABASE_URL" &&
      !isNihoFinanceDatabaseUrl(current) &&
      isNihoFinanceDatabaseUrl(value)
    ) {
      env[key] = value;
      replaced.push(key);
    }
  }
  return replaced;
}

let rootEnvLoaded = false;

/** Applies `<repo root>/.env` once per process (local development; CI and Cloud Run have no such file). */
export function loadRootEnv(startDir?: string): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;
  const root = findRepoRoot(startDir);
  const file = root ? path.join(/* turbopackIgnore: true */ root, ".env") : null;
  if (!file || !existsSync(file)) return;
  if (applyEnvFile(file).includes("DATABASE_URL")) {
    console.warn(
      `[niho-finance] DATABASE_URL from the environment is not a niho_finance database; using ${file}.`,
    );
  }
}

const databaseUrlSchema = z
  .string({
    error:
      "DATABASE_URL is not set. Copy .env.example to .env (local) or set it in the environment.",
  })
  .regex(/^postgres(ql)?:\/\//, { error: "DATABASE_URL must be a postgresql:// URL" });

/** `DATABASE_URL` (after the root `.env`), checked to be a niho-finance database. Throws when unset. */
export function requireDatabaseUrl(): string {
  loadRootEnv();
  const url = databaseUrlSchema.parse(process.env.DATABASE_URL);
  assertNihoFinanceDatabase(url);
  return url;
}

/** Like `requireDatabaseUrl`, but `undefined` when `DATABASE_URL` is not set. */
export function optionalDatabaseUrl(): string | undefined {
  loadRootEnv();
  if (!process.env.DATABASE_URL) return undefined;
  return requireDatabaseUrl();
}
