/**
 * The reading provider (20-reader §2.1): sends one document file to a model and returns its raw,
 * unchecked JSON answer with the token usage. `parseReading` checks the answer.
 */

/** Formats the provider can read: images for the vision input and PDF for the document input. */
export const READABLE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type ReadableMime = (typeof READABLE_MIMES)[number];

/** The API's limit for one image. PDFs are bounded by the document size limit of S6. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function isReadableMime(value: unknown): value is ReadableMime {
  return typeof value === "string" && (READABLE_MIMES as readonly string[]).includes(value);
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult {
  /** The answer following `READING_JSON_SCHEMA`, not yet checked. */
  raw: unknown;
  usage: ProviderUsage;
}

export interface ProviderInput {
  bytes: Uint8Array;
  mime: string;
  /** SHA-256 of `bytes` (lower-case hex), the key of recorded answers. */
  sha256: string;
}

export interface ReaderProvider {
  readonly provider: "anthropic" | "recorded";
  readonly model: string;
  read(input: ProviderInput): Promise<ProviderResult>;
}

export const READER_ERROR_CODES = [
  "unsupported_mime",
  "too_large",
  "refusal",
  "truncated",
  "invalid_output",
  "api",
  "not_configured",
  "not_recorded",
] as const;
export type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

/** Owner-facing default messages. None of them carries a key, a URL or an API response body. */
export const READER_ERROR_MESSAGES: Readonly<Record<ReaderErrorCode, string>> = {
  unsupported_mime: "この形式は読み取れません（画像は JPEG・PNG・WebP、または PDF）",
  too_large: "画像が大きすぎます。5 MB 以下にして撮り直すか、PDF にしてください",
  refusal: "読み取りを断られました。項目は手で入れてください",
  truncated: "読み取りの結果が途中で切れました。もう一度読み取ってください",
  invalid_output: "読み取りの結果の形式が正しくありません。もう一度読み取ってください",
  api: "読み取りの API でエラーが起きました",
  not_configured: "読み取りが設定されていません",
  not_recorded: "この証憑の記録済みの応答がありません（開発用の読み取り）",
};

/**
 * A failed reading. `message` is shown to the owner as is. `usage` is set when the API answered
 * (refusal, truncation, malformed output): those calls are billed and are counted (§9).
 */
export class ReaderError extends Error {
  override readonly name = "ReaderError";
  readonly code: ReaderErrorCode;
  readonly usage: ProviderUsage | null;

  constructor(
    code: ReaderErrorCode,
    message: string = READER_ERROR_MESSAGES[code],
    usage: ProviderUsage | null = null,
  ) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}

/** Rejects what no provider reads, before anything is sent: other formats and large images. */
export function assertReadable(input: { bytes: Uint8Array; mime: string }): ReadableMime {
  if (!isReadableMime(input.mime)) throw new ReaderError("unsupported_mime");
  if (input.mime !== "application/pdf" && input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ReaderError("too_large");
  }
  return input.mime;
}
