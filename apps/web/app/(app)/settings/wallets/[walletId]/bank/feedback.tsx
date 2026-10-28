"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * The outcome at the top of 銀行 API の接続 (19-bank-api §1.1): what the last operation did (同期の
 * 結果, a refusal) or, after the bank's redirect, how the authorization ended (`?bank=…`). The
 * provider sits in the page's layout, so the outcome stays while the page is refreshed with the
 * new state of the connection.
 */
export interface BankOutcome {
  tone: "success" | "warn" | "error";
  text: string;
  /** Further lines: the sync's warnings. */
  details?: readonly string[];
  /** The batch of the sync, opened at /imports/<batchId>. */
  batchId?: string | null;
}

interface BankOutcomeContext {
  outcome: BankOutcome | null;
  settle: (outcome: BankOutcome) => void;
}

const OutcomeContext = createContext<BankOutcomeContext>({ outcome: null, settle: () => {} });

export function BankOutcomeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [outcome, setOutcome] = useState<BankOutcome | null>(null);

  function settle(next: BankOutcome) {
    setOutcome(next);
    // The authorization's outcome in the URL (?bank=…) gives way to this one.
    if (window.location.search !== "") router.replace(pathname, { scroll: false });
    else router.refresh();
  }

  return <OutcomeContext value={{ outcome, settle }}>{children}</OutcomeContext>;
}

/** Shows an outcome at the top of the page and refreshes the page. */
export function useBankOutcome(): (outcome: BankOutcome) => void {
  return useContext(OutcomeContext).settle;
}

const TONES: Readonly<Record<BankOutcome["tone"], string>> = {
  success: "bg-primary-soft text-primary-ink",
  warn: "bg-warn-soft text-warn",
  error: "bg-danger-soft text-danger",
};

/** The last operation's outcome, else `notice` (the authorization's, from the URL). */
export function BankOutcomeBanner({ notice }: { notice: BankOutcome | null }) {
  const { outcome } = useContext(OutcomeContext);
  const shown = outcome ?? notice;
  if (!shown) return null;
  return (
    <div
      role={shown.tone === "error" ? "alert" : "status"}
      className={`mb-6 flex flex-col gap-1 rounded-card px-4 py-3 text-[14px] ${TONES[shown.tone]}`}
    >
      <p className="font-bold break-words">{shown.text}</p>
      {shown.details?.map((detail) => (
        <p key={detail} className="text-[13px] break-words">
          {detail}
        </p>
      ))}
      {shown.batchId ? (
        <Link
          href={`/imports/${shown.batchId}`}
          className="w-fit text-[13px] font-bold underline underline-offset-4"
        >
          同期の結果を見る
        </Link>
      ) : null}
    </div>
  );
}
