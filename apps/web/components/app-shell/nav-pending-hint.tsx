"use client";

import { useLinkStatus } from "next/link";

/** Shows feedback on the clicked link while the current screen stays visible. */
export function NavPendingHint({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full bg-primary transition-opacity duration-75 ${
          pending ? "opacity-100 delay-100" : "opacity-0"
        } ${className ?? ""}`}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? "読み込み中" : ""}
      </span>
    </>
  );
}
