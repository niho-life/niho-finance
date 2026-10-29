"use client";

import { usePathname } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isActivePath } from "../nav-items";
import { SEARCH_PALETTE_ID, SEARCH_PALETTE_INPUT_ID, SearchPalette } from "./search-palette";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest("input, textarea, select"));
}

/** A dialog other than the palette is open (a sheet, a confirmation …). */
function otherDialogOpen(): boolean {
  return Array.from(document.querySelectorAll("dialog[open]")).some(
    (dialog) => dialog.id !== SEARCH_PALETTE_ID,
  );
}

/**
 * 全体検索の入口 (10 §7.1): the box under the brand in the side navigation (a magnifier button named
 * 検索 in the 76px rail, 10 §1), the palette, and the keys.
 * `/` opens the palette outside the fields and the dialogs, except on /statements (its `/` goes to
 * the statements' own search, 15 §6); Ctrl+K / ⌘K opens it on every screen. The palette is put in
 * `<body>`: the side navigation is hidden on phones, where Ctrl+K still opens it.
 */
export function SearchLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Where the focus was before the palette opened (it goes back there on close).
  const returnFocus = useRef<HTMLElement | null>(null);

  function openPalette() {
    if (open) {
      const input = document.getElementById(SEARCH_PALETTE_INPUT_ID);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
      return;
    }
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement ? focused : null;
    setOpen(true);
  }

  function onClosed() {
    setOpen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      if ((key === "k" || key === "K") && !otherDialogOpen()) {
        event.preventDefault();
        openPalette();
      }
      return;
    }
    if (key !== "/" || event.altKey) return;
    if (isTyping(event.target) || document.querySelector("dialog[open]")) return;
    if (isActivePath(pathname, "/statements")) return;
    event.preventDefault();
    openPalette();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        aria-haspopup="dialog"
        aria-keyshortcuts="/ Control+K Meta+K"
        className="mx-auto mb-3 flex size-10 shrink-0 items-center justify-center gap-2 rounded-[9px] border border-border-2 bg-surface text-left text-[13px] text-muted hover:border-muted-2 hover:text-text lg:mx-0 lg:h-auto lg:min-h-9 lg:w-full lg:justify-start lg:px-2.5 lg:text-muted-2 lg:hover:text-muted"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0"
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.5 4.5" />
        </svg>
        <span className="sr-only lg:not-sr-only lg:flex-1">検索</span>
        <kbd
          aria-hidden="true"
          className="hidden rounded border border-border px-1.5 font-sans text-[11px] leading-[18px] text-muted-2 lg:inline"
        >
          /
        </kbd>
      </button>
      {open
        ? createPortal(
            <SearchPalette query={query} onQueryChange={setQuery} onClosed={onClosed} />,
            document.body,
          )
        : null}
    </>
  );
}
