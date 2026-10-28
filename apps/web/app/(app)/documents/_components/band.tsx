import type { ReactNode } from "react";

/** A state band of a detail (無効・差し替え), the same look as the bands of 取引の詳細 (11 §5). */
export function Band({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warn";
  children: ReactNode;
}) {
  return (
    <p
      className={`rounded-lg px-3.5 py-2.5 text-[14px] break-words ${
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-text"
      }`}
    >
      {children}
    </p>
  );
}
