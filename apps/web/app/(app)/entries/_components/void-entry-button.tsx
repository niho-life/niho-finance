"use client";

import { displayDate, type CalendarDate } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { voidEntryAction } from "../actions";

const REASON_REQUIRED = "理由を入力してください";

/**
 * 取消 (11 §5): a danger confirmation with the reason (required) and the date of the reversal —
 * the first open date when the entry's month is closed. The page stays and shows the band.
 */
export function VoidEntryButton({
  entryId,
  no,
  reversalDate,
  lockedThrough,
}: {
  entryId: string;
  no: number;
  reversalDate: CalendarDate;
  /** Set when the entry is on or before the close. */
  lockedThrough: CalendarDate | null;
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
    if (reason.trim() === "") {
      setError({ ok: false, error: REASON_REQUIRED, fieldErrors: { reason: REASON_REQUIRED } });
      return;
    }
    startTransition(async () => {
      const result = await voidEntryAction(entryId, { reason });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      toast(`${entryNo(no)} を取り消しました（反対仕訳 ${entryNo(result.data.reversalNo)}）`);
      router.refresh();
    });
  }

  const dialogError = formLevelErrors(error, (field) => field === "reason").join(" / ") || null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger! hover:text-danger!"
        onClick={() => setOpen(true)}
      >
        取消
      </Button>
      <ConfirmDialog
        open={open}
        title={`${entryNo(no)} を取り消します`}
        confirmLabel="取消"
        variant="danger"
        pending={pending}
        error={dialogError}
        onCancel={close}
        onConfirm={confirm}
      >
        <p>
          借方と貸方を入れ替えた反対仕訳を{" "}
          <span className="num font-bold">{displayDate(reversalDate)}</span> 付で登録し、
          {entryNo(no)} を取消済みにします。どちらも台帳に残ります。
        </p>
        {lockedThrough ? (
          <p className="mt-2 text-[13px] text-muted">
            {displayDate(lockedThrough)}{" "}
            までは締めているため、反対仕訳の日付は開いている最初の日付です。
          </p>
        ) : null}
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
