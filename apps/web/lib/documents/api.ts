import {
  documentFileSchema,
  enumField,
  idField,
  optionalEnumField,
  optionalIdField,
  optionalText,
  requiredText,
  SettingsError,
} from "@niho-finance/db";
import { DOCUMENT_KINDS, DOCUMENT_LINK_KINDS, normalizeDocumentMime } from "@niho-finance/ledger";
import { z, ZodError } from "zod";
import { toActionError } from "@/lib/action-result";
import { isSafeDocumentKey } from "@/lib/storage/keys";

/*
 * Shared parts of the documents API (13-documents §7): same-origin checks, JSON bodies validated
 * with the repository's Zod parts, and `{ error }` responses with owner-facing Japanese.
 */

/** A failure with an owner-facing message and its HTTP status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const SHAPE_ERROR =
  "送信の形式が正しくありません。画面を読み込み直してから、もう一度試してください";
const UNEXPECTED_ERROR =
  "処理できませんでした。もう一度試してください。続くときは画面を読み込み直してください";

export const NO_STORE: Readonly<Record<string, string>> = { "Cache-Control": "no-store" };

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/** Refuses requests from another site (`Sec-Fetch-Site: cross-site`): only the app's own pages. */
export function assertSameOrigin(request: Request): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "ほかのサイトからは操作できません。アプリの画面から操作してください");
  }
}

function mediaType(request: Request): string | undefined {
  return request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
}

/** The JSON body parsed with `schema`; other content types are refused (415). */
export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (mediaType(request) !== "application/json") throw new ApiError(415, SHAPE_ERROR);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, SHAPE_ERROR);
  }
  return schema.parse(body);
}

/**
 * The raw body when it is at most `limit` bytes; `null` as soon as it is longer (the rest is not
 * buffered).
 */
export async function readBodyBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Runs a handler: `ApiError` → its status, `SettingsError` / `ZodError` → 400 with the owner-facing
 * message, anything else → 500 with a generic one (logged).
 */
export async function handleApi(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error.status, error.message);
    if (error instanceof SettingsError || error instanceof ZodError) {
      return jsonError(400, toActionError(error).error);
    }
    console.error("[niho-finance] documents API failed", error);
    return jsonError(500, UNEXPECTED_ERROR);
  }
}

/** The browser's `File.type` and name → an accepted MIME type (kept as sent when there is none). */
function withNormalizedMime(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const { mime, originalName } = body as { mime?: unknown; originalName?: unknown };
  const normalized = normalizeDocumentMime(
    typeof mime === "string" ? mime : "",
    typeof originalName === "string" ? originalName : "",
  );
  return { ...body, mime: normalized ?? mime };
}

/** `POST /api/documents/prepare` (`PrepareRequest` in `api-types.ts`). */
export const prepareRequestSchema = z.preprocess(withNormalizedMime, documentFileSchema);

/**
 * `POST /api/documents/complete` (`CompleteRequest` in `api-types.ts`): the prepared upload, plus a
 * replacement (`supersedesId` and `reason`) or a link to create in the same transaction.
 */
export const completeRequestSchema = z.preprocess(
  withNormalizedMime,
  documentFileSchema.extend({
    key: requiredText("送信先", 300).refine(isSafeDocumentKey, {
      error: "送信先が正しくありません。もう一度アップロードしてください",
    }),
    /** Defaults to 明細書 for CSV, 領収書 otherwise. Ignored for a replacement (inherited). */
    kind: optionalEnumField("種別", DOCUMENT_KINDS),
    supersedesId: optionalIdField("差し替える証憑"),
    reason: optionalText("理由", 200),
    link: z
      .object({ kind: enumField("紐づける先", DOCUMENT_LINK_KINDS), id: idField("紐づける先") })
      .nullish(),
  }),
);
