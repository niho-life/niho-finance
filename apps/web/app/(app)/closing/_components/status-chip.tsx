import type { YearEndStepState } from "@niho-finance/db";

const CHIPS: Readonly<Record<YearEndStepState, { label: string; className: string }>> = {
  done: { label: "完了", className: "bg-primary-soft text-primary-ink" },
  todo: { label: "未完了", className: "bg-track text-muted" },
  pending: { label: "準備中", className: "border border-border text-muted-2" },
  na: { label: "対象外", className: "bg-primary-soft text-primary" },
};

/** The state of a checklist step (16 §3): 完了 (green) / 未完了 / 準備中 / 対象外. */
export function StatusChip({ state }: { state: YearEndStepState }) {
  const chip = CHIPS[state];
  return (
    <span
      className={`inline-flex min-h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-bold whitespace-nowrap ${chip.className}`}
    >
      {chip.label}
    </span>
  );
}
