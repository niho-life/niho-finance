import { Text, View, type Styles } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { PDF_COLORS, PDF_FONT_SIZES } from "./styles";

/**
 * Table parts for every PDF (14-reports §12): the caller gives each cell its width (`width` in pt
 * or a percentage, or `flex`). Numbers are right-aligned; subtotal rows are bold with a line
 * above; a row never breaks across pages.
 */
/** One style object of react-pdf. */
export type PdfStyle = Styles[string];

export type PdfRowVariant = "header" | "body" | "group" | "subtotal" | "total";

const ROW_STYLES: Readonly<Record<PdfRowVariant, PdfStyle>> = {
  header: {
    backgroundColor: PDF_COLORS.fill,
    borderBottomWidth: 0.75,
    borderBottomColor: PDF_COLORS.border2,
    color: PDF_COLORS.muted,
    fontSize: PDF_FONT_SIZES.small,
    fontWeight: 700,
  },
  body: { borderBottomWidth: 0.5, borderBottomColor: PDF_COLORS.border },
  group: {
    backgroundColor: PDF_COLORS.fill,
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.border,
    fontWeight: 700,
  },
  subtotal: {
    borderTopWidth: 0.75,
    borderTopColor: PDF_COLORS.border2,
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.border,
    fontWeight: 700,
  },
  total: {
    borderTopWidth: 1,
    borderTopColor: PDF_COLORS.text,
    borderBottomWidth: 0.5,
    borderBottomColor: PDF_COLORS.border,
    fontWeight: 700,
  },
};

export function PdfTable({ children, style }: { children: ReactNode; style?: PdfStyle }) {
  return (
    <View
      style={[
        { borderTopWidth: 0.75, borderTopColor: PDF_COLORS.border2, marginBottom: 8 },
        style ?? {},
      ]}
    >
      {children}
    </View>
  );
}

export function PdfRow({
  variant = "body",
  muted = false,
  fixed = false,
  children,
}: {
  variant?: PdfRowVariant;
  /** Voided entries, sub-accounts: the muted grey. */
  muted?: boolean;
  /** Repeat on every page the table continues on (header rows). */
  fixed?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      wrap={false}
      fixed={fixed}
      style={[
        { flexDirection: "row", alignItems: "flex-start", paddingVertical: 3 },
        ROW_STYLES[variant],
        muted ? { color: PDF_COLORS.muted } : {},
      ]}
    >
      {children}
    </View>
  );
}

export function PdfCell({
  width,
  flex,
  align = "left",
  bold = false,
  muted = false,
  indent = 0,
  children,
}: {
  /** Fixed width in pt (or a percentage string). */
  width?: number | string;
  /** Share of the remaining width (when `width` is not given). */
  flex?: number;
  align?: "left" | "right" | "center";
  bold?: boolean;
  muted?: boolean;
  /** Indentation steps of 8pt (sub-rows). */
  indent?: number;
  children?: ReactNode;
}) {
  const box: PdfStyle =
    width !== undefined ? { width, flexShrink: 0 } : { flexGrow: flex ?? 1, flexBasis: 0 };
  return (
    <View style={[box, { paddingHorizontal: 4, paddingLeft: 4 + indent * 8 }]}>
      <Text
        style={[
          { textAlign: align },
          bold ? { fontWeight: 700 } : {},
          muted ? { color: PDF_COLORS.muted } : {},
        ]}
      >
        {children}
      </Text>
    </View>
  );
}
