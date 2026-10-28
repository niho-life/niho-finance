import type { InvoiceChecklist, InvoiceChecklistState } from "@niho-finance/ledger";

const STATE_TEXT: Readonly<Record<InvoiceChecklistState, string>> = {
  ok: "✓",
  info: "情報",
  error: "不備",
};

const STATE_CLASS: Readonly<Record<InvoiceChecklistState, string>> = {
  ok: "text-muted",
  info: "text-muted",
  error: "font-bold text-danger",
};

/**
 * 記載事項の確認 (18 §4): each item with ✓ / 不備 / 情報 and what it says. Shared by the form (computed
 * as the owner types) and the draft's detail; the server refuses the issue on the same check.
 */
export function InvoiceChecklistView({
  checklist,
  note,
}: {
  checklist: InvoiceChecklist;
  /** Under the title, e.g. that a draft with 不備 can be saved but not issued. */
  note?: string;
}) {
  return (
    <section aria-label="記載事項の確認" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-[15px] font-extrabold">記載事項の確認</h2>
        <span className="text-[12px] text-muted">
          {checklist.qualified ? "適格請求書" : "区分記載請求書"}
        </span>
      </div>
      {note && !checklist.ready ? <p className="text-[12px] text-muted">{note}</p> : null}
      <ul className="border-t border-border">
        {checklist.items.map((item) => (
          <li
            key={item.key}
            className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-2 gap-y-0.5 border-b border-border py-2 text-[14px] md:grid-cols-[40px_180px_minmax(0,1fr)]"
          >
            <span className={`text-[13px] ${STATE_CLASS[item.state]}`}>
              {STATE_TEXT[item.state]}
            </span>
            <span className="font-bold">{item.label}</span>
            <span
              className={`col-start-2 text-[13px] md:col-start-auto ${
                item.state === "error" ? "text-danger" : "text-muted"
              }`}
            >
              {item.detail}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
