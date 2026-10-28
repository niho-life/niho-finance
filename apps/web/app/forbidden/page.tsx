import { UNREGISTERED_USER_MESSAGE } from "@niho-finance/db";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { ActorError } from "@/lib/actor";
import { appEnv } from "@/lib/env";

export const metadata: Metadata = { title: "この画面は開けません" };

/** Why the screen is refused (`proxy.ts` rewrites here with the reason). */
const REASONS = {
  role: "閲覧の役割で開けるのは 報告 と 書き出し だけです",
  unregistered: UNREGISTERED_USER_MESSAGE,
  unverified: new ActorError().message,
} as const;

type Reason = keyof typeof REASONS;

function isReason(value: unknown): value is Reason {
  return typeof value === "string" && Object.hasOwn(REASONS, value);
}

/**
 * 権限の画面 (23-users-and-expenses §3.3): outside the app frame, without navigation. 閲覧 gets the
 * way back to 報告.
 */
export default async function ForbiddenPage({ searchParams }: PageProps<"/forbidden">) {
  const { reason } = await searchParams;
  const shown: Reason = isReason(reason) ? reason : "role";
  return (
    <main className="min-h-dvh px-4 pt-10 pb-16 md:px-8">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-center gap-2.5 font-extrabold">
          <span aria-hidden="true" className="relative size-[26px] shrink-0 rounded-lg bg-primary">
            <span className="absolute inset-[7px] rounded bg-accent" />
          </span>
          NIHO finance
        </div>
        <div className="flex flex-col gap-3 rounded-card border border-border bg-surface px-5 py-6">
          <h1 className="text-[20px] font-extrabold leading-tight">この画面は開けません</h1>
          <p className="text-[14px] leading-relaxed">{REASONS[shown]}</p>
          {shown === "unregistered" && appEnv().NIHO_FINANCE_ENV === "local" ? (
            // Only without IAP: a worktree whose `.env` still has v1's `NIHO_FINANCE_ACTOR=owner`.
            <p className="text-[13px] leading-relaxed text-muted">
              開発環境では、<code>.env</code> の <code>NIHO_FINANCE_ACTOR</code>{" "}
              を利用者に登録したメール（seed した DB では <code>owner@example.com</code>
              ）にして、開発サーバを起動し直してください。
            </p>
          ) : null}
          {shown === "role" ? (
            <div className="mt-1">
              <ButtonLink href="/reports" variant="primary">
                報告へ
              </ButtonLink>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
