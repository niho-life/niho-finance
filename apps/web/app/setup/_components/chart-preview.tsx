import {
  ACCOUNT_GROUP_LABELS,
  ACCOUNT_KIND_LABELS,
  ACCOUNT_KINDS,
  type AccountGroup,
  type AccountKind,
} from "@niho-finance/ledger";

export interface ChartRow {
  code: string;
  name: string;
  kind: AccountKind;
  group: AccountGroup;
}

/** The chart grouped by kind, each kind folded (Step 3, 10 §3). */
export function ChartPreview({ accounts }: { accounts: readonly ChartRow[] }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      {ACCOUNT_KINDS.map((kind) => {
        const rows = accounts.filter((account) => account.kind === kind);
        if (rows.length === 0) return null;
        return (
          <details key={kind} className="group border-b border-border last:border-b-0">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 font-bold">
              <span aria-hidden="true" className="text-muted-2 group-open:rotate-90">
                ›
              </span>
              {ACCOUNT_KIND_LABELS[kind]}
              <span className="num ml-auto text-[12px] font-normal text-muted">
                {rows.length} 科目
              </span>
            </summary>
            <ul className="border-t border-border bg-surface-2 px-4 py-2">
              {rows.map((account) => (
                <li key={account.code} className="flex min-h-8 items-center gap-3 text-[14px]">
                  <span className="num w-10 shrink-0 text-muted">{account.code}</span>
                  <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  <span className="hidden text-[12px] text-muted sm:inline">
                    {ACCOUNT_GROUP_LABELS[account.group]}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
