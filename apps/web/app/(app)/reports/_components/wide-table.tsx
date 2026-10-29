import type { ReactNode } from "react";
import { gridStyle } from "@/components/ui/table";

/**
 * A table wider than a phone (月次推移・セグメント損益・仕訳帳・総勘定元帳, 14-reports §1): it keeps
 * its columns and header on every width and scrolls sideways inside its own frame, so the page
 * itself never scrolls sideways. The first column can stick to the left while scrolling.
 */
export function WideTable({
  label,
  minWidth,
  children,
}: {
  label: string;
  /** Below this width the table scrolls inside its frame. */
  minWidth: number;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <div role="table" aria-label={label} style={{ minWidth: `${minWidth}px` }}>
        {children}
      </div>
    </div>
  );
}

/** The grid of a wide row: the same columns on phones (no 2-line layout). */
export function wideGrid(columns: string) {
  return gridStyle({ columns, mobileColumns: columns });
}

export const WIDE_HEAD_CLASS =
  "min-h-9 bg-surface-2 text-[11px] font-bold tracking-[0.03em] text-muted";

const STICKY_INDENT = ["pl-3.5", "pl-7", "pl-10"] as const;

/**
 * Sticky first cell (the 科目 column). It reaches over the row's left padding with its own
 * background, so that what scrolls under it stays hidden; `indent` steps in the labels.
 */
export function stickyCell(
  options: { background?: "surface" | "surface-2"; indent?: 0 | 1 | 2 } = {},
): string {
  const { background = "surface", indent = 0 } = options;
  return [
    "sticky left-0 z-[1] -ml-3.5 pr-2",
    STICKY_INDENT[indent],
    background === "surface" ? "bg-surface" : "bg-surface-2",
  ].join(" ");
}

export function WideHead({ columns, children }: { columns: string; children: ReactNode }) {
  return (
    <div role="row" className={`data-row ${WIDE_HEAD_CLASS}`} style={wideGrid(columns)}>
      {children}
    </div>
  );
}

export function WideRow({
  columns,
  className = "",
  children,
}: {
  columns: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="row" className={`data-row text-[14px] ${className}`} style={wideGrid(columns)}>
      {children}
    </div>
  );
}

/** A heading row across the whole width (セグメント損益's 収益 / 費用, 仕訳帳's entries). */
export function WideGroupRow({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="row" className={`data-group ${className}`}>
      <span
        role="rowheader"
        className="sticky left-3.5 inline-flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"
      >
        {children}
      </span>
    </div>
  );
}
