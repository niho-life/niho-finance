"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";

/**
 * A table row that opens and closes the rows under it: 月次推移's groups (open by default) and
 * 試算表's sub-accounts (closed by default). A button with `aria-expanded` instead of `<details>`
 * keeps the table's row structure (`role="row"` directly under the table or a row group).
 */
export function DisclosureRows({
  style,
  rowClassName = "",
  labelClassName = "",
  label,
  toggleLabel,
  labelIsToggle = false,
  cells,
  defaultOpen,
  children,
}: {
  /** The grid of the row (`gridStyle(...)`). */
  style: CSSProperties;
  rowClassName?: string;
  labelClassName?: string;
  /** The row's first cell after the chevron (may hold a link unless `labelIsToggle`). */
  label: ReactNode;
  /** Accessible name of the chevron button, e.g. 「普通預金の補助科目の内訳」 (unless `labelIsToggle`). */
  toggleLabel: string;
  /** The whole label opens and closes the rows (it must not hold a link then). */
  labelIsToggle?: boolean;
  /** The other cells of the row. */
  cells: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const chevron = (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`size-3.5 shrink-0 text-muted-2 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
  return (
    <>
      <div role="row" className={`data-row text-[14px] ${rowClassName}`} style={style}>
        <span role="rowheader" className={`flex min-w-0 items-center gap-1 ${labelClassName}`}>
          {labelIsToggle ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((value) => !value)}
              className="-ml-1 flex min-h-6 min-w-0 items-center gap-1 rounded px-1 text-left"
            >
              {chevron}
              <span className="min-w-0">{label}</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                aria-label={toggleLabel}
                onClick={() => setOpen((value) => !value)}
                className="-ml-1.5 flex size-6 shrink-0 items-center justify-center rounded hover:bg-black/5"
              >
                {chevron}
              </button>
              <span className="min-w-0">{label}</span>
            </>
          )}
        </span>
        {cells}
      </div>
      <div
        id={id}
        role="rowgroup"
        hidden={!open}
        className="[&>[role=row]:last-child]:border-b [&>[role=row]:last-child]:border-border"
      >
        {children}
      </div>
    </>
  );
}
