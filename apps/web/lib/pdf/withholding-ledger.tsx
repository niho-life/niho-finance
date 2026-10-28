import { Text, View } from "@react-pdf/renderer";
import { ReportDocument } from "./document";
import { PDF_COLORS, pdfStyles } from "./styles";
import { PdfCell, PdfRow, PdfTable } from "./table";

/** One column of a 源泉徴収簿 table: its header and each row's text. */
export interface WithholdingLedgerColumn {
  key: string;
  label: string;
  align: "left" | "right";
  /** Width in pt; the first column takes the rest. */
  width?: number;
}

export interface WithholdingLedgerTable {
  title: string;
  columns: WithholdingLedgerColumn[];
  rows: { key: string; cells: Record<string, string> }[];
  /** The 合計 row (`null`: no rows). */
  total: Record<string, string> | null;
  /** Shown instead of the rows when there are none. */
  empty: string;
}

/**
 * 源泉徴収簿 as text (22-payroll §11.4): built once from `loadWithholdingLedger` and drawn both as the
 * printable page and as this PDF, so the two never differ.
 */
export interface WithholdingLedgerData {
  companyName: string;
  /** 「2026 年分」 */
  yearLabel: string;
  employeeName: string;
  /** 役員 / 従業員 */
  kindLabel: string;
  months: WithholdingLedgerTable;
  bonuses: WithholdingLedgerTable;
  yearEnd: {
    /** 「年末調整（確定 2026/12/25）」 / 「年末調整（概算・未確定）」 */
    title: string;
    rows: { key: string; label: string; amount: string; note: string | null; strong: boolean }[];
    /** 過不足 and the entry (when confirmed). */
    settlement: string;
  } | null;
  /** Why the 年末調整 columns are empty (no data for the year). */
  yearEndMessage: string | null;
}

function LedgerTable({ table }: { table: WithholdingLedgerTable }) {
  const [first, ...rest] = table.columns;
  if (!first) return null;
  const cell = (column: WithholdingLedgerColumn, text: string | undefined, bold = false) => (
    <PdfCell
      key={column.key}
      {...(column === first ? { flex: 1 } : { width: column.width ?? 64 })}
      align={column.align}
      bold={bold}
    >
      {text ?? ""}
    </PdfCell>
  );
  return (
    <View>
      <Text style={pdfStyles.heading}>{table.title}</Text>
      <PdfTable>
        <PdfRow variant="header" fixed>
          {[first, ...rest].map((column) => (
            <PdfCell
              key={column.key}
              {...(column === first ? { flex: 1 } : { width: column.width ?? 64 })}
              align={column.align}
            >
              {column.label}
            </PdfCell>
          ))}
        </PdfRow>
        {table.rows.length === 0 ? (
          <PdfRow>
            <PdfCell flex={1} muted>
              {table.empty}
            </PdfCell>
          </PdfRow>
        ) : (
          table.rows.map((row) => (
            <PdfRow key={row.key}>
              {table.columns.map((column) => cell(column, row.cells[column.key]))}
            </PdfRow>
          ))
        )}
        {table.total ? (
          <PdfRow variant="total">
            {table.columns.map((column) => cell(column, table.total?.[column.key], true))}
          </PdfRow>
        ) : null}
      </PdfTable>
    </View>
  );
}

/** 源泉徴収簿 on A4 landscape, with the fonts and styles of every PDF of the app. */
export function WithholdingLedgerDocument({
  ledger,
  exportedAt,
}: {
  ledger: WithholdingLedgerData;
  exportedAt?: Date;
}) {
  return (
    <ReportDocument
      title="源泉徴収簿"
      company={ledger.companyName}
      periodLabel={ledger.yearLabel}
      subtitle={`${ledger.employeeName}（${ledger.kindLabel}）`}
      orientation="landscape"
      {...(exportedAt ? { exportedAt } : {})}
    >
      <LedgerTable table={ledger.months} />
      <LedgerTable table={ledger.bonuses} />
      <Text style={pdfStyles.heading}>{ledger.yearEnd?.title ?? "年末調整"}</Text>
      {ledger.yearEnd ? (
        <View>
          <PdfTable>
            {ledger.yearEnd.rows.map((row) => (
              <PdfRow key={row.key} variant={row.strong ? "subtotal" : "body"}>
                <PdfCell flex={1} bold={row.strong}>
                  {row.label}
                  {row.note ? `（${row.note}）` : ""}
                </PdfCell>
                <PdfCell width={96} align="right" bold={row.strong}>
                  {row.amount}
                </PdfCell>
              </PdfRow>
            ))}
          </PdfTable>
          <View
            wrap={false}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              paddingVertical: 6,
              paddingHorizontal: 8,
              borderWidth: 1,
              borderColor: PDF_COLORS.text,
              backgroundColor: PDF_COLORS.fill,
            }}
          >
            <Text style={{ fontWeight: 700 }}>9. 過不足</Text>
            <Text style={{ fontWeight: 700 }}>{ledger.yearEnd.settlement}</Text>
          </View>
        </View>
      ) : (
        <Text style={pdfStyles.muted}>{ledger.yearEndMessage ?? ""}</Text>
      )}
    </ReportDocument>
  );
}
