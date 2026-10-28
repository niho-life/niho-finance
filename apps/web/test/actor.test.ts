import { generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyIapAssertion } from "../lib/actor";

const AUDIENCE = "/projects/123456789/locations/asia-northeast1/services/niho-finance";
const ISSUER = "https://cloud.google.com/iap";

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("ES256"));
  ({ privateKey: otherPrivateKey } = await generateKeyPair("ES256"));
});

async function assertion(
  claims: JWTPayload = {},
  options: { key?: CryptoKey; issuer?: string; audience?: string; expiresAt?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "Owner@Example.com", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: "test" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject("accounts.google.com:1234567890")
    .setIssuedAt(now - 60)
    .setExpirationTime(options.expiresAt ?? now + 600)
    .sign(options.key ?? privateKey);
}

function verify(token: string) {
  return verifyIapAssertion(token, { audience: AUDIENCE, getKey: () => publicKey });
}

describe("verifyIapAssertion", () => {
  it("returns the lower-cased email and the subject of a valid assertion", async () => {
    await expect(verify(await assertion())).resolves.toEqual({
      email: "owner@example.com",
      subject: "accounts.google.com:1234567890",
    });
  });

  it("rejects another audience", async () => {
    const token = await assertion({}, { audience: "/projects/1/locations/x/services/other" });
    await expect(verify(token)).rejects.toThrow(/aud/);
  });

  it("rejects another issuer", async () => {
    await expect(verify(await assertion({}, { issuer: "https://example.com" }))).rejects.toThrow(
      /iss/,
    );
  });

  it("rejects an expired assertion (beyond the 30-second tolerance)", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 120;
    await expect(verify(await assertion({}, { expiresAt }))).rejects.toThrow(/exp/);
  });

  it("accepts an assertion that expired within the 30-second tolerance", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 10;
    await expect(verify(await assertion({}, { expiresAt }))).resolves.toMatchObject({
      email: "owner@example.com",
    });
  });

  it("rejects an assertion without an email", async () => {
    await expect(verify(await assertion({ email: undefined }))).rejects.toThrow(/email/);
  });

  it("rejects a signature by another key", async () => {
    await expect(verify(await assertion({}, { key: otherPrivateKey }))).rejects.toThrow(
      /signature/,
    );
  });

  it("checks the expiry against `now`", async () => {
    const token = await assertion();
    await expect(
      verifyIapAssertion(token, {
        audience: AUDIENCE,
        getKey: () => publicKey,
        now: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toThrow(/exp/);
  });
});
