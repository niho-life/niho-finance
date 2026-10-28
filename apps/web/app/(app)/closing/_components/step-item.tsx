import type { YearEndStep } from "@niho-finance/db";
import type { ReactNode } from "react";
import { StatusChip } from "./status-chip";

function StepNumber({ step }: { step: YearEndStep }) {
  const done = step.state === "done" || step.state === "na";
  return (
    <span
      aria-hidden="true"
      className={`num mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${
        done ? "bg-primary text-white" : "bg-track text-muted"
      }`}
    >
      {step.no}
    </span>
  );
}

/**
 * One step of the checklist (16 §3): 番号・項目名・状態 / 要約 / 入口 — three lines at 320px. The row
 * opens to its details with a native `<details>` (works without JS); the entry point stays visible
 * under it either way.
 */
export function StepItem({
  step,
  open,
  details,
  actions,
}: {
  step: YearEndStep;
  /** Open on load (the first step that is not done). */
  open: boolean;
  details?: ReactNode;
  actions?: ReactNode;
}) {
  const head = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="sr-only">{step.no}. </span>
        <span className="text-[15px] font-bold">{step.label}</span>
        <StatusChip state={step.state} />
      </span>
      <span className="text-[13px] break-words text-muted">{step.summary}</span>
    </span>
  );
  return (
    <li className="flex gap-3 border-b border-border py-3.5 last:border-b-0">
      <StepNumber step={step} />
      <div className="min-w-0 flex-1">
        {details ? (
          <details open={open} className="group">
            <summary className="-mx-1.5 flex cursor-pointer list-none items-start gap-2 rounded-lg px-1.5 py-0.5 hover:bg-black/[0.02] [&::-webkit-details-marker]:hidden">
              {head}
              <svg
                viewBox="0 0 24 24"
                className="mt-1 size-4 shrink-0 text-muted-2 group-open:rotate-90"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </summary>
            <div className="mt-3 flex min-w-0 flex-col gap-3">{details}</div>
          </details>
        ) : (
          head
        )}
        {actions ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </li>
  );
}
