"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Under the title, e.g. the code of the account. */
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Edit panel from the right (native modal `<dialog>`): 400px on PC, the whole screen on phones.
 * The content is rendered only while open, so it always starts from the latest props.
 */
export function Sheet({ open, onClose, title, description, children, footer }: SheetProps) {
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
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-full border-0 border-l border-border bg-surface p-0 text-text shadow-float md:w-[400px]"
    >
      {open ? (
        <div className="flex h-full flex-col">
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[16px] font-extrabold">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-[12px] text-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="-mr-2 inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-text"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
