"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { setPartnerIndividualAction } from "../actions";

const CHOICES = [
  { value: "unknown", label: "未確認" },
  { value: "individual", label: "個人" },
  { value: "corporation", label: "法人" },
] as const;

/** 個人 / 法人 / 未確認 of a payee: saved at once (audit log), the page reloads its numbers. */
export function PartnerKindSelect({
  partnerId,
  partnerName,
  value,
}: {
  partnerId: string;
  partnerName: string;
  value: "individual" | "corporation" | "unknown";
}) {
  const id = useId();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex flex-col gap-0.5">
      <label htmlFor={id} className="sr-only">
        {partnerName} は個人か法人か
      </label>
      <Select
        id={id}
        value={value}
        disabled={pending}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          const choice = event.currentTarget.value;
          startTransition(async () => {
            const result = await setPartnerIndividualAction(partnerId, choice);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setError(null);
            toast(`「${result.data.name}」を保存しました`);
            router.refresh();
          });
        }}
        className="h-8 w-[96px] text-[13px]"
      >
        {CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Select>
      {error ? (
        <span id={`${id}-error`} role="alert" className="text-[11px] font-bold text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
