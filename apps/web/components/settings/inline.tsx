"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useToast } from "@/components/ui/toast";
import type { ActionError, ActionResult, RowValues } from "@/lib/action-types";

/**
 * Editing in the list (Google-form style, 10 §2): a cell saves on blur, Enter or change, and the
 * row shows 保存中 / 保存済み / エラー（理由） at its right end. Cells are uncontrolled: what the
 * owner typed stays in the field when the save fails, Escape puts the saved value back.
 */
export type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "error"; message: string };

export type CommitOutcome = { ok: true; value?: string | boolean | undefined } | { ok: false };

export type SaveRow = (patch: RowValues) => Promise<ActionResult<RowValues>>;

/** Save state of one row: `track` runs a save and the row shows 保存中 → 保存済み / エラー. */
export function useRowStatus() {
  const [status, setStatus] = useState<SaveState>({ state: "idle" });
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function track<T>(
    action: () => Promise<ActionResult<T>>,
    field?: string,
  ): Promise<ActionResult<T>> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await action();
        if (result.ok) setStatus({ state: "saved" });
        else {
          const message = (field ? result.fieldErrors[field] : undefined) ?? result.error;
          setStatus({ state: "error", message });
        }
        resolve(result);
      });
    });
  }

  /**
   * For a save that is not one cell (e.g. 無効にする). `savedMessage` is also shown as a toast:
   * a deactivated row leaves the list (folded), taking its status with it.
   */
  function run(action: () => Promise<ActionResult<unknown>>, savedMessage?: string): void {
    void track(action).then((result) => {
      if (result.ok && savedMessage) toast(savedMessage);
    });
  }

  const shown: SaveState = pending ? { state: "saving" } : status;
  return { status: shown, track, run, pending };
}

/** Toast text after 無効にする / 有効にする. */
export function activeToggledMessage(name: string, isActive: boolean): string {
  return isActive ? `「${name}」を無効にしました` : `「${name}」を有効にしました`;
}

/** `useRowStatus` plus the `commit(field, value)` the row's cells call. */
export function useRowSave(save: SaveRow) {
  const row = useRowStatus();

  async function commit(field: string, value: string | boolean): Promise<CommitOutcome> {
    const result = await row.track(() => save({ [field]: value }), field);
    return result.ok ? { ok: true, value: result.data[field] } : { ok: false };
  }

  return { ...row, commit };
}

/**
 * The right end of a row: 保存中… / 保存済み / エラー（理由）. `asCell={false}` outside a table row
 * (a sheet's header, inside another cell).
 */
export function SaveStatus({ status, asCell = true }: { status: SaveState; asCell?: boolean }) {
  let content = "";
  let tone = "text-muted";
  if (status.state === "saving") content = "保存中…";
  if (status.state === "saved") {
    content = "保存済み";
    tone = "text-primary-ink";
  }
  if (status.state === "error") {
    content = `エラー（${status.message}）`;
    tone = "font-bold text-danger";
  }
  return (
    <span
      role={asCell ? "cell" : undefined}
      data-sm="status"
      data-state={status.state}
      aria-live="polite"
      className={`min-w-0 text-right text-[12px] leading-snug ${tone}`}
    >
      {content}
    </span>
  );
}

interface CellBase {
  /** Accessible name (the column). */
  label: string;
  disabled?: boolean;
  className?: string;
}

export function TextCell({
  label,
  value,
  onCommit,
  disabled,
  className = "",
  placeholder,
  maxLength,
  inputMode,
  align = "left",
}: CellBase & {
  value: string;
  onCommit: (value: string) => Promise<CommitOutcome>;
  placeholder?: string;
  maxLength?: number;
  inputMode?: "text" | "numeric";
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(value);
  const [invalid, setInvalid] = useState(false);

  async function commit() {
    const input = ref.current;
    if (!input || input.value === saved.current) return;
    const outcome = await onCommit(input.value);
    if (outcome.ok) {
      const next = typeof outcome.value === "string" ? outcome.value : input.value;
      saved.current = next;
      input.value = next;
      setInvalid(false);
    } else {
      setInvalid(true);
    }
  }

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      inputMode={inputMode}
      autoComplete="off"
      className={`cell-input ${align === "right" ? "num text-right" : ""} ${className}`}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        }
        if (event.key === "Escape") {
          event.currentTarget.value = saved.current;
          setInvalid(false);
        }
      }}
    />
  );
}

export interface Option {
  value: string;
  label: string;
  /** Consecutive options of the same group are drawn as one `<optgroup>`. */
  group?: string;
}

/** The `<option>`s of a select; options with a `group` go into an `<optgroup>`. */
function OptionList({ options }: { options: readonly Option[] }) {
  const runs: { group: string | undefined; options: Option[] }[] = [];
  for (const option of options) {
    const last = runs[runs.length - 1];
    if (last && last.group === option.group) last.options.push(option);
    else runs.push({ group: option.group, options: [option] });
  }
  return runs.flatMap((run, index) => {
    const items = run.options.map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));
    if (run.group === undefined) return items;
    return [
      <optgroup key={`group:${index}:${run.group}`} label={run.group}>
        {items}
      </optgroup>,
    ];
  });
}

export function SelectCell({
  label,
  value,
  options,
  onCommit,
  confirm,
  disabled,
  className = "",
}: CellBase & {
  value: string;
  options: readonly Option[];
  onCommit: (value: string) => Promise<CommitOutcome>;
  /** Asked before saving (e.g. a ConfirmDialog); `false` puts the old value back. */
  confirm?: (value: string) => Promise<boolean>;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const saved = useRef(value);

  async function change(next: string) {
    const select = ref.current;
    if (confirm && !(await confirm(next))) {
      if (select) select.value = saved.current;
      return;
    }
    const outcome = await onCommit(next);
    if (outcome.ok) saved.current = next;
    else if (select) select.value = saved.current;
  }

  return (
    <select
      ref={ref}
      defaultValue={value}
      aria-label={label}
      disabled={disabled}
      className={`cell-input ${className}`}
      onChange={(event) => void change(event.currentTarget.value)}
    >
      <OptionList options={options} />
    </select>
  );
}

export function CheckboxCell({
  label,
  checked,
  onCommit,
  disabled,
}: CellBase & { checked: boolean; onCommit: (value: boolean) => Promise<CommitOutcome> }) {
  const ref = useRef<HTMLInputElement>(null);
  const saved = useRef(checked);

  async function change(next: boolean) {
    const outcome = await onCommit(next);
    if (outcome.ok) saved.current = next;
    else if (ref.current) ref.current.checked = saved.current;
  }

  return (
    <label className="inline-flex min-h-8 min-w-8 cursor-pointer items-center justify-center">
      <input
        ref={ref}
        type="checkbox"
        defaultChecked={checked}
        aria-label={label}
        disabled={disabled}
        className="size-4 cursor-pointer accent-[var(--primary)]"
        onChange={(event) => void change(event.currentTarget.checked)}
      />
    </label>
  );
}

/**
 * Submit handler of a form calling a Server Action. Unlike `<form action>`, a failed save keeps
 * what was typed (React resets action forms); `reset` clears the form after a success (追加 rows).
 */
export function useFormSubmit<T>(
  action: (formData: FormData) => Promise<ActionResult<T>>,
  options: { onSuccess?: (data: T) => void; reset?: boolean } = {},
) {
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    startTransition(async () => {
      const result = await action(formData);
      if (!result) return; // The action redirected.
      if (result.ok) {
        setError(null);
        if (options.reset ?? true) form.reset();
        options.onSuccess?.(result.data);
      } else {
        setError(result);
      }
    });
  }

  return { onSubmit, pending, error, clearError: () => setError(null) };
}

/** 「無効 n 件を表示」: inactive rows are folded under the list (10 §2). */
export function InactiveToggle({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-bold text-muted hover:bg-black/5 hover:text-text"
    >
      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      {open ? `無効 ${count} 件を畳む` : `無効 ${count} 件を表示`}
    </button>
  );
}
