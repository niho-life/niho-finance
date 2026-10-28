"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";

const REASON_REQUIRED = "理由を入力してください";

/**
 * A button that asks for confirmation with a reason (required or optional), runs a Server Action,
 * then shows a toast and refreshes the page (16 §1.1, §1.2, §5.2). The dialog states the impact.
 */
export function ReasonAction<T>({
  label,
  ariaLabel,
  triggerVariant = "secondary",
  triggerSize = "sm",
  triggerClassName,
  title,
  confirmLabel,
  variant = "default",
  reasonRequired,
  reasonHelp,
  children,
  run,
  doneMessage,
}: {
  label: string;
  /** The accessible name when several buttons share the label (e.g. 「No. 12 を取り消す」). */
  ariaLabel?: string;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  triggerClassName?: string;
  title: string;
  confirmLabel: string;
  variant?: "default" | "danger";
  reasonRequired: boolean;
  reasonHelp?: string;
  children?: ReactNode;
  run: (reason: string) => Promise<ActionResult<T>>;
  doneMessage: (data: T) => string;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    // The reason is what the dialog asks first.
    if (open) document.getElementById(`${id}-reason`)?.focus();
  }, [open, id]);

  function close() {
    setOpen(false);
    setError(null);
  }

  function confirm() {
    if (reasonRequired && reason.trim() === "") {
      setError({ ok: false, error: REASON_REQUIRED, fieldErrors: { reason: REASON_REQUIRED } });
      return;
    }
    startTransition(async () => {
      const result = await run(reason);
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      toast(doneMessage(result.data));
      router.refresh();
    });
  }

  const dialogError = formLevelErrors(error, (field) => field === "reason").join(" / ") || null;

  return (
    <>
      <Button
        variant={triggerVariant}
        size={triggerSize}
        className={triggerClassName}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        title={title}
        confirmLabel={confirmLabel}
        variant={variant}
        pending={pending}
        error={dialogError}
        onCancel={close}
        onConfirm={confirm}
      >
        {children}
        <div className="mt-3">
          <FormField
            label="理由"
            htmlFor={`${id}-reason`}
            required={reasonRequired}
            help={reasonHelp ?? (reasonRequired ? undefined : "任意")}
            error={error?.fieldErrors.reason}
          >
            <Textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={500}
              onChange={(event) => {
                setReason(event.currentTarget.value);
                if (error?.fieldErrors.reason) setError(null);
              }}
            />
          </FormField>
        </div>
      </ConfirmDialog>
    </>
  );
}
