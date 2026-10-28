"use server";

import { applyDocumentReading, getPrismaClient, type ReadingProposalField } from "@niho-finance/db";
import { revalidatePath } from "next/cache";
import { attempt, parseId } from "@/lib/action-result";
import type { ActionResult } from "@/lib/action-types";
import { actor } from "@/lib/actor";
import { readDocumentForActor } from "@/lib/reader/read-document";
import { authorizeAction } from "@/lib/authz";

/*
 * Server Actions of 読み取り (20-reader §5・§10): 読み取る (the detail, and one by one from the
 * inbox's まとめて読み取る) and 提案を保存. A reading writes only the proposal (`document.read`);
 * saving it goes through `updateDocument` (`document.update`) with the values of the stored
 * reading, the client sending only which items.
 */

export interface ReadDocumentOutcome {
  status: "proposed" | "failed";
  /** Warnings and errors of the proposal (要確認). */
  issueCount: number;
  /** Why the reading failed (owner-facing), stored on the document too. */
  error: string | null;
}

export async function readDocumentAction(id: string): Promise<ActionResult<ReadDocumentOutcome>> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await attempt(async () => readDocumentForActor(parseId(id), await actor()));
  if (!result.ok) return result;
  // The detail, the list's states and the inbox's unread count all read the proposal.
  revalidatePath("/", "layout");
  return {
    ok: true,
    data: {
      status: result.data.status,
      issueCount: result.data.issues.length,
      error: result.data.error ?? null,
    },
  };
}

export async function applyDocumentReadingAction(
  id: string,
  fields: readonly ReadingProposalField[],
): Promise<ActionResult> {
  const denied = await authorizeAction("accountant");
  if (denied) return denied;
  const result = await attempt(async () =>
    applyDocumentReading(
      getPrismaClient(),
      // The repository's schema checks the items: an unknown or repeated one is refused.
      { documentId: parseId(id), fields: [...fields] },
      { actor: await actor() },
    ),
  );
  if (!result.ok) return result;
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}
