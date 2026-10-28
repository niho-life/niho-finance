import { createHash } from "node:crypto";

/** SHA-256 as 64 lowercase hex digits. A string is hashed as its UTF-8 bytes. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
