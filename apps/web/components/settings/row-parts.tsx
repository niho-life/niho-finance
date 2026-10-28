"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ActionError } from "@/lib/action-types";

/** 無効にする / 有効にする (rows are never deleted, 10 §2). */
export function ActiveToggleButton({
  isActive,
  onToggle,
  disabled,
  lockedReason,
}: {
  isActive: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Shown instead of the button when the row cannot be deactivated (e.g. 標準 for a segment). */
  lockedReason?: string;
}) {
  if (lockedReason) {
    return <span className="px-2 text-[12px] text-muted-2">{lockedReason}</span>;
  }
  return (
    <Button size="sm" variant="ghost" onClick={onToggle} disabled={disabled}>
      {isActive ? "無効にする" : "有効にする"}
    </Button>
  );
}

/** The error of an 「追加」 row or form, spanning the row. */
export function FormError({
  error,
  className = "",
}: {
  error: ActionError | null;
  className?: string;
}) {
  if (!error) return null;
  return (
    <p role="alert" data-sm="full" className={`text-[12px] font-bold text-danger ${className}`}>
      {error.error}
    </p>
  );
}

/** A labelled field in a sheet (the same cells as the list, one per line). */
export function SheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3 border-b border-border py-1.5 last:border-b-0">
      <span className="text-[12px] font-bold text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The button that opens a row's sheet (補助科目, 規則, 編集, 開く). */
export function OpenButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
    >
      {children}
      <span aria-hidden="true">›</span>
    </button>
  );
}
