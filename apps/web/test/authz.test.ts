import type { UserRole } from "@niho-finance/db";
import { describe, expect, it } from "vitest";
import { proxyDecision, viewerMayOpen, type CurrentUser } from "../lib/authz";

/* The screens' rules of the proxy (23-users-and-expenses §3.3), as a pure decision. */

const page = (pathname: string) => ({ pathname, serverAction: false });
const action = (pathname: string) => ({ pathname, serverAction: true });

function user(role: UserRole, state: "registered" | "first_owner" = "registered"): CurrentUser {
  return { email: "someone@example.com", role, name: null, state };
}
const unregistered: CurrentUser = { email: "someone@example.com", state: "unregistered" };

describe("viewerMayOpen", () => {
  it("opens 報告, 書き出し and the refusal page, and the pages under them", () => {
    for (const path of [
      "/reports",
      "/reports/journal",
      "/reports/export",
      "/settings/export",
      "/settings/export/download",
      "/forbidden",
    ]) {
      expect(viewerMayOpen(path), path).toBe(true);
    }
  });

  it("opens nothing else", () => {
    for (const path of [
      "/",
      "/entries",
      "/settings",
      "/settings/users",
      "/settings/exports",
      "/reportsx",
      "/expenses",
      "/api/documents/prepare",
    ]) {
      expect(viewerMayOpen(path), path).toBe(false);
    }
  });
});

describe("proxyDecision", () => {
  it("lets 管理者, 経理 and the first user through", () => {
    for (const current of [user("owner"), user("accountant"), user("owner", "first_owner")]) {
      expect(proxyDecision(page("/entries"), current)).toEqual({ kind: "next" });
      expect(proxyDecision(action("/settings"), current)).toEqual({ kind: "next" });
    }
  });

  it("sends 閲覧 from / to 報告 and refuses the other screens with the role page", () => {
    const viewer = user("viewer");
    expect(proxyDecision(page("/"), viewer)).toEqual({ kind: "redirect", location: "/reports" });
    expect(proxyDecision(page("/reports/trial-balance"), viewer)).toEqual({ kind: "next" });
    expect(proxyDecision(page("/settings/export"), viewer)).toEqual({ kind: "next" });
    expect(proxyDecision(page("/entries"), viewer)).toEqual({
      kind: "forbidden_page",
      reason: "role",
      status: 403,
    });
  });

  it("answers 閲覧's Server Actions and APIs with a bare 403", () => {
    const viewer = user("viewer");
    expect(proxyDecision(action("/reports"), viewer)).toMatchObject({
      kind: "refuse",
      status: 403,
    });
    expect(proxyDecision(page("/api/documents/prepare"), viewer)).toMatchObject({
      kind: "refuse",
      status: 403,
    });
  });

  it("refuses an account that is not a user, and one that could not be verified", () => {
    expect(proxyDecision(page("/reports"), unregistered)).toEqual({
      kind: "forbidden_page",
      reason: "unregistered",
      status: 403,
    });
    expect(proxyDecision(action("/entries"), unregistered)).toMatchObject({
      kind: "refuse",
      status: 403,
    });
    expect(proxyDecision(page("/"), null)).toEqual({
      kind: "forbidden_page",
      reason: "unverified",
      status: 401,
    });
    expect(proxyDecision(action("/"), null)).toMatchObject({ kind: "refuse", status: 401 });
  });

  it("always shows the refusal page itself", () => {
    expect(proxyDecision(page("/forbidden"), unregistered)).toEqual({ kind: "next" });
    expect(proxyDecision(page("/forbidden"), null)).toEqual({ kind: "next" });
  });
});
