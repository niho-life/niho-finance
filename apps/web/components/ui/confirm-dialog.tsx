"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** The impact of the operation: counts, amounts, periods (10 §2). */
  children?: ReactNode;
  /** A result verb: 登録 / 作成 / 保存 / 無効にする. */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "default" | "danger";
  pending?: boolean;
  /** An error from the last attempt, shown in the dialog. */
  error?: string | null;
}

/** Confirmation with a native modal `<dialog>` (never `window.confirm`). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  variant = "default",
  pending = false,
  error,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        if (open) onCancel();
      }}
      className="m-auto w-[min(440px,calc(100vw-32px))] rounded-card border border-border bg-surface p-0 text-text shadow-float"
    >
      {open ? (
        <div className="flex flex-col gap-4 p-5">
          <h2 id={titleId} className="text-[16px] font-extrabold">
            {title}
          </h2>
          {children ? <div className="text-[14px] leading-relaxed">{children}</div> : null}
          {error ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={pending}>
              キャンセル
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              onClick={onConfirm}
              disabled={pending}
              autoFocus
            >
              {pending ? "処理中…" : confirmLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
