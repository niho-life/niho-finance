import type { KeyboardEvent } from "react";

/*
 * The keys of the new-entry forms (11 §4.5): Enter in a one-line field or a select goes to the next
 * field instead of sending, Enter in the last field goes to 「続けて登録」, and Cmd+Enter (Ctrl+Enter)
 * presses 「続けて登録」 from anywhere in the form. Buttons and textareas keep their own Enter.
 */

/** Marks the form's 「続けて登録」 button. */
export const CONTINUE_ATTRIBUTE = "data-entry-continue";

/**
 * What a key does: go to the next field, press 「続けて登録」, stay (Shift / Alt+Enter in a field:
 * not sent), or nothing (the browser's own).
 */
export type EntryKeyIntent = "next" | "continue" | "stay" | null;

export interface EntryKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Enter that confirms an IME conversion (Safari reports it as keyCode 229 only). */
  isComposing: boolean;
  keyCode: number;
}

export interface EntryKeyTarget {
  tagName: string;
  type?: string | undefined;
}

/** Inputs that are not one-line fields: their Enter stays theirs. */
const NOT_FIELDS = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "hidden",
  "color",
  "range",
]);

/** One-line inputs (checkboxes too: their Enter would send the form) and selects. */
export function isEnterField(target: EntryKeyTarget): boolean {
  const tag = target.tagName.toLowerCase();
  if (tag === "select") return true;
  return tag === "input" && !NOT_FIELDS.has((target.type ?? "text").toLowerCase());
}

export function entryKeyIntent(key: EntryKey, target: EntryKeyTarget): EntryKeyIntent {
  if (key.key !== "Enter" || key.isComposing || key.keyCode === 229) return null;
  if ((key.metaKey || key.ctrlKey) && !key.shiftKey && !key.altKey) return "continue";
  if (!isEnterField(target)) return null;
  return key.shiftKey || key.altKey || key.metaKey || key.ctrlKey ? "stay" : "next";
}

/** Inputs whose text is selected when Enter moves into them (as Tab does). */
const SELECTABLE = new Set(["text", "search", "tel", "url", "email"]);

function isFocusableField(element: Element): element is HTMLElement {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLSelectElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    return false;
  }
  if (element.disabled || element.tabIndex < 0) return false;
  if (element instanceof HTMLInputElement && NOT_FIELDS.has(element.type)) return false;
  return element.getClientRects().length > 0;
}

/** The field after `current` in the form, or `null` when `current` is the last one. */
function nextField(form: HTMLFormElement, current: Element): HTMLElement | null {
  const fields = Array.from(form.elements).filter(isFocusableField);
  const index = fields.indexOf(current as HTMLElement);
  return index < 0 ? null : (fields[index + 1] ?? null);
}

/**
 * `onKeyDown` of a new-entry form, which marks its 「続けて登録」 button with `CONTINUE_ATTRIBUTE`.
 * A disabled button is neither pressed nor focused.
 */
export function entryFormKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
  // A picker or a select's list may take the key first (the date picker, 11 §4.5).
  if (event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const intent = entryKeyIntent(
    {
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    },
    {
      tagName: target.tagName,
      type: target instanceof HTMLInputElement ? target.type : undefined,
    },
  );
  if (!intent) return;
  event.preventDefault();
  if (intent === "stay") return;
  const form = event.currentTarget;
  const button = form.querySelector<HTMLButtonElement>(`button[${CONTINUE_ATTRIBUTE}]`);
  const usable = button && !button.disabled ? button : null;
  if (intent === "continue") {
    usable?.click();
    return;
  }
  const next = nextField(form, target);
  if (!next) {
    usable?.focus();
    return;
  }
  next.focus();
  if (next instanceof HTMLInputElement && SELECTABLE.has(next.type)) next.select();
}
