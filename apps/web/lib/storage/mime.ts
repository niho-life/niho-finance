/**
 * The format of a stored file from its first bytes (13-documents §6). `complete` compares it with
 * the declared type, so a renamed or mislabelled file is never stored as evidence of another kind.
 */

export type SniffedDocumentMime =
  "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "application/pdf" | "text/csv";

function hasBytes(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return end <= bytes.length ? String.fromCharCode(...bytes.subarray(start, end)) : "";
}

/** HEIC (HEVC-coded HEIF) brands, and the generic HEIF brands that AVIF uses as well. */
const HEIC_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
]);
const HEIF_BRANDS: ReadonlySet<string> = new Set(["mif1", "msf1"]);
const AVIF_BRANDS: ReadonlySet<string> = new Set(["avif", "avis"]);

/** An ISO BMFF `ftyp` box whose major or compatible brands say HEIC / HEIF (not AVIF). */
function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
  const boxSize =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const end = Math.min(bytes.length, Math.max(16, boxSize));
  const brands = [ascii(bytes, 8, 12)];
  for (let offset = 16; offset + 4 <= end; offset += 4)
    brands.push(ascii(bytes, offset, offset + 4));
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return true;
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return false;
  return brands.some((brand) => HEIF_BRANDS.has(brand));
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** `%PDF-` within the first 1024 bytes (where PDF readers look for it). */
function isPdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - PDF_HEADER.length, 1024 - PDF_HEADER.length);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (hasBytes(bytes, PDF_HEADER, offset)) return true;
  }
  return false;
}

/** Control characters text may contain: TAB, LF, VT, FF, CR and SUB (the old DOS end of file). */
const TEXT_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1a]);

function decodes(bytes: Uint8Array, encoding: string): boolean {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Text without binary control bytes that reads as UTF-8 or as Shift_JIS (bank CSVs). */
function isCsvText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if ((byte < 0x20 && !TEXT_CONTROLS.has(byte)) || byte === 0x7f) return false;
  }
  return decodes(bytes, "utf-8") || decodes(bytes, "shift_jis");
}

/** The format the bytes are in, or `null` when they are none of the accepted ones. */
export function sniffDocumentMime(bytes: Uint8Array): SniffedDocumentMime | null {
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (isHeif(bytes)) return "image/heic";
  if (isPdf(bytes)) return "application/pdf";
  if (isCsvText(bytes)) return "text/csv";
  return null;
}

/** Whether the declared (normalized) type matches the bytes; HEIF and HEIC are one family. */
export function matchesDeclaredMime(
  declared: string,
  sniffed: SniffedDocumentMime | null,
): boolean {
  if (sniffed === null) return false;
  if (declared === "image/heif") return sniffed === "image/heic";
  return declared === sniffed;
}
