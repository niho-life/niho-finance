import { appEnv } from "@/lib/env";
import { taskQueueConfig } from "@/lib/jobs/enqueue";

/*
 * The conditions of 受け渡しパッケージ (14-reports §16.1) as the URL and the forms carry them:
 * `fy` (第 n 期) and `documents=1` (証憑のファイルを含める; off by default).
 */

export type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export interface PackageConditions {
  /** `null`: the default year. */
  fiscalYearNo: number | null;
  includeDocuments: boolean;
}

export function packageConditions(read: (name: string) => string | undefined): PackageConditions {
  const fy = read("fy");
  return {
    fiscalYearNo: fy !== undefined && /^\d{1,4}$/.test(fy) ? Number(fy) : null,
    includeDocuments: read("documents") === "1",
  };
}

export function conditionsOfParams(params: RawParams): PackageConditions {
  return packageConditions((name) => first(params[name]));
}

export function conditionsOfSearch(params: URLSearchParams): PackageConditions {
  return packageConditions((name) => params.get(name) ?? undefined);
}

export function conditionsOfForm(form: FormData): PackageConditions {
  return packageConditions((name) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  });
}

/** `/settings/export/package?fy=1&documents=1` (plus `extra`, e.g. `error`). */
export function packagePageHref(
  conditions: { fiscalYearNo: number | null; includeDocuments: boolean },
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  if (conditions.fiscalYearNo !== null) params.set("fy", String(conditions.fiscalYearNo));
  if (conditions.includeDocuments) params.set("documents", "1");
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return `/settings/export/package${query ? `?${query}` : ""}`;
}

/**
 * How a package over the size limit is made (§16.4): `queue` (Cloud Tasks → the jobs service),
 * `inline` (local development without a queue: the screen runs the job itself) or `none`
 * (production without a queue: the files are left out and the screen makes it directly).
 */
export type LargePackageMode = "queue" | "inline" | "none";

export function largePackageMode(): LargePackageMode {
  if (taskQueueConfig()) return "queue";
  return appEnv().NIHO_FINANCE_ENV === "prod" ? "none" : "inline";
}

/** A request id is a ULID. */
export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
