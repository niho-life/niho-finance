import { useEffect, useRef, type RefObject } from "react";

/** The fields people type into or choose from, in document order. */
const FIELDS = [
  'input:not([type="hidden"]):not(:disabled):not([readonly])',
  "select:not(:disabled)",
  "textarea:not(:disabled):not([readonly])",
].join(", ");

/** Any other control, the dialog's own close button (`data-dialog-close`) left for last. */
const CONTROLS = [
  "button:not(:disabled):not([data-dialog-close])",
  "a[href]",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The focus when a dialog opens (05-ui-ux §3.1): the control marked `data-autofocus`, else the
 * first field, else the first control, else the close button. React's `autoFocus` runs before
 * `showModal()`, while the dialog is still hidden, so the focus is moved here instead.
 */
function focusFirst(dialog: HTMLDialogElement): void {
  for (const selector of ["[data-autofocus]", FIELDS, CONTROLS, "[data-dialog-close]"]) {
    for (const element of dialog.querySelectorAll<HTMLElement>(selector)) {
      element.focus();
      if (document.activeElement === element) return;
    }
  }
}

/** Back to the control that opened the dialog, unless the focus has already moved elsewhere. */
function restoreFocus(dialog: HTMLDialogElement, opener: HTMLElement | null): void {
  if (!opener?.isConnected) return;
  const current = document.activeElement;
  if (current && current !== document.body && !dialog.contains(current)) return;
  opener.focus();
}

/**
 * Opens and closes a native modal `<dialog>` with `open` and moves the focus (05-ui-ux §3.1):
 * into the dialog when it opens, back to the button that opened it when it closes or unmounts.
 * Esc is the dialog's own `cancel` event, which the caller handles.
 */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>, open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      dialog.showModal();
      focusFirst(dialog);
    }
    if (!open && dialog.open) {
      dialog.close();
      restoreFocus(dialog, opener.current);
      opener.current = null;
    }
  }, [ref, open]);

  // Unmounted while open (the parent renders it only while needed): the dialog is gone with it.
  useEffect(() => {
    const dialog = ref.current;
    const state = opener;
    return () => {
      if (dialog && state.current) restoreFocus(dialog, state.current);
    };
  }, [ref]);
}
