import { loadRootEnv } from "@niho-finance/db";
import { z } from "zod";

const environmentSchema = z.object({
  NIHO_FINANCE_ENV: z.enum(["local", "prod"]).default("local"),
});

export type AppEnvironment = z.infer<typeof environmentSchema>["NIHO_FINANCE_ENV"];

/** The environment name (`NIHO_FINANCE_ENV`), read at request time. */
export function appEnvironment(): AppEnvironment {
  loadRootEnv();
  return environmentSchema.parse(process.env).NIHO_FINANCE_ENV;
}
