"use client";

import { Checkbox, type CheckboxProps } from "@/components/ui/form";

/** A checkbox that sends its GET form when it changes. Without JS the form's own button sends it. */
export function AutoSubmitCheckbox({ onChange, ...props }: CheckboxProps) {
  return (
    <Checkbox
      onChange={(event) => {
        onChange?.(event);
        event.currentTarget.form?.requestSubmit();
      }}
      {...props}
    />
  );
}
