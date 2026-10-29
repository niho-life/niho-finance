import type { WithholdingLedgerData, WithholdingLedgerTable } from "@/lib/pdf/withholding-ledger";

/** Printing keeps only the ledger: no navigation, the whole width, A4 landscape. */
export const WITHHOLDING_LEDGER_PRINT_CSS = `
@media print {
  @page { size: A4 landscape; margin: 12mm; }
  html, body { background: #fff !important; }
  aside, nav, [data-print="hide"] { display: none !important; }
  main { grid-column: 1 / -1 !important; padding: 0 !important; }
  main > div { max-width: none !important; }
}
`;

function LedgerTable({ table }: { table: WithholdingLedgerTable }) {
  return (
    <div className="overflow-x-auto print:overflow-visible">
      <table className="w-full min-w-[860px] border-collapse text-[12px] print:min-w-0">
        <caption className="pb-1.5 text-left text-[13px] font-extrabold">{table.title}</caption>
        <thead>
          <tr className="border-y border-border-2 bg-surface-2 text-[11px] text-muted">
            {table.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-2 py-1.5 font-bold ${column.align === "right" ? "text-right" : "text-left"}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr className="border-b border-border">
              <td colSpan={table.columns.length} className="px-2 py-2 text-muted">
                {table.empty}
              </td>
            </tr>
          ) : (
            table.rows.map((row) => (
              <tr key={row.key} className="border-b border-border">
                {table.columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-2 py-1.5 ${column.align === "right" ? "num text-right" : ""}`}
                  >
                    {row.cells[column.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {table.total ? (
          <tfoot>
            <tr className="border-t-2 border-text font-bold">
              {table.columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-2 py-1.5 ${column.align === "right" ? "num text-right" : ""}`}
                >
                  {table.total?.[column.key] ?? ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/**
 * 源泉徴収簿 (22-payroll §11.4) as one printable sheet: the same `WithholdingLedgerData` the PDF
 * draws, so the page and the PDF never differ.
 */
export function WithholdingLedgerSheet({ data }: { data: WithholdingLedgerData }) {
  return (
    <article
      aria-label={`${data.employeeName} の源泉徴収簿`}
      className="mx-auto flex w-full max-w-[1123px] flex-col gap-5 rounded-card border border-border bg-surface px-5 py-6 text-text md:px-8 md:py-8 print:max-w-none print:rounded-none print:border-0 print:p-0"
    >
      <header className="flex flex-col gap-2 border-b border-border-2 pb-3">
        <div className="flex flex-wrap justify-between gap-x-4 text-[12px] text-muted">
          <span>{data.companyName}</span>
          <span>{data.yearLabel}</span>
        </div>
        <h2 className="text-center text-[20px] font-extrabold">源泉徴収簿</h2>
        <p className="text-[15px] font-bold">
          {data.employeeName}
          <span className="ml-2 text-[12px] font-normal text-muted">{data.kindLabel}</span>
        </p>
      </header>
      <LedgerTable table={data.months} />
      <LedgerTable table={data.bonuses} />
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-extrabold">{data.yearEnd?.title ?? "年末調整"}</h3>
        {data.yearEnd ? (
          <>
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {data.yearEnd.rows.map((row) => (
                  <tr
                    key={row.key}
                    className={`border-b border-border first:border-t ${row.strong ? "bg-surface-2 font-bold" : ""}`}
                  >
                    <th scope="row" className="px-2 py-1.5 text-left font-normal">
                      <span className={row.strong ? "font-bold" : ""}>{row.label}</span>
                      {row.note ? (
                        <span className="ml-1 text-[11px] text-muted">（{row.note}）</span>
                      ) : null}
                    </th>
                    <td className="num w-[140px] px-2 py-1.5 text-right">{row.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between rounded-lg border-2 border-text bg-surface-2 px-4 py-2.5">
              <span className="text-[13px] font-extrabold">9. 過不足</span>
              <span className="num text-[15px] font-extrabold">{data.yearEnd.settlement}</span>
            </div>
          </>
        ) : (
          <p className="text-[13px] text-muted">{data.yearEndMessage}</p>
        )}
      </section>
    </article>
  );
}
