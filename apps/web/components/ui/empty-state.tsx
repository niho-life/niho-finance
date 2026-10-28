import type { ReactNode } from "react";

/** An empty list says what is missing and what to do next (05-ui-ux §4). */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-card border border-dashed border-border-2 bg-surface px-5 py-6">
      <p className="text-[15px] font-bold">{title}</p>
      {description ? <p className="text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
