"use client";

import { useState, useTransition } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-types";

/**
 * A button that runs a Server Action without input (e.g. 「この内容で作成」「あとで」). The action
 * usually redirects; a failure is shown next to the button.
 */
export function ActionButton({
  action,
  label,
  pendingLabel = "処理中…",
  variant = "primary",
}: {
  action: () => Promise<ActionResult<unknown>>;
  label: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button
        variant={variant}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await action();
            setError(result && !result.ok ? result.error : null);
          })
        }
      >
        {pending ? pendingLabel : label}
      </Button>
      {error ? (
        <p role="alert" className="text-[12px] font-bold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
