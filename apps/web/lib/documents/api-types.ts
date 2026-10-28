/**
 * Request and response shapes of the documents API (13-documents §7), shared with client code
 * (`upload-client.ts`): types only, no server imports. Every failure is `ApiErrorBody` with a 4xx
 * (or 500) status.
 */
import type { DocumentKind, DocumentLinkKind, DocumentSource } from "@niho-finance/ledger";

export interface ApiErrorBody {
  /** Owner-facing: what is wrong and how to get back. */
  error: string;
}

/** `POST /api/documents/prepare` */
export interface PrepareRequest {
  /** SHA-256 of the file (`crypto.subtle.digest`), hex. */
  sha256: string;
  /** `File.type` as the browser reports it (may be empty); normalized with the file name. */
  mime: string;
  byteSize: number;
  /** `File.name`, at most 200 characters. */
  originalName: string;
  source: DocumentSource;
}

export type PrepareResponse =
  /** A document that is not voided already has this file: nothing to upload. */
  | { kind: "duplicate"; documentId: string }
  | {
      kind: "upload";
      key: string;
      /** GCS's signed URL, or the local endpoint (relative). */
      url: string;
      method: "PUT";
      /** Send exactly these (the signature covers `Content-Type`). */
      headers: Record<string, string>;
      /** The normalized type: the `Content-Type` of the PUT and the `mime` of `complete`. */
      mime: string;
      /** ISO 8601. */
      expiresAt: string;
    };

/** `POST /api/documents/complete`, after the PUT. */
export interface CompleteRequest {
  key: string;
  sha256: string;
  mime: string;
  byteSize: number;
  originalName: string;
  source: DocumentSource;
  /** Defaults to 明細書 for CSV, 領収書 otherwise. Ignored for a replacement (inherited). */
  kind?: DocumentKind | null;
  /** Replace this document (its items and links are inherited; it is voided). */
  supersedesId?: string | null;
  /** Required with `supersedesId`, at most 200 characters. */
  reason?: string | null;
  /** Link the new document in the same transaction. */
  link?: { kind: DocumentLinkKind; id: string } | null;
}

export interface CompleteResponse {
  documentId: string;
  /** `true`: the same file was already stored; that document is returned and nothing changed. */
  duplicate: boolean;
}
