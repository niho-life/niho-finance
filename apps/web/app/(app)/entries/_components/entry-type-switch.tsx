import Link from "next/link";
import type { ReactNode } from "react";

export const ENTRY_TYPES = ["income", "expense", "transfer", "voucher"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_TYPE_LABELS: Readonly<Record<EntryType, string>> = {
  income: "収入",
  expense: "支出",
  transfer: "振替",
  voucher: "伝票",
};

export function isEntryType(value: unknown): value is EntryType {
  return typeof value === "string" && (ENTRY_TYPES as readonly string[]).includes(value);
}

/**
 * 収入 / 支出 / 振替 / 伝票 as links (11 §4): the URL keeps the chosen form. `aside` sits to its
 * right (「テンプレートから」, 21-cashflow §10.7).
 */
export function EntryTypeSwitch({ current, aside }: { current: EntryType; aside?: ReactNode }) {
  if (aside) {
    return (
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <TypeLinks current={current} />
        {aside}
      </div>
    );
  }
  return <TypeLinks current={current} className="mb-5" />;
}

function TypeLinks({ current, className }: { current: EntryType; className?: string }) {
  return (
    <nav aria-label="取引の種類" className={className}>
      <ul className="inline-flex flex-wrap gap-1 rounded-[10px] bg-track p-1">
        {ENTRY_TYPES.map((type) => {
          const active = type === current;
          return (
            <li key={type}>
              <Link
                href={`/entries/new?type=${type}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-lg px-4 text-[14px] font-bold ${
                  active ? "bg-surface text-text shadow-raised" : "text-muted hover:text-text"
                }`}
              >
                {ENTRY_TYPE_LABELS[type]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
