"use client";

import { useEffect, useEffectEvent } from "react";

const DURATION_MS = 5_000;

export interface UndoState {
  /** A new key for every settle: the 5 seconds start again and the previous bar is replaced. */
  key: number;
  message: string;
  /** One group per settle: the line acted on (reopened with 「登録直後の取消」) and every line settled. */
  groups: { id: string; ids: string[] }[];
}

/**
 * 5 秒の取消 (15 §7): 「No. 12 を登録しました」 with 取消 at the bottom centre, where the toast shows
 * (the same look; it has a button, so the statements screen owns it). Z does the same while it shows.
 */
export function UndoBar({
  undo,
  onUndo,
  onExpire,
}: {
  undo: UndoState | null;
  onUndo: (undo: UndoState) => void;
  onExpire: () => void;
}) {
  const expire = useEffectEvent(onExpire);
  const key = undo?.key ?? null;

  useEffect(() => {
    if (key === null) return;
    const timer = setTimeout(() => expire(), DURATION_MS);
    return () => clearTimeout(timer);
  }, [key]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 md:bottom-7"
    >
      {undo ? (
        <div
          key={undo.key}
          role="status"
          className="pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-3 rounded-xl bg-text px-4 py-2.5 text-[13px] text-white shadow-float"
        >
          <span>{undo.message}</span>
          <button
            type="button"
            onClick={() => onUndo(undo)}
            className="inline-flex min-h-7 shrink-0 items-center rounded-lg px-2 font-bold text-accent hover:bg-white/10"
          >
            取消
            <span className="ml-1 hidden text-[11px] font-normal text-white/60 md:inline">Z</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
