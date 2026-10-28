import { loadRootEnv } from "@niho-finance/db";
import { z } from "zod";

const environmentSchema = z.object({
  NIHO_FINANCE_ENV: z.enum(["local", "prod"]).default("local"),
  /** Who writes (audit log `actor`). S8 replaces it with the IAP user's email. */
  NIHO_FINANCE_ACTOR: z.preprocess(
    (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined),
    z.string().max(200).default("owner"),
  ),
});

export type AppEnvironment = z.infer<typeof environmentSchema>["NIHO_FINANCE_ENV"];

/** The environment name (`NIHO_FINANCE_ENV`), read at request time. */
export function appEnvironment(): AppEnvironment {
  loadRootEnv();
  return environmentSchema.parse(process.env).NIHO_FINANCE_ENV;
}

/** The actor of Server Actions (`NIHO_FINANCE_ACTOR`, default `owner`). */
export function actor(): string {
  loadRootEnv();
  return environmentSchema.parse(process.env).NIHO_FINANCE_ACTOR;
}
