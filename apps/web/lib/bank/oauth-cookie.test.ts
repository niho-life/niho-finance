import { describe, expect, it } from "vitest";
import {
  BANK_OAUTH_COOKIE,
  bankOAuthCookie,
  checkBankOAuthCallback,
  clearedBankOAuthCookie,
  decodeBankOAuthState,
  encodeBankOAuthState,
  newBankOAuthState,
  randomBankOAuthValue,
  readCookie,
  type BankOAuthState,
} from "./oauth-cookie";

/** Fictional values: 43 base64url characters each, like 32 random bytes. */
const STATE = "S".repeat(43);
const NONCE = "N".repeat(43);
const ISSUED = new Date("2026-11-30T01:00:00Z");

function value(overrides: Partial<BankOAuthState> = {}): BankOAuthState {
  return {
    walletId: "01JBANKWALLET0000000000001",
    state: STATE,
    nonce: NONCE,
    issuedAt: ISSUED.getTime(),
    ...overrides,
  };
}

function after(seconds: number): Date {
  return new Date(ISSUED.getTime() + seconds * 1000);
}

function encodedJson(json: unknown): string {
  return Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
}

describe("the bank authorization cookie", () => {
  it("makes a state and a nonce of 32 random bytes each", () => {
    const made = newBankOAuthState("wallet-1", ISSUED);
    expect(made.walletId).toBe("wallet-1");
    expect(made.issuedAt).toBe(ISSUED.getTime());
    expect(made.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.state).not.toBe(made.nonce);
    expect(Buffer.from(randomBankOAuthValue(), "base64url")).toHaveLength(32);
  });

  it("reads back what it wrote", () => {
    expect(decodeBankOAuthState(encodeBankOAuthState(value()))).toEqual(value());
  });

  it.each([
    ["not base64url", "abc.def"],
    ["not JSON", Buffer.from("{walletId", "utf8").toString("base64url")],
    ["not an object", encodedJson("text")],
    ["no state", encodedJson({ ...value(), state: undefined })],
    ["a short nonce", encodedJson({ ...value(), nonce: "short" })],
    ["a wallet ID with a path in it", encodedJson({ ...value(), walletId: "../imports" })],
    ["a non-numeric time", encodedJson({ ...value(), issuedAt: "2026-11-30" })],
  ])("refuses a value that is not ours: %s", (_case, text) => {
    expect(decodeBankOAuthState(text)).toBeNull();
  });

  it("is httpOnly, scoped to the bank routes, Lax, 10 minutes, and Secure in production", () => {
    const local = bankOAuthCookie(value(), { secure: false });
    expect(local).toBe(
      `${BANK_OAUTH_COOKIE}=${encodeBankOAuthState(value())}; Path=/api/bank/gmo-aozora; Max-Age=600; HttpOnly; SameSite=Lax`,
    );
    expect(bankOAuthCookie(value(), { secure: true }).endsWith("; Secure")).toBe(true);
    expect(clearedBankOAuthCookie({ secure: true })).toBe(
      `${BANK_OAUTH_COOKIE}=; Path=/api/bank/gmo-aozora; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
  });

  it("finds its cookie among others", () => {
    const encoded = encodeBankOAuthState(value());
    expect(readCookie(`a=1; ${BANK_OAUTH_COOKIE}=${encoded}; b=2`, BANK_OAUTH_COOKIE)).toBe(
      encoded,
    );
    expect(readCookie("a=1; b=2", BANK_OAUTH_COOKIE)).toBeNull();
    expect(readCookie(null, BANK_OAUTH_COOKIE)).toBeNull();
  });
});

describe("checkBankOAuthCallback", () => {
  const cookie = encodeBankOAuthState(value());

  it("accepts the state it issued within 10 minutes, and gives the wallet and the nonce", () => {
    expect(checkBankOAuthCallback(cookie, STATE, after(599))).toEqual({
      ok: true,
      walletId: "01JBANKWALLET0000000000001",
      nonce: NONCE,
    });
  });

  it("refuses without the cookie", () => {
    expect(checkBankOAuthCallback(null, STATE, after(10))).toEqual({
      ok: false,
      reason: "missing",
      walletId: null,
    });
    expect(checkBankOAuthCallback("", STATE, after(10))).toMatchObject({ reason: "missing" });
  });

  it("refuses a broken cookie", () => {
    expect(checkBankOAuthCallback("not-our-cookie", STATE, after(10))).toEqual({
      ok: false,
      reason: "malformed",
      walletId: null,
    });
  });

  it("refuses an expired cookie, and one issued in the future", () => {
    expect(checkBankOAuthCallback(cookie, STATE, after(601))).toEqual({
      ok: false,
      reason: "expired",
      walletId: "01JBANKWALLET0000000000001",
    });
    expect(checkBankOAuthCallback(cookie, STATE, after(-120))).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  it.each([
    ["another state", "T".repeat(43)],
    ["a shorter state", STATE.slice(1)],
    ["no state", null],
  ])("refuses %s", (_case, state) => {
    expect(checkBankOAuthCallback(cookie, state, after(10))).toEqual({
      ok: false,
      reason: "state",
      walletId: "01JBANKWALLET0000000000001",
    });
  });
});
