"use client";

import { displayDate, isCalendarDate, type CalendarDate } from "@niho-finance/ledger";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, Input, Select, Textarea } from "@/components/ui/form";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { formLevelErrors, type ActionError } from "@/lib/action-types";
import { entryNo } from "@/lib/format";
import { cancelPayableAction, updatePayableAction } from "../actions";

const SCHEDULE_FIELDS = new Set(["dueDate", "walletId"]);

/**
 * 期日・支払元を変える (25 §4.3): not a ledger change, so it can be done at any time. A cleared due
 * date leaves the payable undated (the forecast then counts it on the next day).
 */
export function ChangeScheduleButton({
  documentId,
  name,
  invoiceDate,
  dueDate,
  walletId,
  wallets,
}: {
  documentId: string;
  name: string;
  invoiceDate: CalendarDate;
  dueDate: CalendarDate | null;
  walletId: string | null;
  wallets: { id: string; label: string }[];
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ dueDate: dueDate ?? "", walletId: walletId ?? "" });
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, startTransition] = useTransition();

  function openSheet() {
    setDraft({ dueDate: dueDate ?? "", walletId: walletId ?? "" });
    setError(null);
    setOpen(true);
  }

  function submit() {
    startTransition(async () => {
      const result = await updatePayableAction(documentId, draft);
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setError(null);
      toast("期日と支払元の予定を保存しました");
      router.refresh();
    });
  }

  const fieldError = (field: string) => error?.fieldErrors[field];
  const alerts = formLevelErrors(error, (field) => SCHEDULE_FIELDS.has(field));
  const dueProblem =
    isCalendarDate(draft.dueDate) && draft.dueDate < invoiceDate
      ? `請求書の日付 ${displayDate(invoiceDate)} 以後にしてください`
      : draft.dueDate === ""
        ? "空にすると期日なしになります"
        : null;

  return (
    <>
      <Button size="sm" onClick={openSheet}>
        期日・支払元を変える
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="期日・支払元を変える"
        description={name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending}>
              {pending ? "保存中…" : "保存"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {alerts.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger"
            >
              {alerts.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          ) : null}
          <FormField
            label="支払期日"
            htmlFor={`${id}-due`}
            error={fieldError("dueDate")}
            help={dueProblem}
          >
            <Input
              id={`${id}-due`}
              type="date"
              value={draft.dueDate}
              onChange={(event) => setDraft({ ...draft, dueDate: event.currentTarget.value })}
            />
          </FormField>
          <FormField
            label="支払元の予定"
            htmlFor={`${id}-wallet`}
            error={fieldError("walletId")}
            help="資金繰りの見通しのための予定です。仕訳には使いません"
          >
            <Select
              id={`${id}-wallet`}
              value={draft.walletId}
              onChange={(event) => setDraft({ ...draft, walletId: event.currentTarget.value })}
            >
              <option value="">決めていない</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </Sheet>
    </>
  );
}

/**
 * 登録を取り消す (25 §4.3): a danger confirmation with the reason. The 計上 entry is reversed and the
 * payable becomes 取消; it can be registered again. Offered only without payments.
 */
export function CancelPayableButton({
  documentId,
  name,
  registrationNo,
}: {
  documentId: string;
  name: string;
  registrationNo: number;
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
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
      const result = await cancelPayableAction(documentId, { reason });
      if (!result.ok) {
        setError(result);
        return;
      }
      setOpen(false);
      setReason("");
      setError(null);
      toast(`${name} の登録を取り消しました`);
      router.refresh();
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
        登録を取り消す
      </Button>
      <ConfirmDialog
        open={open}
        title="登録を取り消します"
        confirmLabel="取消"
        variant="danger"
        pending={pending}
        error={formLevelErrors(error, (field) => field === "reason").join(" / ") || null}
        onCancel={close}
        onConfirm={confirm}
      >
        <p>
          計上の仕訳 {entryNo(registrationNo)}{" "}
          を反対仕訳で取り消します。状態は「取消」になり、証憑から登録し直せます。
        </p>
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
