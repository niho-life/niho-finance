import { getPrismaClient, resolveUserAccess } from "@niho-finance/db";
import { NextResponse, type NextRequest } from "next/server";
import { actorFromHeaders, ActorError } from "@/lib/actor";
import { proxyDecision, toCurrentUser, type CurrentUser } from "@/lib/authz";
import { logEvent } from "@/lib/log";

/*
 * The early refusal of the screens (23-users-and-expenses §3.3), before every page, RSC request,
 * Server Action and route: the actor is verified as `lib/actor.ts` does (IAP) and looked up once in
 * `app_user`. 未登録 and 閲覧 outside 報告 / 書き出し see `/forbidden`; the real checks are in each
 * Server Action and route (`lib/authz.ts`). Node runtime (the Next 16 default): Prisma is used here.
 */

const DATABASE_ERROR = "利用者を確かめられませんでした。しばらくしてから読み込み直してください";

function textResponse(message: string, status: number): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let user: CurrentUser | null;
  try {
    const email = await actorFromHeaders(request.headers);
    try {
      user = toCurrentUser(email, await resolveUserAccess(getPrismaClient(), email));
    } catch (error) {
      // Without the users nothing can be decided: refuse rather than let it through.
      logEvent("ERROR", "proxy.user_lookup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return textResponse(DATABASE_ERROR, 500);
    }
  } catch (error) {
    if (!(error instanceof ActorError)) throw error;
    user = null;
  }

  const decision = proxyDecision(
    {
      pathname: request.nextUrl.pathname,
      serverAction: request.method === "POST" && request.headers.has("next-action"),
    },
    user,
  );
  switch (decision.kind) {
    case "next":
      return NextResponse.next();
    case "redirect":
      return NextResponse.redirect(new URL(decision.location, request.url));
    case "forbidden_page": {
      // The page is drawn with 200: Next renders a rewritten page with its own status. The refusal is
      // the page itself (nothing of the requested page is rendered); Server Actions and APIs get the
      // status (`refuse`).
      const target = new URL("/forbidden", request.url);
      target.searchParams.set("reason", decision.reason);
      return NextResponse.rewrite(target, { status: decision.status });
    }
    case "refuse":
      return textResponse(decision.message, decision.status);
  }
}

export const config = {
  // Not the build's files, the health check or the jobs (S4 authenticates those). Nor the home-screen
  // app's static files (10 §1.1: sw.js, the manifest, 接続がない画面, the icons): they hold nothing
  // of the books and IAP decides who reaches them; here 閲覧 would get 403 and every one a DB lookup.
  matcher: [
    "/((?!_next/|api/health|api/jobs/|favicon\\.ico|sw\\.js$|app\\.webmanifest$|offline\\.html$|icons/).*)",
  ],
};
