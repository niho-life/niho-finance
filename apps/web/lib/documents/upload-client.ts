import {
  DOCUMENT_MAX_BYTES,
  normalizeDocumentMime,
  type DocumentKind,
  type DocumentLinkKind,
  type DocumentSource,
} from "@niho-finance/ledger";
import type {
  ApiErrorBody,
  CompleteRequest,
  CompleteResponse,
  PrepareRequest,
  PrepareResponse,
} from "./api-types";

/*
 * The browser side of an upload (13-documents §3.1): check the file → SHA-256 → prepare (a file
 * that is already stored is not sent again) → PUT to the upload target → complete. No React: the
 * screens call it and show the states. Messages are owner-facing; the server's own `{ error }` is
 * shown as it is.
 */

/** Where one file is: 計算中 / 送信中 / 登録中. */
export type UploadState = "hashing" | "uploading" | "registering";

export type UploadResult =
  /** `saved`: stored now. `duplicate`: a document that is not voided already has the file. */
  { outcome: "saved" | "duplicate"; documentId: string } | { outcome: "error"; message: string };

export interface UploadOptions {
  source: DocumentSource;
  /** Defaults on the server: 明細書 for CSV, 領収書 otherwise. */
  kind?: DocumentKind | null;
  /** Replace this document (its items and links move to the new one; it is voided). */
  supersedesId?: string | null;
  /** Required with `supersedesId`. */
  reason?: string | null;
  /** Link the new document in the same transaction. */
  link?: { kind: DocumentLinkKind; id: string } | null;
  onState?: (state: UploadState) => void;
}

// The same wording as the server's checks (packages/db `documentFileSchema`).
const FORMAT_ERROR =
  "この形式のファイルは保存できません。画像（JPEG・PNG・WebP・HEIC）・PDF・CSV を選んでください";
const TOO_LARGE_ERROR = "ファイルは 20 MB までです。小さくしてから選び直してください";
const EMPTY_ERROR = "空のファイルは保存できません。中身のあるファイルを選んでください";
const NETWORK_ERROR = "送信できませんでした。通信を確かめてもう一度試してください";
const READ_ERROR = "ファイルを読めませんでした。ファイルを選び直してください";
const INSECURE_ERROR =
  "この接続ではファイルを確かめられません。https のアドレス（または localhost）で開き直してください";
const SERVER_ERROR =
  "処理できませんでした。もう一度試してください。続くときは画面を読み込み直してください";
const PUT_ERROR =
  "ファイルを送信できませんでした。もう一度試してください。続くときは画面を読み込み直してください";

class UploadFailure extends Error {}

/** SHA-256 of the file as 64 lower-case hex digits (`crypto.subtle`: https or localhost only). */
export async function sha256Hex(file: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UploadFailure(INSECURE_ERROR);
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new UploadFailure(READ_ERROR);
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The server's `{ error }`, or `fallback` when the body is not one (e.g. GCS's XML errors). */
async function errorOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody> | null;
    if (body && typeof body.error === "string" && body.error !== "") return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new UploadFailure(NETWORK_ERROR);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await send(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!response.ok) throw new UploadFailure(await errorOf(response, SERVER_ERROR));
  try {
    return (await response.json()) as T;
  } catch {
    throw new UploadFailure(SERVER_ERROR);
  }
}

/** Why the file cannot be stored, before anything is sent; `null` when it can. */
export function fileProblem(file: File): string | null {
  if (normalizeDocumentMime(file.type, file.name) === null) return FORMAT_ERROR;
  if (file.size === 0) return EMPTY_ERROR;
  if (file.size > DOCUMENT_MAX_BYTES) return TOO_LARGE_ERROR;
  return null;
}

/** Stores one file: ① checks ② SHA-256 ③ prepare ④ PUT ⑤ complete. Never throws. */
export async function uploadDocument(file: File, options: UploadOptions): Promise<UploadResult> {
  const problem = fileProblem(file);
  if (problem) return { outcome: "error", message: problem };
  try {
    options.onState?.("hashing");
    const sha256 = await sha256Hex(file);

    const prepareBody: PrepareRequest = {
      sha256,
      mime: file.type,
      byteSize: file.size,
      originalName: file.name,
      source: options.source,
    };
    const prepared = await postJson<PrepareResponse>("/api/documents/prepare", prepareBody);
    if (prepared.kind === "duplicate") {
      return { outcome: "duplicate", documentId: prepared.documentId };
    }

    options.onState?.("uploading");
    const put = await send(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: file,
      credentials: "same-origin",
    });
    if (!put.ok) throw new UploadFailure(await errorOf(put, PUT_ERROR));

    options.onState?.("registering");
    const completeBody: CompleteRequest = {
      key: prepared.key,
      sha256,
      mime: prepared.mime,
      byteSize: file.size,
      originalName: file.name,
      source: options.source,
      kind: options.kind ?? null,
      supersedesId: options.supersedesId ?? null,
      reason: options.reason ?? null,
      link: options.link ?? null,
    };
    const completed = await postJson<CompleteResponse>("/api/documents/complete", completeBody);
    return {
      outcome: completed.duplicate ? "duplicate" : "saved",
      documentId: completed.documentId,
    };
  } catch (error) {
    return {
      outcome: "error",
      message: error instanceof UploadFailure ? error.message : SERVER_ERROR,
    };
  }
}

export interface UploadManyOptions extends Omit<UploadOptions, "onState"> {
  /** The state of `files[index]`. */
  onState?: (index: number, state: UploadState) => void;
  /** `files[index]` is done (before the next one starts). */
  onResult?: (index: number, result: UploadResult) => void;
}

/** Stores the files one after another; the results are in the order of `files`. */
export async function uploadDocuments(
  files: readonly File[],
  options: UploadManyOptions,
): Promise<UploadResult[]> {
  const { onState, onResult, ...shared } = options;
  const results: UploadResult[] = [];
  for (const [index, file] of files.entries()) {
    const result = await uploadDocument(file, {
      ...shared,
      onState: (state) => onState?.(index, state),
    });
    results.push(result);
    onResult?.(index, result);
  }
  return results;
}
