import type { PayslipData, PayslipLine } from "@/lib/pdf/payslip";

/** Printing keeps only the payslip: no navigation, the whole width, A4 portrait. */
export const PAYSLIP_PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 14mm; }
  html, body { background: #fff !important; }
  aside, nav, [data-print="hide"] { display: none !important; }
  main { grid-column: 1 / -1 !important; padding: 0 !important; }
  main > div { max-width: none !important; }
}
`;

function LinesTable({
  title,
  lines,
  total,
}: {
  title: string;
  lines: readonly PayslipLine[];
  total: PayslipLine;
}) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="pb-1.5 text-left text-[13px] font-extrabold">{title}</caption>
      <thead>
        <tr className="border-y border-border-2 bg-surface-2 text-[11px] text-muted">
          <th scope="col" className="px-2 py-1.5 text-left font-bold">
            項目
          </th>
          <th scope="col" className="px-2 py-1.5 text-right font-bold">
            金額（円）
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.label} className="border-b border-border">
            <th scope="row" className="px-2 py-1.5 text-left font-normal">
              {line.label}
              {line.note ? (
                <span className="ml-1 text-[11px] text-muted">（{line.note}）</span>
              ) : null}
            </th>
            <td className="num px-2 py-1.5 text-right">{line.amount}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-text font-bold">
          <th scope="row" className="px-2 py-1.5 text-left">
            {total.label}
          </th>
          <td className="num px-2 py-1.5 text-right">{total.amount}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * 給与明細 / 賞与明細 as one A4 portrait sheet (22-payroll §6.5・§10.5): the same `PayslipData` the
 * PDF draws, so the printable page and the PDF never differ.
 */
export function PayslipSheet({ data }: { data: PayslipData }) {
  const title = data.title ?? "給与明細";
  return (
    <article
      aria-label={`${data.employeeName} の${title}`}
      className="mx-auto flex w-full max-w-[794px] flex-col gap-5 rounded-card border border-border bg-surface px-5 py-6 text-text md:px-10 md:py-9 print:max-w-none print:rounded-none print:border-0 print:p-0"
    >
      <header className="flex flex-col gap-2 border-b border-border-2 pb-3">
        <div className="flex flex-wrap justify-between gap-x-4 text-[12px] text-muted">
          <span>{data.companyName}</span>
          <span>
            {data.payMonthLabel} · 支払日 <span className="num">{data.paymentDate}</span>
          </span>
        </div>
        <h2 className="text-center text-[20px] font-extrabold">{title}</h2>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <p className="text-[16px] font-bold">{data.employeeName} 様</p>
          <p className="text-[12px] text-muted">{data.kindLabel}</p>
        </div>
      </header>
      <div className="grid gap-5 sm:grid-cols-2 print:grid-cols-2">
        <LinesTable
          title="支給"
          lines={data.pay}
          total={{ label: "総支給", amount: data.grossPay }}
        />
        <LinesTable
          title="控除"
          lines={data.deductions}
          total={{ label: "控除計", amount: data.totalDeductions }}
        />
      </div>
      <div className="flex items-center justify-between rounded-lg border-2 border-text bg-surface-2 px-4 py-3">
        <span className="text-[14px] font-extrabold">差引支給額</span>
        <span className="num text-[22px] font-extrabold">
          {data.netPay}
          <span className="ml-1 text-[13px] font-bold">円</span>
        </span>
      </div>
      <table className="w-full border-collapse text-[13px]">
        <caption className="pb-1.5 text-left text-[13px] font-extrabold">参考</caption>
        <tbody>
          {data.reference.map((row) => (
            <tr key={row.label} className="border-b border-border first:border-t">
              <th scope="row" className="w-[45%] px-2 py-1.5 text-left font-normal text-muted">
                {row.label}
              </th>
              <td className="num px-2 py-1.5">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}
