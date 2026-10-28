import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { isJobAuthConfigured, verifyJobRequest, type JobAuthOptions, type JobJwks } from "./auth";

const AUDIENCE = "https://jobs.example.test/api/jobs/stripe-sync";
const SERVICE_ACCOUNT = "scheduler@example-project.iam.gserviceaccount.com";
const LOCAL_TOKEN = "local-test-token-0123456789";
const NOW = new Date("2026-11-30T21:00:00Z");
const NOW_SECONDS = NOW.getTime() / 1000;

/** An environment with only these variables (Next.js types require NODE_ENV). */
function testEnv(variables: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...variables };
}

const CONFIGURED_VARIABLES = {
  NIHO_FINANCE_ENV: "prod",
  NIHO_FINANCE_JOB_AUDIENCE: AUDIENCE,
  NIHO_FINANCE_JOB_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
};
const CONFIGURED = testEnv(CONFIGURED_VARIABLES);

function rsaKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" } };
}

const KEY = rsaKey("test-key-1");
/** Another key pair announcing the same kid: its signatures must not verify. */
const IMPOSTOR = rsaKey("test-key-1");
const ROTATED = rsaKey("test-key-2");

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(
  claims: Record<string, unknown> = {},
  options: { header?: Record<string, unknown>; key?: KeyObject } = {},
): string {
  const header = { alg: "RS256", kid: KEY.kid, typ: "JWT", ...options.header };
  const payload = {
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    sub: "100000000000000000001",
    email: SERVICE_ACCOUNT,
    email_verified: true,
    iat: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 3570,
    ...claims,
  };
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(input), options.key ?? KEY.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

function request(authorization?: string): Request {
  return new Request(AUDIENCE, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });
}

function jwks(...keys: JobJwks["keys"]) {
  return vi.fn((): Promise<JobJwks> => Promise.resolve({ keys }));
}

/** Each call gets its own JWKS fetcher, so the module's key cache does not leak between tests. */
function options(overrides: Partial<JobAuthOptions> = {}): JobAuthOptions {
  return { env: CONFIGURED, now: NOW, fetchJwks: jwks(KEY.jwk), ...overrides };
}

async function status(authorization: string | undefined, overrides: Partial<JobAuthOptions> = {}) {
  const result = await verifyJobRequest(request(authorization), options(overrides));
  return result.ok ? 200 : result.status;
}

describe("verifyJobRequest (12-imports §5)", () => {
  it("accepts Cloud Scheduler's token and names the service account", async () => {
    await expect(verifyJobRequest(request(`Bearer ${token()}`), options())).resolves.toEqual({
      ok: true,
      principal: SERVICE_ACCOUNT,
    });
    expect(await status(`Bearer ${token({ iss: "accounts.google.com" })}`)).toBe(200);
    expect(await status(`bearer ${token()}`)).toBe(200);
  });

  it("rejects a request without a bearer token with 401", async () => {
    expect(await status(undefined)).toBe(401);
    expect(await status("")).toBe(401);
    expect(await status("Bearer ")).toBe(401);
    expect(await status(`Basic ${Buffer.from("user:pass").toString("base64")}`)).toBe(401);
  });

  it("rejects malformed tokens with 401", async () => {
    expect(await status("Bearer not-a-jwt")).toBe(401);
    expect(await status("Bearer a.b.c")).toBe(401);
    expect(await status(`Bearer ${token()}.extra`)).toBe(401);
    expect(await status(`Bearer ${encode(["RS256"])}.${encode({})}.c2ln`)).toBe(401);
  });

  it("rejects a wrong signature with 401", async () => {
    expect(await status(`Bearer ${token({}, { key: IMPOSTOR.privateKey })}`)).toBe(401);
    const [header, , signature] = token().split(".");
    const forged = `${header}.${encode({ aud: AUDIENCE, email: "attacker@example.test" })}.${signature}`;
    expect(await status(`Bearer ${forged}`)).toBe(401);
  });

  it("rejects tokens that are not RS256 with 401", async () => {
    const payload = encode({ iss: "https://accounts.google.com", aud: AUDIENCE });
    const unsigned = `${encode({ alg: "none", kid: KEY.kid })}.${payload}.`;
    expect(await status(`Bearer ${unsigned}`)).toBe(401);
    const noneWithSignature = `${encode({ alg: "none", kid: KEY.kid })}.${payload}.c2ln`;
    expect(await status(`Bearer ${noneWithSignature}`)).toBe(401);
    const input = `${encode({ alg: "HS256", kid: KEY.kid })}.${payload}`;
    const hmac = createHmac("sha256", JSON.stringify(KEY.jwk)).update(input).digest("base64url");
    expect(await status(`Bearer ${input}.${hmac}`)).toBe(401);
  });

  it("rejects a token without a kid, or with a kid Google does not list, with 401", async () => {
    expect(await status(`Bearer ${token({}, { header: { kid: undefined } })}`)).toBe(401);
    const fetchJwks = jwks(KEY.jwk);
    expect(await status(`Bearer ${token({}, { header: { kid: "unknown" } })}`, { fetchJwks })).toBe(
      401,
    );
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("rejects another audience, issuer or account with 403", async () => {
    expect(await status(`Bearer ${token({ aud: "https://other.example.test/" })}`)).toBe(403);
    expect(await status(`Bearer ${token({ aud: [AUDIENCE] })}`)).toBe(403);
    expect(await status(`Bearer ${token({ iss: "https://evil.example.test" })}`)).toBe(403);
    expect(
      await status(`Bearer ${token({ email: "other@example-project.iam.gserviceaccount.com" })}`),
    ).toBe(403);
    expect(await status(`Bearer ${token({ email_verified: false })}`)).toBe(403);
    expect(await status(`Bearer ${token({ email_verified: undefined })}`)).toBe(403);
  });

  it("rejects an expired token with 401, allowing 60 seconds of clock skew", async () => {
    expect(await status(`Bearer ${token({ exp: NOW_SECONDS - 61 })}`)).toBe(401);
    expect(await status(`Bearer ${token({ exp: NOW_SECONDS - 30 })}`)).toBe(200);
    expect(await status(`Bearer ${token({ exp: undefined })}`)).toBe(401);
  });

  it("rejects a token issued in the future with 401, allowing 60 seconds of clock skew", async () => {
    expect(await status(`Bearer ${token({ iat: NOW_SECONDS + 120 })}`)).toBe(401);
    expect(await status(`Bearer ${token({ iat: NOW_SECONDS + 30 })}`)).toBe(200);
    expect(await status(`Bearer ${token({ iat: undefined })}`)).toBe(401);
  });

  it("caches Google's keys for max-age and fetches them again afterwards", async () => {
    const fetchJwks = vi.fn((): Promise<JobJwks> =>
      Promise.resolve({ keys: [KEY.jwk], maxAgeSeconds: 600 }),
    );
    expect(await status(`Bearer ${token()}`, { fetchJwks })).toBe(200);
    expect(await status(`Bearer ${token()}`, { fetchJwks })).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    const later = new Date(NOW.getTime() + 601_000);
    const fresh = token({ iat: NOW_SECONDS + 600, exp: NOW_SECONDS + 4200 });
    expect(await status(`Bearer ${fresh}`, { fetchJwks, now: later })).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("fetches the keys again once when Google has rotated them", async () => {
    const fetchJwks = vi
      .fn((): Promise<JobJwks> => Promise.resolve({ keys: [ROTATED.jwk] }))
      .mockResolvedValueOnce({ keys: [KEY.jwk] });
    expect(await status(`Bearer ${token()}`, { fetchJwks })).toBe(200);
    const rotated = token({}, { header: { kid: ROTATED.kid }, key: ROTATED.privateKey });
    expect(await status(`Bearer ${rotated}`, { fetchJwks })).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("answers 503 when Google's keys cannot be fetched", async () => {
    const fetchJwks = vi.fn((): Promise<JobJwks> => Promise.reject(new Error("network down")));
    expect(await status(`Bearer ${token()}`, { fetchJwks })).toBe(503);
  });

  it("answers 503 when the audience or the service account is not set", async () => {
    const fetchJwks = jwks(KEY.jwk);
    for (const env of [
      testEnv({ NIHO_FINANCE_ENV: "prod" }),
      testEnv({ NIHO_FINANCE_ENV: "prod", NIHO_FINANCE_JOB_AUDIENCE: AUDIENCE }),
      testEnv({ NIHO_FINANCE_ENV: "prod", NIHO_FINANCE_JOB_SERVICE_ACCOUNT: SERVICE_ACCOUNT }),
      testEnv({ ...CONFIGURED_VARIABLES, NIHO_FINANCE_JOB_AUDIENCE: "  " }),
    ]) {
      await expect(
        verifyJobRequest(request(`Bearer ${token()}`), options({ env, fetchJwks })),
      ).resolves.toEqual({
        ok: false,
        status: 503,
        reason:
          "ジョブの認証が設定されていません（NIHO_FINANCE_JOB_AUDIENCE / NIHO_FINANCE_JOB_SERVICE_ACCOUNT）",
      });
    }
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it("accepts the local static token outside production only", async () => {
    const localVariables = { NIHO_FINANCE_ENV: "local", NIHO_FINANCE_JOB_TOKEN: LOCAL_TOKEN };
    const local = testEnv(localVariables);
    await expect(
      verifyJobRequest(request(`Bearer ${LOCAL_TOKEN}`), options({ env: local })),
    ).resolves.toEqual({ ok: true, principal: "local-job" });
    expect(
      await status(`Bearer ${LOCAL_TOKEN}`, {
        env: testEnv({ NIHO_FINANCE_JOB_TOKEN: LOCAL_TOKEN }),
      }),
    ).toBe(200);
    expect(await status(`Bearer ${LOCAL_TOKEN}-wrong`, { env: local })).toBe(503);
    expect(
      await status(`Bearer ${LOCAL_TOKEN}`, {
        env: testEnv({ ...localVariables, ...CONFIGURED_VARIABLES }),
      }),
    ).toBe(401);
    expect(
      await status(`Bearer ${LOCAL_TOKEN}`, {
        env: testEnv({ NIHO_FINANCE_ENV: "prod", NIHO_FINANCE_JOB_TOKEN: LOCAL_TOKEN }),
      }),
    ).toBe(503);
    const localConfigured = testEnv({ ...CONFIGURED_VARIABLES, ...localVariables });
    expect(await status(`Bearer ${LOCAL_TOKEN}`, { env: localConfigured })).toBe(200);
    expect(await status(`Bearer ${token()}`, { env: localConfigured })).toBe(200);
  });

  it("never puts the token in the reason", async () => {
    const presented = token({ aud: "https://other.example.test/" });
    for (const env of [CONFIGURED, testEnv({ NIHO_FINANCE_ENV: "prod" })]) {
      const result = await verifyJobRequest(request(`Bearer ${presented}`), options({ env }));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(presented.split(".")[1]);
    }
  });
});

describe("isJobAuthConfigured", () => {
  it("needs both the audience and the service account", () => {
    expect(isJobAuthConfigured(CONFIGURED)).toBe(true);
    expect(isJobAuthConfigured(testEnv({ NIHO_FINANCE_JOB_AUDIENCE: AUDIENCE }))).toBe(false);
    expect(
      isJobAuthConfigured(testEnv({ NIHO_FINANCE_JOB_SERVICE_ACCOUNT: SERVICE_ACCOUNT })),
    ).toBe(false);
    expect(
      isJobAuthConfigured(
        testEnv({ ...CONFIGURED_VARIABLES, NIHO_FINANCE_JOB_SERVICE_ACCOUNT: "" }),
      ),
    ).toBe(false);
  });
});
