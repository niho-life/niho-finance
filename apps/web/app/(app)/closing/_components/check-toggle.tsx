"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { setYearEndCheckAction } from "../actions";

/**
 * 「照合した」「確認した」 and 「確認を外す」 (16 §3): who and when once checked. A closed year only shows
 * the record.
 */
export function CheckToggle({
  fiscalYearId,
  checkKey,
  record,
  label,
  doneText,
  subject,
  readOnly,
}: {
  fiscalYearId: string;
  checkKey: "balances" | "accruals";
  /** Who checked and when (formatted in JST), or `null`. */
  record: { actor: string; at: string } | null;
  /** 「照合した」 / 「確認した」 */
  label: string;
  /** 「照合しました」 / 「確認しました」 */
  doneText: string;
  /** The step, for the accessible name of 「確認を外す」 (e.g. 「残高の照合」). */
  subject: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(checked: boolean) {
    startTransition(async () => {
      const result = await setYearEndCheckAction(fiscalYearId, { key: checkKey, checked });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      toast(checked ? doneText : "確認を外しました");
      router.refresh();
    });
  }

  return (
    <>
      {record ? (
        <span className="text-[13px] break-words text-muted">
          {record.actor} が <span className="num">{record.at}</span> に{doneText}
        </span>
      ) : null}
      {readOnly ? null : record ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${subject}の確認を外す`}
          disabled={pending}
          onClick={() => toggle(false)}
        >
          確認を外す
        </Button>
      ) : (
        <Button size="sm" disabled={pending} onClick={() => toggle(true)}>
          {label}
        </Button>
      )}
      {error ? (
        <p role="alert" className="w-full text-[12px] font-bold text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
