"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { CommitOutcome } from "@/components/settings/inline";
import { MoneyInput } from "@/components/ui/money-input";

/*
 * In-place cells the settings' `inline.tsx` does not have (13 §4): a date and an amount. Like
 * `TextCell` they are uncontrolled, keep what was typed when the save fails and put the saved value
 * back on Escape.
 */

interface CellProps {
  /** Accessible name. */
  label: string;
  value: string;
  onCommit: (value: string) => Promise<CommitOutcome>;
  disabled?: boolean;
}

/**
 * `<input type="date">`: a date picked from the calendar is saved on `change`. Typed digits are
 * saved on blur or Enter, so that the years a keyboard passes through (0002, 0020 …) are never
 * saved. A half-typed date is not saved.
 */
export function DateCell({ label, value, onCommit, disabled }: CellProps) {
  const saved = useRef(value);
  const typing = useRef(false);
  const [invalid, setInvalid] = useState(false);

  async function commit(input: HTMLInputElement) {
    if (input.validity.badInput) {
      setInvalid(true);
      return;
    }
    if (input.value === saved.current) {
      setInvalid(false);
      return;
    }
    const outcome = await onCommit(input.value);
    if (outcome.ok) {
      saved.current = typeof outcome.value === "string" ? outcome.value : input.value;
      setInvalid(false);
    } else {
      setInvalid(true);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      typing.current = false;
      void commit(event.currentTarget);
      return;
    }
    if (event.key === "Escape") {
      event.currentTarget.value = saved.current;
      typing.current = false;
      setInvalid(false);
      return;
    }
    if (event.key !== "Tab") typing.current = true;
  }

  return (
    <input
      type="date"
      defaultValue={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      className="cell-input num"
      onKeyDown={onKeyDown}
      onChange={(event) => {
        if (!typing.current) void commit(event.currentTarget);
      }}
      onBlur={(event) => {
        typing.current = false;
        void commit(event.currentTarget);
      }}
    />
  );
}

/** `MoneyInput` as a cell: saved on blur or Enter (0 or more, whole yen). */
export function AmountCell({ label, value, onCommit, disabled }: CellProps) {
  const saved = useRef(value);
  const [invalid, setInvalid] = useState(false);

  async function commit(input: HTMLInputElement) {
    if (input.value === saved.current) return;
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
    <MoneyInput
      variant="cell"
      defaultValue={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      onBlur={(event) => void commit(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit(event.currentTarget);
        }
        if (event.key === "Escape") {
          event.currentTarget.value = saved.current;
          setInvalid(false);
        }
      }}
    />
  );
}
