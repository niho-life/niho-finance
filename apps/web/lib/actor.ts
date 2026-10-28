import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { headers } from "next/headers";
import { appEnv } from "./env";
import { logEvent } from "./log";

/*
 * Who writes (the audit log `actor` of Server Actions). On Cloud Run the screens sit behind IAP,
 * which signs every request it lets through (`x-goog-iap-jwt-assertion`, ES256); the email of
 * that verified assertion is the actor. In prod a missing or invalid assertion rejects the write.
 * Locally, without IAP, it is `NIHO_FINANCE_ACTOR` (default `owner`). docs/ops/deploy.md §5.
 */

export const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";
const IAP_ISSUER = "https://cloud.google.com/iap";

/** IAP's public keys, fetched on first use and cached by jose (one set per process). */
const iapKeys = createRemoteJWKSet(new URL("https://www.gstatic.com/iap/verify/public_key-jwk"));

const ACTOR_UNVERIFIED = "ログイン情報を確認できませんでした。画面を読み込み直してください";

/** The signed-in user could not be established; nothing is written. `message` is owner-facing. */
export class ActorError extends Error {
  constructor(message: string = ACTOR_UNVERIFIED, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ActorError";
  }
}

export interface IapIdentity {
  /** Lower-cased email of the Google account. */
  email: string;
  /** IAP's stable account ID (`accounts.google.com:<number>`). */
  subject: string;
}

/** Verifies an IAP assertion (signature, issuer, audience, expiry) and returns who it is for. */
export async function verifyIapAssertion(
  token: string,
  options: { audience: string; getKey: JWTVerifyGetKey; now?: Date },
): Promise<IapIdentity> {
  const { payload } = await jwtVerify(token, options.getKey, {
    issuer: IAP_ISSUER,
    audience: options.audience,
    algorithms: ["ES256"],
    clockTolerance: 30,
    ...(options.now ? { currentDate: options.now } : {}),
  });
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email === "") throw new Error("the IAP assertion has no email");
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new Error("the IAP assertion has no subject");
  }
  return { email, subject: payload.sub };
}

function reject(reason: string, cause?: unknown): never {
  logEvent("WARNING", "actor.rejected", { reason });
  throw new ActorError(undefined, { cause });
}

export type IapAssertionStatus = "verified" | "missing" | "invalid" | "not-configured";

/**
 * Whether the current request carries a valid IAP assertion, without saying whose (the health
 * check: after a deploy it shows that writes will be accepted, without writing anything).
 */
export async function iapAssertionStatus(): Promise<IapAssertionStatus> {
  const audience = appEnv().NIHO_FINANCE_IAP_AUDIENCE;
  if (!audience) return "not-configured";
  const assertion = (await headers()).get(IAP_ASSERTION_HEADER);
  if (!assertion) return "missing";
  try {
    await verifyIapAssertion(assertion, { audience, getKey: iapKeys });
    return "verified";
  } catch {
    return "invalid";
  }
}

/** The actor of the current request (Server Actions). Throws `ActorError` when it is not known. */
export async function actor(): Promise<string> {
  const env = appEnv();
  const assertion = (await headers()).get(IAP_ASSERTION_HEADER);
  const audience = env.NIHO_FINANCE_IAP_AUDIENCE;
  if (!audience || !assertion) {
    if (env.NIHO_FINANCE_ENV === "prod") {
      reject(audience ? "no IAP assertion header" : "NIHO_FINANCE_IAP_AUDIENCE is not set");
    }
    return env.NIHO_FINANCE_ACTOR;
  }
  try {
    return (await verifyIapAssertion(assertion, { audience, getKey: iapKeys })).email;
  } catch (error) {
    reject(error instanceof Error ? error.message : String(error), error);
  }
}
