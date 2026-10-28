"use client";

import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";

/**
 * A small modal of the statement rows (編集・振替・分割・メモ・理由をつけて無視): a native `<dialog>`
 * with the look of `ConfirmDialog`. Esc closes it; the content is a form, so Enter in a field sends
 * it (not in a textarea). The parent mounts it only while it is open and puts the focus back on the
 * row when it closes. The control marked `data-autofocus` takes the focus when it opens.
 */
export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  onSubmit,
  wide = false,
  busy = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** The buttons (a submit button sends the form). */
  footer: ReactNode;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** 分割: the table of lines needs more room. */
  wide?: boolean;
  /** While sending: Esc does not close. */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // The field marked `data-autofocus` (e.g. 科目 when Enter found no account), else the first one.
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (!busy) onClose();
      }}
      className={`m-auto max-h-[calc(100dvh-32px)] rounded-card border border-border bg-surface p-0 text-text shadow-float ${
        wide ? "w-[min(760px,calc(100vw-32px))]" : "w-[min(440px,calc(100vw-32px))]"
      }`}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(event);
        }}
        onKeyDown={(event) => {
          // Enter sends from a select or a radio too (text fields submit by themselves; buttons
          // and the textarea keep their own Enter).
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const target = event.target;
          const choice =
            target instanceof HTMLSelectElement ||
            (target instanceof HTMLInputElement &&
              (target.type === "radio" || target.type === "checkbox"));
          if (!choice) return;
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div>
          <h2 id={titleId} className="text-[16px] font-extrabold">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[12px] text-muted">{description}</p> : null}
        </div>
        {children}
        <div className="flex flex-wrap items-center justify-end gap-2">{footer}</div>
      </form>
    </dialog>
  );
}

/** A link-like button at the bottom of a dialog (分割 / ルールにする). */
export function DialogLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-8 items-center rounded-lg px-1 text-[13px] font-bold text-muted underline underline-offset-4 hover:text-text"
    >
      {children}
    </button>
  );
}

/** The problems of a dialog that belong to no field of its own. */
export function DialogAlert({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}
