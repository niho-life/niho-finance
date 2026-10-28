import { Document, Page, Text, View } from "@react-pdf/renderer";
import { formatPdfDateTime } from "./document";
import { PDF_COLORS, PDF_FONT_SIZES, pdfStyles } from "./styles";

/**
 * 法定調書 as boxed forms (22-payroll §12.2): 源泉徴収票（受給者交付用）, 給与支払報告書（個人別明細書・
 * 総括表）, 法定調書合計表の元データ and 報酬、料金、契約金及び賞金の支払調書. Each form is built once
 * as text (the screens' `_lib/statement-forms.ts`) and drawn both as the printable page and as this
 * PDF: every item of the official form with its label, in boxes, on A4 portrait (the layout is not
 * the official one; the items and their words are).
 */

/** One box: the label of the form's item and its value (`""` = empty box). */
export interface FormCell {
  label: string;
  value: string;
  /** Share of the row's width (default 1). */
  flex?: number;
  align?: "left" | "right" | "center";
  /** A small note under the value (e.g. 「内 0」). */
  note?: string;
}

export interface FormSection {
  /** The group's heading (e.g. 「支払を受ける者」); left out = no heading. */
  title?: string;
  rows: FormCell[][];
}

export interface StatementForm {
  key: string;
  /** 「令和 8 年分 給与所得の源泉徴収票」 */
  title: string;
  /** 「受給者交付用」 */
  subtitle?: string;
  sections: FormSection[];
  /** Small print under the form. */
  footnotes: string[];
}

const BORDER = PDF_COLORS.text;

function Cell({ cell, last }: { cell: FormCell; last: boolean }) {
  return (
    <View
      style={{
        flexGrow: cell.flex ?? 1,
        flexBasis: 0,
        borderRightWidth: last ? 0 : 0.5,
        borderRightColor: BORDER,
        paddingHorizontal: 3,
        paddingVertical: 2,
        minHeight: 26,
      }}
    >
      <Text style={{ fontSize: 6.5, color: PDF_COLORS.muted }}>{cell.label}</Text>
      <Text
        style={{
          fontSize: PDF_FONT_SIZES.body,
          marginTop: 1,
          textAlign: cell.align ?? "left",
        }}
      >
        {cell.value}
      </Text>
      {cell.note ? (
        <Text style={{ fontSize: 6.5, color: PDF_COLORS.muted, textAlign: cell.align ?? "left" }}>
          {cell.note}
        </Text>
      ) : null}
    </View>
  );
}

function Section({ section }: { section: FormSection }) {
  return (
    <View wrap={false} style={{ marginBottom: 6 }}>
      {section.title ? (
        <Text style={{ fontSize: PDF_FONT_SIZES.small, fontWeight: 700, marginBottom: 2 }}>
          {section.title}
        </Text>
      ) : null}
      <View style={{ borderWidth: 0.75, borderColor: BORDER }}>
        {section.rows.map((row, index) => (
          <View
            key={index}
            style={{
              flexDirection: "row",
              borderTopWidth: index === 0 ? 0 : 0.5,
              borderTopColor: BORDER,
            }}
          >
            {row.map((cell, cellIndex) => (
              <Cell key={cellIndex} cell={cell} last={cellIndex === row.length - 1} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

/** Every form on a page of its own (A4 portrait), with the app's fonts. */
export function StatementFormDocument({
  title,
  author,
  forms,
  exportedAt = new Date(),
}: {
  title: string;
  author: string;
  forms: readonly StatementForm[];
  exportedAt?: Date;
}) {
  return (
    <Document
      title={title}
      author={author}
      creator="NIHO finance"
      producer="NIHO finance"
      language="ja"
    >
      {forms.map((form) => (
        <Page key={form.key} size="A4" style={pdfStyles.page} wrap>
          <View style={{ marginBottom: 8 }}>
            <Text style={pdfStyles.title}>{form.title}</Text>
            {form.subtitle ? <Text style={pdfStyles.subtitle}>{form.subtitle}</Text> : null}
          </View>
          {form.sections.map((section, index) => (
            <Section key={index} section={section} />
          ))}
          {form.footnotes.map((note) => (
            <Text key={note} style={pdfStyles.note}>
              {note}
            </Text>
          ))}
          <View style={pdfStyles.footer} fixed>
            <Text>出力日時 {formatPdfDateTime(exportedAt)}</Text>
            <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages} ページ`} />
          </View>
        </Page>
      ))}
    </Document>
  );
}
