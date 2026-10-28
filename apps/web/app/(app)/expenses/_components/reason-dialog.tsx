"use client";

import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Textarea } from "@/components/ui/form";
import { formLevelErrors, type ActionError, type ActionResult } from "@/lib/action-types";

/**
 * 取消 / 支払の取消 (23-users-and-expenses §6): a danger confirmation with the reason (required). The
 * text says the amount and that a reversal is posted (on the first open day when the month is
 * closed).
 */
export function ReasonButton<T>({
  label,
  title,
  confirmLabel,
  children,
  action,
  onDone,
}: {
  label: string;
  title: string;
  confirmLabel: string;
  children: ReactNode;
  action: (reason: string) => Promise<ActionResult<T>>;
  onDone: (data: T) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) document.getElementById(`${id}-reason`)?.focus();
  }, [open, id]);

  function close() {
    setOpen(false);
    setError(null);
  }

  function confirm() {
    if (reason.trim() === "") {
      const message = "理由を入力してください";
      setError({ ok: false, error: message, fieldErrors: { reason: message } });
      return;
    }
    startTransition(async () => {
      const result = await action(reason);
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      onDone(result.data);
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger! hover:text-danger!"
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        title={title}
        confirmLabel={confirmLabel}
        variant="danger"
        pending={pending}
        error={formLevelErrors(error, (field) => field === "reason").join(" / ") || null}
        onCancel={close}
        onConfirm={confirm}
      >
        {children}
        <div className="mt-3">
          <FormField
            label="理由"
            htmlFor={`${id}-reason`}
            required
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
