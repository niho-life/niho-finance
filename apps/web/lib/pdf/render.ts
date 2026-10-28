import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { registerFonts } from "./font";

/**
 * Renders a `<ReportDocument>` (or any react-pdf `<Document>`) to the bytes of a PDF. Fonts are
 * registered on the first call.
 */
export async function renderPdf(element: ReactElement): Promise<Uint8Array> {
  registerFonts();
  const buffer = await renderToBuffer(element as ReactElement<DocumentProps>);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
