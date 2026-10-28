"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Textarea } from "@/components/ui/form";

interface ReasonDialogProps {
  open: boolean;
  title: ReactNode;
  /** What the operation does and what stays. */
  children?: ReactNode;
  /** A result verb: 無効にする. */
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  variant?: "default" | "danger";
  pending?: boolean;
  error?: string | null;
  maxLength?: number;
}

/** The dialog's content, mounted while open: every opening starts with an empty reason. */
function ReasonForm({
  titleId,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  variant,
  pending,
  error,
  maxLength,
}: Omit<ReasonDialogProps, "open"> & { titleId: string; maxLength: number }) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const empty = reason.trim() === "";
  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty && !pending) onConfirm(reason.trim());
      }}
    >
      <h2 id={titleId} className="text-[16px] font-extrabold">
        {title}
      </h2>
      {children ? <div className="text-[14px] leading-relaxed">{children}</div> : null}
      <FormField label="理由" htmlFor={reasonId} required help={`${maxLength} 字まで`}>
        <Textarea
          id={reasonId}
          value={reason}
          maxLength={maxLength}
          required
          autoFocus
          aria-describedby={`${reasonId}-help`}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </FormField>
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
          type="submit"
          variant={variant === "danger" ? "danger" : "primary"}
          disabled={pending || empty}
        >
          {pending ? "処理中…" : confirmLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * A confirmation that asks for a reason: the look and behavior of `ConfirmDialog` (native modal
 * `<dialog>`, never `window.confirm`), plus a required 理由 — the confirm button cannot be pressed
 * while it is empty. `ConfirmDialog` has no way to disable its button, hence this one.
 */
export function ReasonDialog({
  open,
  onCancel,
  pending = false,
  maxLength = 200,
  variant = "default",
  ...rest
}: ReasonDialogProps) {
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
        <ReasonForm
          {...rest}
          titleId={titleId}
          onCancel={onCancel}
          pending={pending}
          maxLength={maxLength}
          variant={variant}
        />
      ) : null}
    </dialog>
  );
}
