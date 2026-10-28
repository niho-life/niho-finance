"use server";

import {
  getPrismaClient,
  linkDocument,
  unlinkDocument,
  updateDocument,
  voidDocument,
  type DocumentDetail,
} from "@niho-finance/db";
import { formatYenInput, type DocumentLinkKind } from "@niho-finance/ledger";
import { revalidatePath } from "next/cache";
import { attempt, inlinePatch, parseId } from "@/lib/action-result";
import type { ActionResult, RowValues } from "@/lib/action-types";
import { actor } from "@/lib/actor";

/*
 * Server Actions of /documents (13-documents §4): the items, 無効にする, 紐づける / 外す. The
 * repository validates every input with its Zod schemas and writes the audit log as
 * `NIHO_FINANCE_ACTOR`. Registering and replacing files go through the API (`complete`).
 */

const prisma = () => getPrismaClient();
const by = async () => ({ actor: await actor() });

async function write<T, R>(
  run: () => Promise<T>,
  toData: (value: T) => R,
): Promise<ActionResult<R>> {
  const result = await attempt(run);
  if (!result.ok) return result;
  // The list's counts, the detail's candidates, the entries' documents and the shell all read it.
  revalidatePath("/", "layout");
  return { ok: true, data: toData(result.data) };
}

const nothing = () => null;

/** The items the detail edits in place. */
const DOCUMENT_FIELDS = [
  "kind",
  "txnDate",
  "amount",
  "partnerId",
  "partnerName",
  "invoiceRegistrationNumber",
  "note",
] as const;

/** The saved items as the cells show them (amount with 3-digit grouping, empty as ""). */
function documentValues(document: DocumentDetail): RowValues {
  return {
    kind: document.kind,
    txnDate: document.txnDate ?? "",
    amount: formatYenInput(document.amount),
    partnerId: document.partnerId ?? "",
    partnerName: document.partnerName ?? "",
    invoiceRegistrationNumber: document.invoiceRegistrationNumber ?? "",
    note: document.note ?? "",
  };
}

export async function updateDocumentAction(
  id: string,
  patch: RowValues,
): Promise<ActionResult<RowValues>> {
  return write(
    async () => updateDocument(prisma(), inlinePatch(id, patch, DOCUMENT_FIELDS), await by()),
    documentValues,
  );
}

export async function voidDocumentAction(id: string, reason: string): Promise<ActionResult> {
  return write(
    async () => voidDocument(prisma(), { id: parseId(id), reason }, await by()),
    nothing,
  );
}

export interface DocumentLinkValues {
  kind: DocumentLinkKind;
  /** The entry / statement line / invoice. */
  id: string;
  documentId: string;
}

export async function linkDocumentAction(values: DocumentLinkValues): Promise<ActionResult> {
  return write(async () => linkDocument(prisma(), values, await by()), nothing);
}

export async function unlinkDocumentAction(values: DocumentLinkValues): Promise<ActionResult> {
  return write(async () => unlinkDocument(prisma(), values, await by()), nothing);
}
