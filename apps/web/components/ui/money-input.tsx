"use client";

import { formatYenInput, parseYenInput } from "@niho-finance/ledger";
import type { InputHTMLAttributes } from "react";

export interface MoneyInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "inputMode" | "onChange" | "value"
> {
  /** Controlled text; leave out for an uncontrolled input with `defaultValue`. */
  value?: string;
  onValueChange?: (text: string) => void;
  allowNegative?: boolean;
  /** Use the inline-cell look instead of a form control. */
  variant?: "control" | "cell";
}

/**
 * Amount in whole yen. Accepts `50000`, `50,000` and full-width digits; shows 3-digit grouping
 * after leaving the field. The unit 「円」 belongs to the label, not the field (05-ui-ux §3).
 */
export function MoneyInput({
  value,
  onValueChange,
  allowNegative = false,
  variant = "control",
  className = "",
  onBlur,
  ...props
}: MoneyInputProps) {
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      {...(value === undefined ? {} : { value })}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
      onBlur={(event) => {
        const parsed = parseYenInput(event.currentTarget.value, { allowNegative });
        if (parsed !== null) {
          const formatted = formatYenInput(parsed);
          if (value === undefined) event.currentTarget.value = formatted;
          else onValueChange?.(formatted);
        }
        onBlur?.(event);
      }}
      className={`${variant === "cell" ? "cell-input" : "control"} num text-right ${className}`}
      {...props}
    />
  );
}
