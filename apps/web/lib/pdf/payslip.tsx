import { Text, View } from "@react-pdf/renderer";
import { ReportDocument } from "./document";
import { PDF_COLORS, PDF_FONT_SIZES, pdfStyles } from "./styles";
import { PdfCell, PdfRow, PdfTable } from "./table";

/** One line of 支給 or 控除: the amount as shown (3-digit grouping, the unit in the header). */
export interface PayslipLine {
  label: string;
  amount: string;
  /** A muted note after the label (e.g. the parts of 調整). */
  note?: string | null;
}

/**
 * 給与明細 as text (22-payroll §6.5): built once from `loadPayslip` and drawn both as the printable
 * page and as this PDF, so the two never differ.
 */
export interface PayslipData {
  companyName: string;
  /** 「2026 年 12 月支給」 */
  payMonthLabel: string;
  /** 「2026/12/25」 */
  paymentDate: string;
  employeeName: string;
  /** 役員 / 従業員 */
  kindLabel: string;
  pay: PayslipLine[];
  grossPay: string;
  deductions: PayslipLine[];
  totalDeductions: string;
  netPay: string;
  reference: { label: string; value: string }[];
}

const AMOUNT_WIDTH = 84;

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
    <View>
      <Text style={pdfStyles.heading}>{title}</Text>
      <PdfTable>
        <PdfRow variant="header">
          <PdfCell flex={1}>項目</PdfCell>
          <PdfCell width={AMOUNT_WIDTH} align="right">
            金額（円）
          </PdfCell>
        </PdfRow>
        {lines.map((line) => (
          <PdfRow key={line.label}>
            <PdfCell flex={1}>
              {line.label}
              {line.note ? `（${line.note}）` : ""}
            </PdfCell>
            <PdfCell width={AMOUNT_WIDTH} align="right">
              {line.amount}
            </PdfCell>
          </PdfRow>
        ))}
        <PdfRow variant="total">
          <PdfCell flex={1}>{total.label}</PdfCell>
          <PdfCell width={AMOUNT_WIDTH} align="right">
            {total.amount}
          </PdfCell>
        </PdfRow>
      </PdfTable>
    </View>
  );
}

/** 給与明細 on one A4 portrait page, with the fonts and styles of every PDF of the app. */
export function PayslipDocument({
  payslip,
  exportedAt,
}: {
  payslip: PayslipData;
  exportedAt?: Date;
}) {
  return (
    <ReportDocument
      title="給与明細"
      company={payslip.companyName}
      periodLabel={`${payslip.payMonthLabel} · 支払日 ${payslip.paymentDate}`}
      {...(exportedAt ? { exportedAt } : {})}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-end",
          marginBottom: 6,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: 700 }}>{payslip.employeeName} 様</Text>
        <Text style={pdfStyles.muted}>
          {payslip.kindLabel} · {payslip.payMonthLabel} · 支払日 {payslip.paymentDate}
        </Text>
      </View>
      <View style={{ flexDirection: "row" }}>
        <View style={{ flexGrow: 1, flexBasis: 0, marginRight: 12 }}>
          <LinesTable
            title="支給"
            lines={payslip.pay}
            total={{ label: "総支給", amount: payslip.grossPay }}
          />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 0 }}>
          <LinesTable
            title="控除"
            lines={payslip.deductions}
            total={{ label: "控除計", amount: payslip.totalDeductions }}
          />
        </View>
      </View>
      <View
        wrap={false}
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 4,
          paddingVertical: 8,
          paddingHorizontal: 10,
          borderWidth: 1,
          borderColor: PDF_COLORS.text,
          backgroundColor: PDF_COLORS.fill,
        }}
      >
        <Text style={{ fontSize: PDF_FONT_SIZES.heading, fontWeight: 700 }}>差引支給額</Text>
        <Text style={{ fontSize: PDF_FONT_SIZES.title, fontWeight: 700 }}>{payslip.netPay} 円</Text>
      </View>
      <Text style={pdfStyles.heading}>参考</Text>
      <PdfTable>
        {payslip.reference.map((row) => (
          <PdfRow key={row.label}>
            <PdfCell width={160} muted>
              {row.label}
            </PdfCell>
            <PdfCell flex={1}>{row.value}</PdfCell>
          </PdfRow>
        ))}
      </PdfTable>
    </ReportDocument>
  );
}
