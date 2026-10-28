export type CsvEncoding = "utf-8" | "shift_jis";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return UTF8_BOM.every((byte, index) => bytes[index] === byte);
}

/**
 * Decodes a CSV file (12-imports §3.2): the UTF-8 BOM is dropped, strict UTF-8 is tried first and
 * Shift_JIS (WHATWG, i.e. cp932 with its vendor characters) is the fallback.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  const body = hasUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(body), encoding: "shift_jis" };
  }
}
