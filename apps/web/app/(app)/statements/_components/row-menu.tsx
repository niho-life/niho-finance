"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type MenuItem =
  | { label: string; onSelect: () => void; disabled?: false; note?: undefined }
  | { label: string; href: string; disabled?: false; note?: undefined }
  | { label: string; disabled: true; note: string };

/** The items the arrows move between (a disabled item is skipped). */
function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])].filter(
    (item) => item.getAttribute("aria-disabled") !== "true",
  );
}

/**
 * The 「…」 of a row (15 §5): a menu button (`aria-haspopup="menu"`) whose items are buttons and
 * links. ↑↓ move between the items, Esc / Tab / a click outside close it and the focus goes back to
 * the button. The menu floats (the one shadow of the row).
 */
export function RowMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    enabledItems(menuRef.current)[0]?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function close(focusButton: boolean) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = enabledItems(menuRef.current);
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      list[(at + 1) % list.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      list[(at - 1 + list.length) % list.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      list.at(-1)?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  const itemClass =
    "flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-[14px] whitespace-nowrap";

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-[15px] font-bold text-muted hover:bg-black/5 hover:text-text"
      >
        …
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="absolute top-full right-0 z-30 mt-1 flex min-w-48 flex-col rounded-xl border border-border bg-surface p-1 text-text shadow-float"
        >
          {items.map((item) => {
            if (item.disabled) {
              return (
                <span
                  key={item.label}
                  role="menuitem"
                  aria-disabled="true"
                  tabIndex={-1}
                  className={`${itemClass} cursor-not-allowed text-muted-2`}
                >
                  {item.label}
                  <span className="ml-auto text-[11px]">{item.note}</span>
                </span>
              );
            }
            if ("href" in item) {
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  className={`${itemClass} hover:bg-surface-2 focus-visible:bg-surface-2`}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              );
            }
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${itemClass} hover:bg-surface-2 focus-visible:bg-surface-2`}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
