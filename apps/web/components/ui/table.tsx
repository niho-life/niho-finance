import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * Grid table: rows of 40px (05-ui-ux §3), numbers right-aligned by the caller with `num text-right`.
 * `columns` is the PC `grid-template-columns`; `mobileColumns` applies under 768px, where cells
 * marked `data-sm="hide"` are left out so that a row reads as 名前＋主要 2 項目 on 2 lines.
 */
export interface TableColumns {
  columns: string;
  mobileColumns?: string;
}

/** The grid of a row, for elements that are rows but not `TableRow` (e.g. an 「追加」 form). */
export function gridStyle({ columns, mobileColumns }: TableColumns): CSSProperties {
  return {
    "--cols": columns,
    ...(mobileColumns ? { "--cols-sm": mobileColumns } : {}),
  } as CSSProperties;
}

export function Table({
  className = "",
  children,
  label,
  minWidth,
}: {
  className?: string;
  children: ReactNode;
  /** Accessible name of the table. */
  label: string;
  /** Wide tables scroll sideways on PC below this width (phones use the 2-line rows). */
  minWidth?: number;
}) {
  if (minWidth) {
    return (
      <div className={`overflow-x-auto rounded-card border border-border bg-surface ${className}`}>
        <div
          role="table"
          aria-label={label}
          style={{ "--table-min": `${minWidth}px` } as CSSProperties}
          className="md:min-w-(--table-min)"
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      role="table"
      aria-label={label}
      className={`overflow-hidden rounded-card border border-border bg-surface ${className}`}
    >
      {children}
    </div>
  );
}

export function TableHead({
  columns,
  mobileColumns,
  children,
}: TableColumns & { children: ReactNode }) {
  return (
    <div role="row" className="data-row data-head" style={gridStyle({ columns, mobileColumns })}>
      {children}
    </div>
  );
}

export interface TableRowProps extends TableColumns, Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  children: ReactNode;
  muted?: boolean;
}

export function TableRow({
  columns,
  mobileColumns,
  children,
  muted,
  className = "",
  style,
  ...props
}: TableRowProps) {
  return (
    <div
      role="row"
      className={`data-row text-[14px] ${muted ? "text-muted" : ""} ${className}`}
      style={{ ...gridStyle({ columns, mobileColumns }), ...style }}
      {...props}
    >
      {children}
    </div>
  );
}

/** A heading row inside a table (e.g. 資産 / 負債 in the chart of accounts). */
export function TableGroup({ children }: { children: ReactNode }) {
  return (
    <div role="row" className="data-group">
      <span role="rowheader">{children}</span>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  sm,
}: {
  children?: ReactNode;
  align?: "left" | "right";
  sm?: "hide";
}) {
  return (
    <span role="columnheader" data-sm={sm} className={align === "right" ? "text-right" : ""}>
      {children}
    </span>
  );
}

export function Td({
  children,
  align = "left",
  sm,
  className = "",
  label,
}: {
  children?: ReactNode;
  align?: "left" | "right";
  /** `hide`: left out on phones. `full`: a whole line of its own on phones. */
  sm?: "hide" | "full";
  className?: string;
  /** Shown before the value on phones, where the header row is hidden. */
  label?: string;
}) {
  return (
    <span
      role="cell"
      data-sm={sm}
      className={`min-w-0 ${align === "right" ? "num text-right" : ""} ${className}`}
    >
      {label ? <span className="mr-1 text-[11px] text-muted-2 md:hidden">{label}</span> : null}
      {children}
    </span>
  );
}
