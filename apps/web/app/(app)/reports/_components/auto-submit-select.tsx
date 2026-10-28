"use client";

import type { SelectHTMLAttributes } from "react";
import { Select } from "@/components/ui/form";

/**
 * A native `<select>` that submits its GET form on change (14-reports §2). Without JavaScript the
 * form's 「表示」 button submits it.
 */
export function AutoSubmitSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Select
      {...props}
      onChange={(event) => {
        props.onChange?.(event);
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
