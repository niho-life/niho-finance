import { INVOICE_DOC_TYPE_LABELS, type InvoiceDocType } from "@niho-finance/ledger";
import Link from "next/link";

const ORDER: readonly InvoiceDocType[] = ["invoice", "quote", "delivery"];

/** 請求書 / 見積書 / 納品書 as links (18 §8, new documents only): the URL keeps the chosen type. */
export function DocTypeSwitch({ current }: { current: InvoiceDocType }) {
  return (
    <nav aria-label="書類の種別" className="mb-5">
      <ul className="inline-flex flex-wrap gap-1 rounded-[10px] bg-track p-1">
        {ORDER.map((type) => {
          const active = type === current;
          return (
            <li key={type}>
              <Link
                href={`/invoices/new?type=${type}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-lg px-4 text-[14px] font-bold ${
                  active ? "bg-surface text-text shadow-raised" : "text-muted hover:text-text"
                }`}
              >
                {INVOICE_DOC_TYPE_LABELS[type]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
