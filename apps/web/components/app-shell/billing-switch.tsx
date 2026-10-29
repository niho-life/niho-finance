import Link from "next/link";

const SECTIONS = [
  { key: "invoices", label: "請求書", href: "/invoices" },
  { key: "payables", label: "支払", href: "/payables" },
] as const;

export type BillingSection = (typeof SECTIONS)[number]["key"];

/**
 * 請求書 / 支払 above the lists of 請求 (25 §5): both live under 請求 in the navigation, so this
 * switch moves between them (links, the URL is the truth).
 */
export function BillingSwitch({ current }: { current: BillingSection }) {
  return (
    <nav aria-label="請求の切り替え" className="mb-4">
      <ul className="inline-flex flex-wrap gap-1 rounded-[10px] bg-track p-1">
        {SECTIONS.map((section) => {
          const active = section.key === current;
          return (
            <li key={section.key}>
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-lg px-4 text-[14px] font-bold ${
                  active ? "bg-surface text-text shadow-raised" : "text-muted hover:text-text"
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
