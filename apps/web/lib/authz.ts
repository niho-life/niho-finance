import {
  getPrismaClient,
  OWNER_ONLY_MESSAGE,
  registerFirstOwner,
  resolveUserAccess,
  roleAtLeast,
  SettingsError,
  UNREGISTERED_USER_MESSAGE,
  VIEWER_CANNOT_WRITE_MESSAGE,
  type UserAccess,
  type UserRole,
} from "@niho-finance/db";
import { cache } from "react";
import { toActionError } from "./action-result";
import type { ActionError } from "./action-types";
import { actor, ActorError } from "./actor";
import { logEvent } from "./log";

/*
 * Authorization (23-users-and-expenses §1–§3): the actor (`lib/actor.ts`, the IAP-verified email)
 * is matched with `User` (`resolveUserAccess`), and every Server Action and route checks the role
 * it needs before validating its input or reading anything. A refusal writes nothing (the audit log
 * does not grow); Cloud Logging gets `authz.denied` with the role, never the email. On a book
 * without users the actor is 管理者 and is registered as such on the first authorized request.
 * `proxy.ts` refuses the screens early with the same rules; the checks here are the real ones.
 */

export type MinimumRole = UserRole;

/** Why a request was refused: the viewer's role, an 管理者-only operation, or no user at all. */
export type ForbiddenReason = "viewer" | "owner_only" | "unregistered";

const FORBIDDEN_MESSAGES: Readonly<Record<ForbiddenReason, string>> = {
  viewer: VIEWER_CANNOT_WRITE_MESSAGE,
  owner_only: OWNER_ONLY_MESSAGE,
  unregistered: UNREGISTERED_USER_MESSAGE,
};

/** A refused request (23 §3.1). `toActionError` turns it into `{ ok: false, error }`. */
export class ForbiddenError extends ActorError {
  readonly reason: ForbiddenReason;

  constructor(reason: ForbiddenReason) {
    super(FORBIDDEN_MESSAGES[reason]);
    this.name = "ForbiddenError";
    this.reason = reason;
  }
}

export type CurrentUser =
  | {
      email: string;
      role: UserRole;
      name: string | null;
      /** `first_owner`: no user at all yet; 管理者 until the first write registers them. */
      state: "registered" | "first_owner";
    }
  | { email: string; state: "unregistered" };

/** The user of the access `resolveUserAccess` found for `email`. */
export function toCurrentUser(email: string, access: UserAccess): CurrentUser {
  switch (access.state) {
    case "registered":
      return {
        email,
        role: access.user.role,
        name: access.user.name,
        state: "registered",
      };
    case "first_owner":
      return { email, role: "owner", name: null, state: "first_owner" };
    case "unregistered":
      return { email, state: "unregistered" };
  }
}

/** The current request's user, once per request. Throws `ActorError` when the actor is unknown. */
export const currentUser = cache(async (): Promise<CurrentUser> => {
  const email = await actor();
  return toCurrentUser(email, await resolveUserAccess(getPrismaClient(), email));
});

function deny(minimum: MinimumRole, role: UserRole | null, reason: ForbiddenReason): never {
  logEvent("WARNING", "authz.denied", { minimum, role, reason });
  throw new ForbiddenError(reason);
}

/**
 * Lets the request through when the user's role is at least `minimum` (owner > accountant >
 * viewer) and returns the actor's email; throws `ForbiddenError` otherwise. A first owner is
 * registered here (`user.create`, 「最初の利用者を管理者として登録」) before anything else is written.
 */
export async function authorize(minimum: MinimumRole): Promise<string> {
  const user = await currentUser();
  if (user.state === "unregistered") deny(minimum, null, "unregistered");
  if (!roleAtLeast(user.role, minimum)) {
    deny(minimum, user.role, user.role === "viewer" ? "viewer" : "owner_only");
  }
  if (user.state === "first_owner") {
    try {
      await registerFirstOwner(getPrismaClient(), user.email, { actor: user.email });
    } catch (error) {
      // Someone else became the first user meanwhile, and this email is not one of the users.
      if (error instanceof SettingsError) deny(minimum, null, "unregistered");
      throw error;
    }
  }
  return user.email;
}

/**
 * The first statement of every Server Action (23 §3.1):
 * `const denied = await authorizeAction("accountant"); if (denied) return denied;`. A refusal (or
 * an unknown actor) comes back as `{ ok: false, error }`, never thrown (`lib/action-types.ts`).
 */
export async function authorizeAction(minimum: MinimumRole): Promise<ActionError | null> {
  try {
    await authorize(minimum);
    return null;
  } catch (error) {
    if (error instanceof ActorError) return toActionError(error);
    throw error;
  }
}

/** What a refused download says: one line that leads back to the screens (23 §3.2). */
export function routeDenialMessage(error: ActorError): string {
  if (!(error instanceof ForbiddenError)) return error.message;
  switch (error.reason) {
    case "viewer":
      return "閲覧の役割ではこのファイルを開けません。ブラウザの「戻る」で前の画面に戻ってください";
    case "owner_only":
      return "このファイルは管理者だけが開けます。ブラウザの「戻る」で前の画面に戻ってください";
    case "unregistered":
      return UNREGISTERED_USER_MESSAGE;
  }
}

/**
 * The first statements of every route handler (23 §3.2):
 * `const denied = await authorizeRoute("accountant"); if (denied) return denied;`. A refusal is a
 * 403 (401 for an unknown actor) with one line of text, or `{ error }` for the JSON APIs.
 */
export async function authorizeRoute(
  minimum: MinimumRole,
  options: { json?: boolean } = {},
): Promise<Response | null> {
  try {
    await authorize(minimum);
    return null;
  } catch (error) {
    if (!(error instanceof ActorError)) throw error;
    const status = error instanceof ForbiddenError ? 403 : 401;
    const message = routeDenialMessage(error);
    const headers = { "cache-control": "no-store" };
    if (options.json) return Response.json({ error: message }, { status, headers });
    return new Response(message, {
      status,
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
}

// ---------------------------------------------------------------------------
// Screens (proxy.ts, 23 §3.3)
// ---------------------------------------------------------------------------

/** What 閲覧 may open: 報告, the exports of the books, and the page that says no. */
const VIEWER_PATHS = ["/reports", "/settings/export", "/forbidden"] as const;

/** True for `/reports`, `/settings/export` and `/forbidden`, and the pages under them. */
export function viewerMayOpen(pathname: string): boolean {
  return VIEWER_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Why the screen is refused (`/forbidden?reason=…`). */
export type ForbiddenPageReason = "role" | "unregistered" | "unverified";

export type ProxyDecision =
  | { kind: "next" }
  | { kind: "redirect"; location: "/reports" }
  /** The page `/forbidden?reason=…` with this status. */
  | { kind: "forbidden_page"; reason: ForbiddenPageReason; status: 401 | 403 }
  /** A Server Action or an API request: only the status and one line of text. */
  | { kind: "refuse"; status: 401 | 403; message: string };

export interface ProxyRequest {
  pathname: string;
  /** A Server Action call (`POST` with the `Next-Action` header). */
  serverAction: boolean;
}

/** `ActorError`'s own message (`lib/actor.ts`). */
const UNVERIFIED_MESSAGE = new ActorError().message;

/** A request that only wants a status and a message, not a page. */
function wantsNoPage(request: ProxyRequest): boolean {
  return request.serverAction || request.pathname.startsWith("/api/");
}

/**
 * The proxy's decision (pure, 23 §3.3): `user` is `null` when the actor could not be verified.
 * 未登録 and 閲覧 outside their pages see `/forbidden`; 閲覧's `/` goes to 報告; Server Actions and
 * the APIs get a bare 403 (401 unverified). 管理者・経理・最初の管理者 go through.
 */
export function proxyDecision(request: ProxyRequest, user: CurrentUser | null): ProxyDecision {
  if (request.pathname === "/forbidden" || request.pathname.startsWith("/forbidden/")) {
    return { kind: "next" };
  }
  if (user === null) {
    return wantsNoPage(request)
      ? { kind: "refuse", status: 401, message: UNVERIFIED_MESSAGE }
      : { kind: "forbidden_page", reason: "unverified", status: 401 };
  }
  if (user.state === "unregistered") {
    return wantsNoPage(request)
      ? { kind: "refuse", status: 403, message: UNREGISTERED_USER_MESSAGE }
      : { kind: "forbidden_page", reason: "unregistered", status: 403 };
  }
  if (user.role !== "viewer") return { kind: "next" };
  if (request.serverAction) {
    return { kind: "refuse", status: 403, message: VIEWER_CANNOT_WRITE_MESSAGE };
  }
  if (request.pathname === "/") return { kind: "redirect", location: "/reports" };
  if (viewerMayOpen(request.pathname)) return { kind: "next" };
  return wantsNoPage(request)
    ? { kind: "refuse", status: 403, message: VIEWER_CANNOT_WRITE_MESSAGE }
    : { kind: "forbidden_page", reason: "role", status: 403 };
}
