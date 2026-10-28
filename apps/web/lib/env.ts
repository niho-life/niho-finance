import { loadRootEnv } from "@niho-finance/db";
import { z } from "zod";

/** Empty values count as unset (an empty line in `.env`, `--set-env-vars NAME=`). */
function unsetIfBlank(value: unknown): unknown {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A comma-separated list (`a@example.com, b@example.com`); empty items are dropped. */
function splitList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

const optionalText = z.preprocess(unsetIfBlank, z.string().optional());

const environmentSchema = z.object({
  NIHO_FINANCE_ENV: z.enum(["local", "prod"]).default("local"),
  /** The Cloud Run service: `jobs` runs `/api/jobs/*`; on `web` (the screens) they answer 404. */
  NIHO_FINANCE_SERVICE: z.preprocess(unsetIfBlank, z.enum(["web", "jobs"]).default("web")),
  /** Audience of the IAP signed header (`/projects/<number>/locations/<region>/services/<name>`). */
  NIHO_FINANCE_IAP_AUDIENCE: optionalText,
  /**
   * Who writes when there is no IAP header (local only; audit log `actor`). The default is the
   * seed's 管理者, so that a seeded book opens (23-users-and-expenses §2).
   */
  NIHO_FINANCE_ACTOR: z.preprocess(unsetIfBlank, z.string().max(200).default("owner@example.com")),
  /** `log` writes the mail to the log instead of sending it (local); `smtp` sends it. */
  NIHO_FINANCE_MAIL: z.preprocess(unsetIfBlank, z.enum(["log", "smtp"]).default("log")),
  NIHO_FINANCE_MAIL_FROM: optionalText,
  /** Recipients of the notices (comma-separated). */
  NIHO_FINANCE_MAIL_TO: z.preprocess(splitList, z.array(z.string()).default([])),
  NIHO_FINANCE_SMTP_HOST: z.preprocess(unsetIfBlank, z.string().default("smtp.gmail.com")),
  NIHO_FINANCE_SMTP_PORT: z.preprocess(
    unsetIfBlank,
    z.coerce.number().int().min(1).max(65_535).default(465),
  ),
  NIHO_FINANCE_SMTP_USER: optionalText,
  NIHO_FINANCE_SMTP_PASSWORD: optionalText,
  /** Daily export target: a GCS bucket (Cloud Run) … */
  NIHO_FINANCE_BACKUP_BUCKET: optionalText,
  /** … or a local folder (development). */
  NIHO_FINANCE_BACKUP_DIR: optionalText,
  /** The screens' URL, put in mails. */
  NIHO_FINANCE_APP_URL: optionalText,
  /** The deployed commit (backup manifest, health check). */
  NIHO_FINANCE_GIT_SHA: optionalText,
});

export type AppEnv = z.infer<typeof environmentSchema>;
export type AppEnvironment = AppEnv["NIHO_FINANCE_ENV"];

/** The app's environment variables (after the repository `.env` locally), read at request time. */
export function appEnv(): AppEnv {
  loadRootEnv();
  return environmentSchema.parse(process.env);
}

/** The environment name (`NIHO_FINANCE_ENV`), read at request time. */
export function appEnvironment(): AppEnvironment {
  return appEnv().NIHO_FINANCE_ENV;
}
