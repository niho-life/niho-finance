import { StyleSheet } from "@react-pdf/renderer";
import { PDF_FONT_FAMILY } from "./font";

/** The PDF palette: the app's tokens (05-ui-ux §3) on paper. Numbers are never red. */
export const PDF_COLORS = {
  text: "#1f1f1f",
  muted: "#6b6b6b",
  muted2: "#9b9b9b",
  border: "#e9e9e7",
  border2: "#d6d6d3",
  fill: "#f7f7f5",
  warn: "#b7791f",
} as const;

/** 9pt body, 7.5pt small print (14-reports §12). */
export const PDF_FONT_SIZES = { body: 9, small: 7.5, title: 14, heading: 10 } as const;

export const pdfStyles = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT_FAMILY,
    fontSize: PDF_FONT_SIZES.body,
    color: PDF_COLORS.text,
    paddingTop: 32,
    paddingBottom: 44,
    paddingHorizontal: 36,
    // No lineHeight here: react-pdf turns a unitless value into points at this font size and
    // children inherit the points (a 14pt title would get a 9pt line). The font's own is used.
  },
  header: {
    paddingBottom: 6,
    marginBottom: 12,
    borderBottomWidth: 0.75,
    borderBottomColor: PDF_COLORS.border2,
  },
  headerLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: PDF_FONT_SIZES.small,
    color: PDF_COLORS.muted,
  },
  title: {
    marginTop: 2,
    fontSize: PDF_FONT_SIZES.title,
    fontWeight: 700,
    textAlign: "center",
  },
  subtitle: {
    fontSize: PDF_FONT_SIZES.small,
    color: PDF_COLORS.muted,
    textAlign: "center",
    marginTop: 1,
  },
  footer: {
    position: "absolute",
    left: 36,
    right: 36,
    bottom: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: PDF_FONT_SIZES.small,
    color: PDF_COLORS.muted,
  },
  heading: {
    fontSize: PDF_FONT_SIZES.heading,
    fontWeight: 700,
    marginTop: 10,
    marginBottom: 4,
  },
  note: { fontSize: PDF_FONT_SIZES.small, color: PDF_COLORS.muted, marginBottom: 4 },
  muted: { color: PDF_COLORS.muted },
  small: { fontSize: PDF_FONT_SIZES.small },
  bold: { fontWeight: 700 },
  number: { textAlign: "right" },
});
