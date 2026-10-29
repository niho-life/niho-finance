import type { FormSection, StatementForm } from "@/lib/pdf/statement-form";

/** Printing keeps only the forms: no navigation, the whole width, A4 portrait, a page each. */
export const STATEMENT_FORM_PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 10mm; }
  html, body { background: #fff !important; }
  aside, nav, [data-print="hide"] { display: none !important; }
  main { grid-column: 1 / -1 !important; padding: 0 !important; }
  main > div { max-width: none !important; }
  [data-statement-form] { break-after: page; }
}
`;

function Section({ section }: { section: FormSection }) {
  return (
    <section className="flex flex-col gap-1">
      {section.title ? <h3 className="text-[12px] font-extrabold">{section.title}</h3> : null}
      <div className="overflow-hidden rounded-sm border border-text">
        {section.rows.map((row, index) => (
          <div
            key={index}
            className={`flex flex-wrap md:flex-nowrap ${index === 0 ? "" : "border-t border-text"}`}
          >
            {row.map((cell, cellIndex) => (
              <div
                key={cellIndex}
                className={`min-w-[96px] basis-0 px-1.5 py-1 ${
                  cellIndex === row.length - 1 ? "" : "border-r border-text"
                }`}
                style={{ flexGrow: cell.flex ?? 1 }}
              >
                <p className="text-[10px] leading-tight text-muted">{cell.label}</p>
                <p
                  className={`min-h-[18px] whitespace-pre-wrap text-[13px] ${
                    cell.align === "right"
                      ? "num text-right"
                      : cell.align === "center"
                        ? "text-center"
                        : ""
                  }`}
                >
                  {cell.value}
                </p>
                {cell.note ? (
                  <p
                    className={`text-[10px] text-muted ${cell.align === "right" ? "text-right" : ""}`}
                  >
                    {cell.note}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** One 法定調書 as boxes: the same text as its PDF (`lib/pdf/statement-form.tsx`). */
export function StatementFormSheet({ form }: { form: StatementForm }) {
  return (
    <article
      data-statement-form
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 print:border-0 print:p-0"
    >
      <header className="text-center">
        <h2 className="text-[17px] font-extrabold">{form.title}</h2>
        {form.subtitle ? <p className="text-[12px] text-muted">{form.subtitle}</p> : null}
      </header>
      {form.sections.map((section, index) => (
        <Section key={index} section={section} />
      ))}
      {form.footnotes.length > 0 ? (
        <ul className="list-disc pl-5 text-[11px] text-muted">
          {form.footnotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
