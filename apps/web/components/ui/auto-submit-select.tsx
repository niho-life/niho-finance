"use client";

import type { SelectHTMLAttributes } from "react";

/**
 * A native `<select>` that sends its GET form when it changes (the filters of the lists). Without
 * JS the form's own button sends it.
 */
export function AutoSubmitSelect({
  className = "",
  onChange,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`control ${className}`}
      onChange={(event) => {
        onChange?.(event);
        event.currentTarget.form?.requestSubmit();
      }}
      {...props}
    />
  );
}
