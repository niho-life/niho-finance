import { createNtaClient } from "./client";
import { createFixtureNtaLookup, FIXTURE_NTA_REGISTRATIONS } from "./fixture";
import type { NtaLookup } from "./types";

/**
 * Chooses the registry lookup from the environment (20-reader §8.2). The application ID never
 * leaves this module: the configuration says only whether the lookup is on and how.
 */
export type NtaConfig = { status: "off" } | { status: "on"; mode: "api" | "fixture" };

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * `NIHO_FINANCE_NTA_MODE=fixture` (ignored in production) answers from fictional data, even when
 * an application ID is set; otherwise an application ID turns the API on.
 */
export function ntaConfig(env: NodeJS.ProcessEnv): NtaConfig {
  if (setting(env, "NIHO_FINANCE_NTA_MODE") === "fixture" && env.NIHO_FINANCE_ENV !== "prod") {
    return { status: "on", mode: "fixture" };
  }
  if (setting(env, "NIHO_FINANCE_NTA_APPLICATION_ID") !== null) {
    return { status: "on", mode: "api" };
  }
  return { status: "off" };
}

/** The lookup for the environment, or `null` when off. Not cached: the caller keeps one. */
export function createNtaLookupFromEnv(env: NodeJS.ProcessEnv): NtaLookup | null {
  const config = ntaConfig(env);
  if (config.status === "off") return null;
  if (config.mode === "fixture") return createFixtureNtaLookup(FIXTURE_NTA_REGISTRATIONS);
  const applicationId = setting(env, "NIHO_FINANCE_NTA_APPLICATION_ID");
  return applicationId === null ? null : createNtaClient({ applicationId });
}
