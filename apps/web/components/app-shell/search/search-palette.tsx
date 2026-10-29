"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { searchAction } from "./actions";
import { noHitsMessage, SEARCH_HINT, type SearchView } from "./hit-view";

export const SEARCH_PALETTE_ID = "search-palette";
export const SEARCH_PALETTE_INPUT_ID = "search-palette-input";

/** The input waits this long before asking the server (10 §7.1). */
const DEBOUNCE_MS = 200;
const SEARCH_FAILED = "検索できませんでした。もう一度試してください";

interface Option {
  /** DOM id (for `aria-activedescendant`). */
  id: string;
  href: string;
}

function optionsOf(view: SearchView | null, baseId: string): Option[] {
  return (view?.groups ?? []).flatMap((group) => [
    ...group.hits.map((hit) => ({ id: `${baseId}-${hit.key}`, href: hit.href })),
    ...(group.more ? [{ id: `${baseId}-${group.kind}-more`, href: group.more.href }] : []),
  ]);
}

export interface SearchPaletteProps {
  /** Kept by the launcher between openings. */
  query: string;
  onQueryChange: (query: string) => void;
  /** After the dialog closed (Esc, the backdrop, 閉じる or a result opened). */
  onClosed: () => void;
}

/**
 * The palette of 全体検索 (10 §7.1): a native modal `<dialog>` at the top centre, the input as a
 * combobox and the hits as a listbox grouped by kind. ↓ / ↑ move across every option (they stop at
 * the ends), Enter opens the active one (or the first), Esc closes. Focus stays in the input.
 */
export function SearchPalette({ query, onQueryChange, onClosed }: SearchPaletteProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const [view, setView] = useState<SearchView | null>(null);
  const [loading, setLoading] = useState(() => query.trim() !== "");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  // The latest request; older responses are dropped.
  const sequence = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  // Enter pressed while the results of the latest input were on their way.
  const openWhenReady = useRef(false);

  const options = optionsOf(view, baseId);
  const activeOption = active >= 0 ? options[active] : undefined;

  function close() {
    dialogRef.current?.close();
  }

  function open(href: string) {
    router.push(href);
    close();
  }

  async function run(text: string, seq: number) {
    let result: Awaited<ReturnType<typeof searchAction>>;
    try {
      result = await searchAction(text);
    } catch {
      result = { ok: false, error: SEARCH_FAILED, fieldErrors: {} };
    }
    if (seq !== sequence.current) return;
    setLoading(false);
    setActive(-1);
    if (!result.ok) {
      openWhenReady.current = false;
      setError(result.error);
      return;
    }
    setError(null);
    setView(result.data);
    if (openWhenReady.current) {
      openWhenReady.current = false;
      const first = optionsOf(result.data, baseId)[0];
      if (first) open(first.href);
    }
  }

  function schedule(text: string) {
    window.clearTimeout(timer.current);
    sequence.current += 1;
    const seq = sequence.current;
    openWhenReady.current = false;
    setActive(-1);
    if (text.trim() === "") {
      setView(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = window.setTimeout(() => void run(text, seq), DEBOUNCE_MS);
  }

  // Opens as a modal at once; a query kept from the last time is searched again.
  const onOpen = useEffectEvent(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
    if (query.trim() !== "") {
      sequence.current += 1;
      void run(query, sequence.current);
    }
  });
  const onUnmount = useEffectEvent(() => {
    window.clearTimeout(timer.current);
    sequence.current += 1;
  });
  useEffect(() => {
    onOpen();
    return () => onUnmount();
  }, []);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    onQueryChange(event.target.value);
    schedule(event.target.value);
  }

  function move(next: number) {
    setActive(next);
    const option = options[next];
    if (option) document.getElementById(option.id)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Keys that confirm or move within the IME's conversion are not ours.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (options.length > 0) move(Math.min(active + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length > 0) move(Math.max(active - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Typed and Enter at once: the first hit of what was typed, once it arrives.
      if (loading && !activeOption) {
        openWhenReady.current = true;
        return;
      }
      const option = activeOption ?? options[0];
      if (option) open(option.href);
    }
  }

  const text = query.trim();
  let status: string | null = null;
  if (text === "") status = SEARCH_HINT;
  else if (loading) status = "検索中…";
  else if (!error && view && view.groups.length === 0) status = noHitsMessage(view.query);

  // An option is chosen with the keys or the pointer; a click opens it (the Link navigates).
  function optionProps(id: string) {
    const index = options.findIndex((option) => option.id === id);
    return {
      selected: index === active,
      onPoint: () => {
        if (index !== active) setActive(index);
      },
      onOpen: close,
    };
  }

  return (
    <dialog
      ref={dialogRef}
      id={SEARCH_PALETTE_ID}
      aria-label="検索"
      onClose={(event) => {
        if (event.target === event.currentTarget) onClosed();
      }}
      onClick={(event) => {
        // The backdrop (the dialog itself, outside its content) closes it.
        if (event.target === event.currentTarget) close();
      }}
      className="m-0 max-h-dvh w-full max-w-none overflow-hidden border-b border-border bg-surface p-0 text-text shadow-float md:mx-auto md:mt-[12vh] md:w-[560px] md:max-w-[calc(100vw-32px)] md:rounded-card md:border"
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <input
            ref={inputRef}
            id={SEARCH_PALETTE_INPUT_ID}
            type="text"
            role="combobox"
            aria-label="検索"
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={activeOption?.id}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={100}
            placeholder="摘要・金額・取引先・請求番号"
            value={query}
            onChange={onChange}
            onKeyDown={onKeyDown}
            className="control min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={close}
            className="min-h-10 shrink-0 rounded-[10px] px-3 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
          >
            閉じる
          </button>
        </div>
        <div className="max-h-[calc(100dvh-68px)] overflow-y-auto pb-2 md:max-h-[min(60vh,520px)]">
          <p role="status" className="px-4 pt-3 text-[13px] text-muted empty:pt-0">
            {status}
          </p>
          {error ? (
            <p
              role="alert"
              className="mx-3 mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
            >
              {error}
            </p>
          ) : null}
          <div role="listbox" id={listboxId} aria-label="検索の結果" hidden={options.length === 0}>
            {view?.groups.map((group) => {
              const headingId = `${baseId}-${group.kind}`;
              return (
                <div key={group.kind} role="group" aria-labelledby={headingId} className="pt-2">
                  <div
                    role="presentation"
                    id={headingId}
                    className="flex items-baseline gap-2 px-4 pb-1 text-[12px] font-bold text-muted"
                  >
                    <span>{group.label}</span>
                    <span className="num font-normal">
                      {group.total.toLocaleString("ja-JP")} 件
                    </span>
                  </div>
                  {group.hits.map((hit) => (
                    <OptionLink
                      key={hit.key}
                      id={`${baseId}-${hit.key}`}
                      href={hit.href}
                      label={hit.label}
                      {...optionProps(`${baseId}-${hit.key}`)}
                    >
                      <span
                        className={`block truncate text-[14px] font-semibold ${hit.muted ? "text-muted" : ""}`}
                      >
                        {hit.title}
                      </span>
                      <span className="num block truncate text-[12px] text-muted">
                        {hit.meta.join(" · ")}
                      </span>
                    </OptionLink>
                  ))}
                  {group.more ? (
                    <OptionLink
                      id={`${baseId}-${group.kind}-more`}
                      href={group.more.href}
                      className="num text-[13px] font-bold text-muted"
                      {...optionProps(`${baseId}-${group.kind}-more`)}
                    >
                      {group.more.label}
                      <span aria-hidden="true"> ›</span>
                    </OptionLink>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function OptionLink({
  id,
  href,
  label,
  selected,
  onPoint,
  onOpen,
  className = "",
  children,
}: {
  id: string;
  href: string;
  label?: string;
  selected: boolean;
  onPoint: () => void;
  onOpen: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      id={id}
      href={href}
      prefetch={false}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={-1}
      // Focus stays in the input (aria-activedescendant shows the option).
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onPoint}
      onClick={onOpen}
      className={`mx-2 block rounded-lg px-2.5 py-1.5 ${
        selected ? "bg-primary-soft" : "hover:bg-black/[0.03]"
      } ${className}`}
    >
      {children}
    </Link>
  );
}
